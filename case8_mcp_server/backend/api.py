"""
FastAPI 應用 — KB Agent API（Case 8）

架構特點：
- FastAPI lifespan 管理 MCP Client 的連線生命週期（啟動時建立連線，關閉時釋放資源）
- MultiServerMCPClient 以 stdio transport 啟動 mcp_server/server.py 子程序
- Agent 依 llm_config 快取，共用同一個已連線的 MCP Client
- /api/articles 端點直接讀取 kb.db，不透過 MCP（提供給前端側邊欄使用）

SSE 事件（與 Case 2 相同）：
  event: token      data: {"content": "部分文字"}
  event: tool_start data: {"run_id": "...", "tool_name": "...", "tool_input": {...}}
  event: tool_end   data: {"run_id": "...", "tool_name": "...", "tool_output": "..."}
  event: done       data: {"conversation_id": "..."}
  event: error      data: {"message": "..."}
"""

import json
import os
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from langchain_mcp_adapters.client import MultiServerMCPClient
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import MetaData, Table, create_engine, desc, insert, select, update, delete

from agent import KBAgent
from config import settings
from database import engine, init_db, conversations, messages
from models import (
    ArticleResponse,
    ChatRequest,
    ConversationDetailResponse,
    ConversationResponse,
    MessageResponse,
)

# ============================================================
# MCP Client 與 Agent 快取（應用程式層級的全域變數）
# ============================================================

# langchain-mcp-adapters 0.1.0+ 不再支援 context manager，
# 改為直接實例化後呼叫 await client.get_tools()。
# 在 lifespan 啟動時一次性取得工具清單並快取，後續 Agent 建立時直接使用。
_mcp_tools: list = []

# Agent 快取：key = "api_key前8碼:model名稱"，value = 已編譯的 Agent
_agent_cache: dict[str, object] = {}


# ============================================================
# 知識庫資料庫（直接讀取用於 /api/articles 端點）
# ============================================================

# 確保 kb.db 目錄存在
os.makedirs(
    os.path.dirname(settings.kb_db_path) if os.path.dirname(settings.kb_db_path) else ".",
    exist_ok=True,
)

kb_engine = create_engine(
    f"sqlite:///{settings.kb_db_path}",
    connect_args={"check_same_thread": False},
    echo=False,
)
kb_meta = MetaData()


def _get_articles_table():
    """
    反射知識庫的 articles 資料表。
    使用 extend_existing=True 避免重複定義的錯誤。
    """
    return Table("articles", kb_meta, autoload_with=kb_engine, extend_existing=True)


