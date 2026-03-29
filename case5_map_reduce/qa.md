# Case 5 — Map-Reduce Agent Q&A

---

## Q1：目前的設計可以讓多人同時使用嗎？會需要排隊嗎？

**結論：可以多人同時使用，通常不需要排隊。** 但有幾個細節值得理解。

---

### 為什麼可以並發：FastAPI + asyncio 並發模型

FastAPI 使用 asyncio，整個後端在**單一執行緒**上跑事件迴圈（event loop）。
每個 SSE 端點是一個 `async generator`，當它執行 `await`（等待 LLM 回應、等待 DB 查詢），
事件迴圈就切換去處理其他請求，因此多個連線可以**交錯推進**，不需要等前一個完成。

```
時間軸（單一執行緒，但事件交錯）：

用戶 A → POST /api/chat ──→ await LLM...  ──→ yield token ──→ await LLM... ──→ done
用戶 B → POST /api/chat ──→       await LLM...  ──→ yield token ──→ done
用戶 C → POST /api/chat ──→             await LLM...  ──→ yield token ──→ done
```

三個用戶的請求**同時進行**，都在等 LLM 的那段時間讓出 CPU，讓別人也能推進。

---

### 用什麼隔離不同用戶的狀態：thread_id

LangGraph 的 `MemorySaver` 以 **`thread_id`** 為 key 分別儲存每個對話的 checkpoint：

```python
# api.py：每個請求使用自己的 conversation_id（UUID）作為 thread_id
conversation_id = req.conversation_id or str(uuid.uuid4())

config = {
    "configurable": {"thread_id": conversation_id},  # ← 這是隔離的關鍵
}

agent.astream_events(initial_state, config=config, ...)
```

```
用戶 A ── thread_id="uuid-A" ──┐
用戶 B ── thread_id="uuid-B" ──┼─→ 同一個 agent 實例（MemorySaver）
用戶 C ── thread_id="uuid-C" ──┘   但各自的 checkpoint 完全隔離
```

`MemorySaver` 的內部結構大致如下：

```python
{
    "uuid-A": { state_snapshot_A },
    "uuid-B": { state_snapshot_B },
    "uuid-C": { state_snapshot_C },
}
```

三個對話互不干擾。

---

### Agent 快取：多人共用同一個 agent 實例

`agent.py` 的 `_agent_cache` 以 `(api_key, base_url, model)` 為 key：

```python
_agent_cache: dict[tuple, object] = {}

async def get_or_create_agent(llm_config):
    cache_key = (llm_config.api_key, llm_config.base_url, llm_config.model)
    if cache_key not in _agent_cache:
        instance = MapReduceAgent(llm_config)
        _agent_cache[cache_key] = await instance.create_agent()
    return _agent_cache[cache_key]
```

如果三個用戶填入**相同的 API Key + model**，他們共用同一個 `compiled_graph` 物件。
這沒有問題，因為 LangGraph 的 `astream_events()` 是純函式呼叫，狀態都存在 MemorySaver（by thread_id），
圖本身不帶狀態，多個 coroutine 同時呼叫同一個 `agent` 是安全的。

---

### 真正的限制（教學版的瓶頸）

雖然可以並發，但有幾個地方會在多人使用時**顯現壓力**：

#### 1. SQLite 寫入鎖（最常見的短暫等待）

SQLite 同一時間只允許一個寫入。`api.py` 中有幾個同步寫入點：

```python
# 儲存 user 訊息
conn.execute(insert(messages).values(...))
conn.commit()

# 串流結束後儲存 assistant 回覆
conn.execute(insert(messages).values(...))
conn.commit()
```

多人同時完成請求時，這些寫入會**短暫排隊**（通常幾毫秒），一般感覺不到。
若真的高並發，可以開啟 SQLite 的 WAL（Write-Ahead Logging）模式：

```python
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)

# 啟動時執行一次
with engine.connect() as conn:
    conn.execute(text("PRAGMA journal_mode=WAL"))
```

WAL 模式允許讀寫並行，大幅減少鎖競爭。

#### 1-補充：改用 PostgreSQL 還會有單一寫入限制嗎？

不會。SQLite 的「同一時間只允許一個寫入」是它的架構限制；PostgreSQL 的設計從根本上不同。

**SQLite 為什麼只能單一寫入**：SQLite 是檔案型資料庫，寫入靠鎖整個檔案（或 WAL 模式下鎖 WAL 檔）來保證一致性，同一時間只有一個連線能持有寫入鎖。

