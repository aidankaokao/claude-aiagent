from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path

BASE_DIR = Path(__file__).parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", extra="ignore")

    db_path: str = str(BASE_DIR / "data" / "case7.db")
    cors_origins: str = "*"
    backend_host: str = "0.0.0.0"
    backend_port: int = 8000
    log_level: str = "INFO"

    # 前端 port（僅供 docker-compose port mapping 使用）
    frontend_port: int = 5173


settings = Settings()
