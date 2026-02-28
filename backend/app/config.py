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

    List-like fields (CORS_ORIGINS, CORE_IMAGE_MODELS, TRYON_IMAGE_MODELS) are
    declared as ``str`` so that pydantic-settings accepts any format — JSON
    arrays, comma-separated values, or a single value.  They are parsed into
    real ``List[str]`` in ``model_post_init``.
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
    VERTEX_IMAGE_LOCATION: str = "global"

    # Stored as raw strings; parsed into List[str] in model_post_init.
    CORE_IMAGE_MODELS: str = '["gemini-2.5-flash-image", "gemini-3-pro-image-preview"]'
    TRYON_IMAGE_MODELS: str = ""

    # --- REVE API (core image generation) ---------------------------------
    REVE_API_KEY: str = ""
    REVE_API_URL: str = "https://api.reve.com/v1/image/remix"
    REVE_REMIX_VERSION: str = "latest"
    REVE_REMIX_ASPECT_RATIO: str = "2:3"
    REVE_TEST_TIME_SCALING: float = 1.0

    # --- Auth / Security -----------------------------------------------
    HMAC_SECRET: str = "hackathon-secret"

    # --- CORS -----------------------------------------------------------
    CORS_ORIGINS: str = '["*"]'

    # --- Misc -----------------------------------------------------------
    LOG_LEVEL: str = "INFO"

    # ── Parsed list fields (populated in model_post_init) ─────────────
    _cors_origins_list: List[str] = []
    _core_image_models_list: List[str] = []
    _tryon_image_models_list: List[str] = []

    def model_post_init(self, __context: object) -> None:  # noqa: D401
        """Parse list-like string fields into real lists."""
        object.__setattr__(self, "_cors_origins_list", _parse_list_field(self.CORS_ORIGINS))
        object.__setattr__(self, "_core_image_models_list", _parse_list_field(self.CORE_IMAGE_MODELS))
        object.__setattr__(self, "_tryon_image_models_list", _parse_list_field(self.TRYON_IMAGE_MODELS))
        object.__setattr__(self, "VERTEX_LOCATION", self.VERTEX_LOCATION.strip() or "global")
        object.__setattr__(self, "VERTEX_IMAGE_LOCATION", self.VERTEX_IMAGE_LOCATION.strip() or "global")

    @property
    def cors_origins(self) -> List[str]:
        return self._cors_origins_list

    @property
    def core_image_models(self) -> List[str]:
        return self._core_image_models_list

    @property
    def tryon_image_models(self) -> List[str]:
        return self._tryon_image_models_list

    def validate_runtime(self) -> None:
        """Validate required runtime settings."""
        if not self.tryon_image_models:
            raise ValueError(
                "TRYON_IMAGE_MODELS is required and must contain at least one model id."
            )

    def log_runtime_configuration(self) -> None:
        """Log effective model + region configuration on startup."""
        logger.info(
            "Image generation config: project=%s, vertex_location=%s, vertex_image_location=%s, "
            "core_models=%s, tryon_models=%s, reve_version=%s, reve_configured=%s",
            self.GCP_PROJECT_ID,
            self.VERTEX_LOCATION,
            self.VERTEX_IMAGE_LOCATION,
            self.core_image_models,
            self.tryon_image_models,
            self.REVE_REMIX_VERSION,
            bool(self.REVE_API_KEY),
        )


@lru_cache
def get_settings() -> Settings:
    """Return a cached ``Settings`` singleton."""
    return Settings()


def _parse_list_field(value: object) -> List[str]:
    """Parse list-like env values from JSON arrays, CSV, or single strings."""
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]

    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(v).strip() for v in parsed if str(v).strip()]
        except (json.JSONDecodeError, TypeError):
            pass

        csv_values = [part.strip() for part in stripped.split(",") if part.strip()]
        return csv_values or [stripped]

    return []
