# Case 4 — Plan-Execute Agent Q&A

## Q3：執行任務時如何同步將當前結果傳給前端，並顯示當前狀態？

整個流程分四層：**LangGraph 事件系統 → api.py 過濾轉譯 → SSE 協定傳輸 → 前端 React state 更新**。

---

### 第一層：LangGraph 的 `astream_events`

`astream_events` 是 LangGraph 提供的**非同步事件流**，它在圖執行的各個時間點發出事件，`api.py` 用 `async for event in agent.astream_events(...)` 逐一接收（第 118-129 行）：

```python
async for event in agent.astream_events(
    {"user_request": req.message, "plan": [], ...},
    config={"configurable": {"thread_id": conversation_id}},
    version="v2",
):
```

每個 `event` 是一個字典，關鍵欄位：
- `event["event"]`：事件種類字串，如 `"on_chain_start"`、`"on_tool_end"`
- `event["name"]`：觸發事件的元件名稱，如 `"planner_node"`、`"search_attractions"`
- `event["data"]`：事件相關資料（不同種類格式不同）
- `event["metadata"]["langgraph_node"]`：目前正在執行的圖節點名稱

LangGraph v2 版事件的種類：

| 事件名稱 | 何時觸發 |
|---------|---------|
| `on_chain_start` | 節點函式開始執行 |
| `on_chain_end` | 節點函式執行完畢，`data["output"]` 是節點的回傳值 |
| `on_tool_start` | 工具的 `ainvoke` 被呼叫前 |
| `on_tool_end` | 工具的 `ainvoke` 執行完畢後 |
| `on_chat_model_stream` | LLM 輸出一個 token 時（只有 streaming 模式） |

**重要**：`on_tool_start/end` 不需要 ToolNode 才會觸發。本 Case 的工具是在 `executor_node` 內部直接用 `tool_fn.ainvoke()` 呼叫的，但 LangChain 的 callback 機制在任何 `ainvoke` 呼叫時都會自動觸發這些事件。

---

### 第二層：api.py 過濾事件，轉譯成業務語義的 SSE 事件

`api.py` 的 `event_generator()` 是一個 Python async generator，它監聽 `astream_events` 並用 `yield` 發出 SSE 事件。每個 `yield` 代表「往 HTTP 連線寫一筆資料」：

```python
# api.py 第 101 行
async def event_generator():
    local_plan: list[str] = []
    local_step_index = 0      # api.py 自己維護的步驟計數器
    ...
    async for event in agent.astream_events(...):
        ...
        yield {"event": "step_start", "data": json.dumps({...})}
```

五個重要的映射關係：

**① planner_node 完成 → `plan_created`**（第 138-149 行）
```python
if etype == "on_chain_end" and node_name == "planner_node":
    output = event["data"].get("output", {})
    local_plan = output.get("plan", [])   # 節點回傳的 dict 中取出 plan
    yield {"event": "plan_created", "data": json.dumps({"steps": local_plan})}
```
`on_chain_end` 的 `data["output"]` 就是節點函式的 return 值（是 delta，不是完整 state）。planner_node 回傳 `{"plan": [...], ...}`，所以能直接取到 `plan`。

**② executor_node 開始 → `step_start`**（第 152-163 行）
```python
elif etype == "on_chain_start" and node_name == "executor_node":
    yield {"event": "step_start", "data": json.dumps({
        "step_index": local_step_index,
        "step_text": local_plan[local_step_index],
    })}
```
`local_step_index` 是 api.py 自己維護的計數器，初始為 0，每次 `step_done` 後加 1。這樣就知道「這次 executor_node 啟動是在執行第幾步」。

**③ executor_node 完成 → `step_done`**（第 166-186 行）
```python
elif etype == "on_chain_end" and node_name == "executor_node":
    output = event["data"].get("output", {})
    new_steps = output.get("past_steps", [])   # 節點這次回傳的 past_steps（只有1筆）
    if new_steps:
        result_text = new_steps[-1].get("result", "")
        yield {"event": "step_done", "data": json.dumps({
            "step_index": local_step_index,
            "result": result_text[:300],
        })}
        local_step_index += 1   # 計數器遞增，等待下一個 executor_node 啟動
```

