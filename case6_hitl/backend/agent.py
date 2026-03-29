"""
OrderAgent — 訂單處理 Human-in-the-Loop Agent

【HITL 核心概念】

  interrupt() — 暫停圖執行，等待人工輸入：
    from langgraph.types import interrupt
    decision = interrupt({"message": "需要審核", ...})
    # 執行在此暫停，checkpoint 存入 SqliteSaver
    # 等待 Command(resume=...) 呼叫後，decision 獲得人工回傳的值，繼續執行

  Command(resume=...) — 攜帶人工決定恢復執行：
    from langgraph.types import Command
    await agent.astream_events(
        Command(resume={"action": "approved", "items": [...]}),
        config={"configurable": {"thread_id": "..."}},
    )
    # LangGraph 從 checkpoint 載入暫停前的狀態
    # 重新進入 approval_gate_node，interrupt() 立即返回 {"action": "approved", ...}
    # 繼續執行後續節點

【重要：interrupt() 的節點重入行為】

  當圖被 interrupt() 暫停後 resume：
  1. approval_gate_node 從頭重新執行（不是從 interrupt 那一行繼續）
  2. 再次遇到 interrupt() 時，因為有 resume 值，立即返回而不暫停
  3. 節點中 interrupt() 之前的程式碼會執行兩次，之後的只執行一次
  → 結論：interrupt() 之前不要放有副作用的操作（DB 寫入、API 呼叫等）

【圖結構】

  START
    ↓
  parse_order_node        LLM 解析自然語言 → 結構化訂單
    ↓ route_after_parse
  [error] → respond_node → END
  [ok]    → check_inventory_node   查詢 DB 確認庫存
              ↓ route_after_inventory
  [error] → respond_node → END
  [ok]    → calculate_price_node   計算含折扣總金額
              ↓
            approval_gate_node   若 total >= threshold → interrupt()
              ↓ route_after_approval
  [auto/approved] → finalize_node → respond_node → END
  [rejected]      → respond_node → END

【SqliteSaver 的角色】

  每個節點執行完後，SqliteSaver 自動儲存當前 state 到 SQLite。
  interrupt() 發生時，state 被儲存（包含解析好的訂單、計算好的價格）。
  resume 後，LangGraph 從 SqliteSaver 載入這個 state，繼續從 approval_gate_node 執行。
"""

import operator
import json
from typing import TypedDict, Annotated

from langgraph.graph import StateGraph, START, END, add_messages
from langgraph.types import interrupt, Command
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
from sqlalchemy import select

from models import LlmConfig, ParsedOrder
import checkpointer as cp_module
from database import engine, products as products_table
from tools.inventory import check_inventory
from tools.pricing import calculate_price
from tools.order import create_order


# ============================================================
# State 定義
# ============================================================

class OrderState(TypedDict):
    """
    訂單處理 Agent 的狀態。

    每個節點只更新自己負責的欄位，其他欄位保持不動。
    """
    messages:               Annotated[list, add_messages]
    raw_request:            str         # 原始使用者訊息
    thread_id:              str         # conversation_id，供 finalize_node 建立訂單時使用
    parsed_items:           list[dict]  # 已比對成功的品項 [{"product_id","name","quantity","unit_price"}]
    unresolved_items:       list[dict]  # 無法比對的品項 [{"user_query","quantity","candidates":[...]}]
    quantity_unknown_items: list[dict]  # 未指定數量的品項 [{"product_name","matched_product","candidates"}]
    inventory_ok:           bool        # 庫存檢查結果
    error_message:          str         # 任何錯誤訊息（解析失敗、庫存不足等）
    price_details:          dict        # {"items","subtotal","discount_rate","discount","total"}
    approval_threshold:     float       # 審批門檻
    approval_status:        str         # "" | "auto" | "approved" | "rejected"
    final_order_id:         str         # 建立後的訂單 ID
    response:               str         # 最終回覆文字


# Agent 快取：依 LLM 設定快取編譯後的圖
_agent_cache: dict[tuple, object] = {}


