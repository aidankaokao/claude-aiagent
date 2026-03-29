"""
設定模組 — 從 .env 檔案載入環境變數

注意：API Key 不在此設定，由前端使用者填入後隨每次請求傳入後端。
extra = "ignore" 確保 .env 中有多餘欄位時不會拋出 ValidationError。
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    backend_host: str = "0.0.0.0"              # 後端監聽的 host（容器內固定用 0.0.0.0）
    db_path: str = "data/inventory.db"         # SQLite 資料庫路徑（相對於執行目錄）
    cors_origins: str = "*"                     # 允許的 CORS 來源，多個來源以逗號分隔

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"                        # 忽略 .env 中未定義的欄位，避免驗證錯誤


# 全域單例，其他模組直接 import 使用
settings = Settings()
