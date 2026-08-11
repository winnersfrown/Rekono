import secrets
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

    # JWT signing secret. Leave unset to auto-generate and persist one on
    # first run (see _load_or_create_secret_key below) -- fine for a single
    # self-hosted instance, but set SECRET_KEY explicitly for any deployment
    # with more than one app instance/replica, since each would otherwise
    # mint its own secret and reject the others' tokens.
    secret_key: str = ""
    access_token_expire_minutes: int = 60 * 24 * 14  # 14 days


def _load_or_create_secret_key(storage_dir: str) -> str:
    path = Path(storage_dir).parent / ".rekono_secret_key"
    if path.exists():
        return path.read_text().strip()
    key = secrets.token_hex(32)
    path.write_text(key)
    return key


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    Path(settings.storage_dir).mkdir(parents=True, exist_ok=True)
    if not settings.secret_key:
        settings.secret_key = _load_or_create_secret_key(settings.storage_dir)
    return settings
