# Case 9: Multi-Agent Supervisor — Q&A 筆記

---

## Q1：除了本案例用的方式，Multi-Agent 還有哪些設計模式？

LangGraph 提供多種 Multi-Agent 架構，各有適用場景：

### 1. Supervisor 模式（本案例）

**結構**：一個 Supervisor 節點 + 多個 Worker 節點，所有路由集中在 Supervisor 決策。

```
START → supervisor → researcher → supervisor → analyst → supervisor → writer → END
```

**特點**：
- 路由邏輯集中，易於維護
- Supervisor 有全局視野，可根據上下文決策
- Worker 之間完全解耦（不直接呼叫彼此）
- 使用 `Command(goto=...)` 實現動態路由，圖只需一條顯式邊

**適合**：需要靈活決策、不確定執行順序的任務

---

### 2. 固定流水線（Fixed Pipeline）

**結構**：節點之間用靜態 `add_edge` 連接，執行順序固定。

```python
graph.add_edge(START, "researcher")
graph.add_edge("researcher", "analyst")
graph.add_edge("analyst", "writer")
graph.add_edge("writer", END)
```

**特點**：
- 結構最簡單，執行順序可預測
- 無路由決策邏輯，沒有 LLM routing 的不確定性
- 無法根據中間結果動態調整

**適合**：步驟固定、順序不會改變的處理流程（如文件處理管道）

---

### 3. 分層 Supervisor（Hierarchical Supervisor）

**結構**：Supervisor 之上再加一層 Meta-Supervisor，形成樹狀結構。

```
Meta-Supervisor
├── Research Supervisor → [web_search, db_lookup, citation_check]
├── Analysis Supervisor → [statistics, sentiment, comparison]
└── Writing Supervisor  → [outline, draft, review, polish]
```

**特點**：
- 適合大型複雜任務，子 Supervisor 負責特定領域
- 各層級有清晰的職責邊界
- 實作複雜度較高

**適合**：企業級複雜工作流，如研究報告生成、軟體開發流程

---

### 4. Map-Reduce 模式（見 Case 5）

**結構**：用 `Send()` 將任務扇出給多個並行 Agent，再聚合結果。

```python
# 扇出：動態建立多個並行任務
def fan_out(state):
    return [Send("worker", {"item": item}) for item in state["items"]]

graph.add_conditional_edges("dispatcher", fan_out, ["worker"])
```

**特點**：
- 多個 Agent 真正並行執行（不是序列）
- 適合對多個獨立資料項目做相同處理
- 結果透過 `Annotated[list, operator.add]` 自動聚合

**適合**：批次處理（如分析多份文件、對多個 API 並行呼叫）

---

### 5. 反思/自我批評模式（Reflection/Critic）

**結構**：Generator 生成輸出，Critic 評估品質，根據評分決定是否重試。

```
START → generator → critic
                       ├── 品質不足 → generator（重試）
                       └── 品質達標 → END
```

**特點**：
- 類似人類的「寫作 → 修改」迭代流程
- 可用於提高輸出品質
- 需設定最大重試次數防止無限迴圈

**適合**：程式碼生成與測試、文章品質優化、SQL 生成驗證（見 Case 11）

---

### 6. 專家路由模式（Expert Routing / LLM Router）

**結構**：路由節點根據輸入分類，將請求導向對應的專家節點（類似 Case 7 的意圖分類）。

```
input → router ──→ customer_service_agent
                ──→ technical_support_agent
                ──→ billing_agent
```

**特點**：
- 每個專家只處理自己擅長的任務
- 路由邏輯簡單（一次決策，非反覆協調）
- 比 Supervisor 輕量，但缺少動態協調能力

**適合**：客服分流、任務分類系統

---

### 比較表

