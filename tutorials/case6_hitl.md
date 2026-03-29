# Case 6: Human-in-the-Loop — 訂單審批 Agent

## 前置知識

建議先完成以下 Case：
- **Case 1**：StateGraph 基礎、SSE 串流
- **Case 2**：ReAct 迴圈、工具綁定
- **Case 3**：工具開發、資料庫 CRUD 工具

---

## 核心概念

### 什麼是 Human-in-the-Loop？

在自動化流程中保留人工介入點，讓人類在關鍵決策節點（金額超過門檻、資訊不足需確認等）進行確認，Agent 等待決定後再繼續執行。

本案例實作了**三個連續的 interrupt 節點**，依觸發順序：

```
使用者訊息
    ↓
parse_order_node（LLM 解析 + 商品比對）
    ↓ 依解析結果路由
    ├── 數量未知 → ask_quantity_node  ← interrupt #1
    │       ↓ 數量確認後
    │       ├── 商品模糊 → clarify_node ← interrupt #2
    │       └── 商品明確 → check_inventory_node
    ├── 商品模糊 → clarify_node        ← interrupt #2
    │       ↓ 商品選擇後
    │       └── check_inventory_node
    └── 全部解析 → check_inventory_node
                    ↓
               calculate_price_node
                    ↓
               approval_gate_node     ← interrupt #3（門檻 0，必觸發）
                    ↓
               finalize_node → respond_node → END
```

### `interrupt()` — 暫停圖執行

```python
from langgraph.types import interrupt

async def approval_gate_node(state):
    total = state["price_details"]["total"]
    if total < state["approval_threshold"]:
        return {"approval_status": "auto"}

    # 觸發 interrupt：
    # 1. 儲存當前 state 到 AsyncSqliteSaver checkpoint
    # 2. 拋出 GraphInterrupt，astream_events 串流靜默結束
    # 3. 前端偵測到串流結束後，查詢 snapshot.next 確認是否暫停
    decision = interrupt({
        "type": "order_approval",
        "parsed_items": state["parsed_items"],
        "price_details": state["price_details"],
    })

    # ← 以下程式碼在 Command(resume=...) 後才執行
    return {"approval_status": decision.get("action", "rejected")}
```

**重要：節點重入行為**

Resume 後，節點從頭重新執行（不是從 `interrupt()` 那行繼續）：

| 時機 | interrupt() 行為 |
|------|----------------|
| 首次執行 | 儲存 checkpoint → 拋出 GraphInterrupt → 串流結束 |
| Resume 後重入 | 有 resume 值 → 立即返回，不再暫停 |

> **結論**：`interrupt()` 之前的程式碼會執行兩次。不要在 interrupt 之前放 DB 寫入、外部 API 呼叫等有副作用的操作。

### `Command(resume=data)` — 恢復執行

```python
from langgraph.types import Command

# api.py — 收到審批決定後
async for event in agent.astream_events(
    Command(resume={"action": "approved", "items": [...]}),
    config={"configurable": {"thread_id": conversation_id}},
    version="v2",
):
    ...
```

`Command(resume=data)` 告訴 LangGraph：
1. 從 `thread_id` 的 checkpoint 載入暫停前的完整 state
2. 重入被暫停的節點，讓 `interrupt()` 返回 `data`（不再暫停）
3. 繼續執行後續節點

### `AsyncSqliteSaver` — 非同步持久化 Checkpointer

HITL 必須使用持久化 checkpointer，原因：
- `MemorySaver` 只在記憶體中，伺服器重啟後暫停中的訂單狀態消失
- 人工審批可能在幾分鐘乃至幾小時後才發生，必須持久化

使用 `AsyncSqliteSaver`（而非 `SqliteSaver`），因為 FastAPI 的 async endpoint 不能阻塞 event loop：

```python
# checkpointer.py
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

checkpointer = None   # lifespan 啟動後設值

def get_checkpointer_cm():
    return AsyncSqliteSaver.from_conn_string(settings.checkpoint_db_path)
```

