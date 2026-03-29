"""
MapReduceAgent — 公司報告並行分析 Map-Reduce Agent

【Map-Reduce vs Plan-Execute】

Plan-Execute（Case 4）：線性執行，一步完成才進下一步。
Map-Reduce（本 Case）：並行對 N 份文件做相同操作，再聚合結果。

【Send() API — 動態扇出核心】

  from langgraph.types import Send

  def fan_out(state):
      return [Send("analyze_node", {"document": doc, "query": state["query"]})
              for doc in state["documents"]]

  Send("node_name", payload) 告訴 LangGraph：
    「用 payload 作為輸入，啟動一個 analyze_node 實例」

  回傳 list[Send] 時，LangGraph 並行執行所有實例，
  並等待全部完成後才繼續到下一個節點（reduce_node）。

【圖結構】

  START → intake_node
            ↓ fan_out()：每份文件 Send 一個 analyze_node
          analyze_node × N（並行）
            ↓ 全部完成後
          reduce_node → END

【operator.add Reducer 如何累積並行結果】

  analyses: Annotated[list[dict], operator.add]

  每個 analyze_node 回傳 {"analyses": [one_result]}，
  operator.add 把它 append 到現有 list。
  N 個並行節點 → analyses 最終有 N 筆記錄。
  順序不保證（依完成時間），reduce_node 需自行排序。
"""

import operator
from typing import TypedDict, Annotated

from langgraph.graph import StateGraph, START, END, add_messages
from langgraph.types import Send
from langgraph.checkpoint.memory import MemorySaver
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage

from models import LlmConfig, DocumentAnalysis


# ============================================================
# State 定義
# ============================================================

class MapReduceState(TypedDict):
    """
    Map-Reduce Agent 的主狀態。

    documents：由 api.py 在啟動前從 DB 載入，傳入初始狀態。
    analyses：operator.add reducer，每個 analyze_node 各 append 一筆。
    report：reduce_node 完成後設定，代表整個圖執行完畢。
    """
    query: str                                           # 使用者的分析需求
    documents: list[dict]                                # 所有待分析文件
    analyses: Annotated[list[dict], operator.add]        # 各文件分析結果（並行累積）
    report: str                                          # 最終聚合報告
    messages: Annotated[list, add_messages]              # LLM 訊息歷史（供 reduce_node 使用）


# Agent 快取：同一 LLM 設定只建立一次
_agent_cache: dict[tuple, object] = {}