| 模式 | 靈活性 | 複雜度 | 並行能力 | 適用場景 |
|------|--------|--------|---------|---------|
| Supervisor（本案例） | 高 | 中 | 否（序列） | 需動態協調的複雜任務 |
| 固定流水線 | 低 | 低 | 否 | 步驟固定的管道 |
| 分層 Supervisor | 很高 | 高 | 部分 | 大型企業工作流 |
| Map-Reduce | 中 | 中 | 是 | 批次並行處理 |
| 反思/自我批評 | 中 | 中 | 否 | 需迭代優化輸出品質 |
| 專家路由 | 中 | 低 | 否 | 任務分類分流 |

---

## Q2：`supervisor_node` 的角色與設計為何如此重要？

### 核心職責

`supervisor_node` 在 Supervisor 模式中扮演三個角色：

**1. 狀態分析者（State Analyzer）**
讀取整個 `MultiAgentState`，判斷目前完成了哪些工作：
```python
research_result = state.get("research_result", "")  # 研究完成了嗎？
analysis_result = state.get("analysis_result", "")  # 分析完成了嗎？
writer_ran = any(isinstance(m, AIMessage) for m in messages)  # 寫作完成了嗎？
```

**2. 路由決策者（Router）**
根據現況決定下一步，體現了「集中式協調」的設計哲學：
- 子 Agent 只管自己的工作，不需知道整體流程
- 全局協調邏輯集中在 Supervisor，易於修改

**3. 安全守門者（Safety Guard）**
Python 層的終止條件確保系統不會無限迴圈：
```python
# 不依賴 LLM 判斷，Python 直接終止
if writer_ran or iteration >= 6:
    return Command(goto=END, ...)
```

---

### 雙層決策架構

本案例 Supervisor 採用「Python 守門 + LLM 決策」的雙層架構：

```
Layer 1（Python）：確定性終止條件
  └─ writer_ran == True → 強制 FINISH
  └─ iteration >= 6    → 強制 FINISH

Layer 2（LLM）：語意路由決策
  └─ 研究為空          → 派遣 researcher
  └─ 分析為空          → 派遣 analyst
  └─ 兩者都完成        → 派遣 writer
```

**為何要分兩層？**

| 層級 | 負責什麼 | 原因 |
|------|---------|------|
| Python 層 | 終止條件 | LLM 有時判斷失準，Python 邏輯絕對可靠 |
| LLM 層 | 路由決策 | 自然語言理解，能靈活應對各種狀況 |

---

### `with_structured_output` 為何對 Supervisor 特別重要

Supervisor 的輸出必須是合法的節點名稱，否則圖會崩潰：

```python
# 沒有 with_structured_output 時，LLM 可能輸出：
# "我覺得應該先讓研究員研究一下"    → 無法解析為節點名稱
# "researcher"                     → 合法
# "請呼叫 researcher 節點"          → 無法解析

# with_structured_output 強制格式：
class RouteDecision(BaseModel):
    next_agent: Literal["researcher", "analyst", "writer", "FINISH"]
    reason: str
```

這確保了 `Command(goto=decision.next_agent)` 永遠得到合法的目標節點。

---

### Supervisor 多次執行的時序

Supervisor 在整個流程中被呼叫多次，每次執行都是獨立的決策：

```
呼叫 #1：research="" analysis=""  → 派遣 researcher
呼叫 #2：research="..." analysis=""  → 派遣 analyst
呼叫 #3：research="..." analysis="..."  → 派遣 writer
呼叫 #4：writer_ran=True  → Python 層直接 FINISH（不呼叫 LLM）
```

這也說明為何 `astream_events` 會看到多個 `agent_start {"agent": "supervisor"}` 事件——每次呼叫都是新的 LLM 呼叫，有各自的 `run_id`。

---

### 若不用 Supervisor，改成固定流水線會有何差異？

```python
# 固定流水線（無 Supervisor）
graph.add_edge(START, "researcher")
graph.add_edge("researcher", "analyst")
graph.add_edge("analyst", "writer")
graph.add_edge("writer", END)
```