```python
# api.py — lifespan（必須用 async with）
@asynccontextmanager
async def lifespan(app: FastAPI):
    async with get_checkpointer_cm() as cp:
        cp_module.checkpointer = cp   # 設定模組層級變數
        init_db()
        yield
```

```python
# agent.py — import 模組而非值（確保取到 lifespan 設定後的實例）
import checkpointer as cp_module

agent = graph.compile(checkpointer=cp_module.checkpointer)
```

### LLM 結構化輸出與商品比對

使用 `with_structured_output(ParsedOrder)` 強制 LLM 輸出固定格式：

```python
# models.py
class ParsedOrderItem(BaseModel):
    product_name: str        # 目錄名稱 or 使用者原始描述
    quantity: int = Field(default=1, ge=1)
    quantity_unknown: bool = Field(default=False)  # 使用者未指定數量
    candidate_ids: list[str] = Field(default=[])   # 模糊時的相關商品 ID

class ParsedOrder(BaseModel):
    items: list[ParsedOrderItem]
    is_valid: bool   # False 只用於完全沒有商品描述時
    invalid_reason: str = ""
```

商品比對邏輯（`parse_order_node`）：

```python
for item in result.items:
    matched = None

    # candidate_ids 非空 = LLM 認為語意模糊，跳過 substring 比對
    if not item.candidate_ids:
        for p in products:
            if item.product_name in p["name"] or p["name"] in item.product_name:
                matched = p
                break

    # 計算候選清單
    if not matched:
        if item.candidate_ids:
            candidates = [p for p in products if p["id"] in set(item.candidate_ids)]
        if not candidates:
            candidates = _find_candidates(item.product_name, products)  # 字元比對 fallback

    # 分配到對應的 state 欄位
    if item.quantity_unknown:
        quantity_unknown_items.append({...})  # → ask_quantity_node
    elif matched:
        parsed_items.append({...})            # → check_inventory_node
    else:
        unresolved_items.append({...})        # → clarify_node
```

---

## 實踐內容

### 資料夾結構

```
case6_hitl/
  backend/
    agent.py              # OrderAgent（3 個 interrupt 節點）
    api.py                # FastAPI：5 個端點，含 SSE + interrupt 偵測
    checkpointer.py       # AsyncSqliteSaver 初始化（lifespan 模式）
    config.py             # approval_threshold = 0（所有訂單皆需審批）
    database.py           # products、conversations、messages、pending_approvals
    models.py             # ParsedOrder、ParsedOrderItem（含 candidate_ids、quantity_unknown）
    tools/
      inventory.py        # check_inventory
      pricing.py          # calculate_price（滿千九五折，滿五千九折）
      order.py            # create_order
    seed_data.py          # 10 個商品初始資料
    requirements.txt      # 含 aiosqlite
  frontend/
    src/
      Chat.tsx            # 主聊天介面（處理 3 種 interrupt 事件）
      Chat.css
      ApprovalQueue.tsx   # 審批卡片（核准 / 拒絕 / 修改數量）
      ApprovalQueue.css
      ProductSelector.tsx # 商品選擇卡片（候選清單）
      ProductSelector.css
      QuantityClarify.tsx # 數量確認卡片（填入未指定數量）
      QuantityClarify.css
      App.tsx
      main.tsx
    package.json
    vite.config.ts
  docker-compose.yaml
  Dockerfile.backend
  Dockerfile.frontend
  .env.example
  qa.md
```

---

## 程式碼導讀

### 1. `agent.py` — OrderState 與節點設計

```python
class OrderState(TypedDict):
    messages:               Annotated[list, add_messages]
    raw_request:            str         # 使用者原始訊息
    thread_id:              str         # 必須宣告在 TypedDict，才能存入 checkpoint
    parsed_items:           list[dict]  # 已比對成功 [{product_id,name,quantity,unit_price}]
    unresolved_items:       list[dict]  # 比對失敗 [{user_query,quantity,candidates}]
    quantity_unknown_items: list[dict]  # 未指定數量 [{product_name,matched_product,candidates}]
    inventory_ok:           bool
    error_message:          str
    price_details:          dict        # {items,subtotal,discount_rate,discount,total}
    approval_threshold:     float       # 門檻（0 = 所有訂單皆需審批）
    approval_status:        str         # "" | "auto" | "approved" | "rejected"
    final_order_id:         str
    response:               str
```

