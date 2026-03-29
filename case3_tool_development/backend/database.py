"""
資料庫模組 — SQLAlchemy Core

資料表：
- products      : 庫存產品（名稱、分類、數量、安全庫存、單價）
- stock_changes : 每次庫存異動記錄（由 update_stock 工具寫入）
- conversations : 對話記錄
- messages      : 每則訊息（user / assistant）
- tool_calls    : 每次工具呼叫記錄

使用 SQLAlchemy Core（Table + MetaData），不使用 ORM，
方便未來遷移至 PostgreSQL。
"""

import os
from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    String, Text, Integer, Float, DateTime, ForeignKey
)
from sqlalchemy.sql import func
from config import settings

# 確保資料庫目錄存在
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

# 產品庫存表
products = Table(
    "products", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", String(200), nullable=False),         # 產品名稱
    Column("category", String(50), nullable=False),      # 分類：電子產品/文具/食品/服飾/家居
    Column("quantity", Integer, nullable=False, default=0),    # 目前庫存數量
    Column("min_stock", Integer, nullable=False, default=10),  # 安全庫存（低於此值須補貨）
    Column("unit_price", Float, nullable=False, default=0.0),  # 單價（新台幣）
    Column("created_at", DateTime, server_default=func.now()),
    Column("updated_at", DateTime, server_default=func.now(), onupdate=func.now()),
)

# 庫存異動記錄表
# 每次 update_stock 工具執行時寫入一筆，保留完整的異動歷史
stock_changes = Table(
    "stock_changes", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("product_id", Integer, ForeignKey("products.id"), nullable=False),
    Column("change_amount", Integer, nullable=False),           # 正數=入庫，負數=出庫
    Column("quantity_before", Integer, nullable=False),         # 異動前數量
    Column("quantity_after", Integer, nullable=False),          # 異動後數量
    Column("reason", String(300), nullable=True),               # 異動原因（由 LLM 或工具提供）
    Column("created_at", DateTime, server_default=func.now()),
)

# 對話表：記錄每個對話的 ID 與標題
conversations = Table(
    "conversations", metadata,
    Column("id", String(36), primary_key=True),
    Column("title", String(200), nullable=True),
    Column("created_at", DateTime, server_default=func.now()),
    Column("updated_at", DateTime, server_default=func.now(), onupdate=func.now()),
)

# 訊息表：記錄每則對話內的訊息
messages = Table(
    "messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String(36), ForeignKey("conversations.id"), nullable=False),
    Column("role", String(20), nullable=False),     # "user" 或 "assistant"
    Column("content", Text, nullable=False),
    Column("created_at", DateTime, server_default=func.now()),
)

# 工具呼叫記錄表
# run_id 是 LangGraph 為每次工具呼叫產生的唯一識別碼
tool_calls = Table(
    "tool_calls", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("conversation_id", String(36), ForeignKey("conversations.id"), nullable=False),
    Column("run_id", String(36), nullable=False),
    Column("tool_name", String(100), nullable=False),
    Column("tool_input", Text, nullable=True),      # JSON 字串
    Column("tool_output", Text, nullable=True),     # 工具回傳結果（tool_end 時更新）
    Column("created_at", DateTime, server_default=func.now()),
)


def init_db():
    """建立所有尚未存在的資料表（不會覆蓋已有資料）"""
    metadata.create_all(engine)
    print("[DB] 資料表初始化完成")
