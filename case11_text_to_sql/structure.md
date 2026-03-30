# Case 11 專案架構說明

## 整體概念

這個案例要做一件事：**使用者說人話，後端自動變成 SQL 去查資料庫，再把結果翻譯成人話回傳**。

整個資料流長這樣：

```
使用者輸入問題
    ↓  (HTTP POST /api/chat)
後端 api.py 收到請求
    ↓
啟動 LangGraph Agent (agent.py)
    ↓  5 個節點依序處理
    classify → generate → validate → execute → format
    ↓  每個關鍵步驟透過 SSE 事件推送給前端
前端 Chat.tsx 即時更新畫面
    ↓
SqlViewer 顯示 SQL，泡泡顯示自然語言回答
```

---

## 資料夾結構

```
case11_text_to_sql/
│
├── backend/               ← Python 後端
│   ├── api.py             ← FastAPI 入口，處理 HTTP 與 SSE
│   ├── agent.py           ← LangGraph 5 節點 pipeline
│   ├── database.py        ← PostgreSQL 連線 + 3 張資料表定義
│   ├── config.py          ← 設定（連線字串、schema 名稱）
│   ├── models.py          ← Pydantic 資料結構（request/response）
│   ├── seed_data.py       ← 將 seed_data.json 寫入 PostgreSQL
│   ├── seed_data.json     ← 測試資料（10 產品、29 異動、300 快照）
│   └── prompts/           ← 給 LLM 看的 3 份素材
│       ├── schema_info.txt    ← 資料庫表結構說明
│       ├── alias_map.json     ← 業務術語 → SQL 對應表
│       └── few_shot.json      ← 7 個問答範例
│
├── frontend/              ← React 前端
│   └── src/
│       ├── Chat.tsx       ← 主元件：聊天介面 + SSE 解析
│       ├── Chat.css       ← 樣式
│       ├── SqlViewer.tsx  ← SQL 展示元件（可折疊）
│       └── SqlViewer.css
│
├── docker-compose.yaml    ← 3 個容器：postgres + backend + frontend
├── Dockerfile.backend
├── Dockerfile.frontend
└── .env.example
```

---

## 後端：各檔案的職責

### config.py — 設定中心

```python
postgres_url: str = "postgresql+psycopg://appuser:inv_secure_2024@case11-postgres:5432/inventorydb"
db_schema: str = "inventory"
```

**注意兩個重點**：
- URL 前綴是 `postgresql+psycopg://`（psycopg3 的寫法），不是 `postgresql://`（psycopg2）
- `case11-postgres` 是 Docker 容器名稱；本機開發要換成 `localhost`（需要先開放 postgres port）

### database.py — 資料表定義

```python
metadata = MetaData(schema=settings.db_schema)   # schema="inventory"

products       = Table("products", metadata, ...)
stock_changes  = Table("stock_changes", metadata, ...)
daily_snapshots = Table("daily_snapshots", metadata, ...)
```

**`MetaData(schema="inventory")` 的效果**：所有表名自動加前綴，變成 `inventory.products`、`inventory.stock_changes`、`inventory.daily_snapshots`。不用每次手動寫 schema 名稱。

`init_db()` 做兩件事：
1. `CREATE SCHEMA IF NOT EXISTS inventory`（確保 schema 存在）
2. `metadata.create_all(engine)`（建立三張表）

### models.py — 資料結構

四個 Pydantic 類別，主要關注 `ChatRequest`：

```python
class LlmConfig(BaseModel):
    api_key: str
    model: str = "gpt-4o-mini"
    base_url: str = "https://api.openai.com/v1"
    temperature: float = 0.1    # SQL 生成要低 temperature，才不會亂發揮

class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None   # None = 新對話
    llm_config: LlmConfig          # API Key 每次從前端帶過來，不存在後端
```

### api.py — 入口與 SSE

啟動時（`lifespan`）自動呼叫 `init_db()`，確保資料表存在。

對話記錄（`conversations` 和 `messages` 兩張表）也建在同一個 PostgreSQL、同一個 `inventory` schema 裡面，用 `_conv_meta = MetaData(schema=settings.db_schema)` 另外定義。

主要端點 `POST /api/chat` 用 `EventSourceResponse` 回傳 SSE 串流，其餘端點（列出/取得/刪除對話）是普通 JSON API。

**Agent 快取邏輯**（`api.py:84`）：

```python
cache_key = f"{llm_config.api_key[:8]}:{llm_config.model}"
```