**PostgreSQL 的多版本並發控制（MVCC）**：
PostgreSQL 用 MVCC（Multi-Version Concurrency Control）讓每筆交易看到自己的資料快照，
寫入時只鎖**受影響的列（row-level lock）**，不鎖整張表、更不鎖整個資料庫。
因此多個連線可以同時寫入**不同的列**，彼此完全不阻塞。

```
SQLite（預設模式）：
  連線 A 寫入 messages → 鎖整個 DB 檔 → 連線 B 必須等

SQLite（WAL 模式）：
  連線 A 寫入 → 鎖 WAL 檔 → 連線 B 讀取可以繼續，但寫入仍需排隊

PostgreSQL（MVCC）：
  連線 A 寫入 messages (row 100) → 鎖 row 100
  連線 B 寫入 messages (row 101) → 鎖 row 101
  兩者同時進行，互不影響
```

**什麼情況下 PostgreSQL 仍會等待**：只有寫入**同一列**才會產生鎖競爭。
例如多個請求同時更新同一個 `conversations.updated_at`，才可能短暫等待。
對 Case 5 的寫入模式（每個請求 insert 各自的 `messages` 列），
不同請求的寫入目標永遠不同，完全沒有競爭。

**SQLAlchemy 切換成本**：
由 SQLite 換成 PostgreSQL 只需改 `database.py` 的連線字串，其餘 SQLAlchemy Core 語法不變：

```python
# SQLite（現在）
engine = create_engine("sqlite:///data/app.db", connect_args={"check_same_thread": False})

# PostgreSQL（改這一行）
engine = create_engine("postgresql+psycopg2://user:password@localhost:5432/dbname")
```

`psycopg2` 是同步驅動；若要配合 asyncio 完全不阻塞 event loop，改用非同步驅動：

```python
engine = create_async_engine("postgresql+asyncpg://user:password@localhost:5432/dbname")
# 搭配 AsyncSession 或 async with engine.connect() as conn: await conn.execute(...)
```

這樣 DB 操作也變成 `await`，不再短暫阻塞 event loop（解決下方第 2 點的問題）。

---

#### 2. 同步 DB 呼叫短暫阻塞 event loop

`sqlalchemy` 的 `engine.connect()` 是**同步**呼叫，會短暫阻塞整個 event loop：

```python
# 這段執行時，所有其他請求都必須等
with engine.connect() as conn:
    rows = conn.execute(select(documents)).fetchall()
```

對教學用途影響不大（DB 操作通常 < 5ms）。若需要生產級並發，應改用 `aiosqlite` + `sqlalchemy[asyncio]`。

#### 3. LLM API rate limit

多人同時使用同一組 API Key，所有 LLM 呼叫都計入同一個 rate limit 配額。
**Case 5 的 Map-Reduce 尤其明顯**：一個用戶的單一請求就會同時送出 10 個 LLM 呼叫（10 份文件並行）。
若 3 個用戶同時使用，就是 30 個 LLM 呼叫幾乎同時發出。

```
用戶 A 的請求 → 10 個並行 analyze_node → 10 個 LLM 呼叫
用戶 B 的請求 → 10 個並行 analyze_node → 10 個 LLM 呼叫   ← 共 30 個同時
用戶 C 的請求 → 10 個並行 analyze_node → 10 個 LLM 呼叫
```

若遇到 rate limit 錯誤（HTTP 429），部分 `analyze_node` 會失敗，但 Case 5 的部分失敗容錯機制會捕捉例外，回傳帶 `error: True` 的記錄，不會讓整個流程崩潰。

#### 4. MemorySaver 記憶體無限增長

`MemorySaver` 把所有 conversation 的 state 存在記憶體，**永遠不清除**。
長時間多人使用後，每個 `thread_id` 對應的 checkpoint 都會累積在記憶體中。
教學版影響不大，但長時間運作需要考慮定期重啟或換用 `SqliteSaver`（Case 6 會介紹）。

---

### 與前幾個 Case 的比較

| Case | 並發支援 | 主要瓶頸 |
|------|----------|---------|
| Case 1（基礎聊天）| ✅ 可並發 | SQLite 寫入鎖（偶發，ms 級） |
| Case 2（ReAct）| ✅ 可並發 | LLM rate limit（工具呼叫多） |
| Case 3（工具開發）| ✅ 可並發 | 同步 DB 工具呼叫阻塞 event loop |
| Case 4（Plan-Execute）| ✅ 可並發 | 步驟多，LLM 呼叫次數多 |
| Case 5（Map-Reduce）| ✅ 可並發 | **LLM rate limit 壓力最大**（單請求 = 10 LLM 呼叫） |

