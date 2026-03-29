"""
工具套件 — 匯出所有工具供 agent.py 使用

學習重點（Case 3 核心）：
- 每個工具都使用 Pydantic BaseModel 定義輸入參數（args_schema）
- 工具內部有完整的 try/except 錯誤處理
- inventory 工具直接操作 SQLite 資料庫（CRUD）
- 多工具協作：LLM 可在一次對話中依序呼叫多個工具
- get_inventory_stats：SQL 層聚合，解決 LLM 計數不準問題
"""

from tools.inventory import query_inventory, update_stock
from tools.weather import get_weather_forecast
from tools.calculator import calculate_reorder
from tools.stats import get_inventory_stats

# 所有工具清單，傳給 agent.py 的 bind_tools()
ALL_TOOLS = [query_inventory, update_stock, get_weather_forecast, calculate_reorder, get_inventory_stats]
