"""
FastAPI 應用 — Case 6: Human-in-the-Loop

端點：
  POST /api/chat                           — SSE：初始訂單處理（含 interrupt 偵測）
  POST /api/orders/{thread_id}/decide      — SSE：攜帶審批決定恢復圖執行
  GET  /api/orders/pending                 — 取得所有待審批訂單
  GET  /api/products                       — 取得商品目錄
  GET  /api/conversations                  — 對話列表
  GET  /api/conversations/{id}             — 對話詳情
  DELETE /api/conversations/{id}           — 刪除對話

SSE 事件種類：
  token            → respond_node 逐字輸出
  approval_required → 訂單超過門檻，圖已暫停，等待人工審批
                      {"thread_id", "parsed_items", "price_details", "threshold"}
  order_created    → 訂單已建立 {"order_id", "total"}
  done             → 串流結束
  error            → 發生錯誤

【關鍵：如何偵測 interrupt】

  astream_events 在圖 interrupt 後串流會自然結束（無特殊事件）。
  判斷方式：串流結束後呼叫 await agent.aget_state(config)，
  若 snapshot.next 不為空，代表圖正在等待 interrupt 恢復。

  snapshot = await agent.aget_state(config)
  if snapshot.next:   # 有待執行節點 = 圖被暫停
      # 儲存待審批資訊到 DB，通知前端
"""

import json
import uuid
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select, insert, delete, desc
from langgraph.types import Command

from config import settings

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("case6")

from database import (
    engine, init_db,
    products as products_table,
    conversations, messages,
    save_pending_approval, update_approval_status, get_pending_approvals,
)
from models import ChatRequest, DecisionRequest, SelectionRequest, QuantityRequest, ConversationResponse, ConversationDetailResponse, MessageResponse
from agent import get_or_create_agent
from tools.order import init_order_tables
import checkpointer as cp_module
from checkpointer import get_checkpointer_cm


@asynccontextmanager
async def lifespan(app: FastAPI):
    # AsyncSqliteSaver 必須透過 async with 初始化
    async with get_checkpointer_cm() as cp:
        cp_module.checkpointer = cp
        init_db()
        init_order_tables()
        print("[Server] Human-in-the-Loop Agent API 啟動完成")
        yield
    # 離開 async with 時自動關閉 aiosqlite 連線


