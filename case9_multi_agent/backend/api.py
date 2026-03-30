"""
FastAPI 應用 — Multi-Agent Supervisor API（Case 9）

架構特點：
- Supervisor 模式：supervisor 動態分派任務給 researcher/analyst/writer
- 使用 astream_events v2 追蹤各 Agent 的執行狀態
- 以 metadata.langgraph_node 過濾事件，識別各 Agent 的 LLM 呼叫
- Agent 快取：依 (api_key前8碼, model) 快取已編譯的 Agent 實例

SSE 事件類型：
  event: agent_start   data: {"agent": "supervisor"|"researcher"|"analyst"|"writer"}
  event: agent_end     data: {"agent": "...", "summary": "..."}
  event: token         data: {"content": "..."}   ← 僅 writer 的 token 串流
  event: done          data: {"conversation_id": "..."}
  event: error         data: {"message": "..."}

過濾原則：
- on_chat_model_start + langgraph_node in AGENT_NODES → agent_start 事件
- on_chat_model_stream + langgraph_node == "writer"   → token 事件
- on_chat_model_end + langgraph_node in AGENT_NODES   → agent_end 事件
- run_id 用於配對 start/end，避免重複發送
"""

import json
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import desc, insert, select, update, delete

from agent import SupervisorAgent
from config import settings
from database import engine, init_db, conversations, messages
from models import (
    ChatRequest,
    ConversationDetailResponse,
    ConversationResponse,
    MessageResponse,
)

# ============================================================
# Agent 快取
# ============================================================

_agent_cache: dict[str, object] = {}

# 追蹤的 Agent 節點名稱（與 graph.add_node 的 key 一致）
AGENT_NODES = {"supervisor", "researcher", "analyst", "writer"}


# ============================================================
# FastAPI Lifespan
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    print("[Server] Multi-Agent Supervisor API 啟動完成")
    yield


# ============================================================
# FastAPI App
# ============================================================

