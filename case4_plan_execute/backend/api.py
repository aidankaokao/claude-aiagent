"""
FastAPI 應用 — Plan-Execute Agent API

端點：
- POST /api/chat          — 旅行規劃聊天（SSE 串流，含計劃步驟事件）
- GET  /api/conversations — 對話列表
- GET  /api/conversations/{id} — 對話詳情
- DELETE /api/conversations/{id} — 刪除對話

SSE 事件種類（新增 Plan-Execute 專用事件）：
  plan_created  → 計劃生成完成 {"steps": ["步驟1", "步驟2", ...]}
  step_start    → 步驟開始執行 {"step_index": 0, "step_text": "搜尋景點"}
  step_done     → 步驟完成     {"step_index": 0, "result": "找到 7 個景點..."}
  tool_start    → 工具開始執行（同 Case 2/3）
  tool_end      → 工具執行完成（同 Case 2/3）
  token         → LLM 最終整合時的逐字輸出
  done          → 串流結束
  error         → 發生錯誤
"""

import json
import uuid
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select, insert, delete, desc

from config import settings

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("case4")
from database import engine, init_db, conversations, messages
from models import ChatRequest, ConversationResponse, ConversationDetailResponse, MessageResponse
from agent import get_or_create_agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    """伺服器啟動時初始化資料庫"""
    init_db()
    print("[Server] Plan-Execute Agent API 啟動完成")
    yield


