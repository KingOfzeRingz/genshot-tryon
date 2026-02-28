"""Application configuration loaded from environment variables."""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Central application settings.

    Values are loaded from environment variables or a ``.env`` file located in
    the project root (``backend/.env``).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Google Cloud --------------------------------------------------
    GCP_PROJECT_ID: str = "genshot-tryon"
    GCS_BUCKET: str = "genshot-tryon-assets"
    FIREBASE_CREDENTIALS_PATH: str = ""
    VERTEX_LOCATION: str = "us-central1"

    # --- Auth / Security -----------------------------------------------
    HMAC_SECRET: str = "hackathon-secret"

    # --- CORS -----------------------------------------------------------
    CORS_ORIGINS: List[str] = ["*"]

    # --- Misc -----------------------------------------------------------
    LOG_LEVEL: str = "INFO"

    def model_post_init(self, __context: object) -> None:  # noqa: D401
        """Handle JSON-encoded CORS_ORIGINS (e.g. from .env files)."""
        if isinstance(self.CORS_ORIGINS, str):
            try:
                parsed = json.loads(self.CORS_ORIGINS)
                if isinstance(parsed, list):
                    object.__setattr__(self, "CORS_ORIGINS", parsed)
            except (json.JSONDecodeError, TypeError):
                object.__setattr__(self, "CORS_ORIGINS", [self.CORS_ORIGINS])


@lru_cache
def get_settings() -> Settings:
    """Return a cached ``Settings`` singleton."""
    return Settings()
