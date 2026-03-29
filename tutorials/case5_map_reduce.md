# Case 5 — Map-Reduce Agent 教學文件

## 前置知識

請先完成 Case 1（StateGraph 基礎）、Case 2（ReAct 工具呼叫）、Case 4（Plan-Execute，熟悉擴展 State 設計）。

---

## 1. 概念說明

### Map-Reduce vs Plan-Execute

| 維度 | Plan-Execute（Case 4）| Map-Reduce（本 Case）|
|------|------|------|
| 執行方式 | 線性，一步完成才進下一步 | **並行**，N 份文件同時分析 |
| 適用情境 | 有相依性的多步驟任務 | 對大量同質物件做相同操作 |
| 核心機制 | planner 生成步驟清單 | `Send()` 動態扇出 |
| 結果累積 | `operator.add` 逐步累加 | `operator.add` 並行累加 |

### Map-Reduce 架構

```mermaid
flowchart LR
    START --> intake_node
    intake_node -->|fan_out: Send × N| analyze_node
    analyze_node -->|全部完成後| reduce_node
    reduce_node --> END
```

**Map 階段**：`fan_out` 為每份文件建立一個 `Send()`，LangGraph 並行執行所有 `analyze_node` 實例。

**Reduce 階段**：等所有 `analyze_node` 完成後，`reduce_node` 將所有分析結果整合為跨文件報告。

---

## 2. 核心概念

### 2.1 `Send()` API — 動態扇出

```python
from langgraph.types import Send

def fan_out(state: MapReduceState) -> list[Send]:
    return [
        Send("analyze_node", {
            "document": doc,
            "query": state["query"],
        })
        for doc in state["documents"]
    ]

graph.add_conditional_edges("intake_node", fan_out, ["analyze_node"])
```

`fan_out` 作為 `conditional_edges` 的路由函式，但回傳的不是字串，而是 **`list[Send]`**。每個 `Send("analyze_node", payload)` 告訴 LangGraph：「用 payload 作為輸入，啟動一個 analyze_node 實例」。LangGraph 接收到 list[Send] 後，**並行執行所有實例**。

### 2.2 `operator.add` 如何聚合並行結果

```python
class MapReduceState(TypedDict):
    analyses: Annotated[list[dict], operator.add]  # 並行累積
```

每個 `analyze_node` 回傳：
```python
return {"analyses": [{"doc_id": "doc_001", "summary": "...", ...}]}
```

LangGraph 對每個並行節點的回傳值都執行一次 `operator.add`（即 list + list），結果：
- 10 個並行節點 → `analyses` 最終有 10 筆記錄
- 累積順序**不保證**（依完成時間），`reduce_node` 需自行排序

### 2.3 `analyze_node` 接收 `Send()` 的 payload

`analyze_node` 透過 `Send()` 被呼叫，收到的 state 就是 Send 中傳入的 payload：

```python
async def analyze_node(state: dict):
    document = state["document"]   # Send() 傳入的
    query = state["query"]         # Send() 傳入的

    # 使用 with_structured_output 確保結構化輸出
    result: DocumentAnalysis = await analysis_llm.ainvoke([...])

    return {
        "analyses": [{"doc_id": document["id"], ...}]  # 更新到主 State
    }
```

節點的**回傳值**是更新主 State 的 delta，LangGraph 會用 `operator.add` reducer 將 `analyses` 欄位 append 到主 state。

### 2.4 部分失敗容錯

Map-Reduce 的優點之一：單份文件分析失敗不影響其他文件：

```python
async def analyze_node(state: dict):
    try:
        result = await analysis_llm.ainvoke([...])
        return {"analyses": [{"error": False, ...}]}
    except Exception as e:
        return {"analyses": [{"error": True, "summary": f"分析失敗：{e}"}]}
```

即使某個 `analyze_node` 拋出例外，其他並行實例仍繼續執行。`reduce_node` 收到全部結果後，可識別帶 `error: True` 的記錄並略過。

### 2.5 `with_structured_output` 強制結構化分析輸出

