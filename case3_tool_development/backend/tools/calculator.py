"""
補貨計算工具 — calculate_reorder

根據產品 ID、預估每日需求量與需覆蓋天數，計算建議補貨量。
查詢資料庫取得目前庫存與安全庫存，計算後回傳結構化建議。

Case 3 學習點：
- 工具結合資料庫查詢 + 數學計算
- Field 使用 ge/le 對參數做範圍驗證，非法輸入在進入工具前就被 Pydantic 攔截
"""

import os
import sys

# 將 backend/ 目錄加入 Python 路徑
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pydantic import BaseModel, Field
from langchain_core.tools import tool
from sqlalchemy import select

from database import engine, products


class CalculateReorderInput(BaseModel):
    """補貨計算工具的輸入參數 schema"""
    product_id: int = Field(
        description="要計算補貨量的產品 ID（可從 query_inventory 結果中取得）"
    )
    days_to_cover: int = Field(
        description="需要備貨的天數（例如：30 表示補足 30 天的庫存）",
        ge=1,    # 最少 1 天
        le=365,  # 最多 365 天
    )
    daily_demand: float = Field(
        description="每日預估銷售/消耗量（件數）",
        gt=0,    # 必須大於 0
    )


@tool(args_schema=CalculateReorderInput)
def calculate_reorder(product_id: int, days_to_cover: int, daily_demand: float) -> str:
    """
    計算指定產品的建議補貨量。
    公式：建議補貨量 = 預估需求（daily_demand × days_to_cover）- 目前庫存 + 安全庫存緩衝。
    若目前庫存已充足，回傳不需補貨的說明。

    【Few-Shot 範例】
    輸入：{"product_id": 2, "days_to_cover": 30, "daily_demand": 2.0}
    輸出：
      【智慧型手機】補貨建議
      目前庫存：8 件（可維持 4.0 天）
      安全庫存：10 件
      每日需求：2.0 件，覆蓋天數：30 天
      建議補貨量：62 件
      補貨後庫存：70 件（可維持 35.0 天）
      預估補貨成本：NT$1,550,000

    注意：product_id 必須從 query_inventory 的回傳結果 [ID:X] 中取得，不可自行猜測。
    若使用者未提供 daily_demand，可依產品類型合理估算（電子產品約 1-3 件/天）。
    """
    try:
        with engine.connect() as conn:
            row = conn.execute(
                select(products).where(products.c.id == product_id)
            ).fetchone()

        if not row:
            return f"找不到 ID 為 {product_id} 的產品，請先使用 query_inventory 確認產品 ID。"

        # 計算所需庫存：覆蓋天數的需求量 + 安全庫存作為緩衝
        total_needed = daily_demand * days_to_cover + row.min_stock
        reorder_qty = max(0, total_needed - row.quantity)

        # 計算目前庫存可維持的天數
        days_remaining = row.quantity / daily_demand if daily_demand > 0 else float("inf")

        if reorder_qty <= 0:
            return (
                f"【{row.name}】不需要補貨\n"
                f"目前庫存：{row.quantity} 件，可維持約 {days_remaining:.1f} 天\n"
                f"（設定覆蓋天數：{days_to_cover} 天，每日需求：{daily_demand} 件）"
            )

        # 計算補貨後的預期庫存與可維持天數
        stock_after_reorder = row.quantity + reorder_qty
        days_after = stock_after_reorder / daily_demand

        # 估算補貨成本
        estimated_cost = reorder_qty * row.unit_price

        return (
            f"【{row.name}】補貨建議\n"
            f"目前庫存：{row.quantity} 件（可維持 {days_remaining:.1f} 天）\n"
            f"安全庫存：{row.min_stock} 件\n"
            f"每日需求：{daily_demand} 件，覆蓋天數：{days_to_cover} 天\n"
            f"建議補貨量：{int(reorder_qty)} 件\n"
            f"補貨後庫存：{int(stock_after_reorder)} 件（可維持 {days_after:.1f} 天）\n"
            f"預估補貨成本：NT${estimated_cost:,.0f}"
        )

    except Exception as e:
        return f"補貨計算失敗：{e}"
