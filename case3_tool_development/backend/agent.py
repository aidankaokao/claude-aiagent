"""
InventoryAgent — 庫存管理 ReAct Agent

【雙模式設計】
本 Agent 依據 base_url 自動判斷使用的是雲端模型（OpenAI）還是本地模型（Ollama），
並採用不同的補強策略：

┌─────────────────┬─────────────────────────────────────────────────────────────┐
│ 模式             │ 說明                                                         │
├─────────────────┼─────────────────────────────────────────────────────────────┤
│ OpenAI（標準）   │ 標準 ReAct 迴圈，直接 bind_tools，不注入額外 prompt          │
│ Ollama（補強）   │ 1. 注入詳細 System Prompt（明列工具用途與使用規則）           │
│                 │ 2. 意圖分類（Intent Classification）：縮小每輪可用工具數量     │
│                 │    → 從「4 選 1」變「1~2 選 1」，大幅降低弱模型選錯工具機率   │
└─────────────────┴─────────────────────────────────────────────────────────────┘

判斷方式：base_url 包含 localhost 或 127.0.0.1 → 視為本地模型，啟用補強模式

補強原理詳見 qa.md Q2。
"""

from typing import TypedDict, Annotated
from langgraph.graph import StateGraph, START, END, add_messages
from langgraph.prebuilt import ToolNode
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from models import LlmConfig
from tools import ALL_TOOLS
from tools.inventory import query_inventory, update_stock
from tools.weather import get_weather_forecast
from tools.calculator import calculate_reorder
from tools.stats import get_inventory_stats


class AgentState(TypedDict):
    """Agent 的狀態，只儲存對話訊息串列，add_messages 自動處理追加邏輯"""
    messages: Annotated[list, add_messages]


# Agent 快取：同一組 LLM 設定只建立一次
_agent_cache: dict[tuple, object] = {}


# ============================================================
# 補強模式專用：System Prompt
# ============================================================
# 針對弱模型注入明確規則，避免以下常見失敗：
# - 不呼叫工具直接猜測答案
# - 需要 product_id 時不先查詢就亂填參數
# - 忘記迴圈終止條件，重複呼叫同一工具
_ENHANCED_SYSTEM_PROMPT = SystemMessage(content="""你是專業的庫存管理助手，只能使用以下五個工具：

1. query_inventory      ：查詢產品庫存清單，回傳格式包含 [ID:X]
2. update_stock         ：更新產品庫存數量，需要 product_id（從 query_inventory 取得）
3. get_weather_forecast ：查詢城市天氣與出貨建議
4. calculate_reorder    ：計算補貨量，需要 product_id（從 query_inventory 取得）
5. get_inventory_stats  ：統計各庫存狀態的產品數量，適合「有幾個」「各狀態數量」「統計」類問題

【使用規則】
- 遇到「統計」「數量」「幾種」「各狀態」等問題，優先使用 get_inventory_stats，不要用 query_inventory 手動計數
- 若需要 product_id，必須先呼叫 query_inventory，從回傳結果的 [ID:X] 中取得數值
- 收集到足夠資訊後直接整合回覆，不要重複呼叫同一個工具
- 若工具回傳錯誤訊息，根據錯誤內容修正參數後重試一次
- 請用繁體中文回答""")


# ============================================================
# 補強模式專用：意圖分類
# ============================================================
def _is_local_model(base_url: str) -> bool:
    """
    判斷是否為本地模型（Ollama）。
    Ollama 預設在 localhost:11434 啟動，以 base_url 中是否含 localhost 或 127.0.0.1 判斷。
    """
    return "localhost" in base_url or "127.0.0.1" in base_url


def _classify_intent(message: str) -> list:
    """
    關鍵字意圖分類：依使用者訊息縮小本輪可用的工具集合。

    設計邏輯：
    - 弱模型面對 4 個工具時容易選錯，縮小到 1~2 個後準確率大幅提升
    - 不確定意圖時仍開放全部工具，避免遺漏使用者需求
    - 分類依據：中文關鍵字（可依實際需求擴充）

    Returns:
        適用於本輪問題的工具清單
    """
    msg = message.lower()

    # 天氣相關意圖 → 只需要天氣工具
    if any(k in msg for k in ["天氣", "weather", "颱風", "下雨", "氣候", "氣溫"]):
        return [get_weather_forecast]

    # 出貨影響可能同時需要天氣 + 查詢
    if any(k in msg for k in ["出貨", "配送", "運送"]):
        return [get_weather_forecast, query_inventory]

    # 更新庫存意圖 → 需要先查詢取得 product_id
    if any(k in msg for k in ["更新", "入庫", "出庫", "調整庫存", "修改庫存", "增加", "減少"]):
        return [query_inventory, update_stock]

    # 補貨計算意圖 → 需要先查詢取得 product_id
    if any(k in msg for k in ["補貨", "補充", "進貨量", "採購", "訂購", "reorder"]):
        return [query_inventory, calculate_reorder]

    # 統計意圖 → 直接用統計工具，避免 LLM 手動計數出錯
    if any(k in msg for k in ["統計", "幾種", "幾個", "數量", "各狀態", "比例", "分布", "總共有"]):
        return [get_inventory_stats]

    # 純查詢意圖 → 只需要查詢工具
    if any(k in msg for k in ["查詢", "庫存", "有多少", "清單", "列表", "哪些", "不足"]):
        return [query_inventory]

    # 意圖不明確 → 開放全部工具，讓 LLM 自行判斷
    return ALL_TOOLS


