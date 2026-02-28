"""FastAPI application entry point for GenShot Virtual Try-On."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import firebase_admin
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings

logger = logging.getLogger(__name__)


def _init_firebase() -> None:
    """Initialise the Firebase Admin SDK (idempotent).

    Uses Application Default Credentials when ``FIREBASE_CREDENTIALS_PATH``
    is empty; otherwise loads the service-account JSON file.
    """
    if firebase_admin._apps:
        logger.debug("Firebase already initialised.")
        return

    settings = get_settings()
    cred_path = settings.FIREBASE_CREDENTIALS_PATH

    if cred_path:
        cred = firebase_admin.credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred, {
            "projectId": settings.GCP_PROJECT_ID,
        })
        logger.info("Firebase initialised with credentials from %s", cred_path)
    else:
        firebase_admin.initialize_app(options={
            "projectId": settings.GCP_PROJECT_ID,
        })
        logger.info("Firebase initialised with Application Default Credentials.")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan handler -- runs once at startup/shutdown."""
    settings = get_settings()

    # Configure logging
    logging.basicConfig(
        level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
    )

    try:
        settings.validate_runtime()
    except ValueError as exc:
        logger.error("Invalid runtime configuration: %s", exc)
        raise

    settings.log_runtime_configuration()

    # Initialise Firebase
    _init_firebase()

    logger.info("GenShot Try-On backend started (project=%s)", settings.GCP_PROJECT_ID)
    yield
    logger.info("GenShot Try-On backend shutting down.")


def create_app() -> FastAPI:
    """Application factory."""
    settings = get_settings()

    application = FastAPI(
        title="GenShot Virtual Try-On API",
        description="Backend API for the GenShot virtual try-on system.",
        version="1.0.0",
        lifespan=lifespan,
    )

    # ── CORS ──────────────────────────────────────────────────────────
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Health check (root level) ─────────────────────────────────────
    @application.get("/health", tags=["Health"])
    async def health_check():
        return {"status": "ok", "service": "genshot-tryon"}

    # ── Routers under /v1 prefix ──────────────────────────────────────
    from app.routers.body_scan import router as body_scan_router
    from app.routers.generations import router as generations_router
    from app.routers.import_sessions import router as import_sessions_router
    from app.routers.items import router as items_router
    from app.routers.users import router as users_router

    application.include_router(import_sessions_router, prefix="/v1")
    application.include_router(body_scan_router, prefix="/v1")
    application.include_router(generations_router, prefix="/v1")
    application.include_router(items_router, prefix="/v1")
    application.include_router(users_router, prefix="/v1")

    return application


app = create_app()
