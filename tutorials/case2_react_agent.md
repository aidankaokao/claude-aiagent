# Case 2: ReAct Agent — 教學文件

## 前置知識

完成 [Case 1: 基礎聊天機器人](./case1_basic_chatbot.md) 後再進行本 Case。

---

## 概念說明

### ReAct 是什麼？

ReAct（Reasoning + Acting）是一種讓 LLM 自主決定「何時呼叫工具」的 Agent 模式。相較於 Case 1 的單純對話，ReAct Agent 可以：

1. **推理（Reason）**：分析使用者問題，判斷需要哪些資訊
2. **行動（Act）**：呼叫工具取得資訊
3. **觀察（Observe）**：讀取工具結果，繼續推理
4. 重複直到能給出最終答案

### ReAct 圖結構

```
START
  │
  ▼
llm_node ─────────────────────────────────┐
  │                                        │
  │ (有 tool_calls?)                       │
  ├─ 是 ──▶ tools ──▶ 回到 llm_node        │
  │                                        │
  └─ 否 ──▶ END                            │
                                           │
  （以上是一個迴圈，可執行多次）           │
```

用 LangGraph 程式碼表達：

```python
graph.add_conditional_edges(
    "llm_node",
    should_continue,           # 路由函數
    {"tools": "tools", END: END}
)
graph.add_edge("tools", "llm_node")  # 執行完工具 → 回到 LLM
```

### 關鍵訊息類型

ReAct 迴圈中有三種訊息類型，它們都存在 `state["messages"]` 串列裡：

| 訊息類型 | 何時產生 | 重要欄位 |
|---------|---------|---------|
| `HumanMessage` | 使用者輸入 | `content` |
| `AIMessage` | LLM 輸出 | `content`（最終答案）或 `tool_calls`（決定呼叫工具） |
| `ToolMessage` | 工具執行結果 | `content`（工具輸出），`tool_call_id` |

---

## 實踐內容

### 資料夾結構

```
case2_react_agent/
  backend/
    agent.py          # ReActAgent：ReAct 迴圈核心（本 Case 重點）
    tools.py          # 三個 @tool 定義（搜尋、計算機、時間）
    api.py            # FastAPI + SSE（含工具呼叫事件）
    database.py       # SQLite：conversations + tool_calls 表
    models.py         # Pydantic schemas
    config.py         # 環境變數
    fixtures/
      mock_search.json  # 模擬搜尋結果
    seed_data.py      # 建立初始對話記錄
    requirements.txt
  frontend/
    src/
      App.tsx
      Chat.tsx        # 新增：工具呼叫視覺化面板
      Chat.css
      main.tsx
    index.html
    package.json
    vite.config.ts
    tsconfig.json
  docker-compose.yaml
  Dockerfile.backend
  Dockerfile.frontend
  .env.example
  qa.md               # 常見問題（查看後填寫）
```

---

## 程式碼導讀

### 1. 工具定義（`backend/tools.py`）

Case 2 使用最簡單的 `@tool` 裝飾器，不需要 Pydantic schema（Case 3 才引入）：

```python
@tool
def web_search(query: str) -> str:
    """在網路上搜尋資訊，適合查詢時事、知識、定義等問題。"""
    # 從 mock_search.json 找最相近的結果
    ...

@tool
def calculator(expression: str) -> str:
    """執行數學計算，適合加減乘除、百分比等計算問題。"""
    result = eval(expression)
    ...

@tool
def get_current_time(timezone: str = "Asia/Taipei") -> str:
    """取得指定時區的當前時間。"""
    ...
```

重點：`@tool` 裝飾器會讀取 **函式名稱** 和 **docstring** 作為工具說明，讓 LLM 了解何時使用這個工具。

### 2. Agent 核心（`backend/agent.py`）

```python
class ReActAgent:
    def __init__(self, llm_config: LlmConfig):
        # bind_tools()：將工具 schema 序列化後加入每次 LLM 請求
        self.llm = ChatOpenAI(...).bind_tools(ALL_TOOLS)

    async def create_agent(self):
        async def llm_node(state: AgentState):
            response = await self.llm.ainvoke(state["messages"])
            return {"messages": [response]}

        def should_continue(state: AgentState):
            last_message = state["messages"][-1]
            if last_message.tool_calls:  # AIMessage 有 tool_calls → 繼續
                return "tools"
            return END                   # 沒有 → 結束

        tool_node = ToolNode(ALL_TOOLS)  # 自動執行 tool_calls 中的工具

        graph = StateGraph(AgentState)
        graph.add_node("llm_node", llm_node)
        graph.add_node("tools", tool_node)
        graph.add_edge(START, "llm_node")
        graph.add_conditional_edges("llm_node", should_continue, ...)
        graph.add_edge("tools", "llm_node")   # ← 迴圈的關鍵
        return graph.compile(checkpointer=MemorySaver())
```

