"""
環境變數設定 — Case 6: Human-in-the-Loop
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_path: str = "data/case6.db"
    checkpoint_db_path: str = "data/checkpoints.db"
    cors_origins: str = "*"
    backend_host: str = "0.0.0.0"
    approval_threshold: float = 0.0  # 訂單金額超過此值需人工審批（0 = 所有訂單皆需審批）

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