app = FastAPI(title="Case 6: Human-in-the-Loop API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# POST /api/chat — 初始訂單處理（SSE 串流）
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
        log.info("=" * 60)
        log.info(f"[CHAT] conversation_id={conversation_id}")
        log.info(f"[CHAT] 訊息：{req.message[:80]}")

        try:
            agent = await get_or_create_agent(req.llm_config)
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": 50,
            }

            # 初始 state：thread_id 讓 finalize_node 拿到 conversation_id
            initial_state = {
                "raw_request": req.message,
                "thread_id": conversation_id,
                "parsed_items": [],
                "unresolved_items": [],
                "quantity_unknown_items": [],
                "inventory_ok": False,
                "error_message": "",
                "price_details": {},
                "approval_threshold": settings.approval_threshold,
                "approval_status": "",
                "final_order_id": "",
                "response": "",
                "messages": [],
            }

            full_response = ""

            async for event in agent.astream_events(initial_state, config=config, version="v2"):
                etype = event["event"]
                node_name = event.get("name", "")

                if etype in ("on_chain_start", "on_chain_end"):
                    log.debug(f"[EVENT] {etype:25s} | node={node_name}")

                # ── respond_node 的 token 串流 ──
                if etype == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node == "respond_node":
                        chunk = event["data"]["chunk"].content
                        if chunk:
                            full_response += chunk
                            yield {
                                "event": "token",
                                "data": json.dumps({"content": chunk}, ensure_ascii=False),
                            }

                # ── finalize_node 完成：訂單已建立 ──
                elif etype == "on_chain_end" and node_name == "finalize_node":
                    output = event["data"].get("output", {})
                    order_id = output.get("final_order_id", "") if isinstance(output, dict) else ""
                    if order_id:
                        log.info(f"[ORDER] 訂單建立：{order_id}")
                        price = {}
                        snapshot_before = await agent.aget_state(config)
                        if snapshot_before:
                            price = snapshot_before.values.get("price_details", {})
                        yield {
                            "event": "order_created",
                            "data": json.dumps({
                                "order_id": order_id,
                                "total": price.get("total", 0),
                            }, ensure_ascii=False),
                        }

            # ── 串流結束後：偵測是否因 interrupt 暫停 ──
            snapshot = await agent.aget_state(config)
            if snapshot and snapshot.next:
                state_vals = snapshot.values
                quantity_unknown = state_vals.get("quantity_unknown_items", [])
                unresolved = state_vals.get("unresolved_items", [])

                if quantity_unknown:
                    # ask_quantity_node interrupt：使用者未指定數量
                    log.info(f"[HITL] 數量確認中斷。qty_unknown={len(quantity_unknown)}")
                    yield {
                        "event": "quantity_clarify_required",
                        "data": json.dumps({
                            "thread_id": conversation_id,
                            "items": [{"product_name": item["product_name"]} for item in quantity_unknown],
                        }, ensure_ascii=False),
                    }
                elif unresolved:
                    # clarify_node interrupt：商品無法比對，請使用者選擇
                    log.info(f"[HITL] 商品選擇中斷。unresolved={len(unresolved)}")
                    yield {
                        "event": "product_selection_required",
                        "data": json.dumps({
                            "thread_id": conversation_id,
                            "unresolved_items": unresolved,
                        }, ensure_ascii=False),
                    }
                else:
                    # approval_gate_node interrupt：訂單金額超過門檻
                    parsed_items = state_vals.get("parsed_items", [])
                    price_details = state_vals.get("price_details", {})
                    threshold = state_vals.get("approval_threshold", settings.approval_threshold)

                    log.info(f"[HITL] 圖暫停，等待審批。total={price_details.get('total')}")
                    save_pending_approval(
                        thread_id=conversation_id,
                        items=parsed_items,
                        price_details=price_details,
                        threshold=threshold,
                    )
                    yield {
                        "event": "approval_required",
                        "data": json.dumps({
                            "thread_id": conversation_id,
                            "parsed_items": parsed_items,
                            "price_details": price_details,
                            "threshold": threshold,
                        }, ensure_ascii=False),
                    }
            else:
                # 圖正常完成：儲存最終回覆
                if full_response:
                    with engine.connect() as conn:
                        conn.execute(insert(messages).values(
                            conversation_id=conversation_id,
                            role="assistant",
                            content=full_response,
                        ))
                        conn.commit()

            yield {
                "event": "done",
                "data": json.dumps({"conversation_id": conversation_id}, ensure_ascii=False),
            }

        except Exception as e:
            log.exception(f"[ERROR] {e}")
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_generator())


# ============================================================
# POST /api/chat/{thread_id}/select — 商品選擇恢復端點
# ============================================================
@app.post("/api/chat/{thread_id}/select")
async def select_products(thread_id: str, req: SelectionRequest):
    """
    商品選擇恢復：接收使用者從候選清單選定的商品，
    以 Command(resume=...) 恢復被 clarify_node interrupt 的圖。

    恢復後繼續：clarify_node → check_inventory → calculate_price → approval_gate
    若金額超過門檻，approval_gate 會再次 interrupt → 發出 approval_required 事件。
    """
    async def event_generator():
        log.info(f"[SELECT] thread_id={thread_id}  items={len(req.resolved_items)}")
        try:
            agent = await get_or_create_agent(req.llm_config)
            config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 50}

            resume_data = {
                "resolved_items": [i.model_dump() for i in req.resolved_items]
            }

            full_response = ""

            async for event in agent.astream_events(
                Command(resume=resume_data),
                config=config,
                version="v2",
            ):
                etype = event["event"]
                node_name = event.get("name", "")

                if etype in ("on_chain_start", "on_chain_end"):
                    log.debug(f"[SELECT EVENT] {etype:25s} | node={node_name}")

                if etype == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node == "respond_node":
                        chunk = event["data"]["chunk"].content
                        if chunk:
                            full_response += chunk
                            yield {
                                "event": "token",
                                "data": json.dumps({"content": chunk}, ensure_ascii=False),
                            }

                elif etype == "on_chain_end" and node_name == "finalize_node":
                    output = event["data"].get("output", {})
                    order_id = output.get("final_order_id", "") if isinstance(output, dict) else ""
                    if order_id:
                        log.info(f"[ORDER] 選擇後訂單建立：{order_id}")
                        yield {
                            "event": "order_created",
                            "data": json.dumps({"order_id": order_id}, ensure_ascii=False),
                        }

            # 偵測是否因 approval_gate interrupt 再次暫停
            snapshot = await agent.aget_state(config)
            if snapshot and snapshot.next:
                state_vals = snapshot.values
                parsed_items = state_vals.get("parsed_items", [])
                price_details = state_vals.get("price_details", {})
                threshold = state_vals.get("approval_threshold", settings.approval_threshold)

                log.info(f"[HITL] 選擇後觸發審批。total={price_details.get('total')}")
                save_pending_approval(
                    thread_id=thread_id,
                    items=parsed_items,
                    price_details=price_details,
                    threshold=threshold,
                )
                yield {
                    "event": "approval_required",
                    "data": json.dumps({
                        "thread_id": thread_id,
                        "parsed_items": parsed_items,
                        "price_details": price_details,
                        "threshold": threshold,
                    }, ensure_ascii=False),
                }
            else:
                if full_response:
                    with engine.connect() as conn:
                        conn.execute(insert(messages).values(
                            conversation_id=thread_id,
                            role="assistant",
                            content=full_response,
                        ))
                        conn.commit()

            yield {
                "event": "done",
                "data": json.dumps({"thread_id": thread_id}, ensure_ascii=False),
            }

        except Exception as e:
            log.exception(f"[ERROR] {e}")
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_generator())


