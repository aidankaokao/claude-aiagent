# Case 3: 進階工具開發 — 教學文件

## 前置知識

完成 [Case 2: ReAct Agent](./case2_react_agent.md) 後再進行本 Case。

---

## 概念說明

### Case 3 學習什麼？

Case 2 的工具用最簡單的 `@tool` 定義，僅依賴 docstring 說明參數。Case 3 引入三個進階概念：

| 概念 | Case 2 | Case 3 |
|------|--------|--------|
| 工具參數定義 | 函式 type hint | Pydantic `BaseModel` + `Field` |
| 工具操作對象 | 靜態資料 / 計算 | SQLite 資料庫 CRUD |
| 工具間協作 | 獨立工具 | 工具輸出作為另一工具的輸入 |

### Pydantic args_schema 的作用

```python
class UpdateStockInput(BaseModel):
    product_id: int = Field(
        description="要更新的產品 ID（可從 query_inventory 結果中取得）"
    )
    change_amount: int = Field(
        description="庫存異動數量。正數表示入庫（增加），負數表示出庫（減少）"
    )

@tool(args_schema=UpdateStockInput)
def update_stock(product_id: int, change_amount: int) -> str: ...
```

`bind_tools()` 會將 `args_schema` 的欄位名稱、型別、`Field(description=...)` 序列化成 JSON Schema，附加到每次 LLM 請求。LLM 在「閱讀這份說明書」後生成正確的 `tool_calls` 參數。

### 多工具協作的核心機制

多工具之間沒有任何直接傳遞資料的程式碼——一切靠 **ReAct 迴圈 + 對話歷史**：

```
第 1 輪 llm_node：
  → tool_calls: query_inventory(low_stock_only=true)

ToolNode 執行 → ToolMessage:
  "[ID:2] 智慧型手機 | 庫存：8 / 安全庫存：10 ..."

第 2 輪 llm_node：  ← 此時 messages 包含上面那則 ToolMessage
  LLM 讀到 "[ID:2]" → 判斷 product_id = 2
  → tool_calls: calculate_reorder(product_id=2, days_to_cover=30, ...)

第 3 輪 llm_node：
  整合所有 ToolMessage → 生成最終答案 → END
```

工具輸出進入 `state["messages"]`，LLM 在下一輪自然語言理解時提取所需參數。這就是為什麼工具輸出格式要設計得夠清楚（如 `[ID:2]`）。

### 雙模式設計（OpenAI vs Ollama）

Case 3 的 `agent.py` 依 `base_url` 自動偵測使用環境，採用不同策略：

```
base_url 含 localhost 或 127.0.0.1？
         │
    是（Ollama）        否（OpenAI）
         │                   │
  補強模式              標準模式
  ┌──────────────┐     ┌──────────────┐
  │ System Prompt │     │ bind_tools   │
  │ 意圖分類      │     │ ALL_TOOLS    │
  │ 動態 bind     │     └──────────────┘
  └──────────────┘
```

**為什麼需要補強？** 弱模型（如本地 Llama、Qwen）在面對 4 個工具時容易選錯，或忘記先查詢就亂填 `product_id`。補強策略：

1. **注入 System Prompt**：明確告知工具用途與使用規則（如「需要 product_id 時必須先呼叫 query_inventory」）
2. **意圖分類**：關鍵字分析使用者訊息，從「4 選 1」縮小為「1~2 選 1」，大幅降低選錯工具機率

---

## 實踐內容

### 資料夾結構

```
case3_tool_development/
  backend/
    agent.py          # InventoryAgent：雙模式 ReAct（本 Case 重點）
    tools/
      __init__.py     # ALL_TOOLS 集中匯出
      inventory.py    # query_inventory, update_stock（DB CRUD）
      weather.py      # get_weather_forecast（模擬天氣 API）
      calculator.py   # calculate_reorder（計算補貨量）
    api.py            # FastAPI + SSE + GET /api/inventory
    database.py       # 5 張表：products, stock_changes, conversations 等
    models.py         # Pydantic schemas（含 ProductResponse.status）
    config.py         # 環境變數
    seed_data.py      # 50 個產品模擬資料（10 個刻意設為庫存不足）
    requirements.txt
  frontend/
    src/
      App.tsx
      Chat.tsx          # 新增：庫存面板觸發機制
      Chat.css
      InventoryTable.tsx # 即時庫存資料表（本 Case 新增）
      InventoryTable.css
      main.tsx
    ...
  docker-compose.yaml
  Dockerfile.backend
  Dockerfile.frontend
  .env.example
  qa.md
```