**路由函數**：

```python
def route_after_parse(state) -> str:
    if state.get("error_message"):       return "respond_node"
    if state.get("quantity_unknown_items"): return "ask_quantity_node"  # 優先問數量
    if state.get("unresolved_items"):    return "clarify_node"
    return "check_inventory_node"

def route_after_ask_quantity(state) -> str:
    if state.get("unresolved_items"):    return "clarify_node"
    return "check_inventory_node"
```

### 2. `api.py` — 端點總覽與 interrupt 偵測

| 端點 | 說明 | 恢復節點 |
|------|------|---------|
| `POST /api/chat` | 初始訂單處理，偵測 3 種 interrupt | — |
| `POST /api/chat/{id}/clarify-quantity` | 數量確認後恢復 | `ask_quantity_node` |
| `POST /api/chat/{id}/select` | 商品選擇後恢復 | `clarify_node` |
| `POST /api/orders/{id}/decide` | 審批決定後恢復 | `approval_gate_node` |
| `GET /api/orders/pending` | 取得待審批清單 | — |

**interrupt 偵測（串流結束後）**：

```python
snapshot = await agent.aget_state(config)
if snapshot and snapshot.next:
    state_vals = snapshot.values
    quantity_unknown = state_vals.get("quantity_unknown_items", [])
    unresolved = state_vals.get("unresolved_items", [])

    if quantity_unknown:
        yield {"event": "quantity_clarify_required", "data": ...}
    elif unresolved:
        yield {"event": "product_selection_required", "data": ...}
    else:
        # approval_gate interrupt
        save_pending_approval(...)
        yield {"event": "approval_required", "data": ...}
```

每個恢復端點結束後，也需要同樣的偵測邏輯（因為可能觸發下一個 interrupt）：
- `/clarify-quantity` 後：可能觸發 `product_selection_required` 或 `approval_required`
- `/select` 後：可能觸發 `approval_required`

### 3. `Chat.tsx` — 三種特殊訊息卡片

```typescript
interface Message {
  role: 'user' | 'assistant' | 'approval' | 'selection' | 'quantity'
  content: string
  // 審批卡片
  approvalData?: ApprovalData
  approvalStatus?: 'pending' | 'approved' | 'rejected' | 'processing'
  // 商品選擇卡片
  selectionData?: SelectionData
  selectionStatus?: 'pending' | 'processing' | 'resolved'
  // 數量確認卡片
  quantifyData?: QuantifyClarifyData
  quantifyStatus?: 'pending' | 'processing' | 'resolved'
}
```

每種卡片對應一個處理函數：

| 事件 | 處理函數 | 呼叫端點 |
|------|---------|---------|
| `quantity_clarify_required` | `handleQuantifyClarify()` | `/api/chat/{id}/clarify-quantity` |
| `product_selection_required` | `handleSelect()` | `/api/chat/{id}/select` |
| `approval_required` | `handleDecide()` | `/api/orders/{id}/decide` |

**卡片替換模式**（以數量確認為例）：

```typescript
// 1. handleSend 偵測到 quantity_clarify_required
//    → 將空白 assistant 泡泡替換為數量確認卡片
setMessages(prev => {
  const updated = [...prev]
  updated.splice(assistantIdx, 1, {
    role: 'quantity',
    quantifyData: { thread_id, items },
    quantifyStatus: 'pending',
  })
  return updated
})

// 2. 使用者確認數量 → handleQuantifyClarify() 標記 processing，末尾插入空白 assistant 槽
setMessages(prev => {
  updated[quantifyMsgIdx] = { ...updated[quantifyMsgIdx], quantifyStatus: 'processing' }
  return [...updated, { role: 'assistant', content: '' }]
})

// 3. 恢復後可能觸發下一個 interrupt（product_selection 或 approval）
//    → 將空白 assistant 槽替換為對應卡片
// 4. done 事件 → 將數量卡片標記為 resolved
```