# ============================================================
# POST /api/chat/{thread_id}/clarify-quantity — 數量確認恢復端點
# ============================================================
@app.post("/api/chat/{thread_id}/clarify-quantity")
async def clarify_quantity(thread_id: str, req: QuantityRequest):
    """
    數量確認恢復：接收使用者填入的各商品數量，
    以 Command(resume=...) 恢復被 ask_quantity_node interrupt 的圖。

    恢復後可能繼續：
    - ask_quantity_node → clarify_node（若仍有未比對商品）→ check_inventory → ...
    - ask_quantity_node → check_inventory → calculate_price → approval_gate
    """
    async def event_generator():
        log.info(f"[QUANTITY] thread_id={thread_id}  items={len(req.quantities)}")
        try:
            agent = await get_or_create_agent(req.llm_config)
            config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 50}

            resume_data = {
                "quantities": [q.model_dump() for q in req.quantities]
            }

            full_response = ""

            async for event in agent.astream_events(
                Command(resume=resume_data),
                config=config,
                version="v2",
            ):
                etype = event["event"]
                node_name = event.get("name", "")

                if etype in ("on_chain_start", "on_chain_end"):
                    log.debug(f"[QUANTITY EVENT] {etype:25s} | node={node_name}")

                if etype == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node == "respond_node":
                        chunk = event["data"]["chunk"].content
                        if chunk:
                            full_response += chunk
                            yield {
                                "event": "token",
                                "data": json.dumps({"content": chunk}, ensure_ascii=False),
                            }

                elif etype == "on_chain_end" and node_name == "finalize_node":
                    output = event["data"].get("output", {})
                    order_id = output.get("final_order_id", "") if isinstance(output, dict) else ""
                    if order_id:
                        log.info(f"[ORDER] 數量確認後訂單建立：{order_id}")
                        yield {
                            "event": "order_created",
                            "data": json.dumps({"order_id": order_id}, ensure_ascii=False),
                        }

            # 偵測後續 interrupt
            snapshot = await agent.aget_state(config)
            if snapshot and snapshot.next:
                state_vals = snapshot.values
                unresolved = state_vals.get("unresolved_items", [])

                if unresolved:
                    log.info(f"[HITL] 數量確認後，商品選擇中斷。unresolved={len(unresolved)}")
                    yield {
                        "event": "product_selection_required",
                        "data": json.dumps({
                            "thread_id": thread_id,
                            "unresolved_items": unresolved,
                        }, ensure_ascii=False),
                    }
                else:
                    parsed_items = state_vals.get("parsed_items", [])
                    price_details = state_vals.get("price_details", {})
                    threshold = state_vals.get("approval_threshold", settings.approval_threshold)

                    log.info(f"[HITL] 數量確認後觸發審批。total={price_details.get('total')}")
                    save_pending_approval(
                        thread_id=thread_id,
                        items=parsed_items,
                        price_details=price_details,
                        threshold=threshold,
                    )
                    yield {
                        "event": "approval_required",
                        "data": json.dumps({
                            "thread_id": thread_id,
                            "parsed_items": parsed_items,
                            "price_details": price_details,
                            "threshold": threshold,
                        }, ensure_ascii=False),
                    }
            else:
                if full_response:
                    with engine.connect() as conn:
                        conn.execute(insert(messages).values(
                            conversation_id=thread_id,
                            role="assistant",
                            content=full_response,
                        ))
                        conn.commit()

            yield {
                "event": "done",
                "data": json.dumps({"thread_id": thread_id}, ensure_ascii=False),
            }

        except Exception as e:
            log.exception(f"[ERROR] {e}")
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_generator())


