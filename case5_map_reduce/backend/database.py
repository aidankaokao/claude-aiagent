"""
資料庫設定 — Case 5: Map-Reduce Agent

資料表：
  documents     — 待分析的公司報告文件
  conversations — 對話記錄
  messages      — 訊息記錄（使用者查詢 + 最終報告）
"""

import os
from sqlalchemy import create_engine, MetaData, Table, Column, Integer, String, Text, DateTime
from sqlalchemy.sql import func

from config import settings

DB_PATH = settings.db_path
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)
metadata = MetaData()

documents = Table(
    "documents", metadata,
    Column("id", String, primary_key=True),
    Column("title", String, nullable=False),
    Column("content", Text, nullable=False),
    Column("category", String, nullable=False),
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


def init_db():
    metadata.create_all(engine)
