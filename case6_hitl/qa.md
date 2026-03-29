# Case 6 — Human-in-the-Loop Q&A

---

## HITL 核心機制

### Q: `interrupt()` 到底做了什麼？它和拋出例外有什麼不同？

`interrupt()` 是 LangGraph 內建的暫停原語（primitive）。呼叫後：

1. LangGraph 將當前 `state` 完整儲存進 checkpointer（SqliteSaver）
2. 拋出 `GraphInterrupt` 例外，使 `astream_events` 的 async generator 自然結束
3. 前端的 SSE 串流靜默結束（不會有任何錯誤事件）

和普通 `raise` 不同的是：它配合 checkpointer 實現了「暫停 + 恢復」，而不是「終止」。

```python
# agent.py — approval_gate_node
decision = interrupt({
    "type": "order_approval",
    "parsed_items": state["parsed_items"],
    ...
})
# ← 首次執行到這裡就停住了，以下程式碼等 resume 後才執行
action = decision.get("action", "rejected")
```

---

### Q: `interrupt()` 之後節點會「重新執行」，這是什麼意思？會不會造成問題？

**Resume 後節點從頭執行**，而不是從 `interrupt()` 那行繼續。流程如下：

| 執行時機 | 遇到 interrupt() 的行為 |
|----------|------------------------|
| 首次進入節點 | 儲存 checkpoint，拋出 GraphInterrupt，串流停止 |
| Resume 後重新進入 | 有 resume 值 → 立即返回 resume data，不再暫停 |

**因此 interrupt() 之前的程式碼會執行兩次**。案例中 `approval_gate_node` 在 interrupt 前只做了：

```python
total = state["price_details"]["total"]
threshold = state["approval_threshold"]
if total < threshold:
    return {"approval_status": "auto"}
```

這是純讀取計算，執行兩次完全安全。

**危險操作**：如果在 interrupt() 之前有 DB 寫入、發信、扣款等副作用，resume 後這些操作會重複執行。**解決方式**：副作用一律放在 interrupt() 之後，或拆分到獨立節點。

---

### Q: `Command(resume=data)` 和一般的 `astream_events(initial_state)` 有什麼差別？

`astream_events` 接受的第一個參數可以是：

| 傳入值 | 行為 |
|--------|------|
| `dict`（initial_state） | 從頭開始一個新的圖執行 |
| `Command(resume=data)` | 從 thread_id 的 checkpoint 恢復，讓 `interrupt()` 返回 data |

Resume 時 LangGraph 會：
1. 從 SqliteSaver 載入 `thread_id` 對應的完整 state
2. 定位到被 interrupt 的節點（`approval_gate_node`）
3. 重新進入該節點，讓 `interrupt()` 直接返回 `data` 而不再暫停

```python
# api.py — /api/orders/{thread_id}/decide
async for event in agent.astream_events(
    Command(resume={"action": "approved", "items": [...]}),
    config={"configurable": {"thread_id": thread_id}},
    version="v2",
):
    ...
```

---

### Q: 為什麼需要 `AsyncSqliteSaver`？`SqliteSaver` 不行嗎？

`SqliteSaver` 底層使用同步的 `sqlite3`，在 FastAPI 的 async endpoint 中呼叫會**阻塞整個 event loop**，使其他請求全部排隊等待。

`AsyncSqliteSaver` 底層使用 `aiosqlite`，所有操作都是 `await`，與 `astream_events` 完全相容。

| 特性 | MemorySaver | SqliteSaver | AsyncSqliteSaver |
|------|-------------|-------------|-----------------|
| 伺服器重啟後保留 | ❌ | ✅ | ✅ |
| FastAPI async 相容 | ✅ | ❌（阻塞） | ✅ |
| HITL 用途 | 不適用 | 不推薦 | ✅ 推薦 |
| 需要套件 | — | — | `aiosqlite` |

---

### Q: 如何偵測圖被 interrupt 暫停？astream_events 不是沒有特殊事件嗎？

確實，`astream_events` 在圖 interrupt 後**不發出任何特殊事件**，串流靜默結束。必須在串流迴圈結束後主動查詢：

