"""
環境變數設定 — Case 5: Map-Reduce Agent
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_path: str = "data/case5.db"
    cors_origins: str = "*"
    backend_host: str = "0.0.0.0"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
