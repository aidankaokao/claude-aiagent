"""
ReActAgent — ReAct（Reason + Act）模式的 LangGraph Agent

學習重點：
- ReAct 是目前最主流的 Agent 模式：LLM 先推理（Reason）再行動（Act）
- llm.bind_tools() 讓 LLM 知道有哪些工具可用，LLM 會在回覆中附上 tool_calls
- 條件邊（add_conditional_edges）：根據 LLM 是否呼叫工具決定下一步
- ToolNode 自動執行 LLM 指定的工具，並將結果包成 ToolMessage 加入 state
- 圖會「循環」：tools 執行完後回到 llm_node，直到 LLM 不再呼叫工具為止

圖的流程：
  START
    │
    ▼
  llm_node ──────────────────────────────▶ END
    │                                      ▲
    │（有 tool_calls）                      │
    ▼                                      │
  tools ─────────────────────────────────▶ 回到 llm_node
"""

from typing import TypedDict, Annotated
from langgraph.graph import StateGraph, START, END, add_messages
from langgraph.prebuilt import ToolNode
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from models import LlmConfig
from tools import ALL_TOOLS


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]


# Agent 快取：同一組設定只建立一次
_agent_cache: dict[tuple, object] = {}


class ReActAgent:
    def __init__(self, llm_config: LlmConfig):
        # bind_tools：將工具清單綁定到 LLM
        # 綁定後，LLM 的回覆可能包含 tool_calls 欄位（表示它想呼叫某個工具）
        self.llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        ).bind_tools(ALL_TOOLS)

    async def create_agent(self):

        # ===
        # node functions
        # ===
        async def llm_node(state: AgentState):
            """
            呼叫 LLM，取得回覆。
            回覆可能是：
            1. 純文字（final answer）→ 路由函數會導向 END
            2. 帶有 tool_calls（想要呼叫工具）→ 路由函數會導向 tools 節點
            """
            response = await self.llm.ainvoke(state["messages"])
            return {"messages": [response]}

        # ===
        # route functions
        # ===
        def should_continue(state: AgentState):
            """
            檢查最後一則訊息是否包含 tool_calls：
            - 有 tool_calls → 繼續到 "tools" 節點執行工具
            - 沒有 → 結束（END），代表 LLM 已給出最終答案
            """
            last_message = state["messages"][-1]
            if last_message.tool_calls:
                return "tools"
            return END

        # ===
        # build graph
        # ===
        graph = StateGraph(AgentState)

        # ToolNode：LangGraph 內建的工具執行節點
        # 它會讀取最後一則 AIMessage 的 tool_calls，逐一呼叫對應工具，
        # 並將結果包成 ToolMessage 加入 state["messages"]
        tool_node = ToolNode(ALL_TOOLS)

        graph.add_node("llm_node", llm_node)
        graph.add_node("tools", tool_node)

        graph.add_edge(START, "llm_node")

        # 條件邊：llm_node 結束後，由 should_continue 決定下一步
        graph.add_conditional_edges(
            "llm_node",
            should_continue,
            {
                "tools": "tools",  # 有工具呼叫 → 執行工具
                END: END,          # 無工具呼叫 → 結束
            },
        )

        # tools 執行完後固定回到 llm_node（讓 LLM 根據工具結果繼續推理）
        graph.add_edge("tools", "llm_node")

        agent = graph.compile(checkpointer=MemorySaver())
        return agent


async def get_or_create_agent(llm_config: LlmConfig):
    """依 LLM 設定取得或建立 Agent（快取機制）"""
    cache_key = (llm_config.api_key, llm_config.base_url, llm_config.model)
    if cache_key not in _agent_cache:
        instance = ReActAgent(llm_config)
        _agent_cache[cache_key] = await instance.create_agent()
        print(f"[Agent] 新建 ReActAgent（model={llm_config.model}）")
    return _agent_cache[cache_key]