```python
# api.py
async for event in agent.astream_events(initial_state, config=config, version="v2"):
    ...  # 串流在 interrupt 時靜默結束

# 串流結束後查詢：
snapshot = await agent.aget_state(config)
if snapshot and snapshot.next:
    # snapshot.next 不為空 = 有待執行節點 = 圖被暫停
    state_vals = snapshot.values
    ...
```

注意必須用 `await agent.aget_state()`（非同步版本），否則同樣會阻塞 event loop。

本案例中多個 interrupt 節點的判斷順序：

```python
quantity_unknown = state_vals.get("quantity_unknown_items", [])
unresolved = state_vals.get("unresolved_items", [])

if quantity_unknown:
    # ask_quantity_node interrupt
    yield {"event": "quantity_clarify_required", ...}
elif unresolved:
    # clarify_node interrupt
    yield {"event": "product_selection_required", ...}
else:
    # approval_gate_node interrupt
    yield {"event": "approval_required", ...}
```

---

### Q: 本案例有幾個 interrupt 節點？它們的觸發條件是什麼？

本案例實作了**三個 interrupt 節點**，依觸發順序：

| 順序 | 節點 | 觸發條件 | 前端事件 | 恢復端點 |
|------|------|---------|---------|---------|
| 1 | `ask_quantity_node` | 使用者未指定商品數量 | `quantity_clarify_required` | `POST /api/chat/{id}/clarify-quantity` |
| 2 | `clarify_node` | 商品無法唯一比對到目錄 | `product_selection_required` | `POST /api/chat/{id}/select` |
| 3 | `approval_gate_node` | 訂單金額 ≥ 審批門檻（預設 0，即所有訂單） | `approval_required` | `POST /api/orders/{id}/decide` |

完整流程：

```
使用者訊息
    ↓
parse_order_node
    ├── 有未知數量 → ask_quantity_node (interrupt #1)
    │       └── 數量確認後：
    │           ├── 商品模糊 → clarify_node (interrupt #2)
    │           └── 商品明確 → check_inventory_node
    ├── 有模糊商品 → clarify_node (interrupt #2)
    │       └── 選擇後 → check_inventory_node
    └── 全部解析 → check_inventory_node
                    ↓
               calculate_price_node
                    ↓
               approval_gate_node (interrupt #3，門檻 0 → 必觸發)
                    ├── approved → finalize_node → respond_node → END
                    └── rejected → respond_node → END
```

---

### Q: `AsyncSqliteSaver` 必須用 `async with` 初始化，具體怎麼操作？

`AsyncSqliteSaver.from_conn_string()` 返回的是 **async context manager**，必須用 `async with` 開啟。直接使用會報 `'_AsyncGeneratorContextManager' object has no attribute 'get_next_version'`（見下方 Error Q&A）。

本案例的解法（`checkpointer.py` + `api.py` lifespan 模式）：

```python
# checkpointer.py
checkpointer = None   # 模組層級變數，lifespan 設值後全域共用

def get_checkpointer_cm():
    """返回 async context manager，供 lifespan 使用"""
    cp_path = settings.checkpoint_db_path
    os.makedirs(os.path.dirname(cp_path), exist_ok=True)
    return AsyncSqliteSaver.from_conn_string(cp_path)
```

```python
# api.py — lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    async with get_checkpointer_cm() as cp:
        cp_module.checkpointer = cp   # 設定模組層級變數
        init_db()
        yield
    # async with 結束時自動關閉 aiosqlite 連線
```

```python
# agent.py
import checkpointer as cp_module   # import 模組而非值

async def create_agent(self):
    ...
    agent = graph.compile(checkpointer=cp_module.checkpointer)
    # ↑ 每次建立 agent 時才讀取 cp_module.checkpointer，取得 lifespan 設定的實例
    return agent
```

**為什麼要 import 模組而不是 `from checkpointer import checkpointer`？**
`from checkpointer import checkpointer` 在 import 時（lifespan 啟動前）就綁定了 `None`，之後 lifespan 修改模組變數也無法影響已綁定的值。`import checkpointer as cp_module` 則每次使用 `cp_module.checkpointer` 時都會即時查找模組屬性，取得最新值。

---

### Q: `candidate_ids` 是什麼？為什麼要在 LLM 輸出中加這個欄位？

`candidate_ids` 是 `ParsedOrderItem` 中的欄位，讓 LLM 在解析訂單時直接標記「最相關的候選商品 ID」：

