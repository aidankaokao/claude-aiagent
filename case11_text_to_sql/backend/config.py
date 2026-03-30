"""
config.py — Case 11: Text-to-SQL Agent
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    backend_host: str = "0.0.0.0"
    cors_origins: str = "http://localhost:5173"

    # PostgreSQL 連線字串
    # Docker 環境：使用容器名稱 case11-postgres
    # 本地開發：改為 localhost
    postgres_url: str = "postgresql+psycopg://appuser:inv_secure_2024@case11-postgres:5432/inventorydb"

    # 資料庫 Schema（不使用 public）
    db_schema: str = "inventory"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