| 差異 | Supervisor 模式 | 固定流水線 |
|------|----------------|-----------|
| 執行順序 | LLM 動態決定 | 硬編碼固定 |
| 可跳過步驟 | 可以（LLM 決策） | 不行 |
| 可重試步驟 | 可以（路由回同 Agent） | 不行 |
| 路由失敗風險 | 有（需 `with_structured_output` 降低） | 無 |
| 適合複雜任務 | 是 | 否 |

本案例用 Supervisor 是因為未來可以輕易擴充：加入「fact_checker（事實查核員）」節點後，只需更新 Supervisor 的決策 Prompt，不需修改圖結構。

---

## Q4：如何將後端 Multi-Agent 流程串接到前端的 AgentFlow 視覺化？（完整對照）

這是 Case 9 最重要的整合模式。以下對照後端 SSE 設計、前端狀態管理、渲染邏輯三個層次。

---

### 層次一：後端 SSE 事件設計（api.py）

核心原則：用 `astream_events v2` + `metadata.langgraph_node` 過濾事件，轉換為前端能識別的 SSE 事件。

```python
AGENT_NODES = {"supervisor", "researcher", "analyst", "writer"}

async for event in agent.astream_events({...}, config=config, version="v2"):
    etype  = event["event"]
    run_id = event.get("run_id", "")
    node   = event.get("metadata", {}).get("langgraph_node", "")

    # 1. LLM 開始執行 → agent_start
    if etype == "on_chat_model_start" and node in AGENT_NODES:
        if run_id not in reported_runs:          # 避免同一次 LLM 重複發送
            reported_runs.add(run_id)
            yield {"event": "agent_start", "data": json.dumps({"agent": node})}

    # 2. Writer token 串流 → token
    elif etype == "on_chat_model_stream" and node == "writer":
        chunk = event["data"]["chunk"].content
        if chunk:
            yield {"event": "token", "data": json.dumps({"content": chunk})}

    # 3. LLM 結束 → agent_end（含摘要與 writer 完整內容）
    elif etype == "on_chat_model_end" and node in AGENT_NODES:
        if run_id in reported_runs:              # 配對同一次 start
            summary = _extract_summary(node, event["data"])
            writer_content = ""
            if node == "writer":
                output = event["data"].get("output")
                if hasattr(output, "content"):
                    writer_content = output.content
            yield {"event": "agent_end", "data": json.dumps({
                "agent": node,
                "summary": summary,
                "content": writer_content,        # 非空只在 writer
            })}

    # 4. 全部完成 → done（帶完整內容作為 fallback）
    yield {"event": "done", "data": json.dumps({
        "conversation_id": conversation_id,
        "content": full_response,
    })}
```

**關鍵設計**：
- `reported_runs` set：用 `run_id` 配對 start/end，確保一一對應
- Writer 的完整內容通過三條路徑傳送：`token` streaming → `agent_end.content` fallback → `done.content` 最終 fallback
- `ainvoke` 不發 `on_chat_model_stream`，所以 `agent_end.content` 是必要的 fallback

---

### 層次二：前端 AgentStep 型別與狀態管理（Chat.tsx）

```tsx
// 定義在 AgentFlow.tsx，供 Chat.tsx import
export interface AgentStep {
  id: string
  agent: 'supervisor' | 'researcher' | 'analyst' | 'writer'
  status: 'running' | 'done'
  summary?: string
  startTime: number    // performance.now()，用於計時
  endTime?: number
}

// Message 型別加入 agentSteps（類似 Case 3 的 toolCalls）
interface Message {
  role: 'user' | 'assistant'
  content: string
  agentSteps?: AgentStep[]   // ← 每個 assistant 訊息都有獨立的執行流程記錄
}

// 初始化 assistant 訊息時帶空陣列
setMessages(prev => [...prev,
  { role: 'user', content: text },
  { role: 'assistant', content: '', agentSteps: [] },   // ← 空陣列，等 SSE 填充
])
```

**SSE 事件處理邏輯**：

