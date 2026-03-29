"""
設定模組 — 從 .env 檔案載入環境變數

與前面 Case 的差異：
- kb_db_path   : 知識庫資料庫路徑（mcp_server 使用）
- conv_db_path : 對話記錄資料庫路徑（backend 使用）
- mcp_server_path : MCP Server 腳本路徑（自動解析為 mcp_server/server.py 的絕對路徑）

注意：API Key 不在此設定，由前端使用者填入後隨每次請求傳入後端。
extra = "ignore" 確保 .env 中有多餘欄位時不會拋出 ValidationError。
"""

from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    backend_host: str = "0.0.0.0"
    # 知識庫資料庫（由 mcp_server 讀寫；backend 亦直接讀取用於 /api/articles 側邊欄端點）
    # 使用絕對路徑，確保不論從哪個目錄啟動後端都能正確找到資料庫
    kb_db_path: str = str(Path(__file__).parent.parent / "data" / "kb.db")
    # 對話記錄資料庫（僅 backend 使用）
    conv_db_path: str = str(Path(__file__).parent.parent / "data" / "case8.db")
    # MCP Server 腳本的絕對路徑
    # 預設自動解析為本檔案所在目錄（backend/）的上一層目錄（case8_mcp_server/）下的 mcp_server/server.py
    mcp_server_path: str = str(
        Path(__file__).parent.parent / "mcp_server" / "server.py"
    )
    cors_origins: str = "*"
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # 忽略 .env 中未定義的欄位，避免驗證錯誤


# 全域單例，其他模組直接 import 使用
settings = Settings()
