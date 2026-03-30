# Case 9: Multi-Agent Supervisor 系統

## 學習目標

本案例示範 LangGraph 的 **Supervisor 模式（Multi-Agent 架構）**，透過一個 AI 研究助理中心情境，學習如何讓多個 Agent 協同完成複雜任務。

| 核心概念 | 說明 |
|---------|------|
| Supervisor 模式 | 主控 Agent 負責任務分派與協調，子 Agent 執行後回傳 Supervisor |
| `Command(goto=...)` | 動態跨節點路由，無需預先定義所有可能的邊 |
| 共用 State | 所有 Agent 透過 `MultiAgentState` 傳遞中間結果 |
| `with_structured_output` | 確保 Supervisor 的路由決策格式正確，避免解析錯誤 |
| `astream_events` 過濾 | 用 `metadata.langgraph_node` 識別事件來源，只串流特定 Agent 的輸出 |

---

## 情境說明

使用者提出一個研究問題，系統自動啟動三個專家 Agent：

```
使用者: "分析 LangGraph 的優勢與適用場景"
  ↓
Supervisor → 研究員 → Supervisor → 分析師 → Supervisor → 撰寫員 → 最終報告
```

**三個專家 Agent：**
- **Researcher（研究員）**：收集事實、探索多個角度
- **Analyst（分析師）**：分析研究結果，提煉洞察
- **Writer（撰寫員）**：整合所有資訊，撰寫 Markdown 報告

---

## 圖結構設計

```
START
  ↓
supervisor_node  ←────────────────────────┐
  │                                        │
  ├── Command(goto="researcher") ──▶ researcher_node ──┤
  │                                        │            │ Command(goto="supervisor")
  ├── Command(goto="analyst") ─────▶ analyst_node ────┤
  │                                        │
  ├── Command(goto="writer") ──────▶ writer_node ─────┘
  │
  └── Command(goto=END) ──▶ END
```

**關鍵特點：**
- 只有一條顯式邊：`START → supervisor`
- 其他所有路由由 `Command(goto=...)` 在 runtime 決定
- 圖結構極簡，路由邏輯集中於 Supervisor

---

## 核心程式碼解析

### 1. 狀態設計（`MultiAgentState`）

```python
class MultiAgentState(TypedDict):
    messages: Annotated[list, add_messages]   # 對話歷史（累積）
    task: str                                  # 原始任務（每輪重設）
    research_result: str                       # Researcher 輸出（每輪重設）
    analysis_result: str                       # Analyst 輸出（每輪重設）
    agent_steps: Annotated[list, operator.add] # 執行記錄（累積）
    iteration: int                             # 迭代計數（每輪重設）
```

**設計原則：**
- `add_messages` Reducer：新訊息追加到現有清單（多輪對話記憶）
- `operator.add` Reducer：步驟記錄跨輪累積（除錯用）
- 無 Reducer 欄位（task/research_result 等）：每次呼叫時替換（重設）

### 2. Supervisor 路由決策

```python
class RouteDecision(BaseModel):
    next_agent: Literal["researcher", "analyst", "writer", "FINISH"]
    reason: str

# Supervisor 使用結構化輸出確保格式正確
self.router = self.llm.with_structured_output(RouteDecision)
```

**為何用 `with_structured_output`？**
- LLM 自由輸出時，可能回傳 "researcher" 或 "讓研究員處理" 或其他變體
- 結構化輸出強制 LLM 回傳 `{"next_agent": "researcher", "reason": "..."}`
- 確保路由邏輯的穩定性，避免解析失敗

### 3. Supervisor 的雙層決策

```python
async def supervisor_node(state: MultiAgentState):
    # 第一層：Python 決定終止條件（可靠，不依賴 LLM）
    writer_ran = any(isinstance(m, AIMessage) for m in state.get("messages", []))
    if writer_ran or iteration >= 6:
        return Command(goto=END, ...)

    # 第二層：LLM 決定路由（靈活，利用語言理解能力）
    decision = await self.router.ainvoke([...])
    return Command(goto=decision.next_agent, ...)
```

**為何要分兩層？**
- Python 層處理確定性邏輯（Writer 是否已執行），絕對可靠
- LLM 層處理語意判斷（什麼時候需要研究 vs 分析），靈活但有時不確定
- 兩層結合：既靈活又不會無限迴圈

### 4. Agent 透過 Command 傳遞結果

```python
async def researcher_node(state: MultiAgentState):
    result = await self.llm.ainvoke([...])
    return Command(goto="supervisor", update={
        "research_result": result.content,  # 存入共用 State
        "agent_steps": [{"agent": "researcher", ...}],
    })
```

```python
async def analyst_node(state: MultiAgentState):
    # 從 State 讀取 Researcher 的輸出
    prompt = ANALYST_PROMPT.format(
        research_result=state.get("research_result", "無研究資料"),
    )
    result = await self.llm.ainvoke([...])
    return Command(goto="supervisor", update={"analysis_result": result.content, ...})
```

**Agent 間資料傳遞的原則：**
- Agent 不直接呼叫其他 Agent
- 透過共用 State 傳遞資料（鬆耦合）
- Supervisor 負責確保執行順序（researcher → analyst → writer）