所有 Case 的並發支援都來自同一個設計：
**FastAPI async + LangGraph thread_id 隔離**。

---

### 總結

```
問：多人同時使用會排隊嗎？

答：不會排隊。每個請求是獨立的 async generator，
   用 conversation_id 作為 thread_id 隔離 LangGraph 狀態，
   FastAPI 的事件迴圈讓多個請求交錯推進。

   唯一可能「感覺到慢」的情況：
   → LLM API rate limit 被打滿（尤其 Case 5 Map-Reduce）
   → SQLite 寫入短暫等待（通常 < 5ms，感覺不到）
```

---

## Q2：Map-Reduce 是什麼模式？程式裡是怎麼實現的？

Map-Reduce 是一種**先拆分、並行處理、再聚合**的計算模式。
Case 5 用它對 10 份公司報告做並行分析，最後整合成一份跨文件報告。

---

### 概念：三個階段

```
原始問題
   ↓
【Intake】準備資料
   ↓ 拆分（Map）
┌──────┬──────┬──────┬──────┐
│ 文件1 │ 文件2 │ 文件3 │ ... │  ← 並行，同時處理
└──┬───┴──┬───┴──┬───┴──┬───┘
   ↓      ↓      ↓      ↓
 分析1  分析2  分析3  ...     ← 每份文件獨立分析
   └──────┴──────┴──────┘
              ↓ 聚合（Reduce）
         【reduce_node】
              ↓
          跨文件報告
```

傳統 Map-Reduce（如 Hadoop）用於大規模資料處理；
LangGraph 的 Map-Reduce 用相同概念處理**大量同質的 LLM 任務**。

---

### 對應程式：圖結構（`agent.py` 第 223–236 行）

```python
graph = StateGraph(MapReduceState)

graph.add_node("intake_node", intake_node)
graph.add_node("analyze_node", analyze_node)
graph.add_node("reduce_node", reduce_node)

graph.add_edge(START, "intake_node")
graph.add_conditional_edges("intake_node", fan_out, ["analyze_node"])  # ← Map
graph.add_edge("analyze_node", "reduce_node")                          # ← Reduce 的 join
graph.add_edge("reduce_node", END)
```

關鍵在兩行：
- `add_conditional_edges(..., fan_out, ...)` — 用 `fan_out` 函式動態決定要啟動幾個 `analyze_node`
- `add_edge("analyze_node", "reduce_node")` — 聲明「所有 `analyze_node` 完成後才跑 `reduce_node`」（自動 join 語義）

---

### Map 階段：`Send()` 動態扇出（`agent.py` 第 104–117 行）

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
```

`fan_out` 不回傳字串（普通條件路由的做法），而是回傳 **`list[Send]`**。
每個 `Send("analyze_node", payload)` 告訴 LangGraph：
「用這個 payload 啟動一個 `analyze_node` 實例」。

10 份文件 → `fan_out` 回傳 10 個 `Send` → LangGraph **並行執行** 10 個 `analyze_node`。

```
fan_out 回傳：
[
  Send("analyze_node", {"document": doc_001, "query": "..."}),
  Send("analyze_node", {"document": doc_002, "query": "..."}),
  ...
  Send("analyze_node", {"document": doc_010, "query": "..."}),
]

LangGraph 執行：
  analyze_node(doc_001) ──┐
  analyze_node(doc_002) ──┤
  analyze_node(doc_003) ──┤ 同時進行
  ...                     ┤
  analyze_node(doc_010) ──┘
                          ↓ 全部完成
                      reduce_node
```

---

### analyze_node 收到什麼：payload 就是 state（`agent.py` 第 119–175 行）

`analyze_node` 被 `Send()` 呼叫時，收到的 `state` 就是 `Send` 傳入的 payload：

```python
async def analyze_node(state: dict):        # state = Send() 的 payload
    document = state["document"]            # {"id": "doc_001", "title": "...", "content": "..."}
    query    = state["query"]               # "分析所有公司的財務狀況"

    try:
        result: DocumentAnalysis = await analysis_llm.ainvoke([
            SystemMessage("你是專業的商業分析師..."),
            HumanMessage(f"查詢問題：{query}\n\n文件內容：{document['content']}"),
        ])
        return {
            "analyses": [{                  # ← 回傳給主 State 的 delta
                "doc_id": document["id"],
                "summary": result.summary,
                "sentiment": result.sentiment,
                "error": False,
            }]
        }
    except Exception as e:
        return {
            "analyses": [{                  # ← 失敗也回傳，不拋出例外
                "doc_id": document["id"],
                "summary": f"分析失敗：{e}",
                "error": True,
            }]
        }