同一組 API Key + 模型只建立一次 Agent 實例，避免重複編譯 LangGraph。

---

## 核心：agent.py — 5 節點 Pipeline

### State 設計

```python
class Text2SQLState(TypedDict):
    messages:       list          # 對話歷程（LangGraph 標準）
    question:       str           # 使用者原始問題
    query_type:     str           # "realtime" 或 "historical"
    schema_context: str           # 注入的 schema 說明文字
    sql_query:      str           # 生成的 SQL
    sql_error:      str           # 空字串=無錯誤，否則是錯誤訊息
    sql_result:     str           # JSON 字串格式的查詢結果
    retry_count:    int           # 已重試次數（最多重試 2 次）
    final_answer:   str           # 最終回答
```

State 貫穿所有節點，每個節點從 state 讀資料、把結果寫回 state。

### 5 個節點

```
classify_node
    ↓
sql_generate_node  ←──────────────────┐
    ↓                                  │ 執行失敗 + retry_count < 2
sql_validate_node                      │
    ↓ (VALIDATION_ERROR → format)      │
sql_execute_node ──────────────────────┘
    ↓ (成功 or 重試耗盡)
format_node
    ↓
END
```

**節點 1：classify_node（`agent.py:156`）**

最簡單的節點。只用一個 LLM 呼叫，問它：「這個問題是查即時資料還是歷史資料？」
LLM 只能回傳 `realtime` 或 `historical`。

```python
query_type = "historical" if "historical" in raw else "realtime"
```

判斷方式是找關鍵字，不是完全匹配，所以 LLM 就算多說了一個字也不會壞掉。

---

**節點 2：sql_generate_node（`agent.py:178`）**

最重要的節點，把三份素材拼成 prompt：

```
[schema_info.txt]   → 告訴 LLM 有哪些表、哪些欄位
[alias_map.json]    → 告訴 LLM 業務術語的 SQL 寫法
[few_shot.json]     → 給幾個例子讓 LLM 模仿格式
[使用者問題]
[錯誤訊息（重試時才有）]
```

如果是在重試（`sql_error` 有值且不是 VALIDATION_ERROR），會把上次的錯誤訊息夾進去：

```python
error_hint = f"\n=== 上次執行錯誤（請修正）===\n{state['sql_error']}\n"
```

LLM 看著自己的錯誤重新生成 SQL，這就是「自修正」。

另外要清除 LLM 可能多加的 markdown 圍籬（` ```sql ... ``` `）：
```python
if sql.startswith("```"):
    lines = sql.split("\n")
    sql_lines = lines[1:-1] if lines[-1].strip() == "```" else lines[1:]
    sql = "\n".join(sql_lines)
```

---

**節點 3：sql_validate_node（`agent.py:205`）**

純 Python，**不呼叫 LLM**，速度快。

兩個檢查：
1. SQL 必須以 `SELECT` 開頭
2. 不能含有 `INSERT`、`UPDATE`、`DELETE`、`DROP` 等危險關鍵字

驗證失敗時，`sql_error` 的值會以 `"VALIDATION_ERROR:"` 開頭，這個前綴是路由判斷的依據。

---

**節點 4：sql_execute_node（`agent.py:229`）**

實際對 PostgreSQL 執行 SQL：

```python
with engine.connect() as conn:
    result = conn.execute(text(sql))
    columns = list(result.keys())
    rows = [{col: str(val) if val is not None else None ...}]