---

## 程式碼導讀

### 1. 工具參數 Schema（`backend/tools/inventory.py`）

```python
class QueryInventoryInput(BaseModel):
    keyword: str = Field(
        default="",
        description="搜尋關鍵字（產品名稱），留空則列出全部產品"
    )
    category: Optional[str] = Field(
        default=None,
        description="分類篩選，可選值：電子產品、文具、食品、服飾、家居"
    )
    low_stock_only: bool = Field(
        default=False,
        description="設為 True 則只回傳庫存量低於安全庫存的產品"
    )

@tool(args_schema=QueryInventoryInput)
def query_inventory(...) -> str:
    """
    查詢庫存中的產品資訊。

    【Few-Shot 範例】
    輸入：{"keyword": "手機", "low_stock_only": false}
    輸出：[ID:2] 智慧型手機（電子產品） | 庫存：8 / 安全庫存：10 ...
    注意：回傳中的 [ID:X] 就是 update_stock 和 calculate_reorder 所需的 product_id。
    """
```

Few-Shot 範例寫在 docstring 裡，讓弱模型從具體例子學會如何讀取 `product_id`。

### 2. 範圍驗證（`backend/tools/calculator.py`）

```python
class CalculateReorderInput(BaseModel):
    days_to_cover: int = Field(
        description="需要備貨的天數",
        ge=1,    # ≥ 1
        le=365,  # ≤ 365
    )
    daily_demand: float = Field(
        description="每日預估銷售量",
        gt=0,    # > 0（必須正數）
    )
```

`ge`、`le`、`gt`、`lt` 在工具被呼叫前由 Pydantic 自動驗證，非法輸入直接回傳驗證錯誤給 LLM，不會進入工具函式。

### 3. 雙模式 Agent（`backend/agent.py`）

```python
def _is_local_model(base_url: str) -> bool:
    """Ollama 預設在 localhost:11434，以 base_url 判斷是否為本地模型"""
    return "localhost" in base_url or "127.0.0.1" in base_url

def _classify_intent(message: str) -> list:
    """關鍵字意圖分類：縮小弱模型每輪的工具選擇範圍"""
    msg = message.lower()
    if any(k in msg for k in ["天氣", "weather", "颱風"]):
        return [get_weather_forecast]           # 只開放天氣工具
    if any(k in msg for k in ["更新", "入庫", "出庫"]):
        return [query_inventory, update_stock]  # 需要先查詢才能更新
    if any(k in msg for k in ["補貨", "採購"]):
        return [query_inventory, calculate_reorder]
    if any(k in msg for k in ["查詢", "庫存", "清單"]):
        return [query_inventory]
    return ALL_TOOLS  # 意圖不明確 → 全部工具

class InventoryAgent:
    def __init__(self, llm_config):
        self.is_local = _is_local_model(llm_config.base_url)
        self.base_llm = ChatOpenAI(...)   # 不預先 bind_tools
        if not self.is_local:
            self.llm = self.base_llm.bind_tools(ALL_TOOLS)  # 標準模式：預綁定

    async def create_agent(self):
        async def llm_node(state):
            if is_local:
                # 補強模式：注入 System Prompt + 動態綁定意圖相關工具
                last_human_msg = next(
                    (m.content for m in reversed(state["messages"])
                     if isinstance(m, HumanMessage)), ""
                )
                active_tools = _classify_intent(last_human_msg)
                local_llm = self.base_llm.bind_tools(active_tools)
                msgs = [_ENHANCED_SYSTEM_PROMPT] + list(state["messages"])
                response = await local_llm.ainvoke(msgs)
            else:
                # 標準模式：直接推理
                response = await self.llm.ainvoke(state["messages"])
            return {"messages": [response]}

        # ToolNode 永遠使用 ALL_TOOLS：意圖分類只影響「LLM 看到哪些工具」，
        # 不影響「工具執行」——只要 LLM 產出了 tool_call，就必須能執行
        tool_node = ToolNode(ALL_TOOLS)
```

