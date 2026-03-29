"""
天氣查詢工具 — check_weather（模擬）

提供各城市的模擬天氣資料，用於旅行規劃建議。
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pydantic import BaseModel, Field
from langchain_core.tools import tool

# 模擬各城市天氣（固定資料，供學習展示用）
_WEATHER_DATA = {
    "東京": {"condition": "晴天", "temp": "18-26°C", "rain": "10%", "advice": "天氣晴朗，適合戶外景點"},
    "大阪": {"condition": "多雲", "temp": "17-25°C", "rain": "25%", "advice": "帶把折傘備用，不影響戶外行程"},
    "京都": {"condition": "晴時多雲", "temp": "16-24°C", "rain": "15%", "advice": "舒適宜人，步行古寺最佳天氣"},
    "台北": {"condition": "小雨", "temp": "22-28°C", "rain": "60%", "advice": "建議攜帶雨具，安排部分室內行程"},
    "首爾": {"condition": "晴天", "temp": "14-22°C", "rain": "5%", "advice": "秋高氣爽，戶外景點最舒適"},
    "東京（颱風預警）": {"condition": "颱風警報", "temp": "20-24°C", "rain": "95%", "advice": "⚠️ 建議調整行程，優先安排室內景點"},
}


class CheckWeatherInput(BaseModel):
    """天氣查詢工具的輸入參數 schema"""
    city: str = Field(
        description="要查詢的城市，支援：東京、大阪、京都、台北、首爾"
    )
    days: int = Field(
        default=3,
        description="查詢未來幾天的天氣（1-7 天）",
        ge=1,
        le=7,
    )


@tool(args_schema=CheckWeatherInput)
def check_weather(city: str, days: int = 3) -> str:
    """
    查詢指定城市的天氣預報與旅行建議。
    天氣影響景點選擇：雨天建議安排室內景點，颱風時建議縮短戶外行程。

    【Few-Shot 範例】
    輸入：{"city": "東京", "days": 3}
    輸出：
      【東京】未來 3 天天氣預報
      天氣狀況：晴天
      溫度範圍：18-26°C
      降雨機率：10%
      旅行建議：天氣晴朗，適合戶外景點
    """
    try:
        city_map = {"tokyo": "東京", "osaka": "大阪", "kyoto": "京都",
                    "taipei": "台北", "seoul": "首爾"}
        city_key = city_map.get(city.lower(), city)
        weather = _WEATHER_DATA.get(city_key)

        if not weather:
            # 未知城市回傳預設晴天
            return (
                f"【{city}】未來 {days} 天天氣預報\n"
                "天氣狀況：晴天（預設值，無該城市資料）\n"
                "溫度範圍：20-28°C\n降雨機率：15%\n"
                "旅行建議：天氣良好，適合各類行程"
            )

        return (
            f"【{city_key}】未來 {days} 天天氣預報\n"
            f"天氣狀況：{weather['condition']}\n"
            f"溫度範圍：{weather['temp']}\n"
            f"降雨機率：{weather['rain']}\n"
            f"旅行建議：{weather['advice']}"
        )

    except Exception as e:
        return f"天氣查詢失敗：{e}"