**④ 工具執行 → `tool_start` / `tool_end`**（第 192-217 行）
工具事件直接轉發，帶 `run_id` 讓前端能配對「哪個 tool_start 對應哪個 tool_end」。

**⑤ replanner 最終整合的 LLM token → `token`**（第 228-237 行）
```python
elif etype == "on_chat_model_stream":
    node = event.get("metadata", {}).get("langgraph_node", "")
    if node == "replanner_node":   # 只有最終整合才串流，executor 的 LLM token 不發出
        chunk = event["data"]["chunk"].content
        if chunk:
            yield {"event": "token", "data": json.dumps({"content": chunk})}
```

---

### 第三層：SSE 協定 — HTTP 連線保持開啟

`sse_starlette` 的 `EventSourceResponse` 把 `event_generator()` 包成符合 [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) 規範的 HTTP 回應（第 265 行）：

```python
return EventSourceResponse(event_generator())
```

每次 `yield {"event": "step_start", "data": "..."}` 在 HTTP body 上寫入：
```
event: step_start\r\n
data: {"step_index": 0, "step_text": "搜尋東京景點"}\r\n
\r\n
```

關鍵：HTTP 連線**不關閉**，client 可以持續讀取新事件，直到收到 `done` 事件或連線中斷。這就是為什麼前端能即時看到每個步驟的進度。

---

### 第四層：前端解析 SSE，更新 React state

前端用 `fetch()` + `ReadableStream` 手動讀取 SSE（`Chat.tsx` 第 232-318 行）：

```javascript
const reader = res.body?.getReader()
let buffer = ''

while (true) {
    const { done, value } = await reader.read()    // 從 HTTP 串流讀取一塊資料
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // 以 \n\n 分隔完整事件區塊（關鍵：防止跨 chunk 截斷）
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ''    // 最後不完整的區塊留在 buffer 等下次補全

    for (const block of blocks) {
        let eventType = '', dataStr = ''
        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim()
            else if (line.startsWith('data:')) dataStr = line.slice(5).trim()
        }
        handleEvent(eventType, JSON.parse(dataStr))
    }
}
```

`handleEvent` 依事件種類呼叫 `setMessages(prev => ...)` 更新 React state，React 自動重新渲染 UI：

```javascript
// step_start → 把對應步驟的 status 改為 'running'
} else if (eventType === 'step_start') {
    const step_index = data.step_index as number
    setMessages(prev => {
        const updated = [...prev]
        const msg = updated[assistantIdx]
        const newSteps = (msg.planSteps ?? []).map((s, idx) =>
            idx === step_index ? { ...s, status: 'running' as const } : s
        )
        updated[assistantIdx] = { ...msg, planSteps: newSteps }
        return updated
    })

// step_done → 把對應步驟改為 'done'，附加結果
} else if (eventType === 'step_done') {
    const { step_index, result } = data
    setMessages(prev => {
        const updated = [...prev]
        const msg = updated[assistantIdx]
        const newSteps = (msg.planSteps ?? []).map((s, idx) =>
            idx === step_index ? { ...s, status: 'done' as const, result } : s
        )
        updated[assistantIdx] = { ...msg, planSteps: newSteps }
        return updated
    })
}
```

---

### 完整時序圖

```
後端（LangGraph）                  api.py                    前端（React）
─────────────────                  ──────                    ──────────────
planner_node 執行完畢
  → on_chain_end planner_node  →   yield plan_created    →  setMessages: planSteps=[pending×N]
                                                              UI: PlanTimeline 全部灰點出現

executor_node 開始執行
  → on_chain_start executor_node → yield step_start(0)   →  setMessages: planSteps[0].status='running'
                                                              UI: 步驟0 旋轉動畫

  executor_llm 決定呼叫工具
  → on_tool_start search_attractions → yield tool_start  →  setMessages: toolCalls 新增 running 項目
                                                              UI: ToolCallPanel 顯示執行中

  工具執行完畢
  → on_tool_end                 →   yield tool_end       →  setMessages: toolCalls 項目改為 done
                                                              UI: ToolCallPanel 顯示完成

  synthesis_llm 整合步驟摘要
  (token 不發出，executor 階段靜默)

executor_node 執行完畢
  → on_chain_end executor_node  →   yield step_done(0)   →  setMessages: planSteps[0].status='done'
                                    local_step_index = 1     UI: 步驟0 金色勾、顯示摘要

（步驟 1、2、3 重複上述流程）

replanner_node：all_done=True
  → synthesis_llm 逐 token 輸出
  → on_chat_model_stream        →   yield token×N        →  setMessages: content 逐字累積
                                                              UI: 訊息泡泡逐字出現（Markdown）

  → on_chain_end replanner_node →   yield done           →  setConversationId、更新側邊欄
```

