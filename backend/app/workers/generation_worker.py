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
    """Execute the full generation pipeline for *generation_id*."""
    logger.info("Starting generation worker for %s", generation_id)

    try:
        db.update_generation(generation_id, {"status": "processing", "stage": "preparing"})

        gen_data = db.get_generation(generation_id)
        if gen_data is None:
            logger.error("Generation %s not found.", generation_id)
            return

        user_id: str = gen_data["user_id"]
        item_ids: list = gen_data.get("item_ids", [])
        body_vector_raw: dict = gen_data.get("body_vector", {})
        reference_photo_url: str = gen_data.get("reference_photo_url", "")
        final_angles: list[str] = gen_data.get("final_angles") or ["front", "profile", "three_quarter", "back"]

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
            core_image_url=user_data.get("core_image_url"),
        )

        if user_profile.core_image_url:
            user_profile.reference_photo_url = user_profile.core_image_url
            logger.info("Using core image for generation %s", generation_id)
        elif not user_profile.reference_photo_url:
            user_profile.reference_photo_url = reference_photo_url

        if not user_profile.reference_photo_url:
            raise ValueError("No reference photo available for user.")

        items: list[Item] = []
        for iid in item_ids:
            item_data = db.get_item(user_id, iid)
            if item_data:
                items.append(Item(**item_data))
            else:
                logger.warning("Item %s not found for user %s -- skipping.", iid, user_id)

        if not items:
            raise ValueError("None of the requested items were found.")

        body_vector = BodyVector(**body_vector_raw)

        db.update_generation(generation_id, {"stage": "fit_analysis"})
        fit_scores = []
        for item in items:
            fs = score_fit(body_vector, item)
            fit_scores.append(fs.model_dump())
            logger.info(
                "Fit score for item %s (%s): %d -- recommended size %s",
                item.id,
                item.name,
                fs.overall,
                fs.recommended_size,
            )

        db.update_generation(generation_id, {"stage": "reference_gen"})

        image_bundle = await generate_tryon_images(
            user_profile,
            items,
            body_vector,
            final_angles=final_angles,
        )

        final_image_urls = image_bundle.get("final_image_urls", [])
        if not final_image_urls:
            db.update_generation(
                generation_id,
                {
                    "status": "failed",
                    "images": [],
                    "fit_scores": fit_scores,
                    "internal_reference_images": image_bundle.get("internal_reference_images", []),
                    "final_images": image_bundle.get("final_images", []),
                    "generation_context": {
                        "body_vector_used": image_bundle.get("body_vector_used", {}),
                        "final_angles": final_angles,
                    },
                    "error_message": "No try-on images were generated.",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            logger.error("Generation %s failed: no final images were generated.", generation_id)
            return

        db.update_generation(
            generation_id,
            {
                "status": "completed",
                "stage": "finalized",
                "images": final_image_urls,
                "internal_reference_images": image_bundle.get("internal_reference_images", []),
                "final_images": image_bundle.get("final_images", []),
                "generation_context": {
                    "body_vector_used": image_bundle.get("body_vector_used", {}),
                    "final_angles": image_bundle.get("final_angles", final_angles),
                    "internal_reference_angles": ["front", "profile"],
                },
                "fit_scores": fit_scores,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        logger.info("Generation %s completed with %d images.", generation_id, len(final_image_urls))

    except Exception as exc:
        logger.error("Generation %s failed: %s\n%s", generation_id, exc, traceback.format_exc())
        try:
            db.update_generation(
                generation_id,
                {
                    "status": "failed",
                    "error_message": str(exc),
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                },
            )
        except Exception as db_exc:
            logger.error("Could not update failed generation %s: %s", generation_id, db_exc)
