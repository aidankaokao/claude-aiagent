"""
IntegratedAgent — 全端整合 Agent（Case 10）

架構說明：
- Router 模式：用 with_structured_output 動態分派到三種執行策略
- Chat 模式：直接對話，LLM 一次性回應
- Tools 模式：ReAct + ToolNode（計算 / 查時間 / 知識查詢），支援工具迴圈
- Research 模式：雙 Agent pipeline（researcher → writer），深度研究報告

Graph 結構：
  START
    ↓
  router_node ──(mode="chat")──▶ chat_node ──▶ END
       │
       ├──(mode="tools")──▶ react_node ──(has tool_calls?)──▶ tool_node ──▶ react_node
       │                          ↓ (no tool_calls)
       │                         END
       │
       └──(mode="research")──▶ researcher_node ──▶ writer_node ──▶ END

SSE 事件（由 api.py 產生）：
  mode         → Router 決策結果 {"mode": "chat"|"tools"|"research", "reason": "..."}
  tool_start   → 工具開始執行  {"run_id", "tool_name", "tool_input"}
  tool_end     → 工具執行完畢  {"run_id", "tool_name", "tool_output"}
  agent_start  → Research Agent LLM 開始  {"agent": "researcher"|"writer"}
  agent_end    → Research Agent LLM 結束  {"agent", "summary", "content"}
  token        → LLM 串流 token  {"content"}（chat / react 最終答案 / writer）
  done         → 完成  {"conversation_id", "content"}
"""

import ast
import operator as op
from datetime import datetime
from typing import TypedDict, Annotated, Literal

from langchain_core.messages import SystemMessage, AIMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START, END, add_messages
from langgraph.prebuilt import ToolNode
from pydantic import BaseModel

from models import LlmConfig


# ============================================================
# 知識庫（Tools 模式的 query_knowledge 工具）
# ============================================================

KNOWLEDGE_DB: dict[str, str] = {
    "langgraph": (
        "LangGraph 是 LangChain 開發的 Agent 工作流框架，以圖（Graph）結構定義 Agent 的執行流程。"
        "核心概念包含：StateGraph（狀態機）、節點（Node）、邊（Edge）、條件路由（Conditional Edge）。"
        "支援迴圈、並行（Send API）、中斷恢復（interrupt/Command）等高階控制流，"
        "常搭配 MemorySaver / AsyncSqliteSaver 做對話持久化。"
    ),
    "langchain": (
        "LangChain 是最廣泛使用的 LLM 應用框架，提供 Chain、Prompt、Memory、Tool 等抽象層。"
        "LCEL（LangChain Expression Language）以 | 運算子串接各元件，方便組合複雜流程。"
        "核心套件：langchain-core（基礎型別）、langchain-openai（OpenAI 整合）、langchain-community（社群工具）。"
    ),
    "python": (
        "Python 是一種動態型別、直譯式高階程式語言，以可讀性高著稱。"
        "廣泛用於 AI/ML、後端開發、資料科學、自動化腳本。"
        "主要版本差異：Python 3.10+ 引入 match/case、3.11 顯著提升執行速度、3.12 改善型別系統。"
        "常用套件：NumPy、Pandas、FastAPI、SQLAlchemy、Pydantic。"
    ),
    "fastapi": (
        "FastAPI 是基於 Python 3.8+ 型別提示（Type Hints）的高效能 Web 框架。"
        "自動生成 OpenAPI / Swagger 文件，內建 Pydantic 資料驗證，原生支援 async/await。"
        "適合建構 REST API、SSE 串流端點、WebSocket 服務。"
        "效能媲美 Node.js（基於 Starlette + Uvicorn ASGI 伺服器）。"
    ),
    "docker": (
        "Docker 是容器化平台，以映像（Image）封裝應用及其依賴，確保環境一致性。"
        "Dockerfile 定義映像建構步驟；docker-compose 管理多服務部署。"
        "常見指令：docker build、docker run、docker-compose up -d、docker logs。"
        "生產環境通常搭配 Kubernetes 做叢集管理與自動擴縮。"
    ),
    "react": (
        "React 是 Meta 開發的 JavaScript UI 框架，以元件（Component）為核心。"
        "Hooks（useState、useEffect、useCallback 等）讓函式元件具備狀態管理能力。"
        "React 18 引入並發模式（Concurrent Mode），改善大型應用的響應性。"
        "常搭配 Vite（開發工具）、TypeScript（型別安全）、TailwindCSS（樣式）。"
    ),
    "typescript": (
        "TypeScript 是 JavaScript 的靜態型別超集，由 Microsoft 開發。"
        "在編譯期捕捉型別錯誤，提升大型專案的可維護性。"
        "核心特性：介面（Interface）、泛型（Generics）、列舉（Enum）、型別守衛（Type Guard）。"
        "TypeScript 5.x 引入裝飾器（Decorators）標準化、const 型別推斷等新特性。"
    ),
    "ai": (
        "人工智慧（AI）涵蓋讓機器模擬人類智能的多個技術領域。"
        "主流方向：機器學習（ML）、深度學習（DL）、自然語言處理（NLP）、電腦視覺（CV）。"
        "大型語言模型（LLM）如 GPT-4、Claude、Gemini 以 Transformer 架構為基礎，"
        "透過海量資料預訓練後，可執行問答、摘要、程式生成、推理等多種任務。"
    ),
    "sse": (
        "SSE（Server-Sent Events）是 HTTP 單向推播協定，伺服器可持續向客戶端發送事件。"
        "格式：每個事件由 event:、data:、id: 欄位組成，以空白行分隔。"
        "相比 WebSocket 更輕量（單向、基於 HTTP），適合 LLM token 串流、進度通知等場景。"
        "注意：sse-starlette 使用 \\r\\n 行結尾（HTTP 規範），前端解析時需用 trim() 識別空白行。"
    ),
}