---

### 為什麼用 `\n\n` 切割而非逐行處理？

SSE 的規範是「一個事件 = 若干行 + 一個空行結束」。網路傳輸會分多次 `read()` 才拿到完整資料，如果逐行處理，可能遇到 `event:` 行在這次 read 結尾、`data:` 行在下次 read 開頭的情況——按行處理會把 `event:` 行靜默丟棄，造成步驟狀態永遠不更新。

以 `\n\n` 作為事件邊界切割，不完整的事件塊留在 `buffer` 等下次讀取補全，才能保證每個事件都被完整解析。

---

## Q2：任務清單只是「參考」嗎？找不到合適工具或工具結果無用時會怎樣？

### 你的理解是對的

Plan（任務清單）是純自然語言字串，例如：
```
["搜尋東京的熱門景點", "查詢旅遊期間的天氣", "推薦餐廳", "估算費用"]
```

Planner 不知道有哪些工具存在，它只是根據 Prompt 的引導（「步驟應涵蓋景點搜尋、天氣查詢...」）生成描述性文字。到了 executor_node，才由另一個 LLM（`executor_llm`）閱讀步驟描述、對照已綁定的工具清單，自己判斷要呼叫哪個工具。

這個分離是刻意的設計：**planner 負責「要做什麼」，executor 負責「怎麼做」**。

---

### 情況一：找不到合適的工具 → LLM 直接用知識回答

`executor_llm` 有工具可以呼叫，但 LLM 有可能判斷「這個步驟不需要工具」或「現有工具都不適合」，這時 `ai_response.tool_calls` 就是空的。

程式碼（`agent.py` 第 178-183 行）：
```python
if not ai_response.tool_calls:
    # LLM 直接回答，無需工具
    return {
        "messages": new_messages,
        "past_steps": [{"step": step_text, "result": ai_response.content}],
    }
```

步驟仍然「完成」，result 是 LLM 從訓練知識直接回答的內容。這個情況在實際執行中比想像中常見——例如「估算費用」這個步驟，LLM 可能同時呼叫 `estimate_cost` 工具，也可能直接根據常識回答（尤其是模型本身對旅遊費用有充足知識時）。

---

### 情況二：LLM 呼叫了一個不存在的工具名稱 → 回傳錯誤訊息給自己

程式碼（`agent.py` 第 190-198 行）：
```python
tool_fn = tool_map.get(tc["name"])
if tool_fn is None:
    output = f"未知工具：{tc['name']}"
else:
    try:
        output = await tool_fn.ainvoke(tc["args"])
    except Exception as e:
        output = f"工具執行失敗：{e}"
tool_messages.append(ToolMessage(content=str(output), tool_call_id=tc["id"]))
```

這個情況通常不會發生——`bind_tools()` 已經把工具 schema 注入 LLM，它只會從已知工具中選擇。但若 LLM 真的幻覺出一個工具名稱，這裡有防護：把錯誤訊息包成 `ToolMessage` 回傳，讓 `synthesis_llm` 知道「這個工具呼叫失敗了」，生成的步驟摘要質量會較差，但流程不會崩潰。

（`ToolMessage` 必須存在是因為 OpenAI API 要求：每個 `tool_call_id` 必須有對應的 `ToolMessage`，否則 API 會報錯。這個防護層同時滿足了 API 規範。）

---

### 情況三：工具執行成功，但結果無法回答問題 → 照樣繼續，品質降低

假設使用者問「幫我規劃首爾行程，要包含簽證資訊」，而 Planner 生成了「查詢簽證規定」這個步驟，但現有工具（景點/天氣/餐廳/費用）都無法回答簽證問題。這時：

1. `executor_llm` 可能選擇呼叫最接近的工具（例如 `search_attractions` 搜尋「首爾簽證」），得到無關結果
2. 或直接不呼叫工具，用自身知識回答
3. `synthesis_llm` 拿到工具結果後，仍然生成一份「步驟摘要」，只是品質可能很低

