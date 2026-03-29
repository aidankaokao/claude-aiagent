"""
FastAPI 應用 — Map-Reduce Agent API

端點：
- POST /api/chat              — 並行分析所有文件（SSE 串流）
- GET  /api/documents         — 取得所有文件列表
- GET  /api/conversations     — 對話列表
- GET  /api/conversations/{id} — 對話詳情
- DELETE /api/conversations/{id} — 刪除對話

SSE 事件種類（Map-Reduce 專用）：
  documents_loaded → 文件列表載入完成，前端初始化進度面板
                     {"documents": [{id, title, category}, ...]}
  doc_start        → 單份文件開始分析（並行，可能交錯出現）
                     {"doc_id": "...", "title": "..."}
  doc_done         → 單份文件分析完成
                     {"doc_id": "...", "summary": "...", "sentiment": "positive"}
  reduce_start     → 所有文件分析完畢，開始整合報告
  token            → reduce_node 整合時的逐字輸出
  done             → 串流結束
  error            → 發生錯誤
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
log = logging.getLogger("case5")

from database import engine, init_db, documents, conversations, messages
from models import ChatRequest, ConversationResponse, ConversationDetailResponse, MessageResponse
from agent import get_or_create_agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    print("[Server] Map-Reduce Agent API 啟動完成")
    yield


app = FastAPI(title="Case 5: Map-Reduce Agent API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_all_documents() -> list[dict]:
    """從 DB 載入所有文件"""
    with engine.connect() as conn:
        rows = conn.execute(select(documents).order_by(documents.c.id)).fetchall()
    return [
        {"id": r.id, "title": r.title, "content": r.content, "category": r.category}
        for r in rows
    ]


# ============================================================
# POST /api/chat — 並行文件分析端點（SSE 串流）
# ============================================================
@app.post("/api/chat")
async def chat(req: ChatRequest):
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
        full_report = ""

        log.info("=" * 60)
        log.info(f"[CHAT] 收到請求 conversation_id={conversation_id}")
        log.info(f"[CHAT] 查詢：{req.message[:80]}")

        try:
            # 載入所有文件（在啟動 agent 前完成，方便立即發送 documents_loaded 事件）
            docs = load_all_documents()
            log.info(f"[CHAT] 載入 {len(docs)} 份文件")

            if not docs:
                yield {
                    "event": "error",
                    "data": json.dumps({"message": "資料庫中沒有文件，請先執行 seed_data.py"}, ensure_ascii=False),
                }
                return

            # 立即通知前端將要分析哪些文件（前端可初始化進度面板）
            yield {
                "event": "documents_loaded",
                "data": json.dumps({
                    "documents": [
                        {"id": d["id"], "title": d["title"], "category": d["category"]}
                        for d in docs
                    ]
                }, ensure_ascii=False),
            }

            agent = await get_or_create_agent(req.llm_config)
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": 100,
            }

            async for event in agent.astream_events(
                {
                    "query": req.message,
                    "documents": docs,
                    "analyses": [],
                    "report": "",
                    "messages": [],
                },
                config=config,
                version="v2",
            ):
                etype = event["event"]
                node_name = event.get("name", "")

                if etype in ("on_chain_start", "on_chain_end", "on_tool_start", "on_tool_end"):
                    log.debug(f"[EVENT] {etype:25s} | node={node_name}")

                # ── analyze_node 開始：通知前端該份文件開始分析 ──
                if etype == "on_chain_start" and node_name == "analyze_node":
                    input_data = event["data"].get("input", {})
                    doc = input_data.get("document", {})
                    doc_id = doc.get("id", "")
                    title = doc.get("title", "")
                    log.info(f"[ANALYZE] ▶ 開始分析：{doc_id} — {title}")
                    yield {
                        "event": "doc_start",
                        "data": json.dumps({"doc_id": doc_id, "title": title}, ensure_ascii=False),
                    }

                # ── analyze_node 完成：通知前端該份文件分析結果 ──
                elif etype == "on_chain_end" and node_name == "analyze_node":
                    output = event["data"].get("output", {})
                    analyses_list = output.get("analyses", []) if isinstance(output, dict) else []
                    if analyses_list:
                        a = analyses_list[0]
                        log.info(f"[ANALYZE] ■ 完成：{a.get('doc_id')} — {a.get('sentiment')} "
                                 f"| 摘要前60字：{a.get('summary','')[:60]}")
                        yield {
                            "event": "doc_done",
                            "data": json.dumps({
                                "doc_id": a.get("doc_id", ""),
                                "summary": a.get("summary", "")[:250],
                                "sentiment": a.get("sentiment", "neutral"),
                                "error": a.get("error", False),
                            }, ensure_ascii=False),
                        }

                # ── reduce_node 開始：通知前端進入整合階段 ──
                elif etype == "on_chain_start" and node_name == "reduce_node":
                    log.info("[REDUCE] ▶ 開始整合所有分析結果")
                    yield {
                        "event": "reduce_start",
                        "data": json.dumps({}, ensure_ascii=False),
                    }

                # ── reduce_node 完成 ──
                elif etype == "on_chain_end" and node_name == "reduce_node":
                    output = event["data"].get("output", {})
                    report_len = len(output.get("report", "")) if isinstance(output, dict) else 0
                    log.info(f"[REDUCE] ■ 完成，報告長度={report_len}")

                # ── LLM token 串流：只在 reduce_node 整合時輸出 ──
                elif etype == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node == "reduce_node":
                        chunk = event["data"]["chunk"].content
                        if chunk:
                            full_report += chunk
                            yield {
                                "event": "token",
                                "data": json.dumps({"content": chunk}, ensure_ascii=False),
                            }

            log.info(f"[CHAT] 串流結束，full_report 長度={len(full_report)}")

            with engine.connect() as conn:
                conn.execute(insert(messages).values(
                    conversation_id=conversation_id,
                    role="assistant",
                    content=full_report,
                ))
                conn.commit()

            yield {
                "event": "done",
                "data": json.dumps({
                    "conversation_id": conversation_id,
                    "doc_count": len(docs),
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
# GET /api/documents — 文件列表
# ============================================================
@app.get("/api/documents")
async def list_documents():
    with engine.connect() as conn:
        rows = conn.execute(
            select(documents.c.id, documents.c.title, documents.c.category)
            .order_by(documents.c.id)
        ).fetchall()
    return [{"id": r.id, "title": r.title, "category": r.category} for r in rows]


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
                created_at=str(r.created_at),
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
