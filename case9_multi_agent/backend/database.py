"""
資料庫模組 — SQLAlchemy Core（Case 9）

資料表（存於 case9.db）：
- conversations : 對話記錄（ID、標題、時間）
- messages      : 訊息（user / assistant）

使用 SQLAlchemy Core（非 ORM），設計時考慮 PostgreSQL 相容性。
"""

import os
from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    String, Text, Integer, DateTime, ForeignKey
)
from sqlalchemy.sql import func
from config import settings

os.makedirs(
    os.path.dirname(settings.conv_db_path) if os.path.dirname(settings.conv_db_path) else ".",
    exist_ok=True,
)

engine = create_engine(
    f"sqlite:///{settings.conv_db_path}",
    connect_args={"check_same_thread": False},
    echo=False,
)

metadata = MetaData()

conversations = Table(
    "conversations", metadata,
    Column("id", String(36), primary_key=True),
    Column("title", String(200), nullable=True),
    Column("created_at", DateTime, server_default=func.now()),
    Column("updated_at", DateTime, server_default=func.now(), onupdate=func.now()),
)

messages = Table(
    "messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String(36), ForeignKey("conversations.id"), nullable=False),
    Column("role", String(20), nullable=False),
    Column("content", Text, nullable=False),
    Column("created_at", DateTime, server_default=func.now()),
)


def init_db() -> None:
    """建立所有尚未存在的資料表"""
    metadata.create_all(engine)
    print("[DB] 對話資料表初始化完成")
