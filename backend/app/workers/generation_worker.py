"""Background async worker for try-on image generation.

Designed to be launched as an ``asyncio.Task`` from the generations router.
"""

from __future__ import annotations

import logging
import traceback
from datetime import datetime, timezone

from app.models.body import BodyVector
from app.models.item import Item
from app.models.user import UserProfile
from app.services import firestore as db
from app.services.fit_engine import score_fit
from app.services.image_generation import generate_tryon_images

logger = logging.getLogger(__name__)


async def run_generation(generation_id: str) -> None:
    """Execute the full generation pipeline for *generation_id*.

    Steps
    -----
    1. Mark generation as ``processing``.
    2. Fetch user profile, items, and body vector.
    3. Score fit for each item.
    4. Generate try-on images.
    5. Store results and mark as ``completed``.
    6. On any error, mark as ``failed``.
    """
    logger.info("Starting generation worker for %s", generation_id)

    try:
        # ── 1. Mark processing ────────────────────────────────────────
        db.update_generation(generation_id, {"status": "processing"})

        gen_data = db.get_generation(generation_id)
        if gen_data is None:
            logger.error("Generation %s not found.", generation_id)
            return

        user_id: str = gen_data["user_id"]
        item_ids: list = gen_data.get("item_ids", [])
        body_vector_raw: dict = gen_data.get("body_vector", {})
        reference_photo_url: str = gen_data.get("reference_photo_url", "")

        # ── 2. Fetch user profile ─────────────────────────────────────
        user_data = db.get_user(user_id)
        if user_data is None:
            raise ValueError(f"User {user_id} not found in Firestore.")

        user_profile = UserProfile(
            uid=user_data.get("uid", user_id),
            email=user_data.get("email", ""),
            display_name=user_data.get("display_name", ""),
            gender=user_data.get("gender"),
            height_cm=user_data.get("height_cm"),
            weight_kg=user_data.get("weight_kg"),
            reference_photo_url=user_data.get("reference_photo_url", reference_photo_url),
        )

        # Ensure we have a reference photo
        if not user_profile.reference_photo_url:
            user_profile.reference_photo_url = reference_photo_url
        if not user_profile.reference_photo_url:
            raise ValueError("No reference photo available for user.")

        # ── 3. Fetch items ────────────────────────────────────────────
        items: list[Item] = []
        for iid in item_ids:
            item_data = db.get_item(user_id, iid)
            if item_data:
                items.append(Item(**item_data))
            else:
                logger.warning("Item %s not found for user %s -- skipping.", iid, user_id)

        if not items:
            raise ValueError("None of the requested items were found.")

        # ── 4. Build body vector ──────────────────────────────────────
        body_vector = BodyVector(**body_vector_raw)

        # ── 5. Fit scoring ────────────────────────────────────────────
        fit_scores = []
        for item in items:
            fs = score_fit(body_vector, item)
            fit_scores.append(fs.model_dump())
            logger.info(
                "Fit score for item %s (%s): %d -- recommended size %s",
                item.id, item.name, fs.overall, fs.recommended_size,
            )

        # ── 6. Image generation ───────────────────────────────────────
        image_urls = await generate_tryon_images(user_profile, items, body_vector)

        # ── 7. Persist results ────────────────────────────────────────
        db.update_generation(generation_id, {
            "status": "completed",
            "images": image_urls,
            "fit_scores": fit_scores,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.info("Generation %s completed with %d images.", generation_id, len(image_urls))

    except Exception as exc:
        logger.error("Generation %s failed: %s\n%s", generation_id, exc, traceback.format_exc())
        try:
            db.update_generation(generation_id, {
                "status": "failed",
                "error_message": str(exc),
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as db_exc:
            logger.error("Could not update failed generation %s: %s", generation_id, db_exc)