**這個步驟會被標記為「完成」（`step_done`），流程繼續往下走。** 本 Case 的 replanner 不會重新規劃——它只做兩件事：「還有步驟 → 繼續」或「步驟全完 → 整合輸出」。即使某步驟的結果很差，replanner 也只是把它當作一筆 `past_steps` 記錄使用。

最終的 `synthesis_llm` 在整合時會看到這筆低品質的步驟結果，通常它會試圖用已有資料填補，或在最終行程中略過那個無法回答的部分。

---

### 這是 Plan-Execute 的已知限制

Plan-Execute 的核心假設是：**「planner 規劃的步驟，executor 一定能執行」**。如果這個假設不成立（工具覆蓋範圍不夠，或 LLM 生成了超出工具能力的步驟），系統不會崩潰，但會產生低品質輸出。

要解決這個問題，標準做法是讓 replanner 具備真正的「重新規劃」能力：

```python
# 目前的 replanner（只判斷完成/繼續）
if all_done:
    return {"response": final_answer}
else:
    return {"replan_count": count + 1}

# 完整版 replanner（分析步驟品質，決定是否調整計劃）
if step_result_is_poor:
    return {"plan": revised_plan}    # 修改計劃，跳過或替換失敗步驟
elif all_done:
    return {"response": final_answer}
else:
    return {"replan_count": count + 1}
```

本 Case 保持簡單，採用的是「容錯繼續」策略，而非「偵測失敗後重規劃」。後者是 Case 4 延伸挑戰第 1 題的實作目標。

---

## Q1：Plan-Execute 在 LangGraph 裡的交互機制是什麼？Planner 如何根據使用者問題規劃任務？

### 1. 整體架構：圖（Graph）是骨架

LangGraph 的核心是一個**有向狀態機**——你先定義「節點（node）」要做什麼、「邊（edge）」決定流向，框架負責驅動執行。

本 Case 的圖長這樣（`agent.py` 第 280-295 行）：

```
START → planner_node → executor_node → replanner_node
                                          ↓ route_after_replanner()
                              ┌───────────┴────────────┐
                           response 有值            response 空
                              ↓                        ↓
                             END                  executor_node（下一步）
```

每個節點都是一個 `async def` 函式，接收當前完整的 `AgentState`，回傳要**更新**的欄位（不是整個 state）。

---

### 2. AgentState：節點之間溝通的唯一媒介

```python
# agent.py 第 58-71 行
class AgentState(TypedDict):
    user_request: str                                    # 使用者的原始需求，全程不變
    plan: list[str]                                      # planner 寫入，executor 讀取
    past_steps: Annotated[list[dict], operator.add]      # executor 累積，replanner 讀取
    response: str                                        # replanner 寫入後圖終止
    messages: Annotated[list, add_messages]              # 工具呼叫的工作緩衝區
    replan_count: int                                    # 安全計數器，防止無限迴圈
```

重要的是 `past_steps` 的 `Annotated[list[dict], operator.add]`：這個 **Reducer** 宣告告訴 LangGraph，當節點回傳 `{"past_steps": [new_item]}` 時，要用 `operator.add`（即 `+`）將 `new_item` **附加**到現有清單，而不是覆蓋整個欄位。這讓每次 `executor_node` 只需回傳「這一步的結果」，不需要知道之前有幾步。

---

### 3. planner_node：如何將使用者需求轉為任務清單

**程式碼位置**：`agent.py` 第 108-136 行

```python
async def planner_node(state: AgentState):
    result = await planning_llm.ainvoke([
        SystemMessage(
            "你是旅行規劃專家。根據使用者的旅行需求，制定 3-5 個具體的資訊收集步驟。\n"
            "步驟應涵蓋：景點搜尋、天氣查詢、餐廳推薦、費用估算等面向。\n"
            "每個步驟描述應簡潔明確，例如：「搜尋東京的熱門景點」。"
        ),
        HumanMessage(state["user_request"]),
    ])
    return {
        "plan": result.steps,         # list[str]，是整個 Plan-Execute 的骨架
        "past_steps": [],             # operator.add：回傳 [] 代表「不附加任何東西」
        "response": "",
        "replan_count": 0,
        "messages": [HumanMessage(state["user_request"])],
    }
```