```python
# models.py
class ParsedOrderItem(BaseModel):
    product_name: str
    quantity: int = Field(default=1, ge=1)
    quantity_unknown: bool = Field(default=False)
    candidate_ids: list[str] = Field(
        default=[],
        description="當 product_name 模糊時，從目錄中列出最相關的商品ID（最多 5 個）"
    )
```

**為什麼不用字元比對（舊方法）？**

舊版 `_find_candidates()` 計算使用者輸入與商品名稱的字元重疊數。問題：
- 「儲存裝置」與「滑鼠墊」、「螢幕支架」等字元重疊為 0 → 回退展示全部商品
- 語意相關但字元不同的情境完全無效（如英文描述、縮寫）

LLM 本身理解語意，讓它直接列出相關 ID 比字元匹配更精確。

**另一個重要設計**：`candidate_ids` 非空時，跳過 substring 比對：

```python
# agent.py — parse_order_node
matched = None
if not item.candidate_ids:   # LLM 沒有給 candidate_ids → 嘗試 substring 比對
    for p in products:
        if item.product_name in p["name"] or p["name"] in item.product_name:
            matched = p
            break
# LLM 給了 candidate_ids → 代表語意模糊，直接視為 unresolved，不強制 substring 比對
```

---

### Q: `interrupt()` 的參數（payload）要怎麼寫？`type` 欄位有特殊意義嗎？

`interrupt(payload)` 的參數可以是**任意 JSON 可序列化的 Python 值**（dict、str、list 等），LangGraph 不規定格式。它的用途是把「為什麼暫停」的資訊存進 checkpoint，方便外部讀取。

**存取 payload 的兩種方式**：

方式 A：從 `snapshot.tasks` 讀取 interrupt payload（直接取得 interrupt 節點傳入的值）

```python
snapshot = await agent.aget_state(config)
if snapshot and snapshot.next:
    # snapshot.tasks 列出所有待執行任務
    # tasks[0].interrupts[0].value 是 interrupt(payload) 的 payload
    payload = snapshot.tasks[0].interrupts[0].value
    interrupt_type = payload.get("type", "")
    # interrupt_type == "quantity_clarify" / "product_selection" / "order_approval"
```

方式 B：從 `snapshot.values`（state）判斷是哪個節點暫停（本案例採用此方式）

```python
state_vals = snapshot.values
if state_vals.get("quantity_unknown_items"):
    # 一定是 ask_quantity_node interrupt
elif state_vals.get("unresolved_items"):
    # 一定是 clarify_node interrupt
else:
    # 一定是 approval_gate_node interrupt
```

**兩種方式的比較**：

| 方式 | 優點 | 缺點 |
|------|------|------|
| 讀 tasks[0].interrupts[0].value | 直接取得 payload，不依賴 state 結構 | 若多個節點同時暫停需 loop tasks |
| 讀 snapshot.values（state） | 可取得完整上下文（候選清單、訂單明細等） | 需確保 state 欄位命名清楚 |

本案例選擇方式 B，因為決定事件類型的同時，也要從 state 取得完整資料（`unresolved_items` 帶候選清單、`price_details` 帶金額明細）直接放入 SSE payload，一次完成。

**`type` 欄位的意義**：`type` 是**自訂的慣例欄位，LangGraph 完全不解析它**。它只是讓讀取 payload 的程式碼更易懂：

```python
# agent.py — 各節點的 interrupt payload 設計
# 數量確認節點
interrupt({"type": "quantity_clarify", "items": [...]})

# 商品選擇節點
interrupt({"type": "product_selection", "unresolved_items": [...]})

# 審批節點
interrupt({"type": "order_approval", "parsed_items": [...], "price_details": {...}})
```

**Payload 設計原則**：放「描述當前情況所需的最小資訊」。避免放可以從 state 重新計算的資料（節省 checkpoint 儲存空間，減少序列化錯誤風險）。

---

### Q: 現在用 SQLite 所以用 `AsyncSqliteSaver`，未來改成 PostgreSQL 要怎麼做？

LangGraph 的 checkpointer 都遵循相同介面（`BaseCheckpointSaver`），切換只需換 import、換連線字串，**`lifespan` 初始化模式完全不變**。