```python
class DocumentAnalysis(BaseModel):
    doc_id: str
    title: str
    summary: str                                           # 2-3 句摘要
    key_points: list[str]                                  # 3-5 個重點
    sentiment: Literal["positive", "neutral", "negative"] # 情感判斷

self.analysis_llm = base_llm.with_structured_output(DocumentAnalysis)
```

每份文件都透過 function calling 強制輸出一致的結構，`reduce_node` 可以可靠地讀取 `sentiment`、`key_points` 欄位進行跨文件比較。

---

## 3. 實踐內容

### 資料夾結構

```
case5_map_reduce/
├── backend/
│   ├── agent.py          # MapReduceAgent（核心）
│   ├── api.py            # SSE 串流 API（含並行分析進度事件）
│   ├── config.py         # 環境變數設定
│   ├── database.py       # SQLAlchemy Core：documents, conversations, messages
│   ├── models.py         # DocumentAnalysis, ChatRequest 等 Pydantic 模型
│   ├── seed_data.py      # 10 份模擬公司報告（寫入 DB）
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── Chat.tsx              # 主聊天介面（含 Map-Reduce SSE 處理）
│   │   ├── Chat.css
│   │   ├── ProgressDashboard.tsx # 文件並行分析進度元件
│   │   └── ProgressDashboard.css
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
├── docker-compose.yaml
├── Dockerfile.backend
├── Dockerfile.frontend
├── .env.example
└── qa.md
```

---

## 4. 程式碼導讀

### 4.1 `backend/models.py` — DocumentAnalysis

```python
class DocumentAnalysis(BaseModel):
    doc_id: str
    title: str
    summary: str
    key_points: list[str]
    sentiment: Literal["positive", "neutral", "negative"]
```

`analyze_node` 使用 `with_structured_output(DocumentAnalysis)` 確保每份文件輸出格式一致，`reduce_node` 可直接讀取 `sentiment` 做情感統計。

### 4.2 `backend/agent.py` — 圖的連接方式

```
START → intake_node
intake_node → [Send("analyze_node") × 10, 並行]
analyze_node → reduce_node（所有實例完成後）
reduce_node → END
```

關鍵程式碼（`agent.py` 第 142-160 行）：

```python
def fan_out(state: MapReduceState) -> list[Send]:
    return [
        Send("analyze_node", {"document": doc, "query": state["query"]})
        for doc in state["documents"]
    ]

graph.add_conditional_edges("intake_node", fan_out, ["analyze_node"])
graph.add_edge("analyze_node", "reduce_node")
```

`graph.add_edge("analyze_node", "reduce_node")` 加上並行扇出的語義：LangGraph 等待**所有** `analyze_node` 實例完成後，才啟動 `reduce_node`。這是自動的「join」語義，不需要額外設定。

### 4.3 `backend/api.py` — 並行事件的 SSE 處理

並行執行時，`astream_events` 仍是**單一 async generator**，並行節點的事件按完成時間交錯出現：

```python
# doc_start：從 on_chain_start 的 input 取得文件 ID
if etype == "on_chain_start" and node_name == "analyze_node":
    doc = event["data"].get("input", {}).get("document", {})
    yield {"event": "doc_start", "data": json.dumps({"doc_id": doc.get("id")})}

# doc_done：從 on_chain_end 的 output 取得分析結果
elif etype == "on_chain_end" and node_name == "analyze_node":
    analyses = event["data"]["output"].get("analyses", [])
    if analyses:
        yield {"event": "doc_done", "data": json.dumps({
            "doc_id": analyses[0]["doc_id"],
            "summary": analyses[0]["summary"],
            "sentiment": analyses[0]["sentiment"],
        })}
```

`event["data"]["input"]` 在 on_chain_start 時包含節點接收的狀態（即 `Send()` 傳入的 payload）；`event["data"]["output"]` 在 on_chain_end 時包含節點的回傳值（delta）。

### 4.4 `frontend/src/ProgressDashboard.tsx` — 文件卡片

`DocAnalysis` 型別：

