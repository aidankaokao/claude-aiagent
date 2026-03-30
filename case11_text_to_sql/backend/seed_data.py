"""
seed_data.py — 將 seed_data.json 寫入 PostgreSQL（Case 11）

使用方式：
  python seed_data.py
  python seed_data.py --postgres-url postgresql://user:pass@localhost:5432/inventorydb

注意：
  - 使用 SQLAlchemy Core（非 ORM）
  - 執行前會清空並重建所有資料表
  - seed_data.json 須位於同目錄
"""

import argparse
import json
import sys
from pathlib import Path

from sqlalchemy import create_engine, text, MetaData, insert

# ── 解析命令列參數 ────────────────────────────────────────────

def _normalize_url(url: str) -> str:
    """確保連線字串使用 psycopg3 dialect（postgresql+psycopg://）"""
    if url.startswith("postgresql://") or url.startswith("postgres://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1).replace("postgres://", "postgresql+psycopg://", 1)
    return url


def parse_args():
    parser = argparse.ArgumentParser(description="Seed data for Case 11")
    parser.add_argument(
        "--postgres-url",
        default=None,
        help="PostgreSQL 連線字串（預設從 config.py 讀取）",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    # 載入設定
    if args.postgres_url:
        postgres_url = _normalize_url(args.postgres_url)
    else:
        from config import settings
        postgres_url = settings.postgres_url

    print(f"[Seed] 連線至 PostgreSQL...")
    engine = create_engine(postgres_url, echo=False)

    # 載入 seed_data.json
    seed_file = Path(__file__).parent / "seed_data.json"
    if not seed_file.exists():
        print(f"[Seed] 錯誤：找不到 {seed_file}", file=sys.stderr)
        sys.exit(1)

    with open(seed_file, encoding="utf-8") as f:
        seed = json.load(f)

    # 建立 schema
    from config import settings as _settings
    db_schema = _settings.db_schema if not args.postgres_url else "inventory"

    with engine.connect() as conn:
        conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {db_schema}"))
        conn.commit()
    print(f"[Seed] Schema '{db_schema}' 已確認")

    # 載入資料表定義
    from database import metadata, products, stock_changes, daily_snapshots, init_db
    init_db()

    # 清空資料（依外鍵順序）
    with engine.connect() as conn:
        conn.execute(text(f"TRUNCATE TABLE {db_schema}.daily_snapshots RESTART IDENTITY CASCADE"))
        conn.execute(text(f"TRUNCATE TABLE {db_schema}.stock_changes RESTART IDENTITY CASCADE"))
        conn.execute(text(f"TRUNCATE TABLE {db_schema}.products RESTART IDENTITY CASCADE"))
        conn.commit()
    print("[Seed] 舊資料已清除")

    # 插入 products
    products_data = seed.get("products", [])
    if products_data:
        with engine.connect() as conn:
            conn.execute(insert(products), products_data)
            conn.commit()
        print(f"[Seed] products: 插入 {len(products_data)} 筆")

    # 插入 stock_changes
    changes_data = seed.get("stock_changes", [])
    if changes_data:
        with engine.connect() as conn:
            conn.execute(insert(stock_changes), changes_data)
            conn.commit()
        print(f"[Seed] stock_changes: 插入 {len(changes_data)} 筆")

    # 插入 daily_snapshots
    snapshots_data = seed.get("daily_snapshots", [])
    if snapshots_data:
        # 分批插入，避免單次 SQL 太大
        batch_size = 100
        total = 0
        with engine.connect() as conn:
            for i in range(0, len(snapshots_data), batch_size):
                batch = snapshots_data[i:i + batch_size]
                conn.execute(insert(daily_snapshots), batch)
                total += len(batch)
            conn.commit()
        print(f"[Seed] daily_snapshots: 插入 {total} 筆")

    print("[Seed] 完成！")


if __name__ == "__main__":
    main()
