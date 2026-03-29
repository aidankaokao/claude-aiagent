"""
庫存統計工具 — get_inventory_stats

【為什麼需要這個工具？】

LLM 不擅長計數與算術。當使用者問「統計各種庫存狀態的數量」時，
若只依賴 query_inventory 回傳的文字清單，LLM 手動數數容易出錯。

這個工具直接在 SQL 層做聚合計算，把準確的統計結果以結構化文字回傳，
讓 LLM 只需要「描述數字」而不需要「計算數字」。
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from typing import Optional
from pydantic import BaseModel, Field
from langchain_core.tools import tool
from sqlalchemy import select, func, case as sql_case

from database import engine, products


class GetInventoryStatsInput(BaseModel):
    """庫存統計工具的輸入參數 schema"""
    category: Optional[str] = Field(
        default=None,
        description=(
            "要統計的產品分類，可選值：電子產品、文具、食品、服飾、家居。"
            "不指定或留空則統計全部分類"
        )
    )


@tool(args_schema=GetInventoryStatsInput)
def get_inventory_stats(category: Optional[str] = None) -> str:
    """
    統計庫存各狀態的產品數量與金額。
    由資料庫直接計算，結果精確，適合回答「有幾個」「各狀態數量」等統計問題。
    庫存狀態定義：
      庫存不足 = quantity < min_stock
      庫存正常 = min_stock <= quantity < min_stock * 3
      庫存充足 = quantity >= min_stock * 3

    【Few-Shot 範例】
    輸入：{"category": "家居"}
    輸出：
      【家居】庫存統計
      總產品數：10 種
      ⚠️ 庫存不足：3 種（30.0%）
         產品：窗簾、地毯、床頭燈
      庫存正常：5 種（50.0%）
      ✅ 庫存充足：2 種（20.0%）

      庫存總值：NT$280,500
      最低庫存產品：地毯（庫存 1 件，安全庫存 5 件）

    輸入：{"category": null}
    輸出：全部分類的彙總統計（含各分類小計）
    """
    try:
        with engine.connect() as conn:
            # 動態加入分類過濾
            stmt = select(products)
            if category:
                stmt = stmt.where(products.c.category == category)
            rows = conn.execute(stmt).fetchall()

        if not rows:
            target = f"「{category}」分類" if category else "庫存"
            return f"查無 {target} 的產品資料。"

        # 分類計數（在 Python 層計算，確保狀態邏輯與 query_inventory 一致）
        low_items = []     # quantity < min_stock
        normal_items = []  # min_stock <= quantity < min_stock * 3
        high_items = []    # quantity >= min_stock * 3
        total_value = 0

        for r in rows:
            total_value += r.quantity * r.unit_price
            if r.quantity < r.min_stock:
                low_items.append(r)
            elif r.quantity >= r.min_stock * 3:
                high_items.append(r)
            else:
                normal_items.append(r)

        total = len(rows)

        def pct(n):
            return f"{n / total * 100:.1f}%" if total > 0 else "0%"

        # 找庫存最緊缺的產品（quantity - min_stock 最小值）
        most_critical = min(rows, key=lambda r: r.quantity - r.min_stock)

        title = f"【{category}】" if category else "【全部分類】"
        lines = [
            f"{title}庫存統計",
            f"總產品數：{total} 種",
            f"⚠️ 庫存不足：{len(low_items)} 種（{pct(len(low_items))}）",
        ]

        # 列出庫存不足的產品名稱（最多顯示 5 個，避免輸出過長）
        if low_items:
            names = "、".join(r.name for r in low_items[:5])
            if len(low_items) > 5:
                names += f" 等 {len(low_items)} 種"
            lines.append(f"   產品：{names}")

        lines += [
            f"庫存正常：{len(normal_items)} 種（{pct(len(normal_items))}）",
            f"✅ 庫存充足：{len(high_items)} 種（{pct(len(high_items))}）",
            f"",
            f"庫存總值：NT${total_value:,.0f}",
            f"最低庫存產品：{most_critical.name}"
            f"（庫存 {most_critical.quantity} 件，安全庫存 {most_critical.min_stock} 件）",
        ]

        # 若未指定分類，加入各分類小計
        if not category:
            category_totals: dict[str, dict] = {}
            for r in rows:
                cat = r.category
                if cat not in category_totals:
                    category_totals[cat] = {"total": 0, "low": 0}
                category_totals[cat]["total"] += 1
                if r.quantity < r.min_stock:
                    category_totals[cat]["low"] += 1

            lines.append("")
            lines.append("各分類小計：")
            for cat, stat in sorted(category_totals.items()):
                lines.append(
                    f"  {cat}：共 {stat['total']} 種，"
                    f"庫存不足 {stat['low']} 種"
                )

        return "\n".join(lines)

    except Exception as e:
        return f"庫存統計失敗：{e}"
