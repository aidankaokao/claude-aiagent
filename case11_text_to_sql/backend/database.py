"""
database.py — Case 11: Text-to-SQL Agent

PostgreSQL + SQLAlchemy Core（非 ORM）
Schema: inventory（不使用 public）
Tables:
  - inventory.products          產品主檔
  - inventory.stock_changes     庫存異動記錄
  - inventory.daily_snapshots   每日庫存快照（用於歷史趨勢查詢）
"""

from sqlalchemy import (
    Column, Integer, Numeric, String, Text, Date, DateTime,
    ForeignKey, MetaData, Table, create_engine, func, text,
)

from config import settings

# ── Engine ────────────────────────────────────────────────────
engine = create_engine(settings.postgres_url, echo=False)

# ── Metadata（指定 schema，所有表名自動加前綴）────────────────
metadata = MetaData(schema=settings.db_schema)

# ── 產品主檔 ─────────────────────────────────────────────────
products = Table(
    "products", metadata,
    Column("id",            Integer,       primary_key=True, autoincrement=True),
    Column("name",          String(200),   nullable=False),
    Column("category",      String(100),   nullable=False),   # 電子產品 / 辦公用品 / 家具
    Column("unit",          String(20),    nullable=False),   # 台/個/令/箱/套
    Column("min_stock",     Integer,       nullable=False, default=0),
    Column("current_stock", Integer,       nullable=False, default=0),
    Column("unit_price",    Numeric(12, 2), nullable=False, default=0),
    Column("created_at",    DateTime,      server_default=func.now()),
)

# ── 庫存異動記錄 ──────────────────────────────────────────────
stock_changes = Table(
    "stock_changes", metadata,
    Column("id",          Integer,     primary_key=True, autoincrement=True),
    Column("product_id",  Integer,     ForeignKey(f"{settings.db_schema}.products.id"), nullable=False),
    Column("change_type", String(20),  nullable=False),   # in / out / adjustment
    Column("quantity",    Integer,     nullable=False),   # 正整數
    Column("note",        Text,        nullable=True),
    Column("created_at",  DateTime,    server_default=func.now()),
)

# ── 每日庫存快照 ──────────────────────────────────────────────
daily_snapshots = Table(
    "daily_snapshots", metadata,
    Column("id",            Integer,  primary_key=True, autoincrement=True),
    Column("product_id",    Integer,  ForeignKey(f"{settings.db_schema}.products.id"), nullable=False),
    Column("snapshot_date", Date,     nullable=False),
    Column("quantity",      Integer,  nullable=False),
    Column("min_stock",     Integer,  nullable=False),
)


def init_db():
    """建立 schema 與所有資料表（若不存在則建立）"""
    with engine.connect() as conn:
        conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {settings.db_schema}"))
        conn.commit()
    metadata.create_all(engine)
    print(f"[DB] Schema '{settings.db_schema}' 與資料表初始化完成")
