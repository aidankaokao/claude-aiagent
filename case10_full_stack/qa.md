# Case 10 Q&A 筆記 — Full-Stack Integrated Agent

## Q0：Case 10 的目的是什麼？整合了哪些前面 Case 的功能？

**A：**

### 目的

Case 10 是整個學習路徑的**整合驗收**，目標是把前九個 Case 分別學到的概念——SSE 串流、ReAct 工具迴圈、多 Agent Pipeline、HITL 設計原則、結構化路由——**組合成一個可實際使用的智慧助手**。

整合的核心挑戰不是「再加一個功能」，而是讓三種完全不同的執行路徑（chat / tools / research）共用同一個後端、同一條 SSE 連線、同一個前端介面，並讓使用者在不切換頁面的情況下感受到差異。

---

### 各 Case 貢獻對照表

| Case | 主題 | Case 10 中對應的程式碼 |
|------|------|-----------------------|
| **Case 1** | 基礎 SSE 串流 | `api.py` 的 `EventSourceResponse` + `astream_events`；`Chat.tsx` 的 buffer/SSE 解析迴圈 |
| **Case 2** | ReAct Agent | `agent.py` 的 `react_node` + `should_continue_react`；`react_llm = self.llm.bind_tools(TOOLS)` |
| **Case 3** | 工具開發 + UI | `calculate`（AST safe eval）、`get_datetime`、`query_knowledge`；`ToolCallPanel.tsx` 元件整體設計 |
| **Case 4** | Plan-Execute State | `IntegratedState(TypedDict)` 多欄位設計；`task` 欄位貫穿整條路由 |
| **Case 7** | 意圖分類路由 | `router_node` + `RouteDecision`；三種模式各自的 System Prompt（ROUTER_PROMPT / CHAT_PROMPT / RESEARCHER_PROMPT / WRITER_PROMPT） |
| **Case 9** | 多 Agent Pipeline + AgentFlow | `researcher_node → writer_node`；`AgentFlow.tsx`；`agent_start/end` SSE 事件；`metadata.langgraph_node` 節點過濾；SSE `\r\n` 行結尾解法 |

> Case 5（Map-Reduce）、Case 6（HITL）、Case 8（MCP）的模式未直接使用，但設計思路（State 欄位累積 vs 替換、節點間資料傳遞、外部協定整合）都有影響 Case 10 的架構判斷。

---

### 整合後新增的設計

這些是前面各 Case 沒有的：

1. **統一 SSE 協定**：8 種 event type 組成完整語意層（mode / tool_start / tool_end / agent_start / agent_end / token / done / error），前端根據 event type 決定更新哪個 UI 元件
2. **自適應前端**：同一個 `<Message>` 元件根據 `msg.mode` 動態選擇顯示 ModeBadge + ToolCallPanel（tools）或 AgentFlow（research）
3. **`with_structured_output` 做路由**：不是 if/else 分支，而是讓 LLM 自己判斷意圖並輸出 `Literal["chat","tools","research"]`
4. **Agent 快取**：用 `api_key[:8]:model` 做 cache key，避免每次重建 LangGraph 編譯後的 Runnable

---

## Q1：Case 10 的核心設計是什麼？它和 Case 9 有什麼不同？

**A：**

Case 10 是一個「全端整合」的 Agent，把前幾個 Case 的精華整合在一起：

| 面向 | Case 9 | Case 10 |
|------|--------|---------|
| 架構 | Supervisor 多 Agent（supervisor / researcher / analyst / writer） | Router + 單一主入口（router → chat / react / researcher → writer） |
| 工具 | 無工具（純語言任務） | calculate、get_datetime、query_knowledge |
| 路由 | Supervisor LLM 決定（Command goto） | `with_structured_output(RouteDecision)` 強制結構化輸出 |
| 前端 | AgentFlow 視覺化 | ModeBadge + ToolCallPanel（tools）/ AgentFlow（research）自適應 |

**核心思路**：先用 Router 分類意圖（chat / tools / research），再分派到對應子圖：
- `chat` → 一次性對話（chat_node）
- `tools` → ReAct 迴圈（react_node ↔ tool_node，最多 5 次）
- `research` → 研究管線（researcher_node → writer_node）

---

## Q2：Router 如何強制 LLM 只回傳 mode 分類？

**A：**

使用 `with_structured_output(RouteDecision)` 讓 LLM 輸出符合 Pydantic Schema 的 JSON：

```python
class RouteDecision(BaseModel):
    mode: Literal["chat", "tools", "research"]
    reason: str

router_llm = self.llm.with_structured_output(RouteDecision)
```

Router node 實作：