```

注意 `result: DocumentAnalysis` 是用 `with_structured_output` 強制 LLM 輸出的結構化物件：

```python
# agent.py 第 85 行
self.analysis_llm = base_llm.with_structured_output(DocumentAnalysis)

# models.py
class DocumentAnalysis(BaseModel):
    doc_id: str
    title: str
    summary: str
    key_points: list[str]
    sentiment: Literal["positive", "neutral", "negative"]
```

`with_structured_output` 透過 function calling 讓 LLM 必須輸出符合 schema 的 JSON，
`reduce_node` 才能可靠地讀取 `sentiment`、`key_points` 欄位。

---

### 結果如何聚合：`operator.add` Reducer（`agent.py` 第 67 行）

```python
class MapReduceState(TypedDict):
    analyses: Annotated[list[dict], operator.add]   # ← 並行累積
```

每個 `analyze_node` 回傳 `{"analyses": [one_item]}`（list 包一個元素）。
LangGraph 對每個並行節點的回傳值執行一次 `operator.add`（即 list + list）：

```
analyze_node(doc_001) 回傳 → {"analyses": [result_001]}
analyze_node(doc_002) 回傳 → {"analyses": [result_002]}
...

State 中的 analyses 最終 =
  [] + [result_001] + [result_002] + ... + [result_010]
= [result_001, result_002, ..., result_010]
```

順序**不保證**（依完成時間決定）。所以 `reduce_node` 會先排序：

```python
# agent.py 第 188 行
sorted_analyses = sorted(state["analyses"], key=lambda x: x["doc_id"])
```

---

### Reduce 階段：聚合報告（`agent.py` 第 177–217 行）

當所有 `analyze_node` 完成，LangGraph 自動觸發 `reduce_node`。
此時 `state["analyses"]` 已有完整的 10 筆記錄：

```python
async def reduce_node(state: MapReduceState):
    sorted_analyses = sorted(state["analyses"], key=lambda x: x["doc_id"])

    # 把 10 份分析結果組成一段文字
    analyses_text = "\n\n".join([
        f"【{a['title']}】（情感：{a['sentiment']}）\n"
        f"摘要：{a['summary']}\n"
        f"重點：" + "；".join(a.get("key_points", []))
        for a in sorted_analyses if not a.get("error")
    ])

    # 呼叫 LLM 生成跨文件報告（這裡用普通 LLM，支援 token 串流）
    final_report = await synthesis_llm.ainvoke([
        SystemMessage("你是資深商業分析師，請生成跨文件綜合報告..."),
        HumanMessage(f"使用者查詢：{state['query']}\n\n{analyses_text}"),
    ])
    return {
        "report": final_report.content,
        "messages": [...],
    }
```

`synthesis_llm` 是普通的 `ChatOpenAI`（不綁定 structured output），
讓 `api.py` 可以捕捉 `on_chat_model_stream` 事件做 token 串流。

---

### 完整執行流程時序

```
用戶輸入："分析所有公司的財務狀況"
         ↓
api.py   load_all_documents()         → 從 DB 取出 10 份文件
         yield documents_loaded        → 前端初始化 10 個 pending 卡片
         ↓
LangGraph intake_node                 → 不做額外處理，直接傳遞
         ↓
         fan_out()                    → 回傳 10 個 Send
         ↓ 並行
         analyze_node(doc_001~010)

         ← on_chain_start(analyze_node)  api.py yield doc_start × 10
         ← on_chain_end(analyze_node)    api.py yield doc_done × 10
         ↓ 全部完成
         reduce_node
         ← on_chain_start(reduce_node)   api.py yield reduce_start
         ← on_chat_model_stream × N      api.py yield token × N
         ← on_chain_end(reduce_node)
         ↓
         END
         ↓
