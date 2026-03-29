"""
資料庫設定 — Case 4: Plan-Execute Agent

資料表：
  trips      — 旅行規劃記錄（每次對話對應一筆，含規劃步驟 JSON）
  trip_steps — 各步驟的執行結果（供歷史查詢）
  conversations — 對話列表（與前幾個 Case 一致）
  messages      — 對話訊息

Case 4 學習重點：
  Plan-Execute 會產生「結構化計劃」，適合存成 JSON 欄位，
  以便前端可以重新載入歷史對話並還原 PlanTimeline 狀態。
"""

from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    Integer, String, Text, DateTime, ForeignKey
)
from sqlalchemy.sql import func

from config import settings

# SQLite 引擎（check_same_thread=False 允許 FastAPI 的多執行緒存取）
engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},
)

metadata = MetaData()

# 對話主表
conversations = Table(
    "conversations", metadata,
    Column("id", String, primary_key=True),
    Column("title", String),
    Column("created_at", DateTime, server_default=func.now()),
    Column("updated_at", DateTime, server_default=func.now(), onupdate=func.now()),
)

# 對話訊息
messages = Table(
    "messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String, ForeignKey("conversations.id")),
    Column("role", String),           # "user" | "assistant"
    Column("content", Text),
    Column("plan_json", Text),        # JSON 字串：本則訊息對應的規劃步驟（僅 assistant 有）
    Column("created_at", DateTime, server_default=func.now()),
)

# 旅行規劃記錄
trips = Table(
    "trips", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String, ForeignKey("conversations.id")),
    Column("destination", String),
    Column("duration_days", Integer),
    Column("user_request", Text),
    Column("plan_json", Text),        # JSON list of step strings
    Column("status", String, default="in_progress"),  # in_progress | completed
    Column("created_at", DateTime, server_default=func.now()),
)

# 步驟執行結果
trip_steps = Table(
    "trip_steps", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("trip_id", Integer, ForeignKey("trips.id")),
    Column("step_index", Integer),
    Column("step_text", Text),
    Column("result", Text),
    Column("status", String, default="done"),   # done | failed
    Column("created_at", DateTime, server_default=func.now()),
)


def init_db():
    """啟動時自動建立所有資料表（已存在則跳過）"""
    import os
    os.makedirs(os.path.dirname(settings.db_path), exist_ok=True)
    metadata.create_all(engine)
    print("[DB] 資料庫初始化完成")
