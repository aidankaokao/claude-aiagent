"""
PlanExecuteAgent — 旅行規劃 Plan-Execute Agent

【Plan-Execute vs ReAct】

ReAct（Case 2/3）：
  每一輪 LLM 自行決定「下一步做什麼」，沒有預先計劃。
  優點：靈活；缺點：LLM 可能繞路或遺漏重要步驟。

Plan-Execute（本 Case）：
  先讓 LLM 生成完整計劃（list of steps），再逐步執行。
  優點：結構清楚、可視覺化進度；缺點：初始規劃若有誤，需重新規劃。

【圖結構】

  START → planner_node → executor_node ↔ tool_node（per-step mini-ReAct）
                                 ↓（步驟完成）
                          replanner_node
                                 ↓ response 已設定
                                END
                                 ↓ 還有步驟
                          executor_node（下一步）

【State 設計重點】

  plan：list[str]
    由 planner_node 一次生成，是整個對話的「骨架」。

  past_steps：Annotated[list[dict], operator.add]
    使用 operator.add reducer：每次 executor_node 返回 [{"step":..., "result":...}]，
    會自動 append 到既有 list，不需要手動 list.append()。
    這是 LangGraph State 的「增量累積」設計模式。

  messages：Annotated[list, add_messages]
    供 ToolNode 讀取 AIMessage.tool_calls 用；
    executor_node 每次從頭建立自己的 LLM context（不從 messages 讀歷史），
    避免無關訊息干擾步驟執行。

  response：str
    replanner_node 完成最終整合後設定此欄位，觸發圖終止。
"""

import operator
from typing import TypedDict, Annotated

from langgraph.graph import StateGraph, START, END, add_messages
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage, ToolMessage, AIMessage
from langgraph.checkpoint.memory import MemorySaver

from models import LlmConfig, TravelPlan
from tools import ALL_TOOLS


# ============================================================
# AgentState — 擴展版 State（Plan-Execute 核心）
# ============================================================
class AgentState(TypedDict):
    """
    Plan-Execute Agent 的狀態。

    與 Case 2/3 的差異：
      - 新增 plan、past_steps、response 欄位
      - messages 仍存在，但主要供 ToolNode 使用，不作為 LLM 推理的主要上下文
    """
    user_request: str                                         # 使用者的原始旅行需求
    plan: list[str]                                           # 步驟清單（由 planner_node 生成）
    past_steps: Annotated[list[dict], operator.add]           # 已完成步驟的結果（自動累積）
    response: str                                             # 最終旅行計劃文字（設定後圖終止）
    messages: Annotated[list, add_messages]                   # 工具呼叫工作緩衝區
    replan_count: int                                         # 重新規劃次數（防無限迴圈）


# Agent 快取：同一 LLM 設定只建立一次
_agent_cache: dict[tuple, object] = {}