api.py   yield done
```

---

### Map-Reduce vs Plan-Execute 的本質差異

| | Plan-Execute（Case 4）| Map-Reduce（Case 5）|
|---|---|---|
| 處理對象 | 一個目標，多個步驟 | 多個同質物件，相同操作 |
| 執行方式 | 線性：步驟 1 → 步驟 2 → ... | 並行：物件1, 物件2, ... 同時 |
| 扇出方式 | 無（一條路走到底） | `Send()` 動態扇出 |
| 結果累積 | `operator.add` 逐步累加步驟結果 | `operator.add` 並行累加各物件結果 |
| 適用情境 | 有相依性的任務（步驟 2 需要步驟 1 的結果） | 無相依性的任務（文件之間互不影響） |

---

## Q4：`operator.add` 的累加問題——後續 node 與多輪對話會讓 analyses 膨脹嗎？

這個問題有兩層：**同一次圖執行內的後續 node**，以及**跨多次請求的 MemorySaver 累積**。
兩層的答案和解法不同，分開說明。

---

### 第一層：讀 vs 寫的根本區別

`operator.add` **只在 node 的 return dict 包含該 key 時觸發**，與「讀取」完全無關。

```python
# ✅ 安全：讀取 state["analyses"]，不放進 return
async def post_node(state: MapReduceState):
    count = len(state["analyses"])                               # 讀 ← 不觸發 reducer
    positives = [a for a in state["analyses"] if a["sentiment"] == "positive"]
    return {"report": f"共 {count} 份，{len(positives)} 份正面"} # analyses 不在 return 裡

# ❌ 危險：把現有 list 整個放進 return
async def post_node(state: MapReduceState):
    return {
        "analyses": state["analyses"],   # ← operator.add([A..J], [A..J]) = [A..J, A..J]，加倍
        "report": ...,
    }
```

**結論：後續 node 可以任意讀 `state["analyses"]，只要 return 裡不出現這個 key 就不會累積。**

Case 5 的 `reduce_node` 正是這樣做的（`agent.py` 第 214–217 行）：

```python
return {
    "report": final_report.content,
    "messages": synthesis_msgs + [final_report],
    # analyses 完全不在 return 裡 ← reducer 不觸發
}
```

```
intake_node   return {}                              → analyses 不動
analyze_node  return {"analyses": [one_item]} × 10  → operator.add 觸發 10 次，累積到 10 筆
reduce_node   return {"report": ..., "messages": ...} → analyses 不動，維持 10 筆
END
```

---

### 第二層：MemorySaver 跨 turn 才是真正的膨脹來源

即使圖內部沒有迴圈，**同一個 `thread_id` 的多次請求會讓 analyses 線性增長**。

`api.py` 每次請求都傳 `"analyses": []` 作為初始 state，看似重置：

```python
agent.astream_events(
    {"analyses": [], ...},
    config={"configurable": {"thread_id": conversation_id}},
)
```

但這**不會清空**。`MemorySaver` 有上一次的 checkpoint，LangGraph 啟動新執行時，
會把輸入值套用 reducer 來更新 checkpoint：

```
operator.add(checkpoint 裡的 [10 筆], 輸入的 []) = [10 筆]   ← [] 不是清除，是 no-op
```

結果：

```
第 1 次查詢結束  → analyses = 10 筆，存入 checkpoint
第 2 次查詢開始  → checkpoint 帶 10 筆進來，再跑 10 個 analyze_node
第 2 次查詢結束  → analyses = 20 筆
第 3 次查詢結束  → analyses = 30 筆
...
```

`reduce_node` 每次都把 checkpoint 裡所有累積的結果全部餵給 LLM，
不只浪費 token，報告內容也會因為包含舊資料而錯亂。

**Case 5 目前沒有處理這個問題。**

---

### 解法：用哨兵值重置

空 list `[]` 無法觸發清空，因為 `operator.add(existing, []) = existing`。
需要自訂 reducer，用一個**哨兵值**代表「清除」信號：

```python
_RESET = "__reset__"

def add_or_reset(left: list, right: list) -> list:
    if right and right[0] == _RESET:   # 看到哨兵，清空並取哨兵後面的內容
        return right[1:]
    return left + right

class MapReduceState(TypedDict):
    analyses: Annotated[list[dict], add_or_reset]   # 換掉 operator.add
```

然後在 `intake_node` 開頭重置：

```python
async def intake_node(state: MapReduceState):
    return {"analyses": [_RESET]}   # 每次 map 開始前清空上一輪的殘留
```

執行流程變成：

```
第 1 次查詢：
  intake_node  return {"analyses": ["__reset__"]}   → add_or_reset → []（清空）
  analyze_node × 10                                 → add_or_reset → 10 筆
  reduce_node  return {"report": ...}               → analyses 不動

第 2 次查詢（同 thread_id）：
  checkpoint 帶 10 筆進來
  intake_node  return {"analyses": ["__reset__"]}   → add_or_reset → []（再次清空）
  analyze_node × 10                                 → add_or_reset → 10 筆
  reduce_node                                       → 永遠只看到 10 筆，正確
```