### 4. 庫存表觸發機制（`frontend/src/Chat.tsx`）

```typescript
const [inventoryRefreshTrigger, setInventoryRefreshTrigger] = useState(0)

// 在 SSE 事件處理中
case 'tool_end':
  if (data.tool_name === 'update_stock') {
    // 庫存有異動 → 讓 InventoryTable 重新 fetch
    setInventoryRefreshTrigger(n => n + 1)
  }
  break
```

```tsx
// 右側面板：inventoryOpen 時顯示，傳入 trigger 讓子元件知道需要重新載入
{inventoryOpen && <InventoryTable refreshTrigger={inventoryRefreshTrigger} />}
```

```typescript
// InventoryTable.tsx
useEffect(() => {
  fetchInventory()  // trigger 變化時重新載入
}, [refreshTrigger])
```

### 5. API 端點（`backend/api.py`）

除了 SSE 聊天端點，Case 3 新增了一個 REST 端點供前端庫存表使用：

```python
@app.get("/api/inventory", response_model=list[ProductResponse])
async def get_inventory(db: Engine = Depends(get_db)):
    """回傳所有產品資訊，包含計算後的庫存狀態（low/normal/high）"""
    with db.connect() as conn:
        rows = conn.execute(select(products).order_by(products.c.category)).fetchall()
    return [ProductResponse(..., status=compute_status(r)) for r in rows]
```

---

## 執行方式

### 初始化資料庫

```bash
cd case3_tool_development/backend
pip install -r requirements.txt

# 建立資料庫並填入 50 個測試產品
python seed_data.py

# 啟動後端
python api.py
```

### 本地開發

```bash
# 前端（另開終端機）
cd case3_tool_development/frontend
npm install
npm run dev
```

### Docker 部署

```bash
docker network create aiagent-network  # 已存在則跳過

cd case3_tool_development
cp .env.example .env     # 填入 DEVELOPER_NAME
docker-compose up -d
```

前端：`http://localhost:3003`，後端：`http://localhost:8003`

---

## 測試驗證

啟動後點擊右上角「庫存」按鈕，確認 50 個產品的庫存表正常顯示（紅色標示庫存不足）。

### 測試多工具協作

| 問題 | 預期工具呼叫順序 |
|------|----------------|
| 查詢庫存不足的產品 | `query_inventory(low_stock_only=true)` |
| 幫我把智慧型手機入庫 50 件 | `query_inventory` → `update_stock` |
| 智慧型手機需要補多少貨才夠用 30 天？ | `query_inventory` → `calculate_reorder` |
| 台北今天天氣如何？適合出貨嗎？ | `get_weather_forecast` |
| 查詢庫存不足的產品，並計算 30 天補貨量（每日需求 2 件） | `query_inventory` → `calculate_reorder`（多次） |

### 驗證重點

1. **庫存更新後即時刷新**：執行入庫/出庫後，右側庫存表應自動更新數字
2. **product_id 正確傳遞**：Agent 應從 `query_inventory` 的輸出中讀取 `[ID:X]` 再傳給後續工具，不應憑空填入
3. **錯誤處理**：嘗試「把 ID=99 的產品入庫 10 件」，Agent 應回報找不到該產品
4. **Ollama 模式**（若有安裝）：將 base_url 改為 `http://localhost:11434/v1`，Agent 應自動切換補強模式

---

## 延伸挑戰

1. **新增工具**：實作一個 `bulk_update_stock` 工具，一次更新多個產品的庫存（參數為 list）
2. **改善工具輸出**：修改 `query_inventory` 的回傳格式，在每筆產品後加上「若要更新庫存，請使用 product_id=X」的提示
3. **工具快取**：查詢工具每次都打 DB，嘗試加入簡單的記憶體快取（TTL 60 秒）
4. **測試意圖分類**：修改 `_classify_intent`，加入更多關鍵字，並測試哪些使用者輸入會進入「意圖不明確」分支
5. **合併工具**：實作 `query_and_reorder(product_name, days, daily_demand)` 複合工具，內部自動呼叫查詢和計算邏輯（對比單獨工具的差異）