```typescript
interface DocAnalysis {
  id: string
  title: string
  category: string
  status: 'pending' | 'analyzing' | 'done' | 'error'
  summary?: string
  sentiment?: 'positive' | 'neutral' | 'negative'
}
```

卡片視覺化：
- `pending`：灰色圓點
- `analyzing`：藍色旋轉動畫
- `done`（positive）：綠色勾 + 兩行摘要截斷
- `done`（neutral）：金色勾
- `done`（negative）：紅色勾
- `error`：紅色警示圖示

### 4.5 `frontend/src/Chat.tsx` — SSE 事件處理

```typescript
if (eventType === 'documents_loaded') {
  // 初始化所有文件為 pending
  const docs = data.documents.map(d => ({ ...d, status: 'pending' }))
  setMessages(...)
} else if (eventType === 'doc_start') {
  // 對應文件改為 analyzing（並行，可能多個同時 analyzing）
  const newDocs = docAnalyses.map(d =>
    d.id === data.doc_id ? { ...d, status: 'analyzing' } : d
  )
} else if (eventType === 'doc_done') {
  // 對應文件改為 done，附加摘要與情感
  const newDocs = docAnalyses.map(d =>
    d.id === data.doc_id
      ? { ...d, status: 'done', summary: data.summary, sentiment: data.sentiment }
      : d
  )
} else if (eventType === 'reduce_start') {
  // 進入整合階段，顯示「整合報告中」動畫
  setMessages(prev => { ..., reducing: true })
}
```

---

## 5. 執行方式

### 本地開發

```bash
# 後端
cd case5_map_reduce/backend
pip install -r requirements.txt
python seed_data.py          # 初始化 10 份文件到 DB
python api.py                # 啟動於 localhost:8000

# 前端（另開終端）
cd case5_map_reduce/frontend
npm install
npm run dev                  # 啟動於 localhost:5173
```

### Docker 部署

```bash
cd case5_map_reduce
cp .env.example .env
docker-compose up -d
```

> 注意：Docker 環境需在啟動後手動執行一次 seed_data：
> `docker exec case5-backend python seed_data.py`

---

## 6. 測試驗證

### 基本功能測試

1. 執行 `python seed_data.py`，確認輸出「成功寫入 10 份模擬公司報告」
2. 啟動後端與前端，填入 API Key
3. 側邊欄確認顯示 10 份文件清單
4. 輸入：「分析所有公司的財務狀況與成長潛力」
5. 觀察 ProgressDashboard：多個文件同時顯示「分析中」（藍色旋轉），陸續變為「完成」
6. 所有文件完成後，顯示「整合報告中」，最終報告逐字串流

### 驗證重點

| 項目 | 預期行為 |
|------|---------|
| `documents_loaded` | 10 張卡片全部初始化為 pending（灰色） |
| `doc_start` | 多張卡片同時顯示 analyzing（並行，不是一個接一個）|
| `doc_done` | 卡片依情感顯示不同顏色，附加 2 行摘要 |
| `reduce_start` | 顯示「整合報告中」badge |
| `token` | 最終報告逐字出現 |
| 部分失敗 | 某張卡片顯示紅色錯誤，其他文件仍完成分析 |

### API 手動測試

```bash
# 初始化文件
cd case5_map_reduce/backend && python seed_data.py

# 查詢文件列表
curl http://localhost:8000/api/documents

# 觸發分析
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "分析所有公司的財務狀況",
    "llm_config": {
      "api_key": "sk-...",
      "model": "gpt-4o-mini",
      "base_url": "https://api.openai.com/v1",
      "temperature": 0.7
    }
  }' --no-buffer
```

---

## 7. 延伸挑戰

1. **選擇性分析**：讓使用者勾選要分析的文件，只 Send 選中的文件
2. **分批處理**：文件過多時分批（每批 N 個）避免 API rate limit，`fan_out` 返回多批 Send
3. **Streaming 每份文件的分析**：改用普通 LLM（不用 structured output），讓每份文件的分析可以 token 串流顯示
4. **結合 Plan-Execute**：先規劃「要問每份文件的問題」，再並行執行，最後 reduce 彙整
