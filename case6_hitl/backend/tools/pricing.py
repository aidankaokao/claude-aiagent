"""
定價計算工具 — Case 6

calculate_price: 根據品項與數量計算含折扣的訂單總金額
"""


def calculate_price(items: list[dict]) -> dict:
    """
    計算訂單總金額，滿 1000 元打 95 折，滿 5000 元打 9 折。

    Args:
        items: [{"product_id", "name", "quantity", "unit_price", ...}]

    Returns:
        {
            "items": [{"product_id", "name", "quantity", "unit_price", "subtotal"}],
            "subtotal": float,
            "discount_rate": float,   # 1.0 = 無折扣
            "discount": float,        # 折扣金額
            "total": float,
        }
    """
    line_items = []
    subtotal = 0.0

    for item in items:
        line_subtotal = item["unit_price"] * item["quantity"]
        line_items.append({
            "product_id": item["product_id"],
            "name": item["name"],
            "quantity": item["quantity"],
            "unit_price": item["unit_price"],
            "subtotal": round(line_subtotal, 2),
        })
        subtotal += line_subtotal

    subtotal = round(subtotal, 2)

    if subtotal >= 5000:
        discount_rate = 0.90
    elif subtotal >= 1000:
        discount_rate = 0.95
    else:
        discount_rate = 1.0

    discount = round(subtotal * (1 - discount_rate), 2)
    total = round(subtotal - discount, 2)

    return {
        "items": line_items,
        "subtotal": subtotal,
        "discount_rate": discount_rate,
        "discount": discount,
        "total": total,
    }
