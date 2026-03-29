"""
FastAPI 應用 — ReAct Agent API

與 Case 1 的差異：
- SSE 新增兩種事件：tool_start（工具開始執行）、tool_end（工具執行完成）
- 工具呼叫記錄存入 tool_calls 表
"""

import json
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select, insert, update, delete, desc

from config import settings
from database import engine, init_db, conversations, messages, tool_calls
from models import ChatRequest, ConversationResponse, ConversationDetailResponse, MessageResponse
from agent import get_or_create_agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    print("[Server] ReAct Agent API 啟動完成")
    yield


app = FastAPI(title="Case 2: ReAct Agent API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# POST /api/chat — ReAct 聊天端點（SSE 串流）
# ============================================================
@app.post("/api/chat")
async def chat(req: ChatRequest):
    """
    SSE 事件（相較 Case 1 新增 tool_start / tool_end）：

    event: token      data: {"content": "部分文字"}
    event: tool_start data: {"run_id": "...", "tool_name": "web_search", "tool_input": {...}}
    event: tool_end   data: {"run_id": "...", "tool_name": "web_search", "tool_output": "..."}
    event: done       data: {"conversation_id": "..."}
    event: error      data: {"message": "..."}
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
        try:
            agent = await get_or_create_agent(req.llm_config)
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": 1000,
            }

            async for event in agent.astream_events(
                {"messages": [("user", req.message)]},
                config=config,
                version="v2",
            ):
                etype = event["event"]

                # --- LLM 逐字輸出 ---
                if etype == "on_chat_model_stream":
                    chunk = event["data"]["chunk"].content
                    if chunk:
                        full_response += chunk
                        yield {
                            "event": "token",
                            "data": json.dumps({"content": chunk}, ensure_ascii=False),
                        }

                # --- 工具開始執行 ---
                elif etype == "on_tool_start":
                    run_id = event.get("run_id", "")
                    tool_name = event.get("name", "")
                    tool_input = event["data"].get("input", {})

                    # 存入資料庫（output 稍後更新）
                    with engine.connect() as conn:
                        conn.execute(insert(tool_calls).values(
                            conversation_id=conversation_id,
                            run_id=run_id,
                            tool_name=tool_name,
                            tool_input=json.dumps(tool_input, ensure_ascii=False),
                        ))
                        conn.commit()

                    yield {
                        "event": "tool_start",
                        "data": json.dumps({
                            "run_id": run_id,
                            "tool_name": tool_name,
                            "tool_input": tool_input,
                        }, ensure_ascii=False),
                    }

                # --- 工具執行完成 ---
                elif etype == "on_tool_end":
                    run_id = event.get("run_id", "")
                    tool_name = event.get("name", "")
                    raw_output = event["data"].get("output", "")
                    # output 可能是 ToolMessage 物件，取其 content
                    tool_output = raw_output.content if hasattr(raw_output, "content") else str(raw_output)

                    # 更新資料庫的 tool_output
                    with engine.connect() as conn:
                        conn.execute(
                            tool_calls.update()
                            .where(tool_calls.c.run_id == run_id)
                            .values(tool_output=tool_output)
                        )
                        conn.commit()

                    yield {
                        "event": "tool_end",
                        "data": json.dumps({
                            "run_id": run_id,
                            "tool_name": tool_name,
                            "tool_output": tool_output,
                        }, ensure_ascii=False),
                    }

            # 串流結束，存入 AI 完整回覆
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

            yield {
                "event": "done",
                "data": json.dumps({"conversation_id": conversation_id}, ensure_ascii=False),
            }

        except Exception as e:
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
        ConversationResponse(id=r.id, title=r.title, created_at=r.created_at, updated_at=r.updated_at)
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
            MessageResponse(id=r.id, conversation_id=r.conversation_id,
                            role=r.role, content=r.content, created_at=r.created_at)
            for r in msg_rows
        ],
    )


# ============================================================
# DELETE /api/conversations/{conversation_id}
# ============================================================
@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    with engine.connect() as conn:
        conn.execute(delete(tool_calls).where(tool_calls.c.conversation_id == conversation_id))
        conn.execute(delete(messages).where(messages.c.conversation_id == conversation_id))
        conn.execute(delete(conversations).where(conversations.c.id == conversation_id))
        conn.commit()
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host=settings.backend_host, port=8000, reload=True)