```python
async def router_node(state: IntegratedState) -> IntegratedState:
    system = SystemMessage(content="""你是意圖分類器。根據使用者訊息選擇模式：
- chat：一般問答、閒聊
- tools：需要計算、查詢時間、查詢知識庫
- research：需要深度研究、分析、撰寫報告""")
    decision = await router_llm.ainvoke([system] + state["messages"])
    return {"mode": decision.mode, "mode_reason": decision.reason}
```

`decision` 在 runtime 是 `RouteDecision` 實例（Pyright 可能誤報為 dict，屬 false positive）。

---

## Q3：ReAct 迴圈如何實作？如何防止無限循環？

**A：**

```python
def should_continue_react(state: IntegratedState):
    messages = state["messages"]
    iteration = state.get("iteration", 0)
    if iteration >= 5:
        return END
    last = messages[-1]
    if hasattr(last, "tool_calls") and last.tool_calls:
        return "tools"
    return END

graph.add_conditional_edges("react", should_continue_react, {"tools": "tools", END: END})
graph.add_edge("tools", "react")  # 工具完成後回到 react
```

react_node 每次執行後遞增 `iteration`：

```python
async def react_node(state: IntegratedState) -> IntegratedState:
    ...
    return {"messages": [response], "iteration": state.get("iteration", 0) + 1}
```

防止無限循環的三層機制：
1. `iteration >= 5` 強制中止
2. `tool_calls` 為空（LLM 決定不再呼叫工具）→ END
3. `ToolNode` 本身不會主動呼叫 LLM，只被動執行工具

---

## Q4：SSE 事件設計——前端如何區分三種模式？

**A：**

後端 `api.py` 依 event type 傳遞語意：

| SSE event | 來源 | 前端行為 |
|-----------|------|---------|
| `mode` | router node 結束，從 tool_calls 解析 RouteDecision | 顯示 ModeBadge |
| `tool_start` | `on_tool_start`（react 節點中） | ToolCallPanel 新增 running 項目 |
| `tool_end` | `on_tool_end` | ToolCallPanel 更新為 done + 輸出 |
| `agent_start` | `on_chat_model_start`（researcher/writer） | AgentFlow 新增 running 步驟 |
| `agent_end` | `on_chat_model_end`（researcher/writer，無 tool_calls） | AgentFlow 更新為 done + 摘要 |
| `token` | `on_chat_model_stream`（chat/react/writer） | 串流文字到泡泡 |
| `done` | 串流結束 | 關閉 loading，fallback content |
| `error` | 例外 | 顯示錯誤訊息 |

**mode 事件解析邏輯**（從 router 的 `with_structured_output` tool_calls 中取出）：

```python
def _extract_mode(ai_message) -> dict | None:
    if not hasattr(ai_message, "tool_calls") or not ai_message.tool_calls:
        return None
    for tc in ai_message.tool_calls:
        args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
        if "mode" in args:
            return args
    return None
```

---

## Q5：前端如何根據 mode 自適應渲染不同的視覺化元件？

**A：**

`Message` interface 包含所有可能的視覺化狀態：

```tsx
interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  mode?: 'chat' | 'tools' | 'research'
  modeReason?: string
  toolCalls?: ToolCall[]    // tools mode 用
  agentSteps?: AgentStep[]  // research mode 用
  isLoading?: boolean
  error?: string
}
```

渲染邏輯（在 `cb-msg-content-wrap` 內，泡泡之前）：

```tsx
{msg.role === 'assistant' && (
  <>
    {msg.mode && <ModeBadge mode={msg.mode} reason={msg.modeReason} />}
    {msg.mode === 'tools' && msg.toolCalls && msg.toolCalls.length > 0 && (
      <ToolCallPanel toolCalls={msg.toolCalls} />
    )}
    {msg.mode === 'research' && msg.agentSteps && msg.agentSteps.length > 0 && (
      <AgentFlow steps={msg.agentSteps} />
    )}
  </>
)}
```

三個元件互斥：
- `ModeBadge`：所有模式都顯示（chat/tools/research）
- `ToolCallPanel`：只有 tools mode 且有 toolCalls 時顯示
- `AgentFlow`：只有 research mode 且有 agentSteps 時顯示

---

## Q6：calculate 工具為何不直接用 eval()？

**A：**

直接 `eval()` 會有安全風險（代碼注入）。Case 10 使用 AST（抽象語法樹）白名單驗證：

```python
import ast

def _safe_eval(expr: str) -> float:
    """只允許數字常數和基本四則運算"""
    tree = ast.parse(expr, mode='eval')
    allowed = (
        ast.Expression, ast.BinOp, ast.UnaryOp,
        ast.Add, ast.Sub, ast.Mult, ast.Div,
        ast.Pow, ast.Mod, ast.FloorDiv,
        ast.UAdd, ast.USub,
        ast.Constant,
    )
    for node in ast.walk(tree):
        if not isinstance(node, allowed):
            raise ValueError(f"不允許的運算: {type(node).__name__}")
    return eval(compile(tree, "<string>", "eval"))
```