class MapReduceAgent:
    def __init__(self, llm_config: LlmConfig):
        base_llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        )
        # analysis_llm：with_structured_output 強制輸出 DocumentAnalysis JSON
        self.analysis_llm = base_llm.with_structured_output(DocumentAnalysis)
        # synthesis_llm：純文字輸出，支援 token 串流（用於最終報告）
        self.synthesis_llm = base_llm

    async def create_agent(self):
        analysis_llm = self.analysis_llm
        synthesis_llm = self.synthesis_llm

        # ===
        # node functions
        # ===

        async def intake_node(state: MapReduceState):
            """
            準備節點：接收文件列表，不做額外處理直接傳遞。
            未來可在此加入：向量搜尋過濾、按相關性排序、去重等邏輯。
            """
            return {}

        def fan_out(state: MapReduceState) -> list[Send]:
            """
            扇出函式：為每份文件建立一個 Send，動態產生 N 個並行 analyze_node。

            此函式作為 conditional_edges 的路由函式，
            回傳 list[Send] 而非字串，告訴 LangGraph 要並行執行哪些節點。
            """
            return [
                Send("analyze_node", {
                    "document": doc,
                    "query": state["query"],
                })
                for doc in state["documents"]
            ]

        async def analyze_node(state: dict):
            """
            分析節點：對單份文件進行結構化分析。

            透過 Send() 被動態呼叫，state 就是 Send() 時傳入的 payload：
              {"document": {id, title, content, category}, "query": "..."}

            使用 with_structured_output(DocumentAnalysis) 確保輸出一致：
              {doc_id, title, summary, key_points, sentiment}

            部分失敗容錯：捕捉例外，回傳帶 error 標記的記錄，
            讓整體流程繼續而不因單份文件失敗而中止。
            """
            document = state["document"]
            query = state["query"]

            try:
                result: DocumentAnalysis = await analysis_llm.ainvoke([
                    SystemMessage(
                        "你是專業的商業分析師。請分析以下公司報告並回答使用者的查詢問題。\n"
                        "提供簡潔摘要（2-3 句）、3-5 個關鍵重點、整體情感傾向。\n"
                        "情感判斷標準：\n"
                        "  positive — 業績成長、展望樂觀、市場機會明確\n"
                        "  neutral  — 穩定但無顯著成長，風險與機會並存\n"
                        "  negative — 業績下滑、面臨重大挑戰、前景不確定"
                    ),
                    HumanMessage(
                        f"查詢問題：{query}\n\n"
                        f"文件標題：{document['title']}\n"
                        f"文件類別：{document['category']}\n\n"
                        f"文件內容：\n{document['content']}"
                    ),
                ])
                return {
                    "analyses": [{
                        "doc_id": document["id"],
                        "title": document["title"],
                        "category": document["category"],
                        "summary": result.summary,
                        "key_points": result.key_points,
                        "sentiment": result.sentiment,
                        "error": False,
                    }]
                }
            except Exception as e:
                # 部分失敗容錯：即使單份文件分析失敗，整體流程繼續
                return {
                    "analyses": [{
                        "doc_id": document["id"],
                        "title": document["title"],
                        "category": document["category"],
                        "summary": f"分析失敗：{e}",
                        "key_points": [],
                        "sentiment": "neutral",
                        "error": True,
                    }]
                }

        async def reduce_node(state: MapReduceState):
            """
            聚合節點：等所有 analyze_node 完成後，整合為跨文件報告。

            此時 state["analyses"] 已包含 N 份文件的分析結果
            （由 operator.add reducer 自動累積，順序依完成時間）。

            使用 synthesis_llm（無工具綁定）生成最終報告，
            支援 token 串流（api.py 會監聽 on_chat_model_stream）。
            """
            # 依 doc_id 排序確保報告順序一致
            sorted_analyses = sorted(state["analyses"], key=lambda x: x["doc_id"])

            analyses_text = "\n\n".join([
                (
                    f"【{a['title']}】（類別：{a['category']}，情感：{a['sentiment']}）\n"
                    f"摘要：{a['summary']}\n"
                    f"重點：" + "；".join(a.get("key_points", []))
                ) if not a.get("error") else
                f"【{a['title']}】：分析失敗，已略過"
                for a in sorted_analyses
            ])

            synthesis_msgs = [
                SystemMessage(
                    "你是資深商業分析師。根據以下多份公司報告的分析結果，"
                    "為使用者生成一份全面的跨文件綜合報告。\n"
                    "報告應包含：整體市場趨勢、各公司亮點比較、主要風險、綜合建議。\n"
                    "請用繁體中文，格式清晰，善用標題與條列。"
                ),
                HumanMessage(
                    f"使用者查詢：{state['query']}\n\n"
                    f"各文件分析結果（共 {len(sorted_analyses)} 份）：\n\n{analyses_text}"
                ),
            ]

            final_report = await synthesis_llm.ainvoke(synthesis_msgs)
            return {
                "report": final_report.content,
                "messages": synthesis_msgs + [final_report],
            }

        # ===
        # build graph
        # START → intake_node → [analyze_node × N, 並行] → reduce_node → END
        # ===
        graph = StateGraph(MapReduceState)

        graph.add_node("intake_node", intake_node)
        graph.add_node("analyze_node", analyze_node)
        graph.add_node("reduce_node", reduce_node)

        graph.add_edge(START, "intake_node")
        # fan_out 回傳 list[Send] → 每份文件一個並行 analyze_node
        graph.add_conditional_edges("intake_node", fan_out, ["analyze_node"])
        # 所有 analyze_node 實例完成後，LangGraph 自動觸發 reduce_node
        graph.add_edge("analyze_node", "reduce_node")
        graph.add_edge("reduce_node", END)

        agent = graph.compile(checkpointer=MemorySaver())
        return agent


async def get_or_create_agent(llm_config: LlmConfig):
    """依 LLM 設定取得或建立 Agent（快取，避免重複建立）"""
    cache_key = (llm_config.api_key, llm_config.base_url, llm_config.model)
    if cache_key not in _agent_cache:
        instance = MapReduceAgent(llm_config)
        _agent_cache[cache_key] = await instance.create_agent()
    return _agent_cache[cache_key]
