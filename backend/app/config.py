from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./rekono.db"
    storage_dir: str = "./storage"

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-5"

    review_confidence_threshold: float = 0.85

    match_amount_tolerance_pct: float = 0.02
    match_amount_tolerance_abs: float = 5.00
    match_date_window_days: int = 5
    match_vendor_score_threshold: float = 80.0


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    Path(settings.storage_dir).mkdir(parents=True, exist_ok=True)
    return settings