# ============================================================
# InventoryAgent
# ============================================================
class InventoryAgent:
    def __init__(self, llm_config: LlmConfig):
        self.is_local = _is_local_model(llm_config.base_url)

        # base_llm：不綁定工具的基底模型，供補強模式動態 bind_tools 使用
        self.base_llm = ChatOpenAI(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            model=llm_config.model,
            temperature=llm_config.temperature,
        )

        if self.is_local:
            # 補強模式：先不 bind_tools，在 llm_node 內依意圖動態綁定
            print(f"[Agent] 偵測到本地模型（{llm_config.base_url}），啟用補強模式")
        else:
            # 標準模式：預先 bind 全部工具
            self.llm = self.base_llm.bind_tools(ALL_TOOLS)
            print(f"[Agent] 使用雲端模型（{llm_config.model}），標準 ReAct 模式")

    async def create_agent(self):
        is_local = self.is_local  # 閉包捕捉，避免 llm_node 每次存取 self

        # ===
        # node functions
        # ===
        async def llm_node(state: AgentState):
            """
            呼叫 LLM 節點。

            【標準模式（OpenAI）】
            直接用預先 bind_tools 的 self.llm 推理，不注入額外 prompt。

            【補強模式（Ollama）】
            1. 注入 System Prompt：明確告知工具用途與使用規則
            2. 意圖分類：從原始使用者訊息提取意圖，動態縮小可用工具集合
            3. 動態 bind_tools：只把與本次意圖相關的 1~2 個工具告知 LLM
            """
            if is_local:
                # 從訊息歷史中找出最後一則使用者訊息，用於意圖分類
                # 注意：這裡找「原始問題」而非最後一則訊息（可能是 ToolMessage）
                last_human_msg = ""
                for msg in reversed(state["messages"]):
                    if isinstance(msg, HumanMessage):
                        last_human_msg = msg.content
                        break

                # 依意圖縮小工具集合
                active_tools = _classify_intent(last_human_msg)

                # 動態綁定工具 + 注入 System Prompt
                local_llm = self.base_llm.bind_tools(active_tools)
                messages_with_system = [_ENHANCED_SYSTEM_PROMPT] + list(state["messages"])
                response = await local_llm.ainvoke(messages_with_system)
            else:
                # 標準模式：不修改訊息，直接推理
                response = await self.llm.ainvoke(state["messages"])

            return {"messages": [response]}

        # ===
        # route functions
        # ===
        def should_continue(state: AgentState):
            """
            檢查最後一則訊息是否包含 tool_calls：
            - 有 → 繼續到 tools 節點執行工具
            - 無 → END（LLM 已給出最終答案）
            """
            last_message = state["messages"][-1]
            if last_message.tool_calls:
                return "tools"
            return END

        # ===
        # build graph
        # ===
        graph = StateGraph(AgentState)

        # ToolNode 使用 ALL_TOOLS：因為工具執行不受意圖分類限制，
        # 只要 LLM 產出了 tool_calls，ToolNode 就要能執行對應工具。
        # 意圖分類只影響「LLM 能看見哪些工具 schema」，不影響「執行哪些工具」。
        tool_node = ToolNode(ALL_TOOLS)

        graph.add_node("llm_node", llm_node)
        graph.add_node("tools", tool_node)

        graph.add_edge(START, "llm_node")
        graph.add_conditional_edges(
            "llm_node",
            should_continue,
            {"tools": "tools", END: END},
        )
        graph.add_edge("tools", "llm_node")

        agent = graph.compile(checkpointer=MemorySaver())
        return agent


async def get_or_create_agent(llm_config: LlmConfig):
    """依 LLM 設定取得或建立 Agent（快取機制，避免重複建立）"""
    cache_key = (llm_config.api_key, llm_config.base_url, llm_config.model)
    if cache_key not in _agent_cache:
        instance = InventoryAgent(llm_config)
        _agent_cache[cache_key] = await instance.create_agent()
    return _agent_cache[cache_key]
