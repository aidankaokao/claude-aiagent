"""
FastAPI 應用 — Text-to-SQL API（Case 11）

SSE 事件設計：
  event: sql_query  data: {"sql": "SELECT...", "query_type": "realtime|historical", "attempt": N}
  event: token      data: {"content": "..."}  ← format_node 串流
  event: done       data: {"conversation_id": "...", "content": "..."}
  event: error      data: {"message": "..."}

astream_events v2 過濾邏輯：
  on_chain_end  + name=="generate" → 提取 sql_query → 發出 sql_query 事件
  on_chat_model_stream + node=="format" → 發出 token 事件
"""

import json
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import desc, insert, select, update, delete, text

from agent import Text2SQLAgent
from config import settings
from database import engine, init_db
from models import (
    ChatRequest,
    ConversationDetailResponse,
    ConversationResponse,
    MessageResponse,
)

# ── 對話記錄用 SQLAlchemy 表（SQLite-free，直接用 PostgreSQL 同一 DB）────
from sqlalchemy import MetaData, Table, Column, Integer, String, DateTime, Text, func

_conv_meta = MetaData(schema=settings.db_schema)

conversations = Table(
    "conversations", _conv_meta,
    Column("id",         String(36),  primary_key=True),
    Column("title",      String(200), nullable=True),
    Column("created_at", DateTime,    server_default=func.now()),
    Column("updated_at", DateTime,    server_default=func.now(), onupdate=func.now()),
)

messages_table = Table(
    "messages", _conv_meta,
    Column("id",              Integer,     primary_key=True, autoincrement=True),
    Column("conversation_id", String(36),  nullable=False),
    Column("role",            String(20),  nullable=False),
    Column("content",         Text,        nullable=False),
    Column("created_at",      DateTime,    server_default=func.now()),
)


# ── Agent 快取 ─────────────────────────────────────────────────
_agent_cache: dict[str, object] = {}


# ── FastAPI Lifespan ───────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # 建立對話記錄表
    _conv_meta.create_all(engine)
    print("[Server] Text-to-SQL API 啟動完成")
    yield