---

### 如果後續 node 需要使用分析結果：職責分離

若 reduce 後還有其他 node 需要讀取「這一輪的分析」，建議用兩個欄位分開職責：

```python
class MapReduceState(TypedDict):
    analyses:       Annotated[list[dict], add_or_reset]  # map 階段的暫存（會被重置）
    final_analyses: list[dict]                           # reduce_node 整理後的版本（普通覆蓋）
    report:         str
```

```python
async def reduce_node(state: MapReduceState):
    sorted_analyses = sorted(state["analyses"], key=lambda x: x["doc_id"])
    ...
    return {
        "final_analyses": sorted_analyses,   # 固定下來，後續 node 讀這個
        "report": final_report.content,
    }

async def post_node(state: MapReduceState):
    for a in state["final_analyses"]:        # 讀 final_analyses，不碰 analyses
        ...
    return {"report": "後處理：" + state["report"]}
```

`final_analyses` 是普通欄位（無 reducer），每次 `reduce_node` 覆蓋，永遠是當輪結果。

---

### 總結

| 場景 | 問題 | 解法 |
|------|------|------|
| 後續 node 讀 `state["analyses"]` | 無問題，讀不觸發 reducer | — |
| 後續 node `return {"analyses": state["analyses"]}` | 立即加倍 | 不要帶進 return |
| 多輪對話（同 thread_id，MemorySaver） | 線性累積，每輪 +10 筆 | `add_or_reset` + `intake_node` 重置 |
| reduce 後還需要使用分析結果 | `analyses` 下一輪會被清掉 | 另設 `final_analyses` 欄位（普通覆蓋）|

**Case 5 目前採用最簡設計（圖是 DAG，每次 conversation 只問一個問題），**
**多輪對話的膨脹問題留待需要時用 `add_or_reset` + `intake_node` 重置修正。**

---

## Q3：`astream_events` 有哪些常用事件？每個事件的結構是什麼？

`astream_events(version="v2")` 是 LangGraph / LangChain 的**統一事件串流 API**。
圖執行過程中，每個節點啟動、LLM 輸出 token、工具被呼叫，都會產生對應的事件物件。

---

### 事件的共通結構

每個事件都是一個 dict，有以下固定欄位：

```python
{
    "event":    "on_chain_start",      # 事件類型（見下表）
    "name":     "analyze_node",        # 觸發事件的元件名稱
    "run_id":   "a3f2-...",            # 本次呼叫的唯一 ID（start/end 同一對有相同 run_id）
    "parent_ids": ["b1c3-..."],        # 上層呼叫的 run_id 列表
    "tags":     [],                    # LangChain tags（通常為空）
    "metadata": {
        "langgraph_node":     "analyze_node",  # 目前所在的 LangGraph 節點名稱
        "langgraph_step":     3,               # 圖執行的步驟計數（每個節點 +1）
        "langgraph_triggers": ["intake_node"], # 觸發本節點的上游節點
        "langgraph_path":     ("__pregel_pull", "analyze_node"),
    },
    "data": {
        # 依事件類型不同，包含 input / output / chunk 其中之一（見各類型說明）
    }
}
```

`metadata["langgraph_node"]` 是判斷事件來自哪個節點的最可靠方式，
在 `on_chat_model_stream` 等非節點層級事件中尤其重要（這類事件的 `name` 是模型名稱，不是節點名稱）。

---

### 事件類型總覽

| 事件類型 | 觸發時機 | `name` 的值 |
|---------|---------|------------|
| `on_chain_start` | LangGraph 節點開始執行 | 節點名稱（如 `"analyze_node"`） |
| `on_chain_end` | LangGraph 節點執行結束 | 節點名稱 |
| `on_chat_model_start` | ChatLLM 開始被呼叫 | 模型類別（如 `"ChatOpenAI"`） |
| `on_chat_model_stream` | ChatLLM 輸出一個 token | 模型類別 |
| `on_chat_model_end` | ChatLLM 輸出完成 | 模型類別 |
| `on_tool_start` | `@tool` 函式開始執行 | 工具函式名稱（如 `"web_search"`） |
| `on_tool_end` | `@tool` 函式執行結束 | 工具函式名稱 |
| `on_llm_start` | 非 Chat 的純文字 LLM 開始 | 模型類別 |
| `on_llm_stream` | 非 Chat LLM 輸出 token | 模型類別 |
| `on_llm_end` | 非 Chat LLM 完成 | 模型類別 |