```tsx
let stepCounter = 0  // 每個 agent_start 的唯一 ID

// agent_start → 新增 running 步驟
if (eventType === 'agent_start') {
  const newStep: AgentStep = {
    id: `${data.agent}-${stepCounter++}`,
    agent: data.agent,
    status: 'running',
    startTime: performance.now(),
  }
  setMessages(prev => {
    const updated = [...prev]
    const msg = updated[assistantIdx]
    if (!msg) return prev
    updated[assistantIdx] = {
      ...msg,
      agentSteps: [...(msg.agentSteps ?? []), newStep],
    }
    return updated
  })

// agent_end → 找最後一個同名 running 步驟，更新為 done
} else if (eventType === 'agent_end') {
  setMessages(prev => {
    const updated = [...prev]
    const msg = updated[assistantIdx]
    if (!msg) return prev
    const steps = [...(msg.agentSteps ?? [])]
    // 從尾端找：同名且 running（Supervisor 會被呼叫多次，所以必須找最後一個）
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].agent === data.agent && steps[i].status === 'running') {
        steps[i] = { ...steps[i], status: 'done', summary: data.summary, endTime: performance.now() }
        break
      }
    }
    // writer fallback：ainvoke 沒有 token 時，從 agent_end.content 取得
    const newContent = (data.agent === 'writer' && data.content && !msg.content)
      ? data.content : msg.content
    updated[assistantIdx] = { ...msg, agentSteps: steps, content: newContent }
    return updated
  })
}
```

---

### 層次三：AgentFlow 渲染（AgentFlow.tsx + 嵌入 Chat.tsx）

**AgentFlow.tsx 核心架構**：

```tsx
// 每個步驟的渲染邏輯
function AgentStepRow({ step }: { step: AgentStep }) {
  const isRunning = step.status === 'running'
  const elapsed = useElapsed(step.startTime, step.endTime, isRunning)  // 100ms 更新一次
  const hasSummary = !!(step.summary && step.status === 'done')

  return (
    <div className={`af-step ${colorClass} ${isRunning ? 'af-step--running' : ''}`}>
      <div className="af-step-row" onClick={() => hasSummary && setExpanded(e => !e)}>
        {/* 狀態圖示：執行中 → spinner；完成 → ✓ */}
        {isRunning ? <span className="af-spinner" /> : <CheckIcon />}
        <AgentIcon agent={step.agent} />
        <span>{meta.label}</span>
        <span className={`af-timer${isRunning ? ' af-timer--running' : ''}`}>{elapsed}</span>
        {hasSummary && <ChevronIcon expanded={expanded} />}
      </div>
      {hasSummary && expanded && (
        <div className="af-step-body">
          <p className="af-summary">{step.summary}</p>
        </div>
      )}
    </div>
  )
}
```

**嵌入到 Chat.tsx（位置：bubble 上方，仿 Case 3 的 ToolCallPanel）**：

```tsx
{messages.map((msg, idx) => (
  <div key={idx} className={`cb-msg cb-msg--${msg.role}`}>
    <div className="cb-msg-avatar">...</div>
    <div className="cb-msg-content-wrap">

      {/* ← 這裡嵌入 AgentFlow（類比 Case 3 的 ToolCallPanel 位置） */}
      {msg.role === 'assistant' && msg.agentSteps && msg.agentSteps.length > 0 && (
        <AgentFlow steps={msg.agentSteps} />
      )}

      <div className="cb-msg-bubble">
        {msg.content ? <ReactMarkdown>{msg.content}</ReactMarkdown> : <LoadingIndicator />}
      </div>
    </div>
  </div>
))}
```

---

### 完整資料流圖

