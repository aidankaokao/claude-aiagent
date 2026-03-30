"""
設定模組 — 從 .env 載入環境變數（Case 10）

注意：API Key 不在此設定，由前端使用者填入後隨每次請求傳入。
extra = "ignore" 確保 .env 中有多餘欄位時不會拋出 ValidationError。
"""

from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    backend_host: str = "0.0.0.0"
    conv_db_path: str = str(Path(__file__).parent.parent / "data" / "case10.db")
    cors_origins: str = "*"
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()