`bind_tools()` 的作用：每次呼叫 LLM 時，自動將工具的 JSON schema（名稱、說明、參數型別）附加到 API 請求中。LLM 看到這份「工具說明書」後，在適當時機生成 `tool_calls`。

### 3. ToolNode 的工作原理

`ToolNode(ALL_TOOLS)` 是一個預建的節點，它會：

1. 讀取 `state["messages"][-1].tool_calls`（最後一則 AIMessage 裡的工具呼叫清單）
2. 找到對應的工具函式並執行
3. 把每個工具的執行結果包裝成 `ToolMessage` 加回 `messages`

無需手動處理工具呼叫——`ToolNode` 全自動完成。

### 4. SSE 事件設計（`backend/api.py`）

Case 2 在 Case 1 的 `token` 事件基礎上，新增了 `tool_start` 和 `tool_end`：

```python
async for event in agent.astream_events(input, config, version="v2"):
    kind = event["event"]

    if kind == "on_tool_start":
        # 工具開始執行 → 通知前端顯示 "思考中..."
        yield f"data: {json.dumps({'type': 'tool_start', 'tool_name': name, 'input': input})}\n\n"

    elif kind == "on_tool_end":
        # 工具執行完成 → 通知前端顯示結果
        yield f"data: {json.dumps({'type': 'tool_end', 'tool_name': name, 'output': output})}\n\n"

    elif kind == "on_chat_model_stream":
        # LLM token 串流
        yield f"data: {json.dumps({'type': 'token', 'content': chunk})}\n\n"
```

### 5. 前端工具面板（`frontend/src/Chat.tsx`）

前端新增了「工具呼叫面板」，顯示 Agent 正在使用哪些工具：

```typescript
// 處理 SSE 事件
case 'tool_start':
  setToolCalls(prev => [...prev, {
    name: data.tool_name,
    input: data.input,
    status: 'running',   // 顯示旋轉動畫
  }])
  break

case 'tool_end':
  setToolCalls(prev => prev.map(tc =>
    tc.name === data.tool_name
      ? { ...tc, output: data.output, status: 'done' }  // 更新為完成狀態
      : tc
  ))
  break
```

---

## 執行方式

### 本地開發

```bash
# 後端
cd case2_react_agent/backend
pip install -r requirements.txt
python api.py   # 啟動於 http://localhost:8000

# 前端（另開終端機）
cd case2_react_agent/frontend
npm install
npm run dev     # 啟動於 http://localhost:5173
```

### Docker 部署

```bash
# 確認外部網路存在
docker network create aiagent-network  # 已存在則跳過

cd case2_react_agent
cp .env.example .env     # 填入 DEVELOPER_NAME
docker-compose up -d
```

前端：`http://localhost:3002`，後端 API：`http://localhost:8002`

---

## 測試驗證

啟動後，在前端 Sidebar 填入 API Key 並選擇模型，然後測試以下問題：

### 測試工具選擇

| 問題 | 預期呼叫的工具 |
|------|--------------|
| 台灣的首都是哪裡？ | `web_search` |
| 123 × 456 等於多少？ | `calculator` |
| 現在幾點？ | `get_current_time` |
| 幫我搜尋 AI 的最新發展，並計算一下 GPT-4 發布距今多少天 | `web_search` + `calculator`（多工具） |

### 驗證重點

1. **工具面板出現**：問題發出後，左側應出現工具呼叫記錄（名稱 + 輸入 + 輸出）
2. **工具結果整合**：最終答案應整合工具回傳的資訊，而非 LLM 憑記憶回答
3. **多工具串接**：複合問題應連續呼叫多個工具，每個都顯示在面板中
4. **對話記憶**：同一 thread 中的後續問題可引用之前的工具結果

---

## 延伸挑戰

1. **新增工具**：在 `tools.py` 新增一個 `translate_text(text, target_lang)` 工具，讓 Agent 能翻譯文字
2. **工具錯誤處理**：修改 `calculator`，讓它捕捉 `eval()` 的例外並回傳有意義的錯誤訊息給 LLM
3. **限制工具呼叫次數**：在 `agent.py` 的 `should_continue` 中加入計數器，超過 5 次工具呼叫就強制結束
4. **工具結果持久化**：目前每次新對話工具呼叫記錄會清空，嘗試修改前端讓每則訊息記住自己對應的工具呼叫
