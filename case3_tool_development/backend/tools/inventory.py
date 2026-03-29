"""
庫存工具 — query_inventory / update_stock

Case 3 核心學習點：
1. args_schema=XxxInput：用 Pydantic BaseModel 定義工具的輸入參數 schema
   - LLM 透過 schema 的 Field description 了解每個參數的用途
   - 相較於只寫 docstring，schema 提供更嚴格的型別驗證
2. 工具直接操作 SQLite 資料庫（CRUD）
3. try/except 錯誤處理：工具失敗時回傳錯誤訊息給 LLM，讓 LLM 決定後續行動
"""

import os
import sys
import json

# 將 backend/ 目錄加入 Python 路徑，讓 tools/ 子目錄能 import 同層的模組
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from typing import Optional
from pydantic import BaseModel, Field
from langchain_core.tools import tool
from sqlalchemy import select, update

from database import engine, products, stock_changes


# ============================================================
# 工具 1：query_inventory — 查詢庫存
# ============================================================

class QueryInventoryInput(BaseModel):
    """查詢庫存工具的輸入參數 schema"""
    keyword: str = Field(
        default="",
        description="搜尋關鍵字（產品名稱），留空則列出全部產品"
    )
    category: Optional[str] = Field(
        default=None,
        description="分類篩選，可選值：電子產品、文具、食品、服飾、家居。不指定則搜尋全部分類"
    )
    low_stock_only: bool = Field(
        default=False,
        description="設為 True 則只回傳庫存量低於安全庫存的產品"
    )


@tool(args_schema=QueryInventoryInput)
def query_inventory(keyword: str = "", category: Optional[str] = None, low_stock_only: bool = False) -> str:
    """
    查詢庫存中的產品資訊。可按名稱關鍵字、分類篩選，也可只顯示庫存不足的產品。
    回傳產品清單，包含 ID、名稱、分類、目前庫存、安全庫存、單價。

    【Few-Shot 範例】
    輸入：{"keyword": "手機", "low_stock_only": false}
    輸出：
      共找到 1 筆產品：
      [ID:2] 智慧型手機（電子產品） | 庫存：8 / 安全庫存：10 | 單價：NT$25,000 | ⚠️ 庫存不足

    輸入：{"keyword": "", "low_stock_only": true}
    輸出：
      共找到 3 筆產品：
      [ID:2] 智慧型手機（電子產品） | 庫存：8 / 安全庫存：10 | 單價：NT$25,000 | ⚠️ 庫存不足
      [ID:7] 筆記型電腦（電子產品） | 庫存：3 / 安全庫存：5 | 單價：NT$35,000 | ⚠️ 庫存不足
      ...

    注意：回傳中的 [ID:X] 就是 update_stock 和 calculate_reorder 所需的 product_id 數值。
    """
    try:
        with engine.connect() as conn:
            # 建立查詢，依條件動態加入過濾
            stmt = select(products)

            if keyword:
                # LIKE 模糊搜尋產品名稱
                stmt = stmt.where(products.c.name.like(f"%{keyword}%"))

            if category:
                stmt = stmt.where(products.c.category == category)

            rows = conn.execute(stmt).fetchall()

        if not rows:
            return "查無符合條件的產品。"

        results = []
        for r in rows:
            # 判斷庫存狀態
            if r.quantity < r.min_stock:
                status = "⚠️ 庫存不足"
            elif r.quantity >= r.min_stock * 3:
                status = "✅ 庫存充足"
            else:
                status = "庫存正常"

            # 若指定只顯示庫存不足，跳過其他
            if low_stock_only and r.quantity >= r.min_stock:
                continue

            results.append(
                f"[ID:{r.id}] {r.name}（{r.category}）"
                f" | 庫存：{r.quantity} / 安全庫存：{r.min_stock}"
                f" | 單價：NT${r.unit_price:,.0f}"
                f" | {status}"
            )

        if not results:
            return "目前所有產品庫存皆正常，無庫存不足的產品。"

        return f"共找到 {len(results)} 筆產品：\n" + "\n".join(results)

    except Exception as e:
        # 將錯誤訊息回傳給 LLM，讓 LLM 判斷如何繼續
        return f"查詢失敗：{e}"


# ============================================================
# 工具 2：update_stock — 更新庫存數量
# ============================================================

class UpdateStockInput(BaseModel):
    """更新庫存工具的輸入參數 schema"""
    product_id: int = Field(
        description="要更新的產品 ID（可從 query_inventory 結果中取得）"
    )
    change_amount: int = Field(
        description="庫存異動數量。正數表示入庫（增加），負數表示出庫（減少）"
    )
    reason: str = Field(
        default="",
        description="異動原因，例如：進貨補充、銷售出庫、庫存盤點調整"
    )


@tool(args_schema=UpdateStockInput)
def update_stock(product_id: int, change_amount: int, reason: str = "") -> str:
    """
    更新指定產品的庫存數量，並記錄異動原因。
    change_amount 為正數時入庫，為負數時出庫。
    更新後若庫存低於安全庫存，會在回覆中提示。

    【Few-Shot 範例】
    輸入：{"product_id": 2, "change_amount": 50, "reason": "進貨補充"}
    輸出：
      ✅ 智慧型手機 入庫 50 件
      庫存：8 → 58
      原因：進貨補充

    輸入：{"product_id": 2, "change_amount": -5, "reason": "銷售出庫"}
    輸出：
      ✅ 智慧型手機 出庫 5 件
      庫存：58 → 53
      原因：銷售出庫

    注意：product_id 必須從 query_inventory 的回傳結果 [ID:X] 中取得，不可自行猜測。
    """
    try:
        with engine.connect() as conn:
            # 先取得產品目前資訊
            row = conn.execute(
                select(products).where(products.c.id == product_id)
            ).fetchone()

            if not row:
                return f"找不到 ID 為 {product_id} 的產品，請先使用 query_inventory 確認產品 ID。"

            quantity_before = row.quantity
            quantity_after = quantity_before + change_amount

            # 驗證：庫存不能低於 0
            if quantity_after < 0:
                return (
                    f"更新失敗：{row.name} 目前庫存為 {quantity_before}，"
                    f"無法減少 {abs(change_amount)}（庫存不能為負數）。"
                )

            # 更新 products 表
            conn.execute(
                update(products)
                .where(products.c.id == product_id)
                .values(quantity=quantity_after)
            )

            # 寫入 stock_changes 異動記錄
            conn.execute(
                stock_changes.insert().values(
                    product_id=product_id,
                    change_amount=change_amount,
                    quantity_before=quantity_before,
                    quantity_after=quantity_after,
                    reason=reason or "未說明",
                )
            )
            conn.commit()

        # 組裝回覆訊息
        action = "入庫" if change_amount > 0 else "出庫"
        msg = (
            f"✅ {row.name} {action} {abs(change_amount)} 件\n"
            f"庫存：{quantity_before} → {quantity_after}\n"
            f"原因：{reason or '未說明'}"
        )

        # 若更新後仍低於安全庫存，給出提示
        if quantity_after < row.min_stock:
            msg += f"\n⚠️ 注意：目前庫存 ({quantity_after}) 低於安全庫存 ({row.min_stock})，建議補貨。"

        return msg

    except Exception as e:
        return f"庫存更新失敗：{e}"