**關鍵機制：`with_structured_output(TravelPlan)`**

這裡的 `planning_llm` 不是普通的 LLM，而是：

```python
# agent.py 第 93 行
self.planning_llm = base_llm.with_structured_output(TravelPlan)
```

`with_structured_output` 底層使用 OpenAI 的 **Function Calling**（或 tool use）機制：LangChain 把 `TravelPlan` 的 Pydantic schema 轉成一個 function definition，然後強制 LLM 輸出符合這個 schema 的 JSON，再自動反序列化回 `TravelPlan` 物件：

```python
# models.py
class TravelPlan(BaseModel):
    destination: str         # LLM 填入目的地（如「東京」）
    duration_days: int       # LLM 填入天數（如 3）
    steps: list[str]         # LLM 填入步驟清單（這就是執行計劃）
```

所以 `result` 不是文字字串，而是一個有 `.steps` 屬性的 Python 物件，直接取 `result.steps` 就是 `["搜尋東京景點", "查詢天氣", ...]`。

**排序邏輯**：LLM 根據 System Prompt 的引導（步驟涵蓋景點→天氣→餐廳→費用）以及使用者請求的語義，自行決定步驟順序。這不是程式寫死的排序，而是 LLM 的推理結果——這也是 Plan-Execute 的優點和風險所在（規劃品質取決於 LLM 和 Prompt 的質量）。

---

### 4. executor_node：逐步執行，工具在節點內直接呼叫

**程式碼位置**：`agent.py` 第 138-216 行

每次圖流轉到 `executor_node`，它做這幾件事：

**Step 1：確定要執行哪個步驟**
```python
step_idx = len(state["past_steps"])
# past_steps 有 0 筆 → 執行步驟 0
# past_steps 有 1 筆 → 執行步驟 1
# ...
step_text = state["plan"][step_idx]
```

注意：executor_node 不需要維護「目前執行到第幾步」的計數器，因為 `past_steps` 本身就是計數器——已完成 N 步，就執行第 N 步（0-indexed）。

**Step 2：呼叫 executor_llm 決定工具**
```python
ai_response = await executor_llm.ainvoke([
    SystemMessage("你是旅行資訊搜尋員。使用適合的工具完成指定任務..."),
    HumanMessage(f"當前任務（步驟{step_idx+1}/{len(state['plan'])}）：{step_text}"),
])
```

`executor_llm` 是用 `base_llm.bind_tools(ALL_TOOLS)` 建立的，它知道有哪四個工具可以用（`search_attractions`, `check_weather`, `find_restaurants`, `estimate_cost`）。LLM 回傳的 `AIMessage` 若有工具要呼叫，`.tool_calls` 就不是空的。

**Step 3：直接在節點內執行工具**
```python
tool_map = {t.name: t for t in ALL_TOOLS}
tool_messages = []
for tc in ai_response.tool_calls:
    output = await tool_map[tc["name"]].ainvoke(tc["args"])
    tool_messages.append(ToolMessage(content=str(output), tool_call_id=tc["id"]))
```

這裡沒有用 LangGraph 的 ToolNode，工具直接在節點函式裡被 `await` 執行。這讓整個節點「一進一出」，每次必定完成一個完整步驟後才返回，不需要多次往返 tool_node。

**Step 4：synthesis_llm 整合所有工具結果**
```python
summary = await synthesis_llm.ainvoke([
    SystemMessage("根據工具回傳的資訊，用繁體中文整理此步驟的重要發現..."),
    HumanMessage(f"步驟任務：{step_text}"),
    ai_response,          # AIMessage（含 tool_calls）
    *tool_messages,       # 所有 ToolMessage（一一對應）
])
return {
    "messages": [...],
    "past_steps": [{"step": step_text, "result": summary.content}],
}
```

回傳 `past_steps` 只包含**這一步**的結果。由於 `operator.add` reducer，LangGraph 會自動將它 append 到 state 的 `past_steps` 列表中。

---

### 5. replanner_node：決定繼續還是結束

**程式碼位置**：`agent.py` 第 218-260 行