這樣 `_safe_eval("(2+3)*4")` = 20 是允許的，但 `_safe_eval("__import__('os').system('rm -rf /')")` 會被 AST 驗證拒絕。

---

## Q7：研究管線（researcher → writer）如何傳遞資料？

**A：**

透過 `IntegratedState` 的 `research_result` 欄位：

```python
class IntegratedState(TypedDict):
    messages: Annotated[list, add_messages]
    task: str
    mode: str
    mode_reason: str
    research_result: str   # researcher 寫入，writer 讀取
    iteration: int
```

**researcher_node**：搜集資料後存入 state：
```python
async def researcher_node(state: IntegratedState) -> IntegratedState:
    ...
    return {"research_result": response.content, "messages": [response]}
```

**writer_node**：讀取 research_result 撰寫報告：
```python
async def writer_node(state: IntegratedState) -> IntegratedState:
    system = SystemMessage(content=f"""你是專業撰稿人。
研究員已完成研究，內容如下：
{state.get('research_result', '')}

請基於以上研究撰寫完整報告。""")
    ...
```

這是 LangGraph 中節點間傳遞中間結果的標準模式。

---

## Q8a：串接所有 Agent 與前端功能時，需要特別注意哪些事？

**A：**

整合多種 Agent 模式到同一個前後端時，有 **10 個常見陷阱**，對照 Case 10 的程式碼說明：

---

### 1. SSE 事件命名必須後端前端嚴格對應

後端 `api.py` 發的 event type 字串，和前端 `dispatchSseEvent` 的 `if (eventType === '...')` 必須完全一致。任何拼寫差異（例如 `tool-start` vs `tool_start`）都會導致事件靜默丟失，難以 debug。

**最佳實踐**：把所有 event type 列在後端 docstring 和前端 Chat.tsx 的 JSDoc 裡，兩邊對齊確認一次。

---

### 2. astream_events v2 必須用 langgraph_node 過濾節點

LangGraph 的 `astream_events v2` 會為**圖中所有節點**的所有事件廣播，包含 router、chat、react、tools、researcher、writer。如果不過濾 `metadata.langgraph_node`，同一個 `on_chat_model_stream` 事件在 router / react / researcher / writer 都會觸發，會串出錯誤的 token。

```python
# api.py 的正確做法
node = event.get("metadata", {}).get("langgraph_node", "")

# 只從 STREAM_NODES 抓 token
elif etype == "on_chat_model_stream" and node in STREAM_NODES:
    ...

# 只從 RESEARCH_NODES 抓 agent 事件
elif etype == "on_chat_model_start" and node in RESEARCH_NODES:
    ...
```

STREAM_NODES = {"chat", "react", "writer"}
RESEARCH_NODES = {"researcher", "writer"}

---

### 3. ReAct 模式的 tool-call token 必須過濾

ReAct 迴圈中，LLM 生成 `tool_calls`（決定呼叫哪個工具）時也會觸發 `on_chat_model_stream`，但此時 `chunk.content` 是**空字串**（tool call 的 JSON schema 不走 content 欄位）。如果不過濾，會把空字串塞進前端的 `msg.content`，導致 UI 異常。

```python
# 正確：只取有內容的 token
chunk = event["data"]["chunk"].content
if isinstance(chunk, str) and chunk:   # 過濾空白和非字串
    full_response += chunk
    yield {"event": "token", "data": ...}
```

---

### 4. agent_start / agent_end 必須用 run_id 配對

`on_chat_model_start` 和 `on_chat_model_end` 都帶同一個 `run_id`。必須用 `reported_runs` set 追蹤哪些 run_id 已發過 `agent_start`，`agent_end` 才用 `run_id in reported_runs` 配對：

```python
reported_runs: set[str] = set()

# agent_start：記錄 run_id
if etype == "on_chat_model_start" and node in RESEARCH_NODES:
    if run_id not in reported_runs:
        reported_runs.add(run_id)
        yield {"event": "agent_start", ...}

# agent_end：只更新已記錄的 run_id
elif etype == "on_chat_model_end" and node in RESEARCH_NODES:
    if run_id in reported_runs:   # 沒有這行，router 的 on_chat_model_end 也會誤觸發
        yield {"event": "agent_end", ...}
```

沒有這個配對機制，router 節點的 `on_chat_model_end` 也會被誤判為 agent_end。

---

### 5. mode 事件只能發一次

Router 在 MemorySaver 的某些情況下可能被重新評估，需要 `mode_sent` flag 保護：