app = FastAPI(title="Case 9: Multi-Agent Supervisor API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# 輔助函數
# ============================================================

async def get_or_create_agent(llm_config):
    """依 LLM 設定取得或建立 Agent（快取機制）"""
    cache_key = f"{llm_config.api_key[:8]}:{llm_config.model}"
    if cache_key not in _agent_cache:
        agent_instance = SupervisorAgent(llm_config)
        _agent_cache[cache_key] = await agent_instance.create_agent()
        print(f"[Agent] 新建 SupervisorAgent（model={llm_config.model}）")
    return _agent_cache[cache_key]


def _extract_summary(node: str, event_data: dict) -> str:
    """
    從 on_chat_model_end 事件提取 LLM 輸出摘要。
    - supervisor: 解析 with_structured_output 的 tool_calls，回傳「→ next_agent  reason」
    - researcher/analyst/writer: 回傳前 300 字的文字內容
    """
    output = event_data.get("output")
    if not output:
        return ""

    if node == "supervisor":
        # with_structured_output 透過 function calling 回傳 tool_calls
        tool_calls = getattr(output, "tool_calls", None)
        if tool_calls:
            tc = tool_calls[0]
            args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
            next_agent = args.get("next_agent", "")
            reason = args.get("reason", "")
            if next_agent:
                return f"→ {next_agent}  {reason}" if reason else f"→ {next_agent}"
        # Fallback: JSON mode（部分 LLM 以 JSON 字串回傳 structured output）
        if hasattr(output, "content") and isinstance(output.content, str) and output.content:
            try:
                import json as _json
                obj = _json.loads(output.content)
                next_agent = obj.get("next_agent", "")
                reason = obj.get("reason", "")
                if next_agent:
                    return f"→ {next_agent}  {reason}" if reason else f"→ {next_agent}"
            except Exception:
                pass
            return output.content[:120]
        return ""

    if hasattr(output, "content"):
        content = output.content
        if isinstance(content, str) and content:
            return content[:300]
    return ""


# ============================================================
# GET /api/health
# ============================================================

@app.get("/api/health")
async def health():
    return {"status": "ok", "agents": list(AGENT_NODES)}


# ============================================================
# POST /api/chat — SSE 串流端點
# ============================================================

@app.post("/api/chat")
async def chat(req: ChatRequest):
    """
    Multi-Agent Supervisor 聊天端點，透過 SSE 串流回傳 Agent 執行狀態。

    astream_events v2 事件處理邏輯：
    1. on_chat_model_start：Agent LLM 開始執行
       → 發送 agent_start 事件（用 run_id 避免重複）
    2. on_chat_model_stream（writer 節點）：Writer 的 token 串流
       → 發送 token 事件（逐字建立前端顯示的報告）
    3. on_chat_model_end：Agent LLM 執行完成
       → 發送 agent_end 事件（含輸出摘要）
    """
    conversation_id = req.thread_id or str(uuid.uuid4())

    if not req.thread_id:
        with engine.connect() as conn:
            conn.execute(insert(conversations).values(
                id=conversation_id,
                title=req.message[:50],
            ))
            conn.commit()

    with engine.connect() as conn:
        conn.execute(insert(messages).values(
            conversation_id=conversation_id,
            role="user",
            content=req.message,
        ))
        conn.commit()

    async def event_generator():
        full_response = ""
        # run_id set：避免同一次 LLM 呼叫的 start/end 重複發送
        reported_runs: set[str] = set()

        print(f"\n[Chat] ── 開始處理 conversation={conversation_id[:8]} ──")
        print(f"[Chat] message={req.message[:60]!r}")
        print(f"[Chat] model={req.llm_config.model}  base_url={req.llm_config.base_url}")

        try:
            agent = await get_or_create_agent(req.llm_config)
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": 50,
            }

            print(f"[Chat] astream_events 開始")

            async for event in agent.astream_events(
                {
                    "messages": [("user", req.message)],
                    "task": req.message,
                    "research_result": "",
                    "analysis_result": "",
                    "agent_steps": [],
                    "iteration": 0,
                },
                config=config,
                version="v2",
            ):
                etype = event["event"]
                run_id = event.get("run_id", "")
                node = event.get("metadata", {}).get("langgraph_node", "")
                name = event.get("name", "")

                # 印出所有非 stream 事件（token 太多，只印摘要）
                if etype != "on_chat_model_stream":
                    run_short = run_id[:8] if run_id else "-"
                    print(f"[Event] {etype:<30} node={node:<12} name={name:<30} run={run_short}")

                # ── Agent LLM 開始執行 ─────────────────────────
                if etype == "on_chat_model_start" and node in AGENT_NODES:
                    if run_id not in reported_runs:
                        reported_runs.add(run_id)
                        print(f"  → SSE agent_start: {node}")
                        yield {
                            "event": "agent_start",
                            "data": json.dumps({"agent": node}, ensure_ascii=False),
                        }

                # ── Writer token 串流 ──────────────────────────
                elif etype == "on_chat_model_stream" and node == "writer":
                    chunk = event["data"]["chunk"].content
                    if chunk:
                        full_response += chunk
                        yield {
                            "event": "token",
                            "data": json.dumps({"content": chunk}, ensure_ascii=False),
                        }

                # ── Agent LLM 執行完成 ─────────────────────────
                elif etype == "on_chat_model_end" and node in AGENT_NODES:
                    if run_id in reported_runs:
                        summary = _extract_summary(node, event["data"])

                        # Writer：從 on_chat_model_end 的 output 取得完整內容
                        # 作為 token streaming 失敗時的 fallback（ainvoke 不一定發 stream 事件）
                        writer_content = ""
                        if node == "writer":
                            output = event["data"].get("output")
                            if hasattr(output, "content") and isinstance(output.content, str):
                                writer_content = output.content
                            if writer_content:
                                full_response = writer_content  # 確保儲存到 DB
                            print(f"  → writer_content={len(writer_content)} 字")

                        print(f"  → SSE agent_end:   {node}  summary={summary[:60]!r}")
                        yield {
                            "event": "agent_end",
                            "data": json.dumps({
                                "agent": node,
                                "summary": summary,
                                "content": writer_content,  # 非空只在 writer，其他為 ""
                            }, ensure_ascii=False),
                        }
                    else:
                        print(f"  ✗ agent_end for {node} run={run_id[:8]} NOT in reported_runs (已跳過)")

            # 儲存 Writer 的最終報告
            if full_response:
                with engine.connect() as conn:
                    conn.execute(insert(messages).values(
                        conversation_id=conversation_id,
                        role="assistant",
                        content=full_response,
                    ))
                    conn.execute(
                        update(conversations)
                        .where(conversations.c.id == conversation_id)
                        .values()
                    )
                    conn.commit()

            print(f"[Chat] astream_events 結束  full_response={len(full_response)} 字")
            yield {
                "event": "done",
                "data": json.dumps({
                    "conversation_id": conversation_id,
                    "content": full_response,   # 完整 writer 輸出，作為前端 fallback
                }, ensure_ascii=False),
            }

        except Exception as e:
            import traceback
            print(f"[Chat] !! 例外發生: {e}")
            print(traceback.format_exc())
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_generator())


# ============================================================
# GET /api/conversations
# ============================================================

@app.get("/api/conversations", response_model=list[ConversationResponse])
async def list_conversations():
    with engine.connect() as conn:
        rows = conn.execute(
            select(conversations).order_by(desc(conversations.c.updated_at))
        ).fetchall()
    return [
        ConversationResponse(
            id=r.id, title=r.title,
            created_at=r.created_at, updated_at=r.updated_at,
        )
        for r in rows
    ]


# ============================================================
# GET /api/conversations/{conversation_id}
# ============================================================

@app.get("/api/conversations/{conversation_id}", response_model=ConversationDetailResponse)
async def get_conversation(conversation_id: str):
    with engine.connect() as conn:
        conv = conn.execute(
            select(conversations).where(conversations.c.id == conversation_id)
        ).fetchone()
        if not conv:
            raise HTTPException(status_code=404, detail="對話不存在")
        msg_rows = conn.execute(
            select(messages)
            .where(messages.c.conversation_id == conversation_id)
            .order_by(messages.c.created_at)
        ).fetchall()
    return ConversationDetailResponse(
        id=conv.id, title=conv.title,
        messages=[
            MessageResponse(
                id=r.id, conversation_id=r.conversation_id,
                role=r.role, content=r.content, created_at=r.created_at,
            )
            for r in msg_rows
        ],
    )


# ============================================================
# DELETE /api/conversations/{conversation_id}
# ============================================================

@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    with engine.connect() as conn:
        conn.execute(delete(messages).where(messages.c.conversation_id == conversation_id))
        conn.execute(delete(conversations).where(conversations.c.id == conversation_id))
        conn.commit()
    return {"status": "ok"}


# ============================================================
# 入口點
# ============================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host=settings.backend_host, port=8000, reload=True)
