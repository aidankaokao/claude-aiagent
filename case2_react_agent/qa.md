# Case 2: ReAct Agent — Q&A

---

## Q2：與 Case 1 相比，前端串接後端的方式有改變嗎？

**串接機制本身沒有改變**，用的仍然是一樣的 `fetch + ReadableStream + TextDecoder` 手動解析 SSE。改變的只有「解析到哪些事件後要做什麼」。

### 沒有改變的部分

- 發送請求的方式：`POST /api/chat`，body 帶 `message`、`conversation_id`、`llm_config`
- SSE 解析機制：`fetch → res.body.getReader() → 逐塊讀取 → 按行切割 → 配對 event:/data:`
- 其他 API（`GET /conversations`、`GET /conversations/:id`、`DELETE`）：完全相同

### 新增的部分

**1. Message 型別加了 `toolCalls` 欄位**

```typescript
// Case 1
interface Message {
  role: 'user' | 'assistant'
  content: string
}

// Case 2（新增）
interface Message {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]  // ← 新增
}
```

**2. 初始化 assistant 訊息時帶入空陣列**

```typescript
// Case 1
{ role: 'assistant', content: '' }

// Case 2（新增 toolCalls）
{ role: 'assistant', content: '', toolCalls: [] }
```

**3. SSE 事件處理多了 `tool_start` 和 `tool_end`**

Case 1 只處理三種事件：`token`、`done`、`error`。
Case 2 多了兩種：

```typescript
} else if (eventType === 'tool_start') {
  // 在 toolCalls 陣列新增一筆 status:'running' 的記錄
  setMessages(prev => { ... push new ToolCall ... })

} else if (eventType === 'tool_end') {
  // 依 run_id 找到對應記錄，更新 tool_output 與 status:'done'
  setMessages(prev => { ... map & update by run_id ... })
}
```

**4. 渲染層多了 `ToolCallPanel` 元件**

```tsx
// Case 2 新增：assistant 訊息氣泡上方顯示工具面板
{msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
  <ToolCallPanel toolCalls={msg.toolCalls} />
)}
```

### 小結

| 項目 | Case 1 | Case 2 |
|------|--------|--------|
| 請求方式 | `fetch POST /api/chat` | 相同 |
| SSE 解析機制 | `ReadableStream + TextDecoder` | 相同 |
| 處理的 SSE 事件 | `token` / `done` / `error` | 多加 `tool_start` / `tool_end` |
| Message 型別 | `role` + `content` | 多加 `toolCalls?` |
| 渲染 | 直接顯示氣泡 | 氣泡上方加工具面板 |

---

## Q1：如何串接工具，並讓 LLM 根據使用者問題來調用工具？

整個流程分為三個層次：**定義工具 → 綁定工具到 LLM → 建立循環圖**。

---

### 第一層：用 `@tool` 定義工具（`tools.py`）

```python
from langchain_core.tools import tool

@tool
def get_current_time(location: str = "taipei") -> str:
    """
    取得指定地區的當前日期與時間。
    支援地區：taipei（台北）、tokyo（東京）、utc、london、new york、los angeles。
    若未指定地區，預設回傳台北時間。
    """
    # ... 實作 ...
```

`@tool` 裝飾器做了兩件事：
1. **docstring → 工具描述**：LLM 讀這段文字來判斷「這個工具是用來做什麼的、什麼情況下該用」
2. **參數型別 → 工具 schema**：LLM 知道要傳什麼參數進去（這裡是 `location: str`）

最後將所有工具匯總成一個清單：
```python
ALL_TOOLS = [web_search, calculator, get_current_time]
```

---

### 第二層：用 `bind_tools()` 把工具清單告訴 LLM（`agent.py`）

```python
self.llm = ChatOpenAI(...).bind_tools(ALL_TOOLS)
```

`bind_tools()` 的作用是在每次呼叫 LLM 時，把三個工具的 schema（名稱、描述、參數格式）一起附進 API request。LLM 收到後，如果判斷需要使用工具，回覆的 `AIMessage` 就會帶有 `tool_calls` 欄位：

```json
{
  "content": "",
  "tool_calls": [
    {
      "name": "get_current_time",
      "args": { "location": "taipei" },
      "id": "call_abc123"
    }
  ]
}
```

如果 LLM 判斷不需要工具，就直接回純文字，`tool_calls` 為空。

---

### 第三層：用條件邊 + ToolNode 建立 ReAct 循環（`agent.py`）

```python
tool_node = ToolNode(ALL_TOOLS)   # 內建執行節點，自動執行 tool_calls

graph.add_node("llm_node", llm_node)
graph.add_node("tools", tool_node)

graph.add_edge(START, "llm_node")

# 條件邊：llm_node 結束後，由 should_continue 決定走哪條路
graph.add_conditional_edges(
    "llm_node",
    should_continue,
    {
        "tools": "tools",  # tool_calls 不為空 → 去執行工具
        END: END,          # tool_calls 為空   → 結束，輸出答案
    },
)

graph.add_edge("tools", "llm_node")  # 工具執行完 → 固定回到 llm_node
```

路由函數 `should_continue` 只做一件事：
```python
def should_continue(state: AgentState):
    last_message = state["messages"][-1]
    if last_message.tool_calls:
        return "tools"
    return END
```

`ToolNode` 拿到 `AIMessage.tool_calls` 後，自動呼叫對應工具，並將結果包成 `ToolMessage` 放回 `state["messages"]`。下次 `llm_node` 被呼叫時，LLM 就能看到工具的執行結果，繼續推理。

---

### 完整的一次對話流程

以「現在台北時間幾點？」為例：

```
使用者輸入："現在台北時間幾點？"
         ↓
    [llm_node]
    LLM 看到工具描述，判斷應呼叫 get_current_time
    → AIMessage.tool_calls = [{"name": "get_current_time", "args": {"location": "taipei"}}]
         ↓
    should_continue() → "tools"
         ↓
    [tools / ToolNode]
    自動執行 get_current_time(location="taipei")
    → ToolMessage.content = "目前時間（taipei，UTC+08:00）：\n2024 年 ..."
         ↓
    [llm_node]
    LLM 看到工具結果，產生最終回覆
    → AIMessage.content = "現在台北時間是下午 3:42。"
    → AIMessage.tool_calls = []（空）
         ↓
    should_continue() → END
         ↓
    串流輸出給使用者
```

若問題需要多個工具（例如「搜尋 LangGraph 並計算它發布幾年了」），這個循環會執行多次，每次呼叫一個或多個工具，直到 LLM 認為資訊足夠才結束。