**切換步驟**：

1. 安裝套件：

```bash
# requirements.txt
langgraph-checkpoint-postgres
psycopg[binary,pool]   # 或 asyncpg（擇一）
```

2. 更換 `checkpointer.py`：

```python
# SQLite 版本（舊）
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

def get_checkpointer_cm():
    return AsyncSqliteSaver.from_conn_string("data/checkpoints.db")

# PostgreSQL 版本（新）
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

POSTGRES_URL = "postgresql://user:password@host:5432/dbname"

def get_checkpointer_cm():
    return AsyncPostgresSaver.from_conn_string(POSTGRES_URL)
```

3. `lifespan` 多一行 `await cp.setup()`：

```python
# api.py — lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    async with get_checkpointer_cm() as cp:
        await cp.setup()   # ← PostgreSQL 需要：在 DB 建立 checkpoint 所需的資料表
                           #   SQLite 版本不需要這行（from_conn_string 已自動建表）
        cp_module.checkpointer = cp
        init_db()
        yield
```

4. `agent.py` 和前端**完全不需要改動**。

**`await cp.setup()` 做了什麼？**

`AsyncPostgresSaver` 使用三張系統資料表儲存 checkpoint 資料：
- `checkpoints` — 每個 thread 的 checkpoint metadata
- `checkpoint_writes` — 各節點的 pending writes
- `checkpoint_blobs` — 實際的 state 序列化資料

`setup()` 負責在 PostgreSQL 中建立這三張表（若已存在則跳過），必須在第一次使用前呼叫。

**SQLite vs PostgreSQL Checkpointer 比較**：

| 面向 | AsyncSqliteSaver | AsyncPostgresSaver |
|------|-----------------|-------------------|
| 套件 | `aiosqlite` | `langgraph-checkpoint-postgres` + `psycopg[binary]` |
| 連線字串 | 本地檔案路徑 | `postgresql://...` |
| 需要 `setup()` | ❌（自動建表） | ✅ 首次使用必須呼叫 |
| 並發支援 | 低（SQLite 寫鎖） | 高（PostgreSQL row-level lock） |
| 生產環境適用 | 開發/單機測試 | ✅ 推薦 |
| Docker compose | 只需 backend | 需要 postgres service |
| lifespan 模式 | 相同 | 相同（多一行 setup） |

**Docker Compose 新增 postgres service**：

```yaml
services:
  backend:
    environment:
      POSTGRES_URL: postgresql://user:pass@postgres:5432/checkpoint_db
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: checkpoint_db
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d checkpoint_db"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

---

## 錯誤排查 Q&A

### Error 1: `thread_id` 在 `finalize_node` 取得到 `None`

**問題描述**：`finalize_node` 呼叫 `state.get("_thread_id")` 取得 `None`，建立訂單時 conversation_id 為 None。

**根本原因**：`_thread_id`（底線開頭）在 TypedDict 中不存在。LangGraph 只將 TypedDict 中宣告的欄位儲存進 checkpoint，沒有宣告的欄位不會被儲存，取值永遠是 default。

**解決方式**：
```python
# agent.py — 在 OrderState TypedDict 中宣告
class OrderState(TypedDict):
    thread_id: str   # ← 必須在這裡宣告
    ...

# api.py — 初始 state 設值
initial_state = {
    "thread_id": conversation_id,
    ...
}

# finalize_node 中正確取值
thread_id = state.get("thread_id", "unknown")
```

---

### Error 2: `The SqliteSaver does not support async methods`

**問題描述**：使用 `SqliteSaver` 時，在 FastAPI async endpoint 中呼叫 `agent.astream_events()` 報此錯誤。

**根本原因**：`SqliteSaver` 使用同步的 `sqlite3`，無法在 async context 中使用。

**解決方式**：
1. 改用 `AsyncSqliteSaver`
2. 在 `requirements.txt` 加入 `aiosqlite`
3. 所有 `agent.get_state()` 改為 `await agent.aget_state()`

```python
# requirements.txt
aiosqlite==0.20.0