class PlanExecuteAgent:
    def __init__(self, llm_config: LlmConfig):
        """
        建立三個 LLM 實例：
        - planning_llm：使用 with_structured_output(TravelPlan)，強制輸出 JSON
        - executor_llm：bind_tools(ALL_TOOLS)，執行單一步驟時可呼叫工具
        - synthesis_llm：純文字輸出，整合所有步驟結果生成最終行程
        """
        base_llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        )
        # with_structured_output：LLM 透過 function calling 輸出符合 TravelPlan schema 的 JSON
        self.planning_llm = base_llm.with_structured_output(TravelPlan)
        # bind_tools：executor 可呼叫四個旅行資訊工具
        self.executor_llm = base_llm.bind_tools(ALL_TOOLS)
        # 純文字 LLM：用於最終整合，不需要工具
        self.synthesis_llm = base_llm

    async def create_agent(self):
        planning_llm = self.planning_llm
        executor_llm = self.executor_llm
        synthesis_llm = self.synthesis_llm

        # ===
        # node functions
        # ===

        async def planner_node(state: AgentState):
            """
            規劃節點：將使用者需求拆解成 3-5 個步驟。

            使用 with_structured_output(TravelPlan) 確保輸出結構一致：
              { destination: "東京", duration_days: 3, steps: ["步驟1", "步驟2", ...] }

            返回：
              - plan：步驟字串清單
              - past_steps：重置為空（新計劃開始）
              - response：重置為空
              - replan_count：重置為 0
              - messages：加入使用者的旅行需求訊息（供 ToolNode 工作緩衝區使用）
            """
            result = await planning_llm.ainvoke([
                SystemMessage(
                    "你是旅行規劃專家。根據使用者的旅行需求，制定 3-5 個具體的資訊收集步驟。\n"
                    "步驟應涵蓋：景點搜尋、天氣查詢、餐廳推薦、費用估算等面向。\n"
                    "每個步驟描述應簡潔明確，例如：「搜尋東京的熱門景點」。"
                ),
                HumanMessage(state["user_request"]),
            ])
            return {
                "plan": result.steps,
                "past_steps": [],          # operator.add：返回空 list 代表「從頭開始累積」
                "response": "",
                "replan_count": 0,
                "messages": [HumanMessage(state["user_request"])],
            }

        async def executor_node(state: AgentState):
            """
            執行節點：**自包含**地完成計劃中的一個步驟。

            設計改變（vs 原版）：
              不再依賴 tool_node 往返，而是在 node 內部直接執行所有工具呼叫。
              這樣每次呼叫 executor_node 都保證「一進一出」，狀態流轉簡單可預測。

            流程：
              1. 確認當前要執行哪個步驟（step_idx = len(past_steps)）
              2. 呼叫 executor_llm（帶工具），讓 LLM 決定呼叫哪個工具
              3. 若有 tool_calls：直接執行所有工具，收集所有 ToolMessage
              4. 把 LLM call + 所有工具結果傳給 synthesis_llm 整合成步驟摘要
              5. 回傳 past_steps（step 完成結果），供 replanner 評估
            """
            step_idx = len(state["past_steps"])

            if step_idx >= len(state["plan"]):
                # 安全防護：所有步驟已完成，不應再到達此處
                return {}

            step_text = state["plan"][step_idx]

            # 整理前置步驟摘要，提供背景脈絡
            prev_summary = ""
            if state["past_steps"]:
                prev_lines = [
                    f"- 步驟{i+1}「{s['step']}」：{s['result'][:150]}"
                    for i, s in enumerate(state["past_steps"])
                ]
                prev_summary = "已完成步驟摘要：\n" + "\n".join(prev_lines) + "\n\n"

            # === Step 1：呼叫 executor_llm，決定使用哪個工具 ===
            exec_ctx = [
                SystemMessage("你是旅行資訊搜尋員。使用適合的工具完成指定任務，取得旅行規劃所需資訊。"),
                HumanMessage(f"{prev_summary}當前任務（步驟{step_idx+1}/{len(state['plan'])}）：{step_text}"),
            ]
            ai_response = await executor_llm.ainvoke(exec_ctx)
            new_messages = [ai_response]

            if not ai_response.tool_calls:
                # LLM 直接回答，無需工具
                return {
                    "messages": new_messages,
                    "past_steps": [{"step": step_text, "result": ai_response.content}],
                }

            # === Step 2：逐一執行所有 tool_calls，收集 ToolMessage ===
            tool_map = {t.name: t for t in ALL_TOOLS}
            tool_messages: list[ToolMessage] = []

            for tc in ai_response.tool_calls:
                tool_fn = tool_map.get(tc["name"])
                if tool_fn is None:
                    output = f"未知工具：{tc['name']}"
                else:
                    try:
                        # ainvoke 會觸發 on_tool_start / on_tool_end 回調，SSE tool 事件正常發送
                        output = await tool_fn.ainvoke(tc["args"])
                    except Exception as e:
                        output = f"工具執行失敗：{e}"
                tool_messages.append(ToolMessage(content=str(output), tool_call_id=tc["id"]))

            new_messages.extend(tool_messages)

            # === Step 3：把所有工具結果傳給 synthesis_llm 整合步驟摘要 ===
            synthesis_ctx = [
                SystemMessage("根據工具回傳的資訊，用繁體中文整理此步驟的重要發現，條列式呈現關鍵資訊。"),
                HumanMessage(f"步驟任務：{step_text}"),
                ai_response,          # AIMessage（含 tool_calls）
                *tool_messages,       # 所有 ToolMessage（一一對應）
            ]
            summary = await synthesis_llm.ainvoke(synthesis_ctx)
            new_messages.append(summary)

            return {
                "messages": new_messages,
                "past_steps": [{"step": step_text, "result": summary.content}],
            }

        async def replanner_node(state: AgentState):
            """
            重規劃節點：在每個步驟完成後決定下一步。

            兩種情況：
            1. 所有步驟執行完畢（或重規劃次數耗盡）→ 整合所有結果生成最終旅行計劃
            2. 尚有步驟未完成 → 繼續執行（未來可在此加入重規劃邏輯）

            最終整合使用 synthesis_llm（無工具綁定），streaming token 會出現在 astream_events 中。
            """
            all_done = len(state["past_steps"]) >= len(state["plan"])
            exceeded_replan = state["replan_count"] >= len(state["plan"])

            if all_done or exceeded_replan:
                # === 所有步驟完成：生成最終旅行計劃 ===
                steps_summary = "\n\n".join([
                    f"【步驟{i+1}】{s['step']}\n{s['result']}"
                    for i, s in enumerate(state["past_steps"])
                ])

                synthesis_msgs = [
                    SystemMessage(
                        "你是資深旅行規劃師。根據以下收集到的旅行資訊，"
                        "為使用者整合出一份完整、實用的旅行計劃。\n"
                        "請包含：行程概覽、每日建議行程、餐廳推薦、費用預算、注意事項。\n"
                        "請用繁體中文回覆，格式清晰易讀。"
                    ),
                    HumanMessage(
                        f"使用者需求：{state['user_request']}\n\n"
                        f"收集到的資訊：\n{steps_summary}"
                    ),
                ]
                final_response = await synthesis_llm.ainvoke(synthesis_msgs)
                return {
                    "response": final_response.content,
                    "messages": synthesis_msgs + [final_response],
                }

            else:
                # === 尚有步驟未完成：繼續執行 ===
                # 此處可加入重規劃邏輯：若某步驟結果顯示異常（如天氣警報），
                # 可修改 plan 後才繼續。本 Case 保持簡單，直接繼續。
                return {"replan_count": state["replan_count"] + 1}

        # ===
        # route functions
        # ===

        def route_after_replanner(state: AgentState):
            """
            重規劃節點後的路由判斷：
            - response 已設定 → 整合完成，結束圖
            - response 未設定 → 還有步驟，繼續執行
            """
            if state["response"]:
                return END
            return "executor"

        # ===
        # build graph（簡化版：executor 自包含，不再需要 tool_node 往返）
        # START → planner → executor → replanner → (executor | END)
        # ===
        graph = StateGraph(AgentState)

        graph.add_node("planner_node", planner_node)
        graph.add_node("executor_node", executor_node)
        graph.add_node("replanner_node", replanner_node)

        graph.add_edge(START, "planner_node")
        graph.add_edge("planner_node", "executor_node")
        graph.add_edge("executor_node", "replanner_node")     # 步驟完成 → 重規劃評估
        graph.add_conditional_edges(
            "replanner_node",
            route_after_replanner,
            {"executor": "executor_node", END: END},
        )

        agent = graph.compile(checkpointer=MemorySaver())
        return agent


async def get_or_create_agent(llm_config: LlmConfig):
    """依 LLM 設定取得或建立 Agent（快取，避免重複建立）"""
    cache_key = (llm_config.api_key, llm_config.base_url, llm_config.model)
    if cache_key not in _agent_cache:
        instance = PlanExecuteAgent(llm_config)
        _agent_cache[cache_key] = await instance.create_agent()
    return _agent_cache[cache_key]
