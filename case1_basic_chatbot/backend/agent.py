"""
ChatAgent — 基礎聊天 Agent

學習重點：
- LLM 設定（含 API Key）由外部傳入，不寫死在程式碼中
- _agent_cache 依 (api_key, base_url, model) 快取編譯好的 Agent
  → 相同設定的對話共用同一個 Agent（MemorySaver 以 thread_id 區分對話）
  → 不同 API Key 建立不同 Agent 實例

圖的流程：
  START → chat_node → END
"""

from typing import TypedDict, Annotated
from langgraph.graph import StateGraph, START, END, add_messages
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from models import LlmConfig


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]


# Agent 快取：key = (api_key, base_url, model)，避免重複編譯
_agent_cache: dict[tuple, object] = {}


class ChatAgent:
    def __init__(self, llm_config: LlmConfig):
        self.llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        )

    async def create_agent(self):
        """建立並回傳編譯後的 Agent 圖"""

        # === node functions ===
        async def chat_node(state: AgentState):
            response = await self.llm.ainvoke(state["messages"])
            return {"messages": [response]}

        # === build graph ===
        graph = StateGraph(AgentState)
        graph.add_node("chat_node", chat_node)
        graph.add_edge(START, "chat_node")
        graph.add_edge("chat_node", END)
        agent = graph.compile(checkpointer=MemorySaver())

        return agent


async def get_or_create_agent(llm_config: LlmConfig):
    """
    依 LLM 設定取得或建立 Agent（快取機制）

    相同的 (api_key, base_url, model) 組合共用同一個編譯後的 Agent，
    不同的設定建立各自獨立的 Agent 實例。
    """
    cache_key = (llm_config.api_key, llm_config.base_url, llm_config.model)

    if cache_key not in _agent_cache:
        instance = ChatAgent(llm_config)
        _agent_cache[cache_key] = await instance.create_agent()
        print(f"[Agent] 新建 Agent（model={llm_config.model}）")

    return _agent_cache[cache_key]
