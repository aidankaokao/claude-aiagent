"""
database.py — SQLAlchemy Core 資料表定義

技能定義已改為 SKILL.md 檔案式，不再存入資料庫。
資料庫只保留對話相關記錄：conversations、messages、ratings。
"""

import os
from datetime import datetime, timezone
from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    Integer, String, Text, Boolean, Float, DateTime, ForeignKey,
)
from config import settings

os.makedirs(os.path.dirname(settings.db_path), exist_ok=True)
engine = create_engine(f"sqlite:///{settings.db_path}", connect_args={"check_same_thread": False})
metadata = MetaData()

# ── 對話主表 ──
conversations = Table("conversations", metadata,
    Column("id", String(100), primary_key=True),
    Column("title", String(200), nullable=False, default="新對話"),
    Column("created_at", DateTime, nullable=False,
           default=lambda: datetime.now(timezone.utc)),
    Column("updated_at", DateTime, nullable=False,
           default=lambda: datetime.now(timezone.utc)),
)

# ── 訊息（含技能記錄）──
messages = Table("messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String(100), ForeignKey("conversations.id"), nullable=False),
    Column("role", String(20), nullable=False),          # "user" | "assistant"
    Column("content", Text, nullable=False),
    Column("skill_name", String(50), nullable=True),     # 本次使用的技能（assistant 才有）
    Column("created_at", DateTime, nullable=False,
           default=lambda: datetime.now(timezone.utc)),
)

# ── 評分 ──
ratings = Table("ratings", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("message_id", Integer, ForeignKey("messages.id"), nullable=False),
    Column("conversation_id", String(100), nullable=False),
    Column("skill_name", String(50), nullable=False),
    Column("rating", Integer, nullable=False),           # 1-5
    Column("feedback", Text, nullable=True),
    Column("created_at", DateTime, nullable=False,
           default=lambda: datetime.now(timezone.utc)),
)


def init_db():
    metadata.create_all(engine)