> 現代 LangChain/LangGraph 幾乎都用 `ChatOpenAI` 系列，所以 `on_llm_*` 幾乎不出現。
> 日常只需關注前 7 種。

---

### on_chain_start / on_chain_end — 節點生命週期

對應到 LangGraph 的每一個節點（`add_node` 加入的函式）。

```python
# on_chain_start — data 只有 input
event = {
    "event": "on_chain_start",
    "name":  "analyze_node",          # 節點名稱
    "data":  {
        "input": {                    # 節點收到的 state（或 Send 的 payload）
            "document": {"id": "doc_001", "title": "TechVision 年報", ...},
            "query": "分析所有公司的財務狀況",
        }
    }
}

# on_chain_end — data 只有 output
event = {
    "event": "on_chain_end",
    "name":  "analyze_node",
    "data":  {
        "output": {                   # 節點回傳的 delta（要更新到 state 的部分）
            "analyses": [{
                "doc_id": "doc_001",
                "summary": "TechVision 本年度營收成長 34%...",
                "sentiment": "positive",
            }]
        }
    }
}
```

**Case 5 的用法（`api.py` 第 153–194 行）**：

```python
if etype == "on_chain_start" and node_name == "analyze_node":
    doc = event["data"]["input"]["document"]       # 取得文件資訊
    yield {"event": "doc_start", "data": ...}

elif etype == "on_chain_end" and node_name == "analyze_node":
    a = event["data"]["output"]["analyses"][0]     # 取得分析結果
    yield {"event": "doc_done", "data": ...}
```

**Case 4 的用法（`api.py` 第 138–185 行）**：

```python
if etype == "on_chain_end" and node_name == "planner_node":
    local_plan = event["data"]["output"]["plan"]   # 取得步驟清單

elif etype == "on_chain_start" and node_name == "executor_node":
    yield {"event": "step_start", ...}             # 通知前端步驟開始

elif etype == "on_chain_end" and node_name == "executor_node":
    new_steps = event["data"]["output"]["past_steps"]  # 取得步驟執行結果
```

> **注意**：`on_chain_start/end` 也會出現在 LangGraph 內部的 Runnable 元件上（如 `RunnableSequence`、`PromptTemplate` 等），它們的 `name` 通常是類別名稱而非節點名稱。過濾時用 `node_name == "你的節點名稱"` 精確比對即可。

---

### on_chat_model_stream — LLM token 逐字輸出

每當 ChatLLM 輸出一個 token，就觸發一次。這是實現「打字機效果」的核心事件。

```python
event = {
    "event": "on_chat_model_stream",
    "name":  "ChatOpenAI",             # 模型類別名稱（不是節點名稱！）
    "metadata": {
        "langgraph_node": "reduce_node",  # 要靠 metadata 才能知道是哪個節點
    },
    "data": {
        "chunk": AIMessageChunk(
            content="TechVision",      # 本次輸出的 token 字串
            id="run-abc...",
        )
    }
}
```

取出 token：

```python
chunk = event["data"]["chunk"].content   # 字串，可能是空字串（最後一個 chunk）
if chunk:
    full_response += chunk
```

判斷來自哪個節點：

```python
# ⚠ 不能用 event["name"]，那是模型名稱
node = event["metadata"]["langgraph_node"]

# Case 5：只取 reduce_node 的 token
if node == "reduce_node":
    yield {"event": "token", "data": json.dumps({"content": chunk})}

# Case 4：只取 replanner_node 的 token（最終整合回覆）
if node == "replanner_node":
    yield {"event": "token", "data": json.dumps({"content": chunk})}

# Case 1 / Case 2：所有節點的 token 都要（圖只有一個 LLM 節點）
yield {"event": "token", "data": json.dumps({"content": chunk})}
```

---

### on_chat_model_start / on_chat_model_end — LLM 呼叫的完整資料

```python
# on_chat_model_start
event = {
    "event": "on_chat_model_start",
    "name":  "ChatOpenAI",
    "data":  {
        "input": {
            "messages": [[           # 傳給 LLM 的訊息列表
                SystemMessage("你是..."),
                HumanMessage("請分析..."),
            ]]
        }
    }
}

# on_chat_model_end
event = {
    "event": "on_chat_model_end",
    "name":  "ChatOpenAI",
    "data":  {
        "output": AIMessage(
            content="TechVision 本年度...",    # 完整回覆（非 structured output 時）
            # 若使用 with_structured_output，content 可能為空，結果在 tool_calls 裡
        )
    }
}
```

