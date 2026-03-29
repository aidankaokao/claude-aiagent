"""
環境變數設定 — Case 4: Plan-Execute Agent

使用 pydantic-settings 自動讀取 .env 檔案。
extra = "ignore"：忽略 .env 中 Settings 未定義的欄位（如 DEVELOPER_NAME）。
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_path: str = "data/travel.db"
    cors_origins: str = "*"
    backend_host: str = "0.0.0.0"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
