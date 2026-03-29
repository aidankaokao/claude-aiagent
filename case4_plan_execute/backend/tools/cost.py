"""
旅遊費用估算工具 — estimate_cost

根據目的地、天數與住宿等級估算總費用。
費用數據為模擬資料，僅供學習展示。
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pydantic import BaseModel, Field
from langchain_core.tools import tool

# 各城市的費用基準（每人每天，單位為當地貨幣，附換算參考）
_CITY_COST = {
    "東京":  {"currency": "日圓（JPY）", "rate_note": "約 TWD 0.22/JPY",
              "hotel": {"budget": 4000,  "standard": 12000, "luxury": 35000},
              "food":  {"budget": 1500,  "standard": 4000,  "luxury": 10000},
              "transport_day": 1200},
    "大阪":  {"currency": "日圓（JPY）", "rate_note": "約 TWD 0.22/JPY",
              "hotel": {"budget": 3500,  "standard": 10000, "luxury": 28000},
              "food":  {"budget": 1200,  "standard": 3500,  "luxury": 9000},
              "transport_day": 800},
    "京都":  {"currency": "日圓（JPY）", "rate_note": "約 TWD 0.22/JPY",
              "hotel": {"budget": 4500,  "standard": 13000, "luxury": 40000},
              "food":  {"budget": 1500,  "standard": 4500,  "luxury": 15000},
              "transport_day": 600},
    "台北":  {"currency": "新台幣（TWD）", "rate_note": "本地貨幣",
              "hotel": {"budget": 800,   "standard": 2500,  "luxury": 8000},
              "food":  {"budget": 300,   "standard": 800,   "luxury": 2000},
              "transport_day": 200},
    "首爾":  {"currency": "韓圓（KRW）", "rate_note": "約 TWD 0.023/KRW",
              "hotel": {"budget": 50000, "standard": 120000, "luxury": 350000},
              "food":  {"budget": 20000, "standard": 50000,  "luxury": 120000},
              "transport_day": 10000},
}

_SUPPORTED_CITIES = "、".join(_CITY_COST.keys())


class EstimateCostInput(BaseModel):
    """費用估算工具的輸入參數 schema"""
    city: str = Field(
        description=f"旅遊目的地，支援：{_SUPPORTED_CITIES}"
    )
    days: int = Field(
        description="旅遊天數",
        ge=1,
        le=30,
    )
    hotel_class: str = Field(
        default="standard",
        description="住宿等級：budget（青旅/便宜旅館）、standard（一般商務旅館）、luxury（高級飯店）"
    )
    people: int = Field(
        default=2,
        description="旅遊人數",
        ge=1,
        le=20,
    )


@tool(args_schema=EstimateCostInput)
def estimate_cost(city: str, days: int, hotel_class: str = "standard", people: int = 2) -> str:
    """
    估算指定城市的旅遊總費用（含住宿、餐飲、交通）。

    【Few-Shot 範例】
    輸入：{"city": "東京", "days": 3, "hotel_class": "standard", "people": 2}
    輸出：
      【東京】3 天 2 人旅遊費用估算（standard 住宿）
      住宿：¥12,000 × 3 晚 × 2 人 = ¥72,000
      餐飲：¥4,000 × 3 天 × 2 人 = ¥24,000
      交通：¥1,200 × 3 天 × 2 人 = ¥7,200
      門票等雜費（預估 10%）：¥10,320
      ─────────────────
      合計：約 ¥113,520（約 TWD 24,974）
    """
    try:
        city_map = {"tokyo": "東京", "osaka": "大阪", "kyoto": "京都",
                    "taipei": "台北", "seoul": "首爾"}
        city_key = city_map.get(city.lower(), city)
        cost = _CITY_COST.get(city_key)

        if not cost:
            return f"找不到「{city}」的費用資料。支援城市：{_SUPPORTED_CITIES}"

        # 驗證住宿等級
        if hotel_class not in ("budget", "standard", "luxury"):
            hotel_class = "standard"

        hotel_per_person_night = cost["hotel"][hotel_class]
        food_per_person_day = cost["food"][hotel_class]
        transport_per_person_day = cost["transport_day"]

        total_hotel = hotel_per_person_night * days * people
        total_food = food_per_person_day * days * people
        total_transport = transport_per_person_day * days * people
        subtotal = total_hotel + total_food + total_transport
        misc = int(subtotal * 0.10)   # 門票、購物、雜費估 10%
        total = subtotal + misc

        currency = cost["currency"]
        rate_note = cost["rate_note"]
        unit = currency.split("（")[0]  # 取貨幣名稱

        hotel_class_labels = {"budget": "經濟", "standard": "標準", "luxury": "豪華"}

        lines = [
            f"【{city_key}】{days} 天 {people} 人旅遊費用估算（{hotel_class_labels[hotel_class]}住宿）",
            f"住宿：{unit}{hotel_per_person_night:,} × {days} 晚 × {people} 人 = {unit}{total_hotel:,}",
            f"餐飲：{unit}{food_per_person_day:,} × {days} 天 × {people} 人 = {unit}{total_food:,}",
            f"交通：{unit}{transport_per_person_day:,} × {days} 天 × {people} 人 = {unit}{total_transport:,}",
            f"門票雜費（預估 10%）：{unit}{misc:,}",
            "─" * 30,
            f"合計：約 {unit}{total:,}",
            f"（匯率參考：{rate_note}）",
            "",
            "⚠️ 以上為估算值，實際費用依住宿選擇、個人消費習慣而異。",
        ]
        return "\n".join(lines)

    except Exception as e:
        return f"費用估算失敗：{e}"
