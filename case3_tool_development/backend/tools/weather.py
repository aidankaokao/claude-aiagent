"""
天氣預報工具 — get_weather_forecast（模擬）

提供各城市的模擬天氣資料，影響出貨與補貨建議：
- 晴天/多雲：正常出貨
- 小雨：可能輕微延遲
- 大雨/颱風：建議延遲出貨，並提高安全庫存

Case 3 學習點：
- 使用 args_schema 定義單一參數工具
- 工具可回傳結構化的建議文字，輔助 LLM 做決策
"""

import random
from pydantic import BaseModel, Field
from langchain_core.tools import tool


# 模擬各城市的天氣資料
# 格式：city_key → (天氣狀況, 溫度範圍, 降雨機率, 對出貨的影響建議)
_WEATHER_DATA: dict[str, dict] = {
    "taipei":    {"condition": "多雲時晴", "temp": "22-28°C", "rain": "20%", "shipping": "正常"},
    "台北":      {"condition": "多雲時晴", "temp": "22-28°C", "rain": "20%", "shipping": "正常"},
    "kaohsiung": {"condition": "晴天",     "temp": "26-32°C", "rain": "10%", "shipping": "正常"},
    "高雄":      {"condition": "晴天",     "temp": "26-32°C", "rain": "10%", "shipping": "正常"},
    "taichung":  {"condition": "小雨",     "temp": "20-25°C", "rain": "60%", "shipping": "輕微延遲"},
    "台中":      {"condition": "小雨",     "temp": "20-25°C", "rain": "60%", "shipping": "輕微延遲"},
    "tainan":    {"condition": "晴天",     "temp": "25-30°C", "rain": "15%", "shipping": "正常"},
    "台南":      {"condition": "晴天",     "temp": "25-30°C", "rain": "15%", "shipping": "正常"},
    "hualien":   {"condition": "颱風警報", "temp": "18-22°C", "rain": "95%", "shipping": "暫停出貨"},
    "花蓮":      {"condition": "颱風警報", "temp": "18-22°C", "rain": "95%", "shipping": "暫停出貨"},
    "tokyo":     {"condition": "晴天",     "temp": "15-22°C", "rain": "5%",  "shipping": "正常"},
    "東京":      {"condition": "晴天",     "temp": "15-22°C", "rain": "5%",  "shipping": "正常"},
    "osaka":     {"condition": "多雲",     "temp": "16-23°C", "rain": "30%", "shipping": "正常"},
    "大阪":      {"condition": "多雲",     "temp": "16-23°C", "rain": "30%", "shipping": "正常"},
    "shanghai":  {"condition": "大雨",     "temp": "14-20°C", "rain": "80%", "shipping": "建議延遲"},
    "上海":      {"condition": "大雨",     "temp": "14-20°C", "rain": "80%", "shipping": "建議延遲"},
    "singapore": {"condition": "雷陣雨",   "temp": "28-33°C", "rain": "70%", "shipping": "輕微延遲"},
    "新加坡":    {"condition": "雷陣雨",   "temp": "28-33°C", "rain": "70%", "shipping": "輕微延遲"},
}

# 出貨建議對應的庫存調整建議
_SHIPPING_ADVICE: dict[str, str] = {
    "正常":     "天氣良好，出貨正常，無需特別調整庫存。",
    "輕微延遲": "天氣可能造成輕微延遲，建議確認緊急訂單的出貨時程。",
    "建議延遲": "天氣惡劣，建議暫緩非緊急出貨，並適當提高備貨量以應對需求波動。",
    "暫停出貨": "颱風或嚴重天候，建議暫停出貨作業，並提高安全庫存 20-30% 以備災後補貨需求。",
}


class GetWeatherInput(BaseModel):
    """天氣查詢工具的輸入參數 schema"""
    city: str = Field(
        description=(
            "要查詢的城市名稱，支援：台北/taipei、高雄/kaohsiung、台中/taichung、"
            "台南/tainan、花蓮/hualien、東京/tokyo、大阪/osaka、上海/shanghai、新加坡/singapore"
        )
    )


@tool(args_schema=GetWeatherInput)
def get_weather_forecast(city: str) -> str:
    """
    查詢指定城市的天氣預報，並提供對出貨與庫存管理的影響建議。
    天氣狀況會影響物流時效，颱風或大雨時建議調高安全庫存。

    【Few-Shot 範例】
    輸入：{"city": "台北"}
    輸出：
      【台北 天氣預報】
      天氣狀況：多雲時晴
      溫度：22-28°C
      降雨機率：20%
      出貨影響：正常
      建議：天氣良好，出貨正常，無需特別調整庫存。

    輸入：{"city": "花蓮"}
    輸出：
      【花蓮 天氣預報】
      天氣狀況：颱風警報
      溫度：18-22°C
      降雨機率：95%
      出貨影響：暫停出貨
      建議：颱風或嚴重天候，建議暫停出貨作業，並提高安全庫存 20-30% 以備災後補貨需求。
    """
    try:
        # 嘗試小寫比對（允許大小寫混用輸入）
        weather = _WEATHER_DATA.get(city.lower().strip()) or _WEATHER_DATA.get(city.strip())

        if not weather:
            # 未知城市回傳預設晴天（模擬 API 的 fallback 行為）
            return (
                f"查無 {city} 的天氣資料（此工具使用模擬資料，僅支援固定城市）。\n"
                "預設天氣：晴天，溫度 20-28°C，降雨機率 15%，出貨狀態：正常。"
            )

        shipping_status = weather["shipping"]
        advice = _SHIPPING_ADVICE.get(shipping_status, "")

        return (
            f"【{city} 天氣預報】\n"
            f"天氣狀況：{weather['condition']}\n"
            f"溫度：{weather['temp']}\n"
            f"降雨機率：{weather['rain']}\n"
            f"出貨影響：{shipping_status}\n"
            f"建議：{advice}"
        )

    except Exception as e:
        return f"天氣查詢失敗：{e}"
