"""
訂單建立工具 — Case 6

create_order: 將通過審批的訂單寫入資料庫
"""

import uuid
from sqlalchemy import insert, Table, Column, Integer, String, Float, Text, DateTime, MetaData
from sqlalchemy.sql import func
from database import engine


# 訂單相關資料表（在 database.py 之外定義，保持模組獨立）
_metadata = MetaData()

orders = Table(
    "orders", _metadata,
    Column("id", String, primary_key=True),
    Column("thread_id", String, nullable=False),
    Column("status", String, nullable=False),    # created | cancelled
    Column("subtotal", Float),
    Column("discount", Float),
    Column("total", Float),
    Column("created_at", DateTime, server_default=func.now()),
)

order_items = Table(
    "order_items", _metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("order_id", String, nullable=False),
    Column("product_id", String, nullable=False),
    Column("product_name", String, nullable=False),
    Column("quantity", Integer, nullable=False),
    Column("unit_price", Float, nullable=False),
    Column("subtotal", Float, nullable=False),
)


def init_order_tables():
    _metadata.create_all(engine)


def create_order(thread_id: str, items: list[dict], price_details: dict) -> str:
    """
    建立訂單並寫入 DB，回傳訂單 ID。

    Args:
        thread_id: LangGraph thread_id（= conversation_id）
        items: 已確認的品項列表
        price_details: 計算後的價格詳情

    Returns:
        order_id: 新建立的訂單 ID（格式：ORD-xxxxxxxx）
    """
    order_id = f"ORD-{uuid.uuid4().hex[:8].upper()}"

    with engine.connect() as conn:
        conn.execute(insert(orders).values(
            id=order_id,
            thread_id=thread_id,
            status="created",
            subtotal=price_details["subtotal"],
            discount=price_details["discount"],
            total=price_details["total"],
        ))
        for item in price_details["items"]:
            conn.execute(insert(order_items).values(
                order_id=order_id,
                product_id=item["product_id"],
                product_name=item["name"],
                quantity=item["quantity"],
                unit_price=item["unit_price"],
                subtotal=item["subtotal"],
            ))
        conn.commit()

    return order_id
