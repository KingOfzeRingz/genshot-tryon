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
    GCP_PROJECT_ID: str = "genshot-studio"
    GCS_BUCKET: str = "genshot-tryon-mobile"
    FIRESTORE_DATABASE: str = "genshot-tryon-mobile"
    FIREBASE_CREDENTIALS_PATH: str = ""
    VERTEX_LOCATION: str = "global"
    CORE_IMAGE_MODELS: List[str] = [
        "gemini-3-pro-image-preview",
    ]
    TRYON_IMAGE_MODELS: List[str] = [
        "gemini-3-pro-image-preview",
    ]

    # --- Auth / Security -----------------------------------------------
    HMAC_SECRET: str = "hackathon-secret"

    # --- CORS -----------------------------------------------------------
    CORS_ORIGINS: List[str] = ["*"]

    # --- Misc -----------------------------------------------------------
    LOG_LEVEL: str = "INFO"

    def model_post_init(self, __context: object) -> None:  # noqa: D401
        """Handle JSON-encoded CORS_ORIGINS (e.g. from .env files)."""
        object.__setattr__(self, "CORS_ORIGINS", _parse_list_field(self.CORS_ORIGINS))
        object.__setattr__(self, "CORE_IMAGE_MODELS", _parse_list_field(self.CORE_IMAGE_MODELS))
        object.__setattr__(self, "TRYON_IMAGE_MODELS", _parse_list_field(self.TRYON_IMAGE_MODELS))


@lru_cache
def get_settings() -> Settings:
    """Return a cached ``Settings`` singleton."""
    return Settings()


def _parse_list_field(value: object) -> List[str]:
    """Parse list-like env values from JSON arrays, CSV, or single strings."""
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]

    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(v).strip() for v in parsed if str(v).strip()]
        except (json.JSONDecodeError, TypeError):
            pass

        csv_values = [part.strip() for part in value.split(",") if part.strip()]
        return csv_values or [value]

    return []
