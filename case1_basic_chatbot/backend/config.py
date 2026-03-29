"""
設定模組 — 從 .env 載入環境變數

學習重點：
- API Key 不存在此處，由前端在每次請求時傳入
- .env 只放伺服器本身的設定（port、DB 路徑等）
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # --- 伺服器設定（本地固定 8000，BACKEND_PORT 只供 docker-compose port mapping 使用）---
    backend_host: str = "0.0.0.0"

    # --- 資料庫設定 ---
    db_path: str = "data/chatbot.db"

    # --- CORS 設定 ---
    cors_origins: str = "*"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # 忽略 .env 中多餘的欄位，避免升級/遷移時報錯


settings = Settings()
