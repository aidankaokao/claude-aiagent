"""
agent.py — SkillAgent

LangGraph 圖結構：
  START
    ↓
  classify_node       ← 以 LLM（temperature=0）分類使用者意圖 → 技能名稱
    ↓ route_by_skill（條件邊）
    ├── email_node
    ├── code_review_node
    ├── summarizer_node
    ├── translator_node
    └── generic_node   ← 意圖不明時的 fallback
    ↓
  END

核心學習概念：
- 意圖分類 → 條件路由（route_by_skill）
- 技能執行節點從 SKILL.md 動態載入 system prompt
- few-shot 範例自動注入（XML 格式）
- MemorySaver 維持對話歷史
"""

from typing import Annotated
from typing_extensions import TypedDict

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver

from skills.registry import SkillRegistry
from models import LlmConfig

registry = SkillRegistry()

SKILL_NODES = {"email_node", "code_review_node", "summarizer_node", "translator_node", "weekly_report_node", "generic_node"}


class SkillAgentState(TypedDict):
    """
    SkillAgent 的狀態。

    messages:       對話歷程（add_messages 確保多輪追加而非覆蓋）
    user_input:     當前使用者輸入（供 classify_node 讀取）
    skill_override: 前端手動選擇的技能（空字串 = 自動偵測）
    detected_skill: classify_node 偵測出的技能
    active_skill:   最終使用的技能（override 優先，否則用 detected）
    response:       最終回覆內容
    """
    messages:       Annotated[list, add_messages]
    user_input:     str
    skill_override: str
    detected_skill: str
    active_skill:   str
    response:       str


class SkillAgent:
    def __init__(self, llm_config: LlmConfig):
        kwargs = dict(
            api_key=llm_config.api_key,
            model=llm_config.model,
            temperature=llm_config.temperature,
            streaming=True,
        )
        if llm_config.base_url:
            kwargs["base_url"] = llm_config.base_url
        self.llm = ChatOpenAI(**kwargs)
        self.llm_config = llm_config

    async def create_agent(self):
        # 載入技能清單（用於分類 prompt）
        skill_list = registry.get_all_skills()
        skill_names_str = "、".join(s["name"] for s in skill_list)
        skill_descriptions = "\n".join(
            f"- {s['name']}：{s['description']}" for s in skill_list
        )

        # ===
        # node functions
        # ===

        async def classify_node(state: SkillAgentState):
            """
            意圖分類節點。

            若 skill_override 已設定 → 直接使用，跳過 LLM 分類
            否則 → 用 temperature=0 的 LLM 分類使用者意圖

            temperature=0 的原因：分類是確定性任務，需要穩定輸出；
            若用較高 temperature，同一輸入可能得到不同技能，導致路由不穩定。
            """
            override = state.get("skill_override", "")
            if override:
                return {
                    "detected_skill": override,
                    "active_skill": override,
                }

            classify_kwargs = dict(
                api_key=self.llm_config.api_key,
                model=self.llm_config.model,
                temperature=0,
            )
            if self.llm_config.base_url:
                classify_kwargs["base_url"] = self.llm_config.base_url
            classify_llm = ChatOpenAI(**classify_kwargs)

            response = await classify_llm.ainvoke([
                SystemMessage(
                    "你是意圖分類助手。根據使用者的輸入，判斷最適合的技能。\n\n"
                    f"可用技能：\n{skill_descriptions}\n\n"
                    f"只輸出技能名稱，必須是以下選項之一：{skill_names_str}、unknown\n"
                    "不要輸出任何其他文字或標點符號。"
                ),
                HumanMessage(state["user_input"]),
            ])

            detected = response.content.strip().lower()
            valid_names = {s["name"] for s in skill_list}
            if detected not in valid_names:
                detected = "unknown"

            return {
                "detected_skill": detected,
                "active_skill": detected,
            }

        async def _execute(state: SkillAgentState, skill_name: str) -> dict:
            """
            共用技能執行邏輯。

            從 SKILL.md 取得 system prompt（含 few-shot 範例），
            然後呼叫 LLM。
            """
            system_prompt = registry.compose_system_prompt(skill_name)
            messages_for_llm = [SystemMessage(system_prompt)] + list(state["messages"])
            response = await self.llm.ainvoke(messages_for_llm)

            return {
                "active_skill": skill_name,
                "response": response.content,
                "messages": [AIMessage(response.content)],
            }

        async def email_node(state: SkillAgentState):
            return await _execute(state, "email")

        async def code_review_node(state: SkillAgentState):
            return await _execute(state, "code_review")

        async def summarizer_node(state: SkillAgentState):
            return await _execute(state, "summarizer")

        async def translator_node(state: SkillAgentState):
            return await _execute(state, "translator")

        async def weekly_report_node(state: SkillAgentState):
            return await _execute(state, "weekly_report")

        async def generic_node(state: SkillAgentState):
            """意圖不明時的 fallback 節點"""
            return await _execute(state, "unknown")

        # ===
        # route functions
        # ===

        def route_by_skill(state: SkillAgentState) -> str:
            """
            依 active_skill 路由到對應的執行節點。
            這是 Case 7 的核心條件邊：分類結果驅動圖的執行路徑。
            """
            skill = state.get("active_skill", "unknown")
            mapping = {
                "email":          "email_node",
                "code_review":    "code_review_node",
                "summarizer":     "summarizer_node",
                "translator":     "translator_node",
                "weekly_report":  "weekly_report_node",
            }
            return mapping.get(skill, "generic_node")

        # ===
        # build graph
        # ===
        graph = StateGraph(SkillAgentState)

        graph.add_node("classify_node",      classify_node)
        graph.add_node("email_node",         email_node)
        graph.add_node("code_review_node",   code_review_node)
        graph.add_node("summarizer_node",    summarizer_node)
        graph.add_node("translator_node",    translator_node)
        graph.add_node("weekly_report_node", weekly_report_node)
        graph.add_node("generic_node",       generic_node)

        graph.add_edge(START, "classify_node")

        # 條件邊：classify_node 完成後，依 active_skill 路由
        graph.add_conditional_edges(
            "classify_node",
            route_by_skill,
            ["email_node", "code_review_node", "summarizer_node", "translator_node", "weekly_report_node", "generic_node"],
        )

        for node in ["email_node", "code_review_node", "summarizer_node", "translator_node", "weekly_report_node", "generic_node"]:
            graph.add_edge(node, END)

        agent = graph.compile(checkpointer=MemorySaver())
        return agent