通常用 `on_chat_model_stream` 做即時串流，`on_chat_model_end` 做完整結果記錄（兩者擇一）。

---

### on_tool_start / on_tool_end — 工具呼叫

對應到 `@tool` 裝飾的函式，每次 LLM 決定呼叫工具時觸發。

```python
# on_tool_start — 工具被呼叫前
event = {
    "event": "on_tool_start",
    "name":  "web_search",            # 工具函式名稱
    "run_id": "xyz-789",              # 可與 on_tool_end 配對
    "data":  {
        "input": {                    # LLM 傳入的工具參數（dict）
            "query": "2024年台積電營收"
        }
    }
}

# on_tool_end — 工具執行完畢
event = {
    "event": "on_tool_end",
    "name":  "web_search",
    "run_id": "xyz-789",              # 同一個 run_id，可對應回 on_tool_start
    "data":  {
        "output": ToolMessage(
            content='{"results": [...]}',   # 工具回傳的結果字串
            tool_call_id="...",
        )
    }
}
```

取出工具輸出：

```python
# output 是 ToolMessage 物件，content 才是字串
raw_output = event["data"]["output"]
tool_output = raw_output.content if hasattr(raw_output, "content") else str(raw_output)
```

**Case 2 / Case 4 的用法（`api.py`）**：

```python
elif etype == "on_tool_start":
    tool_name  = event["name"]
    tool_input = event["data"]["input"]    # dict，直接可用
    run_id     = event["run_id"]           # 用來關聯 start/end
    yield {"event": "tool_start", "data": json.dumps({
        "run_id": run_id,
        "tool_name": tool_name,
        "tool_input": tool_input,
    })}

elif etype == "on_tool_end":
    raw = event["data"]["output"]
    tool_output = raw.content if hasattr(raw, "content") else str(raw)
    yield {"event": "tool_end", "data": json.dumps({
        "run_id": event["run_id"],         # 對應回哪次呼叫
        "tool_name": event["name"],
        "tool_output": tool_output,
    })}
```

---

### run_id：關聯同一次呼叫的 start 與 end

`run_id` 在同一次呼叫的 `on_*_start` 和 `on_*_end` 之間保持一致，
適合用來「配對」或「追蹤進行中的工具/節點」：

```python
pending_tools = {}

if etype == "on_tool_start":
    pending_tools[event["run_id"]] = {
        "name": event["name"],
        "started_at": time.time(),
    }

elif etype == "on_tool_end":
    info = pending_tools.pop(event["run_id"], None)
    if info:
        elapsed = time.time() - info["started_at"]
        log.info(f"{info['name']} 耗時 {elapsed:.2f}s")
```

---

### 各 Case 使用的事件對照

| Case | 使用的事件 | 用途 |
|------|-----------|------|
| Case 1 | `on_chat_model_stream` | LLM token 串流 |
| Case 2 | `on_chat_model_stream`、`on_tool_start`、`on_tool_end` | Token + 工具呼叫視覺化 |
| Case 3 | `on_chat_model_stream`、`on_tool_start`、`on_tool_end` | 同 Case 2 |
| Case 4 | `on_chain_start/end`（planner/executor/replanner）、`on_tool_start/end`、`on_chat_model_stream` | 步驟進度 + 工具 + 最終串流 |
| Case 5 | `on_chain_start/end`（analyze/reduce）、`on_chat_model_stream` | 文件分析進度 + 整合報告串流 |

---

### 快速查閱：常用存取路徑

```python
async for event in agent.astream_events(..., version="v2"):
    etype     = event["event"]                           # 事件類型
    name      = event.get("name", "")                   # 元件名稱
    run_id    = event.get("run_id", "")                  # 呼叫唯一 ID
    node      = event.get("metadata", {}).get("langgraph_node", "")  # 所在節點

    # on_chain_start
    chain_input  = event["data"].get("input", {})        # 節點輸入 state

    # on_chain_end
    chain_output = event["data"].get("output", {})       # 節點回傳 delta

    # on_chat_model_stream
    token = event["data"]["chunk"].content               # token 字串

    # on_tool_start
    tool_input  = event["data"].get("input", {})         # 工具參數 dict

    # on_tool_end
    raw = event["data"].get("output")
    tool_output = raw.content if hasattr(raw, "content") else str(raw)
```