```python
mode_sent = False

if etype == "on_chat_model_end" and node == "router" and not mode_sent:
    mode, reason = _extract_mode(event["data"])
    if mode:
        mode_sent = True
        yield {"event": "mode", ...}
```

前端收到兩次 mode 事件會把 ModeBadge 更新兩次，通常無害，但有時第二次會是空字串，把 badge 清掉。

---

### 6. with_structured_output 的輸出藏在 tool_calls，不在 content

`router_llm = self.llm.with_structured_output(RouteDecision)` 底層透過 function calling 實現，LLM 的輸出**不在 `output.content`，而在 `output.tool_calls[0].args`**：

```python
def _extract_mode(event_data: dict) -> tuple[str, str]:
    output = event_data.get("output")
    tool_calls = getattr(output, "tool_calls", None)
    if tool_calls:
        tc = tool_calls[0]
        args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
        return args.get("mode", ""), args.get("reason", "")

    # JSON mode fallback（少數 LLM 不支援 function calling）
    if hasattr(output, "content"):
        obj = json.loads(output.content)
        return obj.get("mode", ""), obj.get("reason", "")
```

---

### 7. 前端 assistantIdx 必須在發送前固定

在 `handleSend` 最頂端計算 `const assistantIdx = messages.length + 1`，後續所有 SSE 事件 handler 都閉包引用這個**固定值**。

**不能**在 handler 內部用「最後一個 assistant message」的動態 index，因為 messages 狀態隨 SSE 事件不斷更新，index 會漂移。

```tsx
const assistantIdx = messages.length + 1  // 固定在發送時

// 所有 setMessages 都用固定 index
setMessages(prev => {
  const updated = [...prev]
  const msg = updated[assistantIdx]
  if (!msg) return prev   // 安全守衛
  updated[assistantIdx] = { ...msg, /* 更新 */ }
  return updated
})
```

---

### 8. React state 必須不可變更新

每個 SSE handler 的 `setMessages` 都必須：
1. `const updated = [...prev]`（淺拷貝陣列）
2. `updated[assistantIdx] = { ...msg, 新欄位 }`（展開物件）
3. `return updated`

**不能** `prev[assistantIdx].toolCalls.push(newTc)` 直接 mutate，React 不會偵測到變化，UI 不更新。

---

### 9. 三層 content fallback 確保任何模式都有輸出

不同模式的 content 來源不同，需要設計 fallback 層級：

| 層級 | 來源 | 適用模式 |
|------|------|---------|
| 第一層 | `token` 事件累積 | chat、tools（最終回答）、research（writer 串流） |
| 第二層 | `agent_end.content` | research（writer 完整內容）、tools（react 最終答案） |
| 第三層 | `done.content` | 全模式保底（網路問題或 token 遺失時） |

```tsx
// agent_end：只在沒有 token 串流時才用 content fallback
const newContent = data.content && !msg.content ? data.content : msg.content

// done：終極保底，只在 content 仍為空時才覆寫
if (data.content) {
  setMessages(prev => {
    const msg = prev[assistantIdx]
    if (!msg || msg.content) return prev   // 已有內容就不覆寫
    ...
  })
}
```

---

### 10. State 中 iteration 每次請求要歸零

`IntegratedState.iteration` 用於計算 ReAct 迴圈次數。MemorySaver 會保留上一輪的 state，因此每次新請求必須在 `agent.astream_events(input=...)` 的 input 中**顯式重設** `iteration: 0`：

```python
async for event in agent.astream_events(
    {
        "messages": [("user", req.message)],
        "task": req.message,
        "mode": "",
        "mode_reason": "",
        "research_result": "",
        "iteration": 0,   # 每次歸零，避免 MemorySaver 記住上次計數
    },
    ...
)
```

忘記歸零會導致第二次 tools 問題時直接跳過所有工具呼叫（因為 iteration 已經 >= 5）。

---

## Q8：如何在本地開發環境啟動 Case 10？

**A：**

```bash
# 1. 後端（需要 Python 3.11+）
cd case10_full_stack/backend
pip install -r requirements.txt
python api.py
# 後端啟動於 http://localhost:8000

# 2. 前端（新開 terminal）
cd case10_full_stack/frontend
npm install
npm run dev
# 前端啟動於 http://localhost:5173

# 3. 在瀏覽器 Sidebar 填入 LLM 設定（API Key / Base URL / Model）
# 4. 點「儲存設定」後即可開始對話
```

**Docker 部署**：

```bash
cd case10_full_stack
cp .env.example .env
# 編輯 .env 填入 DEVELOPER_NAME 等

docker build -f Dockerfile.backend -t claude-aiagent-case10-backend:1.0 .
docker build -f Dockerfile.frontend -t claude-aiagent-case10-frontend:1.0 .
docker-compose up -d
# 前端可由 http://localhost:8015 訪問
```