return {"sql_result": json.dumps(rows, ensure_ascii=False), "sql_error": ""}
```

**所有值轉成字串**（`str(val)`），因為 PostgreSQL 回傳的 `Decimal`、`datetime`、`date` 等型別無法直接 JSON 序列化，轉字串可以統一處理。

執行失敗時 `retry_count += 1`，路由函數判斷是否重試。

---

**節點 5：format_node（`agent.py:250`）**

三條路徑：
1. `sql_error` 以 `"VALIDATION_ERROR:"` 開頭 → 直接輸出「SQL 驗證未通過」訊息
2. `sql_error` 有值（執行失敗，且重試耗盡） → 輸出「已重試 N 次，執行失敗」
3. 查詢成功 → 把問題 + 結果給 LLM，請它用繁體中文回答

成功路徑最多傳 50 筆資料給 LLM（`rows[:50]`），避免 context 太長。

---

### 兩個路由函數

**route_after_validate（`agent.py:284`）**：
```python
return "format" if state.get("sql_error","").startswith("VALIDATION_ERROR") else "execute"
```
驗證失敗 → 直接 format（不執行危險 SQL）。

**route_after_execute（`agent.py:289`）**：
```python
return "generate" if (state.get("sql_error") and state.get("retry_count",0) < 2) else "format"
```
執行失敗且重試次數 < 2 → 回到 generate 重試；否則 → format 輸出錯誤。

---

## Prompts 資料夾：給 LLM 看的素材

### schema_info.txt

白話解釋資料表結構給 LLM：每個欄位的名稱、型別、用途、範例資料，以及常用的查詢模式範例（4 種典型 SQL）。

重要的是最後的注意事項：
- 所有表名必須加 `inventory.` 前綴
- 日期函數用 PostgreSQL 語法（`NOW()`、`INTERVAL 'N days'`、`DATE_TRUNC`）

### alias_map.json

把業務術語翻譯成明確的 SQL 表達，讓 LLM 不用猜：

```json
"庫存不足": "quantity < min_stock  (或 current_stock < min_stock)",
"庫存不足比例": "COUNT(*) FILTER(WHERE quantity < min_stock) * 100.0 / COUNT(*)"
```

在 `agent.py:69` 的 `_format_alias_map()` 把它格式化成條列文字注入 prompt。

### few_shot.json

7 個「問題 → SQL」的對應範例，每個都標了 `query_type`。

`_format_few_shot()`（`agent.py:55`）會依照當前的 `query_type` 過濾出相關範例：

```python
examples = [ex for ex in FEW_SHOT if ex.get("query_type") == query_type]
```

`realtime` 的問題就只看 `realtime` 範例，避免互相干擾。

---

## 資料庫：3 張表的設計邏輯

```
products          → 產品主檔，current_stock 是「現在」的庫存量
stock_changes     → 每次入庫/出庫/調整的記錄（只記事件，不記快照）
daily_snapshots   → 每天結束時的庫存量快照（預計算好的歷史狀態）
```

**為什麼要 daily_snapshots？**

如果要查「過去 30 天有幾天庫存不足」，從 `stock_changes` 反推需要：
1. 對每一天，找當天之前所有的 `in` 和 `out` 記錄
2. 用期初庫存 + 入庫 - 出庫算出當天庫存
3. 判斷是否 < min_stock

這種 SQL 又長又難，LLM 很難寫對。

有了 `daily_snapshots`，直接查 `quantity < min_stock` 就能知道那天是否不足，SQL 簡單到 LLM 幾乎不會出錯。

**seed_data.json 的資料量**：
- 10 個產品（電子產品、辦公用品、家具三個分類）
- 29 筆 stock_changes（各種入庫/出庫）
- 300 筆 daily_snapshots（10 個產品 × 30 天，2026-03-01 到 2026-03-30）

其中有幾個產品的 `current_stock < min_stock`（意圖讓即時查詢有結果）。

---

## SSE 事件設計

後端在 `api.py` 用 `astream_events v2` 監聽 Agent 內部事件，轉換成前端能接收的 SSE：

| SSE 事件 | 後端觸發條件 | 說明 |
|----------|------------|------|
| `sql_query` | `on_chain_end` + `name == "generate"` | SQL 生成完成，帶 sql/query_type/attempt |
| `token` | `on_chat_model_stream` + `node == "format"` | format_node 逐字串流 |
| `done` | Agent 執行結束 | 帶 conversation_id 和完整回應 |
| `error` | 例外捕捉 | 帶錯誤訊息 |

**`sql_attempt` 計數**（`api.py:136`）：

在 api.py 這層用一個普通變數計數，每次收到 `on_chain_end + name=="generate"` 就 +1。重試時 Agent 會再次執行 generate 節點，api.py 就會再收到一次這個事件，`sql_attempt` 自然變成 2，前端 SqlViewer 就顯示「重試 #2」。

**query_type 的傳遞問題**：

`generate` 節點執行完成時，`on_chain_end` 的 output 只有 `generate` 節點自己的輸出（`{sql_query, sql_error}`），不包含 `query_type`（那是 classify 節點寫的）。所以 `sql_query` 事件的 `query_type` 在目前實作中會是空字串，前端 SqlViewer 用 fallback 處理（沒有 badge 或顯示未知）。這是一個可改善的點。

---

## 前端：Chat.tsx 的關鍵設計

### assistantIdx 固定

```javascript
const assistantIdx = messages.length + 1   // 在所有 setState 之前先算好
setMessages(prev => [
    ...prev,
    { role: 'user', content: text },
    { role: 'assistant', content: '' },   // 先插入空的 assistant 訊息
])
```

`assistantIdx` 要在 `setMessages` 之前算好並固定下來，後面所有更新 assistant 訊息的地方都用這個 index，不能在 callback 裡重新計算（否則受到非同步 setState 影響會拿到錯誤的 index）。

### SSE 解析

```javascript
} else if (line.trim() === '') {   // 空行 = 一個 SSE 訊息的結束
    if (sseEvent && sseDataLines.length > 0) {
        dispatch(sseEvent, sseDataLines.join('\n'))
    }
    sseEvent = ''
    sseDataLines = []
}
```

用 `line.trim() === ''` 而不是 `line === ''`，目的是同時相容 `\n` 和 `\r\n` 換行格式。

### sql_query 事件 → SqlViewer

```javascript
if (eventType === 'sql_query') {
    setMessages(prev => {
        const updated = [...prev]
        updated[assistantIdx] = {
            ...updated[assistantIdx],
            sqlInfo: { sql: data.sql, queryType: data.query_type, attempt: data.attempt }
        }
        return updated
    })
}
```

`sql_query` 事件到來時，把 `sqlInfo` 塞進 assistant 訊息。渲染時：

```tsx
{msg.role === 'assistant' && msg.sqlInfo && (
    <SqlViewer sqlInfo={msg.sqlInfo} />   // 顯示在泡泡上方
)}
```

### done 事件的 content fallback

```javascript
if (data.content) {
    setMessages(prev => {
        const msg = updated[assistantIdx]
        if (!msg || msg.content) return prev   // 已有 token 串流就不覆蓋
        updated[assistantIdx] = { ...msg, content: data.content }
        return updated
    })
}
```

`done` 事件的 `content` 是 fallback，只有在 `token` 串流沒有內容時才使用（防止 format_node 沒有串流時畫面空白）。

---

## SqlViewer.tsx — SQL 展示元件

```tsx
interface SqlInfo {
    sql: string
    queryType: string   // "realtime" | "historical" | ""
    attempt: number
}
```

三個顯示邏輯：
1. **查詢類型 badge**：`realtime` 顯示藍色「即時查詢」，`historical` 顯示紫色「歷史分析」
2. **重試 badge**：`attempt > 1` 時顯示黃色「重試 #N」
3. **SQL 展開**：點擊 header 切換展開/收合，展開後顯示 SQL 原始文字

---

## Docker 架構

```
docker-compose.yaml 定義 3 個服務：

