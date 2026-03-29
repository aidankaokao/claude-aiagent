"""
api.py — FastAPI 入口

端點：
  GET  /api/health
  GET  /api/skills                        ← 取得所有技能（從 SKILL.md 讀取）
  POST /api/chat                          ← SSE 對話（含技能自動偵測）
  POST /api/playground/test               ← SSE Playground 測試
  POST /api/rating                        ← 提交評分
  GET  /api/conversations                 ← 對話列表
  GET  /api/conversations/{id}            ← 對話詳情（含訊息）
"""

import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from sqlalchemy import insert, select, update, desc
from sse_starlette.sse import EventSourceResponse

from agent import SkillAgent, SKILL_NODES
from config import settings
from database import engine, init_db, conversations, messages, ratings
from models import (
    ChatRequest, PlaygroundRequest, RatingRequest,
    ConversationResponse, ConversationDetailResponse, MessageResponse,
    SkillInfo, FewShotExampleInfo, SkillParameterInfo,
)
from skills.registry import SkillRegistry

logging.basicConfig(level=settings.log_level)
log = logging.getLogger(__name__)

registry = SkillRegistry()

# ── Agent 快取（依 llm_config 快取編譯後的 agent）──
_agent_cache: dict[str, SkillAgent] = {}


async def get_or_create_agent(llm_config) -> object:
    cache_key = f"{llm_config.api_key[:8]}:{llm_config.base_url}:{llm_config.model}"
    if cache_key not in _agent_cache:
        skill_agent = SkillAgent(llm_config)
        _agent_cache[cache_key] = await skill_agent.create_agent()
    return _agent_cache[cache_key]


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    log.info("Case 7 backend started")
    yield


app = FastAPI(title="Case 7 — Skill Agent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# GET /api/health
# ============================================================
@app.get("/api/health")
def health():
    return {"status": "ok"}


# ============================================================
# GET /api/skills — 從 SKILL.md 讀取技能清單
# ============================================================
@app.get("/api/skills")
def get_skills():
    skill_list = registry.get_all_skills()
    return [
        SkillInfo(
            name=s["name"],
            display_name=s["display_name"],
            description=s["description"],
            icon=s["icon"],
            system_prompt=s["system_prompt"],
            examples=[FewShotExampleInfo(**e) for e in s.get("examples", [])],
            parameters=[SkillParameterInfo(**p) for p in s.get("parameters", [])],
        )
        for s in skill_list
    ]


# ============================================================
# POST /api/chat — SSE 對話
# ============================================================
@app.post("/api/chat")
async def chat(req: ChatRequest):
    async def event_generator():
        conversation_id = req.thread_id
        log.info(f"[CHAT] thread={conversation_id}  skill_override={req.skill_override!r}")

        try:
            with engine.connect() as conn:
                exists = conn.execute(
                    select(conversations).where(conversations.c.id == conversation_id)
                ).fetchone()
                if not exists:
                    conn.execute(insert(conversations).values(
                        id=conversation_id,
                        title=req.message[:40] + ("…" if len(req.message) > 40 else ""),
                    ))
                    conn.commit()

                conn.execute(insert(messages).values(
                    conversation_id=conversation_id,
                    role="user",
                    content=req.message,
                ))
                conn.commit()

            agent = await get_or_create_agent(req.llm_config)
            config = {"configurable": {"thread_id": conversation_id}, "recursion_limit": 20}

            initial_state = {
                "user_input": req.message,
                "skill_override": req.skill_override,
                "detected_skill": "",
                "active_skill": "",
                "response": "",
                "messages": [HumanMessage(req.message)],
            }

            active_skill = ""
            full_response = ""

            async for event in agent.astream_events(initial_state, config=config, version="v2"):
                etype = event["event"]
                node_name = event.get("name", "")

                # classify_node 完成 → 通知前端偵測到的技能
                if etype == "on_chain_end" and node_name == "classify_node":
                    output = event["data"].get("output", {})
                    active_skill = output.get("active_skill", "")
                    log.info(f"[CLASSIFY] skill={active_skill!r}")
                    if active_skill:
                        yield {
                            "event": "skill_detected",
                            "data": json.dumps({"skill": active_skill}, ensure_ascii=False),
                        }

                # 技能節點產出 token → 串流給前端
                if etype == "on_chat_model_stream":
                    cur_node = event.get("metadata", {}).get("langgraph_node", "")
                    if cur_node in SKILL_NODES:
                        chunk = event["data"]["chunk"].content
                        if chunk:
                            full_response += chunk
                            yield {
                                "event": "token",
                                "data": json.dumps({"content": chunk}, ensure_ascii=False),
                            }

            # 儲存 AI 訊息
            msg_id = -1
            if full_response:
                with engine.connect() as conn:
                    result = conn.execute(insert(messages).values(
                        conversation_id=conversation_id,
                        role="assistant",
                        content=full_response,
                        skill_name=active_skill or None,
                    ))
                    msg_id = result.lastrowid
                    conn.execute(
                        update(conversations)
                        .where(conversations.c.id == conversation_id)
                        .values(updated_at=datetime.now(timezone.utc))
                    )
                    conn.commit()

            yield {
                "event": "done",
                "data": json.dumps({
                    "thread_id": conversation_id,
                    "skill": active_skill,
                    "message_id": msg_id,
                }, ensure_ascii=False),
            }

        except Exception as e:
            log.exception(f"[CHAT ERROR] {e}")
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_generator())