# ============================================================
# 工具定義（Tools 模式使用）
# ============================================================

# 安全數學運算子白名單
_SAFE_OPS = {
    ast.Add: op.add,
    ast.Sub: op.sub,
    ast.Mult: op.mul,
    ast.Div: op.truediv,
    ast.Pow: op.pow,
    ast.Mod: op.mod,
    ast.UAdd: op.pos,
    ast.USub: op.neg,
}


def _safe_eval(node: ast.expr) -> float:
    """僅允許數值與四則運算，防止程式碼注入"""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.BinOp) and type(node.op) in _SAFE_OPS:
        return _SAFE_OPS[type(node.op)](_safe_eval(node.left), _safe_eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _SAFE_OPS:
        return _SAFE_OPS[type(node.op)](_safe_eval(node.operand))
    raise ValueError(f"不支援的運算：{ast.dump(node)}")


@tool
def calculate(expression: str) -> str:
    """計算數學表達式，支援加減乘除（+ - * /）、次方（**）、取餘（%）。
    範例：2 + 3 * 4、100 / 7、2 ** 10、17 % 5"""
    try:
        tree = ast.parse(expression.strip(), mode="eval")
        result = _safe_eval(tree.body)
        # 整數結果顯示整數，小數保留 6 位有效數字
        if result == int(result):
            return f"{expression} = {int(result)}"
        return f"{expression} = {result:.6g}"
    except Exception as e:
        return f"計算失敗：{e}（僅支援基本數學運算）"


@tool
def get_datetime() -> str:
    """取得當前的日期與時間（台灣時區 UTC+8）"""
    now = datetime.now()
    weekdays = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"]
    weekday = weekdays[now.weekday()]
    return (
        f"現在時間：{now.strftime('%Y 年 %m 月 %d 日')} {weekday} "
        f"{now.strftime('%H:%M:%S')}"
    )


@tool
def query_knowledge(topic: str) -> str:
    """查詢技術主題的背景知識。
    可查詢的主題：langgraph、langchain、python、fastapi、docker、react、typescript、ai、sse。
    若主題不完全匹配，會嘗試模糊比對。"""
    topic_lower = topic.lower().strip()

    # 完全匹配
    if topic_lower in KNOWLEDGE_DB:
        return KNOWLEDGE_DB[topic_lower]

    # 模糊匹配：若 topic 包含任一關鍵字則回傳
    for key, content in KNOWLEDGE_DB.items():
        if key in topic_lower or topic_lower in key:
            return f"（關鍵字：{key}）\n{content}"

    keys = "、".join(KNOWLEDGE_DB.keys())
    return f"查無「{topic}」相關知識。可查詢的主題有：{keys}"


TOOLS = [calculate, get_datetime, query_knowledge]


# ============================================================
# Router 決策模型
# ============================================================

class RouteDecision(BaseModel):
    """Router 的執行模式決策。使用 with_structured_output 確保 LLM 回傳合法值。"""
    mode: Literal["chat", "tools", "research"]
    reason: str  # 選擇此模式的原因（供前端 ModeBadge 顯示）


# ============================================================
# 共用 State
# ============================================================

class IntegratedState(TypedDict):
    """
    三種模式共用的狀態結構。

    欄位設計：
    - messages:         累積（新訊息追加）
    - task:             替換（當前任務文字）
    - mode:             替換（router 決定後設定）
    - mode_reason:      替換（router 的決策說明）
    - research_result:  替換（researcher 完成後更新）
    - iteration:        替換（react 迴圈計數，防無限迴圈）
    """
    messages: Annotated[list, add_messages]
    task: str
    mode: str
    mode_reason: str
    research_result: str
    iteration: int


# ============================================================
# System Prompts
# ============================================================

ROUTER_PROMPT = """你是一個智慧助手的任務路由器，負責判斷處理用戶問題的最佳策略。

三種可用策略：
- chat：一般對話、創意寫作、觀點討論、簡單問答 → 直接用 LLM 回答
- tools：需要精確計算、查詢當前時間日期、或查詢特定技術知識 → 使用工具
- research：需要深度分析、多面向探討、比較研究的複雜問題 → 研究員+撰寫員 pipeline

判斷原則：
1. 有「計算」「幾點」「幾號」「幾歲」「多少」等精確查詢 → tools
2. 有「分析」「比較」「探討」「研究」「趨勢」等深度需求 → research
3. 一般問候、解釋、意見、創作 → chat

用戶問題：{task}

請選擇最適合的策略，並簡短說明原因（一句話）。"""

CHAT_PROMPT = """你是一個友善、知識豐富的智慧助手。請直接、清楚地回答用戶的問題。
若問題需要觀點或建議，請提供有建設性的回應。回答時使用繁體中文。"""

RESEARCHER_PROMPT = """你是一位深度研究員。請對以下問題進行全面研究：

任務：{task}

要求：
1. 從多個角度收集相關背景知識與事實
2. 識別核心概念、關鍵面向、重要趨勢
3. 提供客觀、系統性的研究發現

格式：直接輸出研究內容（約 300-400 字），以條列或段落組織。"""

WRITER_PROMPT = """你是一位專業報告撰寫員。請根據研究資料，撰寫一份結構清晰的分析報告。

研究資料：
{research_result}

原始任務：{task}

報告格式（使用 Markdown）：
## 摘要
（2-3 句核心重點）

## 主要發現
（研究資料中的關鍵事實）

## 深度分析
（對研究結果的洞察與解讀）

## 結論
（明確的結論與建議）"""


# ============================================================
# IntegratedAgent
# ============================================================

class IntegratedAgent:
    def __init__(self, llm_config: LlmConfig):
        self.llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        )
        # Router：with_structured_output 確保回傳合法的 mode 值
        self.router = self.llm.with_structured_output(RouteDecision)
        # React LLM：綁定工具，LLM 自行決定是否呼叫
        self.react_llm = self.llm.bind_tools(TOOLS)

    async def create_agent(self):
        """建構並編譯全端整合圖"""

        # ────────────────────────────────────────────────────
        # node functions
        # ────────────────────────────────────────────────────

        async def router_node(state: IntegratedState):
            """
            Router 節點：分析用戶問題，決定執行模式。

            設計亮點：
            - with_structured_output 強制 LLM 回傳 RouteDecision 格式
            - mode 寫入 state，後續 route_after_router 函式讀取
            - api.py 從 on_chat_model_end（node="router"）提取 mode 並發出 SSE mode 事件
            """
            prompt = ROUTER_PROMPT.format(task=state.get("task", ""))
            decision = await self.router.ainvoke([
                SystemMessage(content=prompt),
            ])
            print(f"[Router] mode={decision.mode}  reason={decision.reason}")
            return {
                "mode": decision.mode,
                "mode_reason": decision.reason,
            }

        async def chat_node(state: IntegratedState):
            """
            Chat 節點：直接 LLM 對話。
            最簡單的模式，直接將用戶訊息傳給 LLM。
            token 串流由 api.py 的 on_chat_model_stream（node="chat"）捕捉。
            """
            response = await self.llm.ainvoke([
                SystemMessage(content=CHAT_PROMPT),
                *state["messages"],
            ])
            return {"messages": [response]}

        async def react_node(state: IntegratedState):
            """
            React 節點：LLM + 工具綁定。

            ReAct 迴圈運作方式：
            1. LLM 決定呼叫工具 → 回傳含 tool_calls 的 AIMessage
               → route: should_continue_react → "tools" → tool_node → react_node（再次）
            2. LLM 決定直接回答 → 回傳純文字 AIMessage
               → route: should_continue_react → END

            iteration 計數防止無限迴圈（最多 5 次工具呼叫）。
            """
            iteration = state.get("iteration", 0)
            response = await self.react_llm.ainvoke(state["messages"])
            return {
                "messages": [response],
                "iteration": iteration + 1,
            }

        async def researcher_node(state: IntegratedState):
            """
            Researcher 節點：深度研究任務。
            結果存入 research_result，供 writer_node 使用。
            agent_start/end 事件由 api.py 的 RESEARCH_NODES 過濾發出。
            """
            prompt = RESEARCHER_PROMPT.format(task=state.get("task", ""))
            result = await self.llm.ainvoke([
                SystemMessage(content=prompt),
            ])
            return {"research_result": result.content}

        async def writer_node(state: IntegratedState):
            """
            Writer 節點：整合研究結果，撰寫最終報告。
            與 Case 9 相同：以 AIMessage 加入 messages，token 串流。
            """
            prompt = WRITER_PROMPT.format(
                research_result=state.get("research_result", ""),
                task=state.get("task", ""),
            )
            result = await self.llm.ainvoke([
                SystemMessage(content=prompt),
            ])
            return {"messages": [AIMessage(content=result.content)]}

        # ────────────────────────────────────────────────────
        # route functions
        # ────────────────────────────────────────────────────

        def route_after_router(state: IntegratedState) -> str:
            """讀取 router_node 設定的 mode，決定走哪條路徑"""
            return state.get("mode", "chat")

        def should_continue_react(state: IntegratedState) -> str:
            """
            ReAct 迴圈判斷：最後一條訊息有 tool_calls 且未超過迭代上限 → 繼續用工具
            否則 → 結束
            """
            last = state["messages"][-1]
            has_tool_calls = hasattr(last, "tool_calls") and bool(last.tool_calls)
            iteration = state.get("iteration", 0)
            if has_tool_calls and iteration < 5:
                return "tools"
            return END

        # ────────────────────────────────────────────────────
        # build graph
        # ────────────────────────────────────────────────────

        tool_node = ToolNode(TOOLS)

        graph = StateGraph(IntegratedState)

        # 節點
        graph.add_node("router", router_node)
        graph.add_node("chat", chat_node)
        graph.add_node("react", react_node)
        graph.add_node("tools", tool_node)
        graph.add_node("researcher", researcher_node)
        graph.add_node("writer", writer_node)

        # 邊
        graph.add_edge(START, "router")
        graph.add_conditional_edges(
            "router",
            route_after_router,
            {"chat": "chat", "tools": "react", "research": "researcher"},
        )
        graph.add_conditional_edges(
            "react",
            should_continue_react,
            {"tools": "tools", END: END},
        )
        graph.add_edge("tools", "react")
        graph.add_edge("chat", END)
        graph.add_edge("researcher", "writer")
        graph.add_edge("writer", END)

        agent = graph.compile(checkpointer=MemorySaver())
        return agent
