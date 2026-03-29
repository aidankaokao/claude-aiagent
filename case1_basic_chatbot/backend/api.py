"""
FastAPI 應用 — 聊天 API 與 SSE 串流端點

API 端點：
- POST /api/chat              — 發送訊息（SSE 串流），需帶 llm_config
- GET  /api/conversations     — 對話列表
- GET  /api/conversations/{id} — 對話詳情
- DELETE /api/conversations/{id} — 刪除對話
"""

import json
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select, insert, update, delete, desc

from config import settings
from database import engine, init_db, conversations, messages
from models import ChatRequest, ConversationResponse, ConversationDetailResponse, MessageResponse
from agent import get_or_create_agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    print("[Server] 啟動完成，等待請求（LLM 設定由前端填入）")
    yield
    print("[Server] 關閉")


app = FastAPI(title="Case 1: Basic Chatbot API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# POST /api/chat — 聊天端點（SSE 串流）
# ============================================================
@app.post("/api/chat")
async def chat(req: ChatRequest):
    """
    接收使用者訊息與 LLM 設定，透過 SSE 串流回傳 AI 回覆

    SSE 事件：
    - event: token  data: {"content": "..."}
    - event: done   data: {"conversation_id": "..."}
    - event: error  data: {"message": "..."}
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
            # 依請求中的 LLM 設定取得（或建立）Agent
            agent = await get_or_create_agent(req.llm_config)

            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": 1000,  # 預設 25，調高避免多節點 agent 中途中斷
            }

            async for event in agent.astream_events(
                {"messages": [("user", req.message)]},
                config=config,
                version="v2",
            ):
                if event["event"] == "on_chat_model_stream":
                    chunk_content = event["data"]["chunk"].content
                    if chunk_content:
                        full_response += chunk_content
                        yield {
                            "event": "token",
                            "data": json.dumps({"content": chunk_content}, ensure_ascii=False),
                        }

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
            from fastapi import HTTPException
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
        conn.execute(delete(messages).where(messages.c.conversation_id == conversation_id))
        conn.execute(delete(conversations).where(conversations.c.id == conversation_id))
        conn.commit()
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host=settings.backend_host, port=8000, reload=True)