# ============================================================
# FastAPI Lifespan — MCP Client 連線管理
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI 應用程式生命週期管理。

    langchain-mcp-adapters 0.1.0+ 的用法變更：
    - 舊版（<0.1.0）：async with MultiServerMCPClient(...) as client
    - 新版（>=0.1.0）：client = MultiServerMCPClient(...); tools = await client.get_tools()

    工具在啟動時取得一次並快取於 _mcp_tools，後續 Agent 建立直接使用快取。
    """
    global _mcp_tools

    client = MultiServerMCPClient(
        {
            # --- 本機 stdio server（目前使用）---
            # command + args：由 Client 負責 spawn 子程序
            # transport: stdio 透過 stdin/stdout 以 JSON-RPC 溝通
            "kb": {
                "command": "python",
                "args": [settings.mcp_server_path],
                "transport": "stdio",
            },

            # --- 若改用 streamable-http（遠端 server）---
            # server 需獨立部署並執行（不由 Client spawn）
            # 只需提供 URL，Client 透過 HTTP 與 server 溝通
            # "kb": {
            #     "url": "http://localhost:8001/mcp",   # server 的端點
            #     "transport": "streamable_http",
            #     # 若 server 需要認證，加上 headers：
            #     # "headers": {"Authorization": "Bearer <token>"},
            # },

            # --- 若同時串接另一個本機 stdio server（例如 server2.py）---
            # key 名稱不同即可並存，Client 會同時 spawn 兩個子程序
            # "kb2": {
            #     "command": "python",
            #     "args": [str(Path(settings.mcp_server_path).parent / "server2.py")],
            #     "transport": "stdio",
            # },

            # --- 若同時串接多個遠端 server ---
            # 所有 server 的工具會合併成一個 list，Agent 無感知
            # "another_server": {
            #     "url": "https://api.example.com/mcp",
            #     "transport": "streamable_http",
            # },
        }
    )
    # get_tools() 在 0.1.0+ 為 async，會啟動 MCP 子程序並取得工具清單
    _mcp_tools = await client.get_tools()
    init_db()
    print(f"[Server] KB Agent API 啟動完成（MCP 工具數：{len(_mcp_tools)}）")
    yield


# ============================================================
# FastAPI App
# ============================================================

app = FastAPI(title="Case 8: KB Agent API", lifespan=lifespan)

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
    """
    依 LLM 設定取得或建立 Agent（快取機制）。
    工具直接使用 lifespan 階段已取得的 _mcp_tools。
    """
    cache_key = f"{llm_config.api_key[:8]}:{llm_config.model}"
    if cache_key not in _agent_cache:
        _agent_cache[cache_key] = KBAgent(llm_config, _mcp_tools).create_agent()
        print(f"[Agent] 新建 KBAgent（model={llm_config.model}，工具數={len(_mcp_tools)}）")
    return _agent_cache[cache_key]


# ============================================================
# GET /api/health
# ============================================================

@app.get("/api/health")
async def health():
    """健康檢查端點"""
    return {"status": "ok", "mcp_tools_loaded": len(_mcp_tools)}


# ============================================================
# POST /api/chat — SSE 串流端點
# ============================================================

@app.post("/api/chat")
async def chat(req: ChatRequest):
    """
    知識庫 Agent 聊天端點，透過 SSE 串流回傳 LLM 輸出與工具呼叫事件。
    """
    conversation_id = req.thread_id or str(uuid.uuid4())

    # 新對話時建立對話記錄
    if not req.thread_id:
        with engine.connect() as conn:
            conn.execute(insert(conversations).values(
                id=conversation_id,
                title=req.message[:50],
            ))
            conn.commit()

    # 記錄使用者訊息
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

                # --- MCP 工具開始執行 ---
                elif etype == "on_tool_start":
                    run_id = event.get("run_id", "")
                    tool_name = event.get("name", "")
                    tool_input = event["data"].get("input", {})

                    yield {
                        "event": "tool_start",
                        "data": json.dumps({
                            "run_id": run_id,
                            "tool_name": tool_name,
                            "tool_input": tool_input,
                        }, ensure_ascii=False, default=str),
                    }

                # --- MCP 工具執行完成 ---
                elif etype == "on_tool_end":
                    run_id = event.get("run_id", "")
                    tool_name = event.get("name", "")
                    raw_output = event["data"].get("output", "")
                    # MCP 工具的 output 是 ToolMessage，content 可能是
                    # str 或 list[TextContent/ToolRuntime] 等 MCP 物件
                    if hasattr(raw_output, "content"):
                        content = raw_output.content
                        if isinstance(content, str):
                            tool_output = content
                        elif isinstance(content, list):
                            tool_output = "\n".join(
                                item.text if hasattr(item, "text") else str(item)
                                for item in content
                            )
                        else:
                            tool_output = str(content)
                    else:
                        tool_output = str(raw_output)

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
# GET /api/articles — 知識庫文章清單（側邊欄用）
# ============================================================

@app.get("/api/articles", response_model=list[ArticleResponse])
async def list_articles():
    """
    直接讀取 kb.db，回傳所有文章（content 截斷至 200 字）。
    此端點供前端知識庫側邊欄使用，不透過 MCP，以獲得更好的效能。
    """
    articles_table = _get_articles_table()
    with kb_engine.connect() as conn:
        rows = conn.execute(
            select(
                articles_table.c.id,
                articles_table.c.title,
                articles_table.c.tags,
                articles_table.c.created_at,
            ).order_by(desc(articles_table.c.created_at))
        ).fetchall()

        # 分別取得截斷的 content（SQLite substr）
        content_rows = conn.execute(
            select(
                articles_table.c.id,
                articles_table.c.content,
            )
        ).fetchall()
        content_map = {r.id: r.content[:200] for r in content_rows}

    result = []
    for r in rows:
        result.append(ArticleResponse(
            id=r.id,
            title=r.title,
            content=content_map.get(r.id, ""),
            tags=r.tags or "",
            created_at=str(r.created_at),
        ))
    return result


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