app = FastAPI(title="Case 4: Plan-Execute Agent API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# POST /api/chat — 旅行規劃聊天端點（SSE 串流）
# ============================================================
@app.post("/api/chat")
async def chat(req: ChatRequest):
    """
    Plan-Execute 專用 SSE 事件說明：

    plan_created：planner_node 完成後觸發，帶完整步驟清單
      → 前端 PlanTimeline 初始化步驟列表（全部顯示為 pending）

    step_start：executor_node 開始執行某步驟時觸發
      → 前端更新對應步驟狀態為 running（顯示動畫）

    step_done：executor_node 完成某步驟時觸發
      → 前端更新對應步驟狀態為 done（顯示結果摘要）

    token：replanner_node 進行最終整合時的逐字輸出
      → 前端在 chat 訊息區域逐字顯示最終旅行計劃
    """
    conversation_id = req.conversation_id or str(uuid.uuid4())

    if not req.conversation_id:
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
        local_plan: list[str] = []
        local_step_index = 0
        step_results: dict[int, str] = {}

        log.info("=" * 60)
        log.info(f"[CHAT] 收到請求 conversation_id={conversation_id}")
        log.info(f"[CHAT] 訊息：{req.message[:80]}")

        try:
            agent = await get_or_create_agent(req.llm_config)
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": 50,
            }

            async for event in agent.astream_events(
                {
                    "user_request": req.message,
                    "plan": [],
                    "past_steps": [],
                    "response": "",
                    "messages": [],
                    "replan_count": 0,
                },
                config=config,
                version="v2",
            ):
                etype = event["event"]
                node_name = event.get("name", "")

                # ── 印出所有 chain/tool 層級事件（排除 token stream 避免過多輸出） ──
                if etype in ("on_chain_start", "on_chain_end", "on_tool_start", "on_tool_end"):
                    log.debug(f"[EVENT] {etype:25s} | node={node_name}")

                # ── planner_node 完成：取得計劃步驟清單 ──
                if etype == "on_chain_end" and node_name == "planner_node":
                    output = event["data"].get("output", {})
                    local_plan = output.get("plan", [])
                    log.info(f"[PLANNER] 計劃生成完成，共 {len(local_plan)} 步：")
                    for i, s in enumerate(local_plan):
                        log.info(f"  步驟{i+1}：{s}")
                    if local_plan:
                        local_step_index = 0
                        yield {
                            "event": "plan_created",
                            "data": json.dumps({"steps": local_plan}, ensure_ascii=False),
                        }

                # ── executor_node 開始：通知前端哪個步驟開始執行 ──
                elif etype == "on_chain_start" and node_name == "executor_node":
                    log.info(f"[EXECUTOR] ▶ 開始執行步驟 {local_step_index} "
                             f"（local_plan 長度={len(local_plan)}）")
                    if local_plan and local_step_index < len(local_plan):
                        log.info(f"[EXECUTOR]   步驟內容：{local_plan[local_step_index]}")
                        yield {
                            "event": "step_start",
                            "data": json.dumps({
                                "step_index": local_step_index,
                                "step_text": local_plan[local_step_index],
                            }, ensure_ascii=False),
                        }

                # ── executor_node 完成：若有新步驟結果，通知前端 ──
                elif etype == "on_chain_end" and node_name == "executor_node":
                    output = event["data"].get("output", {})
                    output_keys = list(output.keys()) if isinstance(output, dict) else str(type(output))
                    log.info(f"[EXECUTOR] ■ 步驟 {local_step_index} 結束，output keys={output_keys}")

                    new_steps = output.get("past_steps", []) if isinstance(output, dict) else []
                    log.info(f"[EXECUTOR]   past_steps in output: {len(new_steps)} 筆")

                    if new_steps:
                        result_text = new_steps[-1].get("result", "")
                        log.info(f"[EXECUTOR]   結果摘要（前100字）：{result_text[:100]}")
                        step_results[local_step_index] = result_text
                        yield {
                            "event": "step_done",
                            "data": json.dumps({
                                "step_index": local_step_index,
                                "result": result_text[:300],
                            }, ensure_ascii=False),
                        }
                        local_step_index += 1
                        log.info(f"[EXECUTOR]   → local_step_index 更新為 {local_step_index}")
                    else:
                        log.warning(f"[EXECUTOR]   ⚠ output 中沒有 past_steps，步驟未完成！"
                                    f" output={output}")

                # ── 工具開始執行 ──
                elif etype == "on_tool_start":
                    tool_name = event.get("name", "")
                    tool_input = event["data"].get("input", {})
                    log.info(f"[TOOL] ▶ {tool_name}  input={json.dumps(tool_input, ensure_ascii=False)[:120]}")
                    yield {
                        "event": "tool_start",
                        "data": json.dumps({
                            "run_id": event.get("run_id", ""),
                            "tool_name": tool_name,
                            "tool_input": tool_input,
                        }, ensure_ascii=False),
                    }

                # ── 工具執行完成 ──
                elif etype == "on_tool_end":
                    raw_output = event["data"].get("output", "")
                    tool_output = raw_output.content if hasattr(raw_output, "content") else str(raw_output)
                    log.info(f"[TOOL] ■ {event.get('name','')}  output（前80字）={tool_output[:80]}")
                    yield {
                        "event": "tool_end",
                        "data": json.dumps({
                            "run_id": event.get("run_id", ""),
                            "tool_name": event.get("name", ""),
                            "tool_output": tool_output,
                        }, ensure_ascii=False),
                    }

                # ── replanner_node 完成 ──
                elif etype == "on_chain_end" and node_name == "replanner_node":
                    output = event["data"].get("output", {})
                    has_response = bool(output.get("response", "")) if isinstance(output, dict) else False
                    replan_count = output.get("replan_count", "N/A") if isinstance(output, dict) else "N/A"
                    log.info(f"[REPLANNER] 評估完成  has_response={has_response}  "
                             f"replan_count={replan_count}")

                # ── LLM token 串流：只在 replanner_node（最終整合）時輸出 ──
                elif etype == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node == "replanner_node":
                        chunk = event["data"]["chunk"].content
                        if chunk:
                            full_response += chunk
                            yield {
                                "event": "token",
                                "data": json.dumps({"content": chunk}, ensure_ascii=False),
                            }

            log.info(f"[CHAT] 串流結束，full_response 長度={len(full_response)}")

            with engine.connect() as conn:
                conn.execute(insert(messages).values(
                    conversation_id=conversation_id,
                    role="assistant",
                    content=full_response,
                    plan_json=json.dumps(local_plan, ensure_ascii=False),
                ))
                conn.commit()

            yield {
                "event": "done",
                "data": json.dumps({
                    "conversation_id": conversation_id,
                    "plan": local_plan,
                }, ensure_ascii=False),
            }

        except Exception as e:
            log.exception(f"[ERROR] 發生例外：{e}")
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
            created_at=str(r.created_at), updated_at=str(r.updated_at),
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
        id=conv.id,
        title=conv.title,
        messages=[
            MessageResponse(
                id=r.id, conversation_id=r.conversation_id,
                role=r.role, content=r.content,
                plan_json=r.plan_json, created_at=str(r.created_at),
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host=settings.backend_host, port=8000, reload=True)
