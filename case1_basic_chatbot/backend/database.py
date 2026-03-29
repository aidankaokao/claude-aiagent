"""
資料庫模組 — SQLAlchemy Core 定義表結構與連線

學習重點：
- 使用 SQLAlchemy Core（非 ORM）定義資料表
- MetaData + Table 物件建立 schema
- create_all() 自動建表（若不存在）
- 所有查詢使用 connection.execute()，不使用 Session/ORM
- 欄位設計考慮日後遷移至 PostgreSQL 的相容性

資料表：
- conversations: 對話記錄（每次對話一筆）
- messages: 訊息記錄（每則訊息一筆，關聯 conversation_id）
"""

import os
from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    String, Text, Integer, DateTime, ForeignKey
)
from sqlalchemy.sql import func
from config import settings


# --- 建立 Engine ---
# SQLite 連線字串格式：sqlite:///相對路徑 或 sqlite:////絕對路徑
# check_same_thread=False 允許多執行緒存取（FastAPI 需要）
os.makedirs(os.path.dirname(settings.db_path) if os.path.dirname(settings.db_path) else ".", exist_ok=True)
engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},  # SQLite 專用，Postgres 不需要
    echo=False  # 設為 True 可印出所有 SQL（除錯用）
)

# --- 定義 MetaData ---
metadata = MetaData()

# --- 定義資料表 ---

# 對話表：每次「新對話」建立一筆
conversations = Table(
    "conversations", metadata,
    Column("id", String(36), primary_key=True),          # UUID 字串
    Column("title", String(200), nullable=True),          # 對話標題（可由第一則訊息自動生成）
    Column("created_at", DateTime, server_default=func.now()),
    Column("updated_at", DateTime, server_default=func.now(), onupdate=func.now()),
)

# 訊息表：每則使用者/助手訊息一筆
messages = Table(
    "messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String(36), ForeignKey("conversations.id"), nullable=False),
    Column("role", String(20), nullable=False),           # "user" 或 "assistant"
    Column("content", Text, nullable=False),              # 訊息內容
    Column("created_at", DateTime, server_default=func.now()),
)


def init_db():
    """建立所有資料表（若不存在則建立，已存在則跳過）"""
    metadata.create_all(engine)
    print("[DB] 資料表初始化完成")