### 4. `QuantityClarify.tsx` — 數量確認卡片

```typescript
interface Props {
  data: { thread_id: string; items: Array<{product_name: string}> }
  status: 'pending' | 'processing' | 'resolved'
  onConfirm: (quantities: Array<{product_name: string; quantity: number}>) => void
}
```

每個品項顯示商品名稱 + 數字輸入框，按下「確認數量」後觸發 `onConfirm`。

### 5. `tools/pricing.py` — 折扣規則

```python
def calculate_price(items: list[dict]) -> dict:
    subtotal = sum(i["unit_price"] * i["quantity"] for i in items)
    if subtotal >= 5000:   discount_rate = 0.90   # 九折
    elif subtotal >= 1000: discount_rate = 0.95   # 九五折
    else:                  discount_rate = 1.0    # 無折扣
    discount = subtotal * (1 - discount_rate)
    return {
        "items": items, "subtotal": subtotal,
        "discount_rate": discount_rate,
        "discount": discount,
        "total": subtotal - discount,
    }
```

---

## 執行方式

### 方式一：本地開發

```bash
# Backend
cd case6_hitl/backend
pip install -r requirements.txt
python seed_data.py          # 初始化 10 個商品
python api.py                # 啟動 API（port 8000）

# Frontend（另一個終端機）
cd case6_hitl/frontend
npm install
npm run dev                  # 啟動前端（port 5173）
```

### 方式二：Docker

```bash
cd case6_hitl
cp .env.example .env
docker-compose up -d
```

---

## 測試驗證

### 測試 1：數量未指定（新增功能）

輸入：`我想買鍵盤`
- `ask_quantity_node` interrupt → 顯示「請確認訂購數量」藍色卡片
- 填入數量（如 2）→ 確認
- 若「鍵盤」能唯一比對（如「機械鍵盤」）→ 直接跳審批卡片
- 若「鍵盤」模糊（多個候選）→ 先顯示商品選擇卡片，再顯示審批卡片

### 測試 2：商品模糊

輸入：`我要買 2 個電腦儲存裝置`
- LLM 解析：`candidate_ids = ["P007","P008"]`（固態硬碟、隨身碟）
- 顯示商品選擇卡片，只列出相關商品（不會出現全部商品）
- 選擇後 → 審批卡片

### 測試 3：審批流程

輸入：`我想訂 3 個無線滑鼠跟 2 個機械鍵盤`（商品明確，數量明確）
- 直接進入審批卡片（`approval_threshold=0`，所有訂單必審批）
- 點擊「核准」→ 訂單建立，顯示確認訊息
- 點擊「拒絕」→ 顯示拒絕通知

### 測試 4：修改數量後核准

在審批卡片中修改品項數量，點擊「修改並核准」：
- `resume_data` 帶入修改後品項
- `approval_gate_node` resume 後重新計算折扣和總金額

### 測試 5：持久化驗證（SqliteSaver 核心功能）

1. 發送訂單，等待審批卡片出現
2. **重啟 backend**（Ctrl+C 後重新 `python api.py`）
3. 重新整理前端，切換到原對話，點擊「核准」
4. 訂單仍能正常完成 → 確認 `AsyncSqliteSaver` 持久化有效

### 測試 6：三階段連鎖 interrupt

輸入：`我想買儲存裝置`（數量未指定 + 商品模糊）
1. 數量確認卡片 → 填入數量
2. 商品選擇卡片 → 選擇商品
3. 審批卡片 → 核准或拒絕

---

## 延伸挑戰

1. **多層審批**：加入「部門主管審批」→「財務審批」的兩層審批流程
2. **審批逾時**：設定審批有效期（如 24 小時），逾時自動拒絕
3. **批次審批**：`GET /api/orders/pending` 已實作，在 Sidebar 加入待審批清單面板
4. **審批通知**：使用 WebSocket 讓多個前端視窗同步看到審批狀態變更
5. **彈性門檻**：依使用者角色設定不同審批門檻（如 VIP 客戶免審批）
