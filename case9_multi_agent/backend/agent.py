"""
SupervisorAgent — Multi-Agent Supervisor 模式（Case 9）

架構說明：
- Supervisor 模式：主控 Agent 負責任務分派與協調
- 三個專家 Agent 節點：
    1. researcher — 研究員，收集事實與背景知識
    2. analyst    — 分析師，深度分析研究結果
    3. writer     — 撰寫員，整合輸出最終報告
- Command(goto=...) 實現跨節點動態路由
- 共用 MultiAgentState 在 Agent 間傳遞中間結果

圖的流程：
  START
    ↓
  supervisor ──(Command goto)──▶ researcher
       ▲                              ↓ Command(goto="supervisor")
       │◀─────────────────────────── analyst
       │◀─────────────────────────── writer
       ↓ Command(goto=END)
      END

關鍵設計決策：
1. 只有一條顯式邊（START → supervisor），其他路由全由 Command 決定
2. Supervisor 先用 Python 檢查終止條件（防無限迴圈），再用 LLM 決策路由
3. with_structured_output 確保路由決策格式正確
4. Writer 的輸出以 AIMessage 加入 messages，Supervisor 可偵測 Writer 已執行
"""

import operator
from typing import TypedDict, Annotated, Literal

from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START, END, add_messages
from langgraph.types import Command
from pydantic import BaseModel

from models import LlmConfig


# ============================================================
# Supervisor 路由決策模型
# ============================================================

class RouteDecision(BaseModel):
    """
    Supervisor 的路由決策。
    使用 with_structured_output 確保 LLM 回傳合法的 next_agent 值。
    """
    next_agent: Literal["researcher", "analyst", "writer", "FINISH"]
    reason: str  # 說明選擇此 Agent 的原因（供 AgentFlow 視覺化顯示）


# ============================================================
# 多 Agent 共用狀態
# ============================================================

class MultiAgentState(TypedDict):
    """
    所有 Agent 共用的狀態結構。

    欄位設計說明：
    - messages:        Annotated[list, add_messages]  → 累積（新訊息追加到現有清單）
    - task:            無 reducer  → 替換（每次呼叫設定當前任務）
    - research_result: 無 reducer  → 替換（Researcher 完成後更新）
    - analysis_result: 無 reducer  → 替換（Analyst 完成後更新）
    - agent_steps:     Annotated[list, operator.add]  → 累積（記錄每個 Agent 的動作）
    - iteration:       無 reducer  → 替換（每次呼叫重設為 0，Supervisor 遞增）
    """
    messages: Annotated[list, add_messages]
    task: str
    research_result: str
    analysis_result: str
    agent_steps: Annotated[list, operator.add]
    iteration: int


# ============================================================
# System Prompts
# ============================================================

SUPERVISOR_PROMPT = """你是 AI 研究團隊的 Supervisor，負責協調以下三個專家：
- researcher（研究員）：收集事實、探索不同角度
- analyst（分析師）：分析研究結果，找出洞察與模式
- writer（撰寫員）：整合所有資訊，撰寫最終報告

當前任務：{task}
研究結果：{research_status}
分析結果：{analysis_status}

決策邏輯：
1. 若研究結果為空 → 呼叫 researcher
2. 若研究完成但分析為空 → 呼叫 analyst
3. 若研究與分析均完成 → 呼叫 writer
4. 若 writer 已執行（研究、分析、寫作均完成）→ FINISH

請根據以上狀態做出決策，並簡短說明原因（一句話）。"""

RESEARCHER_PROMPT = """你是 AI 研究團隊的研究員（Researcher）。

任務：深入研究使用者提出的問題或主題。

要求：
1. 從多個角度收集相關事實與背景知識
2. 識別關鍵概念與重要面向
3. 提供客觀、全面的研究發現

格式：
- 直接輸出研究內容（勿說明你的角色）
- 使用條列式或段落組織
- 長度：300-500字"""

ANALYST_PROMPT = """你是 AI 研究團隊的分析師（Analyst）。

研究員提供的資料：
{research_result}

任務：對以上研究結果進行深度分析。

要求：
1. 識別資料中的關鍵模式與趨勢
2. 提煉核心洞察，評估優劣勢
3. 提出有依據的分析結論

格式：
- 直接輸出分析結果（勿說明你的角色）
- 重點突出，邏輯清晰
- 長度：250-400字"""

WRITER_PROMPT = """你是 AI 研究團隊的撰寫員（Writer）。

研究資料：
{research_result}

分析洞察：
{analysis_result}

任務：整合以上所有資訊，撰寫一份結構清晰的最終報告。

格式（使用 Markdown）：
## 摘要
（2-3句核心重點）

## 主要發現
（來自研究員的關鍵事實）

## 深度分析
（來自分析師的洞察）

## 結論與建議
（基於分析的具體行動建議）"""


# ============================================================
# SupervisorAgent
# ============================================================

