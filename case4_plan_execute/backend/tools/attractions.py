"""
景點搜尋工具 — search_attractions

從 fixtures/attractions.json 讀取模擬景點資料。
"""

import os
import sys
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from typing import Optional
from pydantic import BaseModel, Field
from langchain_core.tools import tool

# 載入 fixtures 資料（模組載入時讀一次，避免重複 IO）
_FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "..", "fixtures", "attractions.json")
with open(_FIXTURE_PATH, encoding="utf-8") as f:
    _ATTRACTIONS_DATA: dict = json.load(f)

# 支援的城市清單（從 fixture key 取得）
_SUPPORTED_CITIES = "、".join(_ATTRACTIONS_DATA.keys())


class SearchAttractionsInput(BaseModel):
    """景點搜尋工具的輸入參數 schema"""
    city: str = Field(
        description=f"要搜尋的城市名稱，支援：{_SUPPORTED_CITIES}"
    )
    category: Optional[str] = Field(
        default=None,
        description="景點類別篩選，例如：寺廟神社、地標景點、美食文化、自然景觀、主題樂園。不指定則回傳全部類別"
    )

    class Config:
        # Few-Shot 範例
        json_schema_extra = {
            "example": {"city": "東京", "category": "地標景點"}
        }


@tool(args_schema=SearchAttractionsInput)
def search_attractions(city: str, category: Optional[str] = None) -> str:
    """
    搜尋指定城市的熱門旅遊景點，包含景點名稱、類別、說明、建議遊覽時間與小提示。

    【Few-Shot 範例】
    輸入：{"city": "東京"}
    輸出：
      【東京】共 7 個景點：
      1. 淺草寺（寺廟神社）｜推薦遊覽：1-2小時
         東京最古老的寺廟，仲見世商店街充滿傳統手工藝品
         💡 建議早上 8 點前到達避開人潮
      ...
    """
    try:
        # 正規化城市名稱（允許英文輸入）
        city_map = {"tokyo": "東京", "osaka": "大阪", "kyoto": "京都",
                    "taipei": "台北", "seoul": "首爾"}
        city_key = city_map.get(city.lower(), city)

        attractions = _ATTRACTIONS_DATA.get(city_key)
        if not attractions:
            return (
                f"找不到「{city}」的景點資料。\n"
                f"目前支援的城市：{_SUPPORTED_CITIES}"
            )

        # 依分類篩選
        if category:
            attractions = [a for a in attractions if category in a.get("category", "")]
            if not attractions:
                return f"「{city}」沒有符合「{category}」類別的景點。"

        lines = [f"【{city_key}】共 {len(attractions)} 個景點："]
        for i, a in enumerate(attractions, 1):
            lines.append(
                f"{i}. {a['name']}（{a['category']}）｜"
                f"推薦遊覽：{a['duration']}｜評分：{a['rating']}"
            )
            lines.append(f"   {a['description']}")
            lines.append(f"   💡 {a['tip']}")

        return "\n".join(lines)

    except Exception as e:
        return f"景點搜尋失敗：{e}"
