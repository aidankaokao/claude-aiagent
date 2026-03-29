"""
餐廳搜尋工具 — find_restaurants

從 fixtures/restaurants.json 讀取模擬餐廳資料。
"""

import os
import sys
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from typing import Optional
from pydantic import BaseModel, Field
from langchain_core.tools import tool

_FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "..", "fixtures", "restaurants.json")
with open(_FIXTURE_PATH, encoding="utf-8") as f:
    _RESTAURANTS_DATA: dict = json.load(f)

_SUPPORTED_CITIES = "、".join(_RESTAURANTS_DATA.keys())


class FindRestaurantsInput(BaseModel):
    """餐廳搜尋工具的輸入參數 schema"""
    city: str = Field(
        description=f"要搜尋的城市，支援：{_SUPPORTED_CITIES}"
    )
    cuisine: Optional[str] = Field(
        default=None,
        description="料理類型篩選，例如：壽司、拉麵、韓食、甜點。不指定則回傳全部"
    )


@tool(args_schema=FindRestaurantsInput)
def find_restaurants(city: str, cuisine: Optional[str] = None) -> str:
    """
    搜尋指定城市的推薦餐廳，包含料理類型、招牌菜、價位與評分。

    【Few-Shot 範例】
    輸入：{"city": "東京", "cuisine": "拉麵"}
    輸出：
      【東京】拉麵 推薦餐廳（共 1 間）：
      1. 一蘭拉麵（拉麵）｜價位：中（¥1,000-1,500）｜評分：4.5
         招牌：豚骨拉麵，獨立隔間專注享用
    """
    try:
        city_map = {"tokyo": "東京", "osaka": "大阪", "kyoto": "京都",
                    "taipei": "台北", "seoul": "首爾"}
        city_key = city_map.get(city.lower(), city)

        restaurants = _RESTAURANTS_DATA.get(city_key)
        if not restaurants:
            return f"找不到「{city}」的餐廳資料。支援城市：{_SUPPORTED_CITIES}"

        if cuisine:
            restaurants = [r for r in restaurants
                           if cuisine in r.get("cuisine", "") or cuisine in r.get("specialty", "")]
            if not restaurants:
                return f"「{city}」沒有符合「{cuisine}」類型的餐廳推薦。"

        label = f"【{city_key}】"
        if cuisine:
            label += f"{cuisine} 推薦餐廳（共 {len(restaurants)} 間）："
        else:
            label += f"推薦餐廳（共 {len(restaurants)} 間）："

        lines = [label]
        for i, r in enumerate(restaurants, 1):
            lines.append(
                f"{i}. {r['name']}（{r['cuisine']}）｜"
                f"價位：{r['price_range']}｜評分：{r['rating']}"
            )
            lines.append(f"   招牌：{r['specialty']}")

        return "\n".join(lines)

    except Exception as e:
        return f"餐廳搜尋失敗：{e}"