class SupervisorAgent:
    def __init__(self, llm_config: LlmConfig):
        # 基礎 LLM（researcher、analyst、writer 共用）
        self.llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        )
        # Supervisor 路由器：with_structured_output 確保回傳 RouteDecision 格式
        # 這樣不管 LLM 輸出什麼文字，都能解析出合法的 next_agent 值
        self.router = self.llm.with_structured_output(RouteDecision)

    async def create_agent(self):
        """建構並編譯多 Agent Supervisor 圖"""

        # ============================================================
        # node functions
        # ============================================================

        async def supervisor_node(state: MultiAgentState):
            """
            Supervisor 節點：分析目前進度，決定下一個 Agent。

            設計亮點：
            1. Python 層終止條件（writer_ran / 超過迭代上限）→ 不依賴 LLM 判斷，更可靠
            2. LLM 層路由決策（with_structured_output）→ 利用 LLM 的靈活性
            3. Command(goto=...) → 動態路由，無需預先定義邊
            """
            research_result = state.get("research_result", "")
            analysis_result = state.get("analysis_result", "")
            iteration = state.get("iteration", 0)
            messages = state.get("messages", [])

            # Python 層終止條件：Writer 已執行（state.messages 中有 AIMessage）
            writer_ran = any(isinstance(m, AIMessage) for m in messages)
            if writer_ran or iteration >= 6:
                return Command(goto=END, update={
                    "agent_steps": [{
                        "agent": "supervisor",
                        "action": "FINISH",
                        "reason": "任務完成" if writer_ran else "達到最大迭代次數",
                    }],
                })

            # LLM 決策路由
            prompt = SUPERVISOR_PROMPT.format(
                task=state.get("task", ""),
                research_status=f"已完成（{len(research_result)} 字）" if research_result else "尚未執行",
                analysis_status=f"已完成（{len(analysis_result)} 字）" if analysis_result else "尚未執行",
            )
            decision = await self.router.ainvoke([
                SystemMessage(content=prompt),
                HumanMessage(content="請決定下一步行動。"),
            ])

            if decision.next_agent == "FINISH":
                return Command(goto=END, update={
                    "agent_steps": [{
                        "agent": "supervisor",
                        "action": "FINISH",
                        "reason": decision.reason,
                    }],
                })

            return Command(goto=decision.next_agent, update={
                "iteration": iteration + 1,
                "agent_steps": [{
                    "agent": "supervisor",
                    "action": f"dispatch → {decision.next_agent}",
                    "reason": decision.reason,
                }],
            })

        async def researcher_node(state: MultiAgentState):
            """
            Researcher 節點：收集任務相關事實與背景知識。

            結果存入 research_result，透過 Command(goto="supervisor")
            將控制權回傳給 Supervisor，讓它決定下一步。

            這是 Supervisor 模式的核心循環：
            Agent 執行完 → 回傳 Supervisor → Supervisor 決策 → 下一個 Agent
            """
            result = await self.llm.ainvoke([
                SystemMessage(content=RESEARCHER_PROMPT),
                HumanMessage(content=state.get("task", "")),
            ])
            return Command(goto="supervisor", update={
                "research_result": result.content,
                "agent_steps": [{
                    "agent": "researcher",
                    "action": "research_completed",
                    "summary": result.content[:200],
                }],
            })

        async def analyst_node(state: MultiAgentState):
            """
            Analyst 節點：分析研究結果，提煉洞察。

            從 state["research_result"] 讀取 Researcher 的輸出，
            透過 Prompt 注入讓 LLM 聚焦於分析任務。
            Agent 之間透過共用 State 傳遞資料，不直接呼叫彼此。
            """
            prompt = ANALYST_PROMPT.format(
                research_result=state.get("research_result", "無研究資料"),
            )
            result = await self.llm.ainvoke([
                SystemMessage(content=prompt),
                HumanMessage(content=state.get("task", "")),
            ])
            return Command(goto="supervisor", update={
                "analysis_result": result.content,
                "agent_steps": [{
                    "agent": "analyst",
                    "action": "analysis_completed",
                    "summary": result.content[:200],
                }],
            })

        async def writer_node(state: MultiAgentState):
            """
            Writer 節點：整合所有資訊，撰寫最終報告。

            輸出以 AIMessage 加入 messages，有兩個作用：
            1. 讓使用者看到最終報告（透過 SSE token 串流）
            2. 讓 Supervisor 偵測 Writer 已執行（writer_ran 檢查）

            Writer 的 token 串流由 api.py 的 on_chat_model_stream 事件捕捉，
            以 langgraph_node="writer" 過濾後轉發給前端。
            """
            prompt = WRITER_PROMPT.format(
                research_result=state.get("research_result", "無研究資料"),
                analysis_result=state.get("analysis_result", "無分析結果"),
            )
            result = await self.llm.ainvoke([
                SystemMessage(content=prompt),
                HumanMessage(content=state.get("task", "")),
            ])
            return Command(goto="supervisor", update={
                "messages": [AIMessage(content=result.content)],
                "agent_steps": [{
                    "agent": "writer",
                    "action": "report_written",
                    "summary": result.content[:200],
                }],
            })

        # ============================================================
        # build graph
        # ============================================================
        graph = StateGraph(MultiAgentState)

        graph.add_node("supervisor", supervisor_node)
        graph.add_node("researcher", researcher_node)
        graph.add_node("analyst", analyst_node)
        graph.add_node("writer", writer_node)

        # 唯一需要顯式聲明的邊：入口點（START → supervisor）
        # 其他所有路由由各節點的 Command(goto=...) 在 runtime 決定
        # 這是 Supervisor 模式的特色：圖結構極簡，路由邏輯集中於 Supervisor
        graph.add_edge(START, "supervisor")

        agent = graph.compile(checkpointer=MemorySaver())
        return agent