# checkpointer.py
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
```

---

### Error 3: `'_AsyncGeneratorContextManager' object has no attribute 'get_next_version'`

**問題描述**：將 `AsyncSqliteSaver.from_conn_string()` 的回傳值直接當作 checkpointer 使用，在 `graph.compile(checkpointer=...)` 時報此錯誤。

**根本原因**：`from_conn_string()` 回傳的是 **async context manager**（`_AsyncGeneratorContextManager`），不是 checkpointer 實例本身。必須用 `async with` 進入後才能得到真正的 checkpointer。

**錯誤寫法**：
```python
# ❌ 錯誤：直接用 context manager 當 checkpointer
checkpointer = AsyncSqliteSaver.from_conn_string("data/checkpoints.db")
agent = graph.compile(checkpointer=checkpointer)  # 報錯
```

**正確寫法**：見上方「AsyncSqliteSaver 初始化」Q&A，使用 lifespan + 模組層級變數模式。

---

### Error 4: LLM 使用不存在的商品名稱（如「4K顯示器」、「USB-C傳輸線」）

**問題描述**：商品目錄中只有「27吋螢幕」和「USB集線器」，但 LLM 解析後分別輸出「4K顯示器」、「USB-C傳輸線」，導致 substring 比對失敗，訂單無法處理。

**根本原因**：LLM prompt 未提供商品目錄，或未明確要求使用目錄中的實際名稱。

**解決方式**：
1. 在 LLM prompt 中列出完整商品目錄（含 ID、名稱、分類、價格）
2. 明確指示「若能清楚對應目錄中某個商品，product_name 填入目錄中的實際名稱」

```python
product_list_str = "\n".join([
    f"  - ID:{p['id']} {p['name']}（{p['category']}，NT${p['price']:.0f}）"
    for p in products
])
```

---

### Error 5: `is_valid=false` 被 LLM 用在「商品描述模糊」的情境

**問題描述**：輸入「提升電腦效能的零件」，LLM 返回 `is_valid=false`，系統回應「訂單處理失敗」。

**根本原因**：原 prompt 要求「沒有數量資訊」時 `is_valid=false`，LLM 誤解為「不確定商品時」也應 `is_valid=false`。

**解決方式**：明確列舉 `is_valid=false` 的條件，只限「完全無商品描述」一種情況：

```python
"is_valid=false 只用於以下情況：\n"
"   使用者完全沒有說要買什麼（如「我要買東西」、「幫我訂一些東西」）\n"
"   只要有任何商品描述（即使沒有數量），就必須返回 items，is_valid=true"
```

---

### Error 6: 商品選擇卡片顯示全部商品（不相關的也出現）

**問題描述**：輸入「我要買 2 個電腦儲存裝置」，商品選擇卡片中出現全部 10 個商品，而不是相關的幾個。

**根本原因**：舊版 `_find_candidates()` 使用字元集合重疊計分。「儲存裝置」與大多數商品字元重疊為 0（overlap=0），觸發了「無重疊時展示全部商品」的 fallback。

**解決方式**：為 `ParsedOrderItem` 加入 `candidate_ids: list[str]` 欄位，讓 LLM 在解析時直接標記語意相關的商品 ID。字元比對方式保留作 fallback（LLM 未提供 `candidate_ids` 時使用）。

詳見上方「candidate_ids 是什麼？」Q&A。

---

### Error 7: 使用者未指定數量時直接使用預設值 1 完成訂單

**問題描述**：輸入「我想買鍵盤」（未說數量），系統直接以數量 1 建立訂單，未詢問使用者。

**根本原因**：原 prompt 設定「無數量時 `is_valid=false`」，後改為「預設數量 1」，但都沒有詢問使用者確認。

**解決方式**：加入 `quantity_unknown` 欄位和 `ask_quantity_node`：

```python
# models.py
class ParsedOrderItem(BaseModel):
    quantity: int = Field(default=1, ge=1)
    quantity_unknown: bool = Field(default=False)  # 使用者未指定數量時 True

# agent.py — OrderState
quantity_unknown_items: list[dict]  # 未指定數量的品項列表

# routing
def route_after_parse(state):
    if state.get("quantity_unknown_items"):
        return "ask_quantity_node"   # 先問數量
    if state.get("unresolved_items"):
        return "clarify_node"        # 再問商品
    return "check_inventory_node"
```

`ask_quantity_node` 使用 `interrupt()` 暫停，前端顯示 `QuantityClarify` 卡片，使用者填入數量後 resume。