### 5. 圖編譯（只需一條邊）

```python
graph = StateGraph(MultiAgentState)
graph.add_node("supervisor", supervisor_node)
graph.add_node("researcher", researcher_node)
graph.add_node("analyst", analyst_node)
graph.add_node("writer", writer_node)

# 唯一的顯式邊：入口點
graph.add_edge(START, "supervisor")
# 其他路由由 Command(goto=...) 決定，不需要預先定義
```

---

## SSE 事件設計

```
前端收到的事件序列：

agent_start {"agent": "supervisor"}
agent_end   {"agent": "supervisor", "summary": ""}     ← supervisor 不顯示摘要
agent_start {"agent": "researcher"}
agent_end   {"agent": "researcher", "summary": "LangGraph 是..."}
agent_start {"agent": "supervisor"}
agent_end   {"agent": "supervisor", "summary": ""}
agent_start {"agent": "analyst"}
agent_end   {"agent": "analyst", "summary": "關鍵洞察..."}
agent_start {"agent": "supervisor"}
agent_end   {"agent": "supervisor", "summary": ""}
agent_start {"agent": "writer"}
token       {"content": "## 摘要\n"}                   ← 逐字串流
token       {"content": "LangGraph..."}
...（更多 tokens）
agent_end   {"agent": "writer", "summary": "## 摘要..."}
agent_start {"agent": "supervisor"}
agent_end   {"agent": "supervisor", "summary": ""}
done        {"conversation_id": "..."}
```

**過濾邏輯（`api.py`）：**

```python
node = event.get("metadata", {}).get("langgraph_node", "")

# 只串流 writer 的 token（不暴露 researcher/analyst 的思考過程）
if etype == "on_chat_model_stream" and node == "writer":
    yield token event

# 所有 Agent 的 LLM 啟動/結束
if etype == "on_chat_model_start" and node in AGENT_NODES:
    yield agent_start event
```

---

## 前端 AgentFlow 視覺化

前端在 Sidebar 顯示即時的 Agent 執行流程：

```
AGENT PIPELINE
─────────────────────────────────────
◉ Supervisor     ✓ dispatch → researcher
◉ Researcher     ✓ 研究了 LangGraph 的設計理念...
◉ Supervisor     ✓ dispatch → analyst
◉ Analyst        ✓ 關鍵洞察：LangGraph 的優勢在於...
◉ Supervisor     ✓ dispatch → writer
⟳ Writer         執行中...
─────────────────────────────────────
```

**顏色設計：**
- Supervisor: `#4a9eff`（藍色）
- Researcher: `#4fc78e`（綠色）
- Analyst: `#ffc04a`（琥珀色）
- Writer: `#b47eff`（紫色）

---

## 與前面 Case 的對比

| 概念 | Case 2（ReAct） | Case 4（Plan-Execute） | Case 9（Supervisor） |
|------|----------------|----------------------|---------------------|
| 決策方式 | 單一 LLM 決定工具 | 計畫 → 逐步執行 | Supervisor 分派專家 |
| Agent 數量 | 1 | 3（planner/executor/replanner） | 4（supervisor + 3 specialists） |
| 路由機制 | 條件邊 | 條件邊 + State | `Command(goto=...)` |
| 中間結果 | 工具輸出 → messages | 步驟完成狀態 | 共用 State 欄位 |
| 適用場景 | 工具使用 | 多步驟規劃 | 複雜任務分工 |

---

## 啟動方式

### 本地開發

```bash
# 後端（在 case9_multi_agent/ 目錄）
cd backend
pip install -r requirements.txt
python api.py

# 前端（在 case9_multi_agent/ 目錄）
cd frontend
npm install
npm run dev
```

### Docker

```bash
# 複製環境設定
cp .env.example .env
# 編輯 .env 填入 DEVELOPER_NAME 等

# 建置
docker build -f Dockerfile.backend -t claude-aiagent-case9-backend:1.0 .
docker build -f Dockerfile.frontend -t claude-aiagent-case9-frontend:1.0 .

# 啟動
docker-compose up -d
```

---

## 常見問題

**Q: Supervisor 為什麼會無限迴圈？**
A: 通常是因為 `with_structured_output` 的解析失敗，或模型不支援 function calling。解決：確認使用支援 function calling 的模型（如 gpt-4o-mini、gpt-4o）。Python 層的 `iteration >= 6` 和 `writer_ran` 檢查可作為安全網。

**Q: Writer 的輸出為何能串流，Researcher/Analyst 不能？**
A: 在 `api.py` 的 `astream_events` 迴圈中，用 `langgraph_node` 過濾，只將 `writer` 節點的 `on_chat_model_stream` 事件轉發給前端。Researcher/Analyst 的輸出存在 State 中，不直接串流。

**Q: 為何 Supervisor 不顯示路由決策摘要？**
A: Supervisor 使用 `with_structured_output`，其 LLM 輸出是 JSON 格式（`{"next_agent": "...", "reason": "..."}`），不適合直接顯示給使用者。後續可以解析 `reason` 欄位顯示路由原因。