# ============================================================
# POST /api/orders/{thread_id}/decide — 攜帶審批決定恢復圖執行
# ============================================================
@app.post("/api/orders/{thread_id}/decide")
async def decide_order(thread_id: str, req: DecisionRequest):
    """
    用 Command(resume=...) 恢復被 interrupt 暫停的圖。

    Command(resume=data) 告訴 LangGraph：
      「從 thread_id 對應的 checkpoint 恢復，並讓 interrupt() 返回 data」

    圖恢復後從 approval_gate_node 繼續執行（重新進入但 interrupt 立即返回），
    接著 finalize_node（或跳過）→ respond_node → END。
    """
    async def event_generator():
        log.info(f"[DECIDE] thread_id={thread_id}  action={req.action}")

        try:
            agent = await get_or_create_agent(req.llm_config)
            config = {
                "configurable": {"thread_id": thread_id},
                "recursion_limit": 50,
            }

            resume_data: dict = {"action": req.action}
            if req.items:
                resume_data["items"] = [i.model_dump() for i in req.items]

            full_response = ""

            # Command(resume=...) 取代 initial_state，恢復暫停的圖
            async for event in agent.astream_events(
                Command(resume=resume_data),
                config=config,
                version="v2",
            ):
                etype = event["event"]
                node_name = event.get("name", "")

                if etype in ("on_chain_start", "on_chain_end"):
                    log.debug(f"[RESUME EVENT] {etype:25s} | node={node_name}")

                # respond_node token 串流
                if etype == "on_chat_model_stream":
                    node = event.get("metadata", {}).get("langgraph_node", "")
                    if node == "respond_node":
                        chunk = event["data"]["chunk"].content
                        if chunk:
                            full_response += chunk
                            yield {
                                "event": "token",
                                "data": json.dumps({"content": chunk}, ensure_ascii=False),
                            }

                # finalize_node 完成
                elif etype == "on_chain_end" and node_name == "finalize_node":
                    output = event["data"].get("output", {})
                    order_id = output.get("final_order_id", "") if isinstance(output, dict) else ""
                    if order_id:
                        log.info(f"[ORDER] 審批通過，訂單建立：{order_id}")
                        yield {
                            "event": "order_created",
                            "data": json.dumps({"order_id": order_id}, ensure_ascii=False),
                        }

            # 更新 DB 中的審批狀態
            update_approval_status(thread_id, req.action)

            # 儲存最終回覆到對話記錄
            if full_response:
                with engine.connect() as conn:
                    conn.execute(insert(messages).values(
                        conversation_id=thread_id,
                        role="assistant",
                        content=full_response,
                    ))
                    conn.commit()

            yield {
                "event": "done",
                "data": json.dumps({"action": req.action}, ensure_ascii=False),
            }

        except Exception as e:
            log.exception(f"[ERROR] {e}")
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}, ensure_ascii=False),
            }

    return EventSourceResponse(event_generator())


# ============================================================
# GET /api/orders/pending — 取得待審批訂單列表
# ============================================================
@app.get("/api/orders/pending")
async def list_pending_orders():
    return get_pending_approvals()


# ============================================================
# GET /api/products — 取得商品目錄
# ============================================================
@app.get("/api/products")
async def list_products():
    with engine.connect() as conn:
        rows = conn.execute(
            select(products_table).order_by(products_table.c.category, products_table.c.name)
        ).fetchall()
    return [
        {"id": r.id, "name": r.name, "category": r.category,
         "price": r.price, "stock": r.stock}
        for r in rows
    ]


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
