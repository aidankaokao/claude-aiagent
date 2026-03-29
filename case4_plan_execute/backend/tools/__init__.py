"""
工具套件 — Case 4: Plan-Execute Agent

四個旅行規劃工具，供 executor_node 在執行計劃步驟時使用。
與 Case 3 的工具設計相同（args_schema + @tool），重點在 agent.py 的圖結構。
"""

from tools.attractions import search_attractions
from tools.weather import check_weather
from tools.restaurants import find_restaurants
from tools.cost import estimate_cost

ALL_TOOLS = [search_attractions, check_weather, find_restaurants, estimate_cost]