app = FastAPI(title="Case 11: Text-to-SQL API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 輔助函數 ───────────────────────────────────────────────────

async def get_or_create_agent(llm_config):
    cache_key = f"{llm_config.api_key[:8]}:{llm_config.model}"
    if cache_key not in _agent_cache:
        agent_instance = Text2SQLAgent(llm_config)
        _agent_cache[cache_key] = await agent_instance.create_agent()
        print(f"[Agent] 新建 Text2SQLAgent（model={llm_config.model}）")
    return _agent_cache[cache_key]


# ── GET /api/health ────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "db": "postgresql"}


# ── POST /api/chat ─────────────────────────────────────────────

@app.post("/api/chat")
async def chat(req: ChatRequest):
    """
    Text-to-SQL 聊天端點（SSE 串流）

    Pipeline:
    1. classify_node  → 決定 query_type
    2. sql_generate   → 生成 SQL → 發出 sql_query SSE 事件
    3. sql_validate   → 驗證 SQL
    4. sql_execute    → 執行 SQL（失敗則重試）
    5. format_node    → 格式化回答 → 發出 token SSE 事件
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
        conn.execute(insert(messages_table).values(
            conversation_id=conversation_id,
            role="user",
            content=req.message,
        ))
        conn.commit()

    from sse_starlette.sse import EventSourceResponse

    async def event_generator():
        full_response = ""
        sql_attempt = 0

        print(f"\n[Chat] conversation={conversation_id[:8]}  q={req.message[:60]!r}")

        try:
            agent = await get_or_create_agent(req.llm_config)
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": 20,
            }

            async for event in agent.astream_events(
                {
                    "messages":    [("user", req.message)],
                    "question":    req.message,
                    "query_type":  "",
                    "schema_context": "",
                    "sql_query":   "",
                    "sql_error":   "",
                    "sql_result":  "",
                    "retry_count": 0,
                    "final_answer": "",
                },
                config=config,
                version="v2",
            ):
                etype = event["event"]
                name  = event.get("name", "")
                node  = event.get("metadata", {}).get("langgraph_node", "")

                if etype != "on_chat_model_stream":
                    print(f"[Event] {etype:<30} node={node:<12} name={name}")

                # ── 1. SQL 生成完成 → sql_query 事件 ──────────
                if etype == "on_chain_end" and name == "generate":
                    output = event["data"].get("output", {})
                    if isinstance(output, dict):
                        sql = output.get("sql_query", "")
                        qt  = output.get("query_type", "")
                        if not qt:
                            # query_type 由 classify 設定，從狀態讀取
                            qt = ""
                    else:
                        sql = ""
                        qt  = ""

                    if sql:
                        sql_attempt += 1
                        print(f"  → SSE sql_query attempt={sql_attempt}")
                        yield {
                            "event": "sql_query",
                            "data": json.dumps({
                                "sql":        sql,
                                "query_type": qt,
                                "attempt":    sql_attempt,
                            }, ensure_ascii=False),
                        }

                # ── 2. classify 完成 → 記錄 query_type ────────
                elif etype == "on_chain_end" and name == "classify":
                    output = event["data"].get("output", {})
                    if isinstance(output, dict):
                        qt = output.get("query_type", "")
                        if qt:
                            # 下次 sql_query 事件補充 query_type
                            # 用一個閉包變數暫存（已在 sql_generate on_chain_end 讀取）
                            pass

                # ── 3. format_node token 串流 ──────────────────
                elif etype == "on_chat_model_stream" and node == "format":
                    chunk = event["data"]["chunk"].content
                    if isinstance(chunk, str) and chunk:
                        full_response += chunk
                        yield {
                            "event": "token",
                            "data": json.dumps({"content": chunk}, ensure_ascii=False),
                        }

                # ── 4. format_node 完成 → content fallback ─────
                elif etype == "on_chain_end" and name == "format":
                    output = event["data"].get("output", {})
                    if isinstance(output, dict):
                        answer = output.get("final_answer", "")
                        if answer and not full_response:
                            full_response = answer

            # 儲存回應
            if full_response:
                with engine.connect() as conn:
                    conn.execute(insert(messages_table).values(
                        conversation_id=conversation_id,
                        role="assistant",
                        content=full_response,
                    ))
                    conn.execute(
                        update(conversations)
                        .where(conversations.c.id == conversation_id)
                        .values(updated_at=func.now())
                    )
                    conn.commit()

            print(f"[Chat] 完成  response={len(full_response)} 字")
            yield {
                "event": "done",
                "data": json.dumps({
                    "conversation_id": conversation_id,
                    "content":         full_response,
                }, ensure_ascii=False),
            }

        except Exception as e:
            import traceback
            print(f"[Chat] !! 例外: {e}")
            print(traceback.format_exc())
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    from sse_starlette.sse import EventSourceResponse
    return EventSourceResponse(event_generator())


# ── GET /api/conversations ─────────────────────────────────────

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


# ── GET /api/conversations/{id} ────────────────────────────────

@app.get("/api/conversations/{conversation_id}", response_model=ConversationDetailResponse)
async def get_conversation(conversation_id: str):
    with engine.connect() as conn:
        conv = conn.execute(
            select(conversations).where(conversations.c.id == conversation_id)
        ).fetchone()
        if not conv:
            raise HTTPException(status_code=404, detail="對話不存在")
        msg_rows = conn.execute(
            select(messages_table)
            .where(messages_table.c.conversation_id == conversation_id)
            .order_by(messages_table.c.created_at)
        ).fetchall()
    return ConversationDetailResponse(
        id=conv.id, title=conv.title,
        messages=[
            MessageResponse(
                id=r.id, conversation_id=r.conversation_id,
                role=r.role, content=r.content, created_at=str(r.created_at),
            )
            for r in msg_rows
        ],
    )


# ── DELETE /api/conversations/{id} ────────────────────────────

@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str):
    with engine.connect() as conn:
        conn.execute(delete(messages_table).where(messages_table.c.conversation_id == conversation_id))
        conn.execute(delete(conversations).where(conversations.c.id == conversation_id))
        conn.commit()
    return {"status": "ok"}


# ── 入口點 ─────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host=settings.backend_host, port=8000, reload=True)