case11-postgres  → postgres:15
                   - 帳號：appuser / inv_secure_2024 / inventorydb
                   - 無對外 port（只有容器內部可以連）
                   - healthcheck 確認 pg_isready 之後才讓 backend 啟動

case11-backend   → depends_on: case11-postgres (condition: service_healthy)
                   - 等 postgres 健康才啟動，避免連線失敗

case11-frontend  → nginx 服務靜態檔案，proxy /api/ 到 backend:8000
                   - 對外 port 由 .env 的 FRONTEND_PORT 決定（預設 8017）
```

**本地執行 seed_data.py**：postgres 沒有對外 port，所以直接在 backend 容器裡執行：
```bash
docker exec case11-backend python seed_data.py
```

---

## 容易踩到的坑

### 1. psycopg 版本問題

- `psycopg2-binary`（舊版）：URL 前綴 `postgresql://`
- `psycopg[binary]`（新版 v3）：URL 前綴必須是 `postgresql+psycopg://`

本案例用新版，所以 `config.py` 和 `seed_data.py` 的 URL 都要用 `postgresql+psycopg://`。

### 2. LLM 生成 SQL 可能多加 markdown

```python
if sql.startswith("```"):   # agent.py:197
```

要清除，否則 SQL 執行時會報語法錯誤。

### 3. SQLAlchemy 結果無法直接 JSON 序列化

PostgreSQL 回傳的 `Decimal`、`datetime`、`date` 要先 `str(val)` 轉換（`agent.py:241`），否則 `json.dumps` 會拋出例外。

### 4. `on_chain_end` 的 output 只包含該節點的輸出

`generate` 節點的 `on_chain_end` output 只有 `{sql_query, sql_error}`，讀不到 `query_type`（那是 `classify` 節點設定的）。要拿到完整 state 需要監聽不同的事件類型。

### 5. retry_count 初始值要在輸入 state 裡明確給 0

```python
# api.py:155
{
    "retry_count": 0,   # 必須明確給初始值，否則 sql_execute_node 的 +1 會出錯
    ...
}
```