def _load_products() -> list[dict]:
    """從 DB 載入所有商品，供 parse_order_node 提供給 LLM 參考"""
    with engine.connect() as conn:
        rows = conn.execute(select(products_table).order_by(products_table.c.id)).fetchall()
    return [{"id": r.id, "name": r.name, "category": r.category, "price": r.price} for r in rows]


def _find_candidates(product_name: str, all_products: list[dict]) -> list[dict]:
    """
    為比對失敗的商品名稱找出候選清單。

    策略：計算使用者輸入與商品名稱的字元重疊數，取前 5 名；
    若完全無重疊（例如使用英文），回傳全部商品。
    """
    query_chars = set(product_name)
    scored = [(len(query_chars & set(p["name"])), p) for p in all_products]
    scored = [(s, p) for s, p in scored if s > 0]
    if scored:
        scored.sort(key=lambda x: -x[0])
        return [p for _, p in scored[:5]]
    return all_products  # 完全無字元重疊時，展示所有商品


class OrderAgent:
    def __init__(self, llm_config: LlmConfig):
        base_llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        )
        # parse_llm：強制輸出 ParsedOrder JSON
        self.parse_llm = base_llm.with_structured_output(ParsedOrder)
        # synthesis_llm：純文字回覆，支援 token 串流
        self.synthesis_llm = base_llm

    async def create_agent(self):
        parse_llm = self.parse_llm
        synthesis_llm = self.synthesis_llm

        # ===
        # node functions
        # ===

        async def parse_order_node(state: OrderState):
            """
            LLM 解析自然語言訂單為結構化品項列表。

            使用 with_structured_output(ParsedOrder) 確保輸出格式：
              ParsedOrder.items = [ParsedOrderItem(product_name, quantity)]
              ParsedOrder.is_valid = True/False

            解析完成後，對照 DB 商品目錄將 product_name 轉換為 product_id。
            """
            products = _load_products()
            product_list_str = "\n".join([
                f"  - ID:{p['id']} {p['name']}（{p['category']}，NT${p['price']:.0f}）"
                for p in products
            ])

            result: ParsedOrder = await parse_llm.ainvoke([
                SystemMessage(
                    "你是訂單解析助手。根據使用者的自然語言訂購需求，"
                    "提取商品名稱與數量，對照以下產品目錄。\n\n"
                    f"產品目錄：\n{product_list_str}\n\n"
                    "處理規則（依序判斷）：\n"
                    "1. 若使用者描述能清楚且唯一對應目錄中某個商品（如「螢幕」→「27吋螢幕」），"
                    "product_name 填入目錄中的實際名稱，candidate_ids 留空\n"
                    "2. 若商品描述模糊或可對應多個商品（如「儲存裝置」可能是固態硬碟、隨身碟等），"
                    "product_name 原樣填入使用者的原始描述，"
                    "並在 candidate_ids 中填入目錄裡最相關的商品 ID（最多 5 個）\n"
                    "3. candidate_ids 只填語意上真正相關的商品，不要列出不相關的商品\n"
                    "4. 若使用者沒有明確說明數量（如「我想買鍵盤」、「幫我訂一個螢幕」中的「一個」是指 1，"
                    "但「我想買鍵盤」沒有提到數量），將 quantity 設為 1，並將 quantity_unknown 設為 true\n"
                    "5. 若使用者有明確數字（如「3 個」、「兩台」、「15 個」），quantity_unknown 設為 false\n"
                    "6. is_valid=false 只用於以下情況：\n"
                    "   使用者完全沒有說要買什麼（如「我要買東西」、「幫我訂一些東西」）\n"
                    "   只要有任何商品描述（即使沒有數量），就必須返回 items，is_valid=true"
                ),
                HumanMessage(state["raw_request"]),
            ])

            if not result.is_valid or not result.items:
                return {
                    "error_message": result.invalid_reason or "無法解析出有效的訂單內容",
                    "parsed_items": [],
                    "unresolved_items": [],
                }

            # 對照商品目錄
            #   quantity_unknown=True  → quantity_unknown_items（先問數量）
            #   quantity_unknown=False, 比對成功 → parsed_items
            #   quantity_unknown=False, 比對失敗 → unresolved_items（問使用者選商品）
            parsed_items = []
            unresolved_items = []
            quantity_unknown_items = []

            for item in result.items:
                # 若 LLM 已提供 candidate_ids（代表語意模糊），跳過 substring 比對
                matched = None
                if not item.candidate_ids:
                    for p in products:
                        if item.product_name in p["name"] or p["name"] in item.product_name:
                            matched = p
                            break

                # 計算候選清單（比對失敗時使用）
                candidates = []
                if not matched:
                    if item.candidate_ids:
                        id_set = set(item.candidate_ids)
                        candidates = [p for p in products if p["id"] in id_set]
                    if not candidates:
                        candidates = _find_candidates(item.product_name, products)

                candidates_fmt = [
                    {"id": c["id"], "name": c["name"],
                     "category": c["category"], "price": c["price"]}
                    for c in candidates
                ]

                if item.quantity_unknown:
                    # 數量未知：先詢問數量，再決定後續流程
                    quantity_unknown_items.append({
                        "product_name": item.product_name,
                        "matched_product": matched,   # None 表示商品也需要選擇
                        "candidates": candidates_fmt,
                    })
                elif matched:
                    parsed_items.append({
                        "product_id": matched["id"],
                        "name": matched["name"],
                        "quantity": item.quantity,
                        "unit_price": matched["price"],
                    })
                else:
                    unresolved_items.append({
                        "user_query": item.product_name,
                        "quantity": item.quantity,
                        "candidates": candidates_fmt,
                    })

            return {
                "parsed_items": parsed_items,
                "unresolved_items": unresolved_items,
                "quantity_unknown_items": quantity_unknown_items,
                "error_message": "",
            }

        async def ask_quantity_node(state: OrderState):
            """
            數量確認閘門：當 parse_order_node 解析到使用者未指定數量的商品時，
            透過 interrupt() 暫停，等待前端使用者填入各商品的數量。

            resume 後接收 {"quantities": [{"product_name": str, "quantity": int}, ...]}。
            已知商品（matched_product）→ 加入 parsed_items
            未知商品（candidates 非空）→ 加入 unresolved_items，後續由 clarify_node 處理
            """
            qty_unknown = state["quantity_unknown_items"]

            selection = interrupt({
                "type": "quantity_clarify",
                "items": [{"product_name": item["product_name"]} for item in qty_unknown],
            })

            qty_map = {q["product_name"]: q["quantity"] for q in selection.get("quantities", [])}

            new_parsed = list(state.get("parsed_items", []))
            new_unresolved = list(state.get("unresolved_items", []))

            for item in qty_unknown:
                qty = qty_map.get(item["product_name"], 1)
                mp = item.get("matched_product")
                if mp:
                    new_parsed.append({
                        "product_id": mp["id"],
                        "name": mp["name"],
                        "quantity": qty,
                        "unit_price": mp["price"],
                    })
                else:
                    new_unresolved.append({
                        "user_query": item["product_name"],
                        "quantity": qty,
                        "candidates": item.get("candidates", []),
                    })

            return {
                "parsed_items": new_parsed,
                "unresolved_items": new_unresolved,
                "quantity_unknown_items": [],
            }

        async def clarify_node(state: OrderState):
            """
            商品選擇閘門：當 parse_order_node 有無法比對的商品時，
            透過 interrupt() 暫停，等待前端使用者從候選清單中選擇。

            resume 後接收 {"resolved_items": [{product_id, name, quantity, unit_price}, ...]}，
            與已解析的 parsed_items 合併，清空 unresolved_items，繼續執行庫存檢查。

            注意：clarify_node 與 approval_gate_node 一樣有節點重入行為，
            interrupt() 之前的讀取操作（state["unresolved_items"]）安全。
            """
            selection = interrupt({
                "type": "product_selection",
                "unresolved_items": state["unresolved_items"],
            })
            resolved = selection.get("resolved_items", [])
            return {
                "parsed_items": state.get("parsed_items", []) + resolved,
                "unresolved_items": [],
            }

        async def check_inventory_node(state: OrderState):
            """查詢資料庫確認各商品庫存充足"""
            result = await check_inventory(state["parsed_items"])
            if not result["ok"]:
                return {
                    "inventory_ok": False,
                    "error_message": result["error"],
                }
            return {
                "inventory_ok": True,
                "error_message": "",
                "parsed_items": result["items"],
            }

        async def calculate_price_node(state: OrderState):
            """計算訂單含折扣總金額（滿千九五折，滿五千九折）"""
            price_details = calculate_price(state["parsed_items"])
            return {"price_details": price_details}

        async def approval_gate_node(state: OrderState):
            """
            審批閘門：訂單金額超過門檻時暫停等待人工決定。

            ─ interrupt() 的工作方式 ─
            1. 首次執行：interrupt(payload) 儲存 checkpoint 後拋出 GraphInterrupt，
               astream_events 串流結束，api.py 偵測到 graph.get_state().next 不為空
            2. resume 後：approval_gate_node 從頭重新執行，
               遇到 interrupt() 時發現有 resume 值，立即返回該值（不再暫停）
            3. 若 resume 時帶入修改過的品項，重新計算價格後更新 state

            ─ 注意事項 ─
            interrupt() 之前的程式碼（這裡是 total < threshold 的判斷）會執行兩次，
            但因為是純讀取 state 的計算，沒有副作用，安全。
            """
            total = state["price_details"]["total"]
            threshold = state["approval_threshold"]

            if total < threshold:
                return {"approval_status": "auto"}

            # ── 觸發 interrupt：暫停等待人工決定 ──
            # payload 傳給前端顯示訂單詳情（api.py 從 snapshot.values 讀取）
            decision = interrupt({
                "type": "order_approval",
                "parsed_items": state["parsed_items"],
                "price_details": state["price_details"],
                "threshold": threshold,
            })
            # ── 以下程式碼在 resume 後執行 ──

            action = decision.get("action", "rejected")
            updated_items = decision.get("items")

            if action == "approved" and updated_items and updated_items != state["parsed_items"]:
                # 品項被修改 → 重新計算價格
                new_price = calculate_price(updated_items)
                return {
                    "approval_status": "approved",
                    "parsed_items": updated_items,
                    "price_details": new_price,
                }

            return {"approval_status": action}

        async def finalize_node(state: OrderState):
            """
            建立訂單：將通過審批（auto 或 approved）的訂單寫入資料庫。

            thread_id 由 api.py 在初始 state 中帶入（conversation_id）。
            """
            order_id = create_order(
                thread_id=state.get("thread_id", "unknown"),
                items=state["parsed_items"],
                price_details=state["price_details"],
            )
            return {"final_order_id": order_id}

        async def respond_node(state: OrderState):
            """
            生成最終回覆：根據當前狀態（錯誤/自動建立/審批通過/拒絕）生成客服回覆。

            此節點使用 synthesis_llm，api.py 監聽其 on_chat_model_stream 做 token 串流。
            """
            error = state.get("error_message", "")
            status = state.get("approval_status", "")
            order_id = state.get("final_order_id", "")
            price = state.get("price_details", {})

            if error:
                context = f"訂單處理失敗，原因：{error}。請友善地告知客戶並建議解決方法。"
            elif status == "rejected":
                context = "訂單已被管理員拒絕。請告知客戶訂單未能通過審核，並表示抱歉。"
            elif order_id:
                items_str = "、".join([
                    f"{i['name']} × {i['quantity']}"
                    for i in state.get("parsed_items", [])
                ])
                total = price.get("total", 0)
                discount = price.get("discount", 0)
                context = (
                    f"訂單已成功建立！\n"
                    f"訂單編號：{order_id}\n"
                    f"訂購內容：{items_str}\n"
                    f"{'折扣：NT$' + str(discount) + chr(10) if discount > 0 else ''}"
                    f"應付金額：NT${total:.0f}\n"
                    f"請生成友善的訂單確認訊息。"
                )
            else:
                context = "系統發生未知錯誤，請告知客戶稍後再試。"

            response = await synthesis_llm.ainvoke([
                SystemMessage(
                    "你是訂單處理客服助手。用繁體中文、友善專業的語氣回覆客戶。"
                    "回覆簡潔明瞭，不超過 200 字。"
                ),
                HumanMessage(context),
            ])

            return {
                "response": response.content,
                "messages": [response],
            }

        # ===
        # route functions
        # ===

        def route_after_parse(state: OrderState) -> str:
            if state.get("error_message"):
                return "respond_node"
            if state.get("quantity_unknown_items"):
                return "ask_quantity_node"
            if state.get("unresolved_items"):
                return "clarify_node"
            return "check_inventory_node"

        def route_after_ask_quantity(state: OrderState) -> str:
            if state.get("unresolved_items"):
                return "clarify_node"
            return "check_inventory_node"

        def route_after_inventory(state: OrderState) -> str:
            if not state.get("inventory_ok", False):
                return "respond_node"
            return "calculate_price_node"

        def route_after_approval(state: OrderState) -> str:
            status = state.get("approval_status", "")
            if status in ("auto", "approved"):
                return "finalize_node"
            return "respond_node"

        # ===
        # build graph
        # START → parse_order
        #   → [qty unknown]  ask_quantity（interrupt）→ [unresolved] clarify → check_inventory
        #                                             → [all ok]    check_inventory
        #   → [unresolved]   clarify（interrupt）→ check_inventory
        #   → [all matched]  check_inventory
        #   → [error]        respond → END
        # check_inventory → calculate_price → approval_gate（interrupt）→ finalize → respond → END
        # ===
        graph = StateGraph(OrderState)

        graph.add_node("parse_order_node", parse_order_node)
        graph.add_node("ask_quantity_node", ask_quantity_node)
        graph.add_node("clarify_node", clarify_node)
        graph.add_node("check_inventory_node", check_inventory_node)
        graph.add_node("calculate_price_node", calculate_price_node)
        graph.add_node("approval_gate_node", approval_gate_node)
        graph.add_node("finalize_node", finalize_node)
        graph.add_node("respond_node", respond_node)

        graph.add_edge(START, "parse_order_node")
        graph.add_conditional_edges("parse_order_node", route_after_parse,
                                    ["ask_quantity_node", "check_inventory_node", "clarify_node", "respond_node"])
        graph.add_conditional_edges("ask_quantity_node", route_after_ask_quantity,
                                    ["clarify_node", "check_inventory_node"])
        # clarify_node 完成後直接進入庫存檢查
        graph.add_edge("clarify_node", "check_inventory_node")
        graph.add_conditional_edges("check_inventory_node", route_after_inventory,
                                    ["calculate_price_node", "respond_node"])
        graph.add_edge("calculate_price_node", "approval_gate_node")
        graph.add_conditional_edges("approval_gate_node", route_after_approval,
                                    ["finalize_node", "respond_node"])
        graph.add_edge("finalize_node", "respond_node")
        graph.add_edge("respond_node", END)

        # AsyncSqliteSaver 由 api.py lifespan 初始化後存入 cp_module.checkpointer
        agent = graph.compile(checkpointer=cp_module.checkpointer)
        return agent


async def get_or_create_agent(llm_config: LlmConfig):
    """依 LLM 設定取得或建立 Agent（快取，避免重複建立圖）"""
    cache_key = (llm_config.api_key, llm_config.base_url, llm_config.model)
    if cache_key not in _agent_cache:
        instance = OrderAgent(llm_config)
        _agent_cache[cache_key] = await instance.create_agent()
    return _agent_cache[cache_key]
