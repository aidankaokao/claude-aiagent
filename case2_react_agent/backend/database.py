"""
資料庫模組 — SQLAlchemy Core

資料表：
- conversations : 對話記錄（每個對話的標題與時間）
- messages      : 每則訊息（user / assistant 的文字內容）
- tool_calls    : 每次工具呼叫記錄（與 conversation_id 關聯）

使用 SQLAlchemy Core（Table + MetaData），不使用 ORM，
方便未來遷移至 PostgreSQL。
"""

import os
from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    String, Text, Integer, DateTime, ForeignKey
)
from sqlalchemy.sql import func
from config import settings

# 確保資料庫目錄存在（例如 data/）
os.makedirs(os.path.dirname(settings.db_path) if os.path.dirname(settings.db_path) else ".", exist_ok=True)

# 建立 SQLite 引擎
# check_same_thread=False：允許多個執行緒共用同一個連線（FastAPI 非同步環境需要）
engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},
    echo=False,
)

# MetaData 用來統一管理所有資料表定義
metadata = MetaData()

# 對話表：記錄每個對話的 ID 與標題
conversations = Table(
    "conversations", metadata,
    Column("id", String(36), primary_key=True),           # UUID 字串
    Column("title", String(200), nullable=True),           # 對話標題（取自第一則訊息前 50 字）
    Column("created_at", DateTime, server_default=func.now()),
    Column("updated_at", DateTime, server_default=func.now(), onupdate=func.now()),
)

# 訊息表：記錄每則對話內的訊息，role 為 "user" 或 "assistant"
messages = Table(
    "messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String(36), ForeignKey("conversations.id"), nullable=False),
    Column("role", String(20), nullable=False),            # "user" 或 "assistant"
    Column("content", Text, nullable=False),               # 訊息文字內容
    Column("created_at", DateTime, server_default=func.now()),
)

# 工具呼叫記錄表（Case 2 新增）
# run_id 是 LangGraph 為每次工具呼叫產生的唯一識別碼，
# 前端透過 run_id 來對應 tool_start / tool_end 事件，
# 更新同一筆工具呼叫的輸出結果。
tool_calls = Table(
    "tool_calls", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String(36), ForeignKey("conversations.id"), nullable=False),
    Column("run_id", String(36), nullable=False),          # LangGraph 產生的執行 ID
    Column("tool_name", String(100), nullable=False),      # 工具名稱（如 web_search）
    Column("tool_input", Text, nullable=True),             # 工具輸入參數（JSON 字串）
    Column("tool_output", Text, nullable=True),            # 工具回傳結果（tool_end 時更新）
    Column("created_at", DateTime, server_default=func.now()),
)


def init_db():
    """建立所有尚未存在的資料表（不會覆蓋已有資料）"""
    metadata.create_all(engine)
    print("[DB] 資料表初始化完成")