```python
async def replanner_node(state: AgentState):
    all_done = len(state["past_steps"]) >= len(state["plan"])
    exceeded_replan = state["replan_count"] >= len(state["plan"])  # 安全閾值

    if all_done or exceeded_replan:
        # 所有步驟完成：整合最終旅行計劃
        steps_summary = "\n\n".join([
            f"【步驟{i+1}】{s['step']}\n{s['result']}"
            for i, s in enumerate(state["past_steps"])
        ])
        final_response = await synthesis_llm.ainvoke([SystemMessage(...), HumanMessage(...)])
        return {"response": final_response.content}   # ← 設定 response，圖將終止
    else:
        return {"replan_count": state["replan_count"] + 1}   # ← 繼續執行下一步
```

`route_after_replanner` 函式（第 266-274 行）根據 `state["response"]` 是否有值來決定下一步：
```python
def route_after_replanner(state: AgentState):
    if state["response"]:
        return END          # response 有值 → 圖結束
    return "executor"       # response 空 → 回到 executor_node 執行下一步
```

---

### 6. 整個對話的完整流程（以「東京 3 天行程」為例）

```
使用者輸入：「幫我規劃東京 3 天 2 人行程，標準住宿」

[planner_node]
  → planning_llm.ainvoke([SystemMessage, HumanMessage("幫我規劃東京...")])
  → TravelPlan(destination="東京", duration_days=3, steps=[
      "搜尋東京的熱門景點和推薦行程",
      "查詢旅遊期間的天氣預報",
      "推薦適合的餐廳與美食體驗",
      "估算 2 人 3 天的旅遊費用",
    ])
  → state["plan"] = [...4 個步驟...]

[executor_node]（第 1 次，執行步驟 0）
  → step_idx = len(past_steps) = 0
  → step_text = "搜尋東京的熱門景點和推薦行程"
  → executor_llm 決定呼叫 search_attractions(destination="東京", ...)
  → 工具回傳：淺草寺、東京塔、新宿御苑...
  → synthesis_llm 整合成步驟摘要
  → past_steps += [{"step": "搜尋景點...", "result": "找到 7 個景點：..."}]

[replanner_node]（第 1 次）
  → all_done = (1 >= 4) = False
  → replan_count = 0 + 1 = 1，繼續

[executor_node]（第 2 次，執行步驟 1）
  → step_idx = len(past_steps) = 1
  → step_text = "查詢旅遊期間的天氣預報"
  → executor_llm 決定呼叫 check_weather(destination="東京")
  → ...

...（步驟 2、3 重複相同流程）...

[replanner_node]（第 4 次）
  → all_done = (4 >= 4) = True
  → synthesis_llm 將 4 個步驟的結果整合成完整旅行計劃
  → state["response"] = "# 東京 3 天 2 人行程\n\n..."

[route_after_replanner]
  → response 有值 → END
```

---

### 7. 為什麼 executor_node 不用 ToolNode？

LangGraph 官方的 ReAct 範例用 `ToolNode` 是因為每次工具呼叫需要回到圖去決定「下一步」（多輪往返）。Plan-Execute 的情境不同：每個步驟的工具呼叫是**固定的子任務**，我們需要所有工具都完成後才能整合摘要。

如果用 ToolNode 設計，每次工具呼叫結束都要回到圖、再進 executor、再呼叫下一個工具，每一輪都會觸發 `on_chain_start/end` 事件，`local_step_index` 的計數會因此混亂（api.py 第 152 行的計數依賴 executor_node 的 on_chain_start 事件）。

自包含設計讓 api.py 的事件處理更簡單：
- `on_chain_start executor_node` → 發送 `step_start`（步驟開始）
- `on_chain_end executor_node` → 發送 `step_done`（步驟完成）
- 兩個事件各觸發一次，一一對應，不會出現計數錯誤。

---

### 8. SSE 事件與前端的對應關係

```
後端事件                      前端行為
──────────────────────────────────────────────────────
plan_created  {"steps":[...]}   PlanTimeline 初始化，全部顯示為 pending（灰點）
step_start    {"step_index":0}  對應步驟變為 running（旋轉動畫）
  （工具執行中 → tool_start / tool_end 事件，顯示在 ToolCallPanel）
step_done     {"step_index":0, "result":"..."}  步驟變為 done（金色勾），顯示結果摘要
token         {"content":"..."}  replanner 最終整合時，逐字輸出到訊息泡泡
done          {"conversation_id":"..."}  串流結束，更新側邊欄對話列表
```
