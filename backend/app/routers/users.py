"""User profile endpoints."""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.auth.dependencies import get_current_user
from app.config import get_settings
from app.models.user import UserProfile, UserProfileUpdate
from app.services import firestore as db
from app.services.core_image import generate_core_image
from app.services.storage import upload_image
from app.utils.image_processing import resize_image

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["Users"])


@router.get(
    "/me",
    response_model=UserProfile,
    summary="Get current user profile",
)
async def get_me(
    user_id: str = Depends(get_current_user),
) -> UserProfile:
    """Return the authenticated user's profile."""
    data = db.get_user(user_id)
    if data is None:
        # Auto-create a minimal profile on first access
        data = db.create_or_update_user(user_id, {"uid": user_id})

    return UserProfile(**data)


@router.put(
    "/me",
    response_model=UserProfile,
    summary="Update current user profile",
)
async def update_me(
    payload: UserProfileUpdate,
    user_id: str = Depends(get_current_user),
) -> UserProfile:
    """Partially update the authenticated user's profile.

    Only the fields included in the request body are updated; ``None``
    values are excluded.
    """
    update_data: Dict[str, Any] = payload.model_dump(exclude_none=True)

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update.",
        )

    # If body_vector is present, serialise it properly
    if "body_vector" in update_data and update_data["body_vector"] is not None:
        update_data["body_vector"] = payload.body_vector.model_dump(exclude_none=True)

    updated = db.create_or_update_user(user_id, update_data)
    logger.info("Updated profile for user %s: keys=%s", user_id, list(update_data.keys()))

    return UserProfile(**updated)


@router.post(
    "/me/reference-photo",
    response_model=UserProfile,
    summary="Upload a reference photo",
)
async def upload_reference_photo(
    photo: UploadFile = File(..., description="Full-body reference photo"),
    user_id: str = Depends(get_current_user),
) -> UserProfile:
    """Upload a reference photo for virtual try-on generation.

    The image is resized, uploaded to GCS, and the URL is saved on the
    user profile.
    """
    settings = get_settings()

    raw_bytes = await photo.read()
    if not raw_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file.",
        )

    # Resize to a reasonable dimension
    try:
        resized = resize_image(raw_bytes, max_size=1280)
    except Exception as exc:
        logger.error("Image processing error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Could not process image: {exc}",
        ) from exc

    # Determine content type
    content_type = photo.content_type or "image/png"
    extension = "png"
    if "jpeg" in content_type or "jpg" in content_type:
        extension = "jpg"
    elif "webp" in content_type:
        extension = "webp"

    filename = f"{uuid.uuid4().hex[:12]}.{extension}"
    gcs_path = f"users/{user_id}/reference/{filename}"

    try:
        public_url = upload_image(
            settings.GCS_BUCKET,
            gcs_path,
            resized,
            content_type,
        )
    except Exception as exc:
        logger.error("GCS upload failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to upload image to storage.",
        ) from exc

    updated = db.create_or_update_user(user_id, {"reference_photo_url": public_url})
    logger.info("Reference photo uploaded for user %s: %s", user_id, public_url)

    return UserProfile(**updated)


async def _run_core_image_generation(user_id: str, reference_photo_url: str) -> None:
    """Background task: generate core image and update user profile."""
    try:
        db.create_or_update_user(user_id, {"core_image_status": "processing"})
        core_url = await generate_core_image(user_id, reference_photo_url)
        if core_url:
            db.create_or_update_user(user_id, {
                "core_image_url": core_url,
                "core_image_status": "completed",
            })
            logger.info("Core image completed for user %s", user_id)
        else:
            db.create_or_update_user(user_id, {"core_image_status": "failed"})
            logger.warning("Core image generation failed for user %s", user_id)
    except Exception as exc:
        logger.error("Core image background task failed for %s: %s", user_id, exc)
        try:
            db.create_or_update_user(user_id, {"core_image_status": "failed"})
        except Exception:
            pass


@router.post(
    "/me/core-image",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Generate core reference image",
)
async def generate_core(
    user_id: str = Depends(get_current_user),
) -> Dict[str, Any]:
    """Generate a studio-quality core reference image.

    The user's raw reference photo is transformed into a clean studio shot
    (plain white clothing, neutral background) that serves as the base for
    all virtual try-on generations.

    Returns immediately with ``status=processing``.  Poll ``GET /me`` to
    check ``core_image_status`` and ``core_image_url``.
    """
    user_data = db.get_user(user_id)
    if user_data is None:
        raise HTTPException(status_code=404, detail="User not found.")

    ref_url = user_data.get("reference_photo_url")
    if not ref_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload a reference photo first (POST /v1/users/me/reference-photo).",
        )

    # Mark as pending and launch background task
    db.create_or_update_user(user_id, {
        "core_image_status": "pending",
        "core_image_url": None,
    })
    asyncio.create_task(_run_core_image_generation(user_id, ref_url))

    return {"status": "processing", "message": "Core image generation started."}


@router.post(
    "/me/core-image/regenerate",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Regenerate core reference image",
)
async def regenerate_core(
    user_id: str = Depends(get_current_user),
) -> Dict[str, Any]:
    """Regenerate the core reference image (e.g. after uploading a new photo).

    Same as the initial generation endpoint but clears any existing core image.
    """
    user_data = db.get_user(user_id)
    if user_data is None:
        raise HTTPException(status_code=404, detail="User not found.")

    ref_url = user_data.get("reference_photo_url")
    if not ref_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload a reference photo first.",
        )

    db.create_or_update_user(user_id, {
        "core_image_status": "pending",
        "core_image_url": None,
    })
    asyncio.create_task(_run_core_image_generation(user_id, ref_url))

    return {"status": "processing", "message": "Core image regeneration started."}
