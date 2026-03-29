"""
KBAgent — MCP 知識庫 ReAct Agent

與 Case 2 的差異：
- 工具不是本地 @tool 函數，而是從 MCP Server 取得
- 工具清單在建構時傳入（由 api.py 透過 MultiServerMCPClient 取得後注入）
- 圖結構與 Case 2 完全相同（ReAct 迴圈）
- llm_node 額外注入 SystemMessage，引導模型正確使用知識庫工具

圖的流程：
  START → llm_node ⟺ tools → END
"""

from typing import TypedDict, Annotated

from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START, END, add_messages
from langgraph.prebuilt import ToolNode

from models import LlmConfig

# ============================================================
# 系統提示詞
# ============================================================

SYSTEM_PROMPT = """你是知識庫助手，可以使用以下工具查詢和管理知識庫：

- search_articles：根據關鍵字搜尋文章
- get_article：取得完整文章內容
- create_article：建立新文章
- list_articles：列出文章清單（可依標籤篩選）

請根據使用者需求靈活運用這些工具，提供準確有用的回答。若找不到相關資訊，請誠實告知。

建立文章的原則：
- 若使用者要求建立文章但未提供內容，請根據主題自行撰寫完整、有實質內容的技術文章（至少 200 字），不要反問使用者要什麼內容。
- 標籤請依主題自動填入（英文小寫，逗號分隔）。
- 建立完成後，回報文章標題與 ID。"""


# ============================================================
# 狀態定義
# ============================================================

class AgentState(TypedDict):
    messages: Annotated[list, add_messages]


# ============================================================
# KBAgent
# ============================================================

class KBAgent:
    def __init__(self, llm_config: LlmConfig, tools: list):
        """
        Args:
            llm_config: LLM 設定（api_key、base_url、model、temperature）
            tools:      由 MultiServerMCPClient 取得的工具清單（list[BaseTool]）
                        這些工具已是 LangChain 相容的 BaseTool，可直接傳入 bind_tools 與 ToolNode
        """
        self.tools = tools
        # bind_tools：讓 LLM 知道有哪些 MCP 工具可用
        # LLM 的回覆可能包含 tool_calls 欄位（表示它想呼叫某個工具）
        self.llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        ).bind_tools(tools)

    def create_agent(self):
        """建構並編譯 ReAct 圖，回傳已編譯的 Agent"""

        # === node functions ===

        async def llm_node(state: AgentState):
            """
            呼叫 LLM，取得回覆。
            注入 SystemMessage 作為第一則訊息，引導模型使用知識庫工具。
            回覆可能是：
            1. 純文字（final answer）→ should_continue 導向 END
            2. 帶有 tool_calls（想要呼叫 MCP 工具）→ should_continue 導向 tools
            """
            msgs = [SystemMessage(content=SYSTEM_PROMPT)] + list(state["messages"])
            response = await self.llm.ainvoke(msgs)
            return {"messages": [response]}

        # === route functions ===

        def should_continue(state: AgentState):
            """
            檢查最後一則訊息是否包含 tool_calls：
            - 有 tool_calls → 繼續到 "tools" 節點執行 MCP 工具
            - 沒有 → 結束（END），代表 LLM 已給出最終答案
            """
            last_message = state["messages"][-1]
            if last_message.tool_calls:
                return "tools"
            return END

        # === build graph ===

        graph = StateGraph(AgentState)

        # ToolNode：自動執行 LLM 指定的 MCP 工具，並將結果包成 ToolMessage 加入 state
        tool_node = ToolNode(self.tools)

        graph.add_node("llm_node", llm_node)
        graph.add_node("tools", tool_node)

        graph.add_edge(START, "llm_node")

        # 條件邊：llm_node 結束後，由 should_continue 決定下一步
        graph.add_conditional_edges(
            "llm_node",
            should_continue,
            {
                "tools": "tools",  # 有工具呼叫 → 執行 MCP 工具
                END: END,          # 無工具呼叫 → 結束
            },
        )

        # MCP 工具執行完後固定回到 llm_node（讓 LLM 根據工具結果繼續推理）
        graph.add_edge("tools", "llm_node")

        agent = graph.compile(checkpointer=MemorySaver())
        return agent
