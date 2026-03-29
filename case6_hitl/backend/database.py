"""
資料庫設定 — Case 6: Human-in-the-Loop

資料表：
  products          — 商品目錄（名稱、類別、價格、庫存）
  conversations     — 對話記錄
  messages          — 訊息記錄
  pending_approvals — 等待人工審批的訂單（interrupt 後寫入）
"""

import json
import os
from sqlalchemy import create_engine, MetaData, Table, Column, Integer, String, Float, Text, DateTime
from sqlalchemy.sql import func

from config import settings

DB_PATH = settings.db_path
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)
metadata = MetaData()

products = Table(
    "products", metadata,
    Column("id", String, primary_key=True),
    Column("name", String, nullable=False),
    Column("category", String, nullable=False),
    Column("price", Float, nullable=False),
    Column("stock", Integer, nullable=False),
    Column("created_at", DateTime, server_default=func.now()),
)

conversations = Table(
    "conversations", metadata,
    Column("id", String, primary_key=True),
    Column("title", String),
    Column("created_at", DateTime, server_default=func.now()),
    Column("updated_at", DateTime, server_default=func.now(), onupdate=func.now()),
)

messages = Table(
    "messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String, nullable=False),
    Column("role", String, nullable=False),
    Column("content", Text, nullable=False),
    Column("created_at", DateTime, server_default=func.now()),
)

pending_approvals = Table(
    "pending_approvals", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("thread_id", String, nullable=False, unique=True),   # = conversation_id
    Column("items_json", Text, nullable=False),                  # JSON: parsed_items
    Column("price_json", Text, nullable=False),                  # JSON: price_details
    Column("threshold", Float, nullable=False),
    Column("status", String, nullable=False, default="pending"), # pending | approved | rejected
    Column("created_at", DateTime, server_default=func.now()),
    Column("decided_at", DateTime, nullable=True),
)


def init_db():
    metadata.create_all(engine)


def save_pending_approval(thread_id: str, items: list, price_details: dict, threshold: float):
    """儲存待審批訂單（圖 interrupt 後由 api.py 呼叫）"""
    with engine.connect() as conn:
        # upsert: 若已存在則更新
        existing = conn.execute(
            pending_approvals.select().where(pending_approvals.c.thread_id == thread_id)
        ).fetchone()
        if existing:
            conn.execute(
                pending_approvals.update()
                .where(pending_approvals.c.thread_id == thread_id)
                .values(
                    items_json=json.dumps(items, ensure_ascii=False),
                    price_json=json.dumps(price_details, ensure_ascii=False),
                    threshold=threshold,
                    status="pending",
                )
            )
        else:
            conn.execute(
                pending_approvals.insert().values(
                    thread_id=thread_id,
                    items_json=json.dumps(items, ensure_ascii=False),
                    price_json=json.dumps(price_details, ensure_ascii=False),
                    threshold=threshold,
                    status="pending",
                )
            )
        conn.commit()


def update_approval_status(thread_id: str, status: str):
    """審批決定後更新狀態（approved / rejected）"""
    with engine.connect() as conn:
        conn.execute(
            pending_approvals.update()
            .where(pending_approvals.c.thread_id == thread_id)
            .values(status=status, decided_at=func.now())
        )
        conn.commit()


def get_pending_approvals() -> list[dict]:
    """取得所有 pending 狀態的待審批訂單"""
    with engine.connect() as conn:
        rows = conn.execute(
            pending_approvals.select()
            .where(pending_approvals.c.status == "pending")
            .order_by(pending_approvals.c.created_at)
        ).fetchall()
    return [
        {
            "thread_id": r.thread_id,
            "items": json.loads(r.items_json),
            "price_details": json.loads(r.price_json),
            "threshold": r.threshold,
            "created_at": str(r.created_at),
        }
        for r in rows
    ]