# ============================================================
# POST /api/playground/test — Prompt Playground SSE 測試
# ============================================================
@app.post("/api/playground/test")
async def playground_test(req: PlaygroundRequest):
    """
    Playground 測試端點。
    直接單次呼叫 LLM，不走 LangGraph（避免對話歷史干擾）。
    system prompt 從對應的 SKILL.md 讀取。
    """
    async def event_generator():
        log.info(f"[PLAYGROUND] skill={req.skill_name}")
        try:
            system_prompt = registry.compose_system_prompt(req.skill_name)

            kwargs = dict(
                api_key=req.llm_config.api_key,
                model=req.llm_config.model,
                temperature=req.llm_config.temperature,
                streaming=True,
            )
            if req.llm_config.base_url:
                kwargs["base_url"] = req.llm_config.base_url
            llm = ChatOpenAI(**kwargs)

            async for chunk in llm.astream([
                SystemMessage(system_prompt),
                HumanMessage(req.input_text),
            ]):
                if chunk.content:
                    yield {
                        "event": "token",
                        "data": json.dumps({"content": chunk.content}, ensure_ascii=False),
                    }

            yield {
                "event": "done",
                "data": json.dumps({"skill": req.skill_name}, ensure_ascii=False),
            }

        except Exception as e:
            log.exception(f"[PLAYGROUND ERROR] {e}")
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_generator())


# ============================================================
# POST /api/rating — 提交評分
# ============================================================
@app.post("/api/rating")
def submit_rating(req: RatingRequest):
    with engine.connect() as conn:
        conn.execute(insert(ratings).values(
            message_id=req.message_id,
            conversation_id=req.conversation_id,
            skill_name=req.skill_name,
            rating=req.rating,
            feedback=req.feedback or None,
        ))
        conn.commit()
    log.info(f"[RATING] msg={req.message_id}  skill={req.skill_name}  rating={req.rating}")
    return {"ok": True}


# ============================================================
# GET /api/conversations — 對話列表
# ============================================================
@app.get("/api/conversations")
def list_conversations():
    with engine.connect() as conn:
        rows = conn.execute(
            select(conversations).order_by(desc(conversations.c.updated_at)).limit(50)
        ).fetchall()
    return [ConversationResponse(
        id=r.id,
        title=r.title,
        created_at=str(r.created_at),
        updated_at=str(r.updated_at),
    ) for r in rows]


# ============================================================
# GET /api/conversations/{id} — 對話詳情
# ============================================================
@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: str):
    with engine.connect() as conn:
        conv = conn.execute(
            select(conversations).where(conversations.c.id == conversation_id)
        ).fetchone()
        if not conv:
            return {"error": "not found"}, 404

        msgs = conn.execute(
            select(messages)
            .where(messages.c.conversation_id == conversation_id)
            .order_by(messages.id)
        ).fetchall()

    return ConversationDetailResponse(
        id=conv.id,
        title=conv.title,
        messages=[MessageResponse(
            id=m.id,
            role=m.role,
            content=m.content,
            skill_name=m.skill_name,
            created_at=str(m.created_at),
        ) for m in msgs],
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host=settings.backend_host, port=settings.backend_port, reload=True)
