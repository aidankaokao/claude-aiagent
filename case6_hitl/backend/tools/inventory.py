"""
庫存檢查工具 — Case 6

check_inventory: 查詢資料庫確認各商品庫存是否充足
"""

from sqlalchemy import select
from database import engine, products as products_table


async def check_inventory(items: list[dict]) -> dict:
    """
    檢查訂單中各商品的庫存是否充足。

    Args:
        items: [{"product_id": str, "name": str, "quantity": int, "unit_price": float}]

    Returns:
        {
            "ok": bool,
            "error": str,          # 若 ok=False，說明原因
            "items": list[dict],   # 補充 available_stock 欄位
        }
    """
    result_items = []

    with engine.connect() as conn:
        for item in items:
            row = conn.execute(
                select(products_table).where(products_table.c.id == item["product_id"])
            ).fetchone()

            if not row:
                return {
                    "ok": False,
                    "error": f"商品不存在：{item['name']}（ID: {item['product_id']}）",
                    "items": [],
                }

            if row.stock < item["quantity"]:
                return {
                    "ok": False,
                    "error": (
                        f"商品「{item['name']}」庫存不足，"
                        f"需要 {item['quantity']} 件，現有 {row.stock} 件"
                    ),
                    "items": [],
                }

            result_items.append({
                **item,
                "available_stock": row.stock,
            })

    return {"ok": True, "error": "", "items": result_items}