```
後端 LangGraph                        前端 React
─────────────────────────────────────────────────────────
supervisor_node 開始
  on_chat_model_start                → agent_start {agent:"supervisor"}
  on_chat_model_end                  → agent_end {agent:"supervisor", summary:"→ researcher"}
                                          ↓ setMessages: steps=[{id:"supervisor-0", status:"done"}]

researcher_node 開始
  on_chat_model_start                → agent_start {agent:"researcher"}
                                          ↓ setMessages: steps=[..., {id:"researcher-1", status:"running"}]
  on_chat_model_end                  → agent_end {agent:"researcher", summary:"研究完成..."}
                                          ↓ setMessages: 找最後一個 researcher+running → status:"done"

writer_node 開始
  on_chat_model_start                → agent_start {agent:"writer"}
  on_chat_model_stream × N           → token {content:"..."} × N
                                          ↓ setMessages: content 逐字累積
  on_chat_model_end                  → agent_end {agent:"writer", content:"完整報告"}
                                          ↓ 若無 token（ainvoke），從 agent_end.content 更新

done event                           → finalize, setLoading(false)
                                          ↓ AgentFlow: 所有步驟都是 done 狀態，計時器停止
```

---

### SSE 解析注意事項（`\r\n` 行結尾問題）

`sse-starlette` 使用 HTTP 規範的 `\r\n` 行結尾。前端解析時必須用 `line.trim() === ''` 識別空白分隔行，而非 `line === ''`：

```tsx
// ❌ 錯誤："\r" !== "" → 事件永遠不 dispatch
else if (line === '') { dispatchSseEvent(...) }

// ✅ 正確："\r".trim() === "" → 正確識別空白行
else if (line.trim() === '') { dispatchSseEvent(...) }
```

詳見 Q3 的完整說明。

---

## Q3：前端 SSE 事件明明後端有送出，但前端完全沒收到，原因是什麼？

### 問題現象

SSE Debug 面板只出現：
```
15:53:29.705 ─── 串流開始 model=gpt-4o-mini ───
15:54:21.969 ─── 串流結束（stream closed）───
```

中間沒有任何 `[agent_start]`、`[agent_end]`、`[token]`、`[done]` 事件。

後端 log 確認所有事件都有正常發出，`full_response=995 字`，顯然不是後端問題。

---

### 根本原因：SSE 行結尾格式（`\r\n` vs `\n`）

HTTP 規範中，SSE 訊息使用 `\r\n` 作為行結尾，`sse-starlette` 嚴格遵守此規範。

後端實際發出的 SSE 資料格式：
```
event: agent_start\r\ndata: {"agent": "supervisor"}\r\n\r\n
```

前端用 `\n` 分割：
```js
const lines = buffer.split('\n')
```

分割結果：
```
["event: agent_start\r", "data: {...}\r", "\r", ""]
```

關鍵問題：空白分隔行變成 `"\r"` 而非 `""`。

```js
// 原本的判斷（錯誤）
else if (line === '') {          // "\r" !== "" → 永遠不成立！
  dispatchSseEvent(...)          // 從未被呼叫
}
```

由於 `dispatchSseEvent` 永遠不被觸發，所有事件都被靜默丟棄，前端看起來什麼都沒發生。

---

### 修正方式

```js
// 修正後
else if (line.trim() === '') {   // "\r".trim() === "" → 正確！
  dispatchSseEvent(...)
}
```

`String.prototype.trim()` 會移除 `\r`、`\n`、空格等空白字元，因此無論行結尾是 `\r\n` 還是純 `\n` 都能正確識別空白分隔行。

---

### 為何 Case 1~8 沒有遇到這個問題？

Case 1~8 的 SSE 解析使用「看到 `event:` 就往下找 `data:`」的方式：

```js
if (line.startsWith('event:')) {
  const eventType = line.slice(6).trim()
  if (i + 1 < lines.length && lines[i + 1].startsWith('data:')) {
    const dataStr = lines[i + 1].slice(5).trim()
    // 直接處理，不需要等到空白行
  }
}
```

這種方式根本不依賴空白分隔行，所以 `\r` 的問題不會影響它。

Case 9 為了正確支援「一個事件有多行 data」（`sseDataLines.join('\n')`），改用「累積到空白行才 dispatch」的標準 SSE 解析方式，才暴露了這個行結尾問題。
