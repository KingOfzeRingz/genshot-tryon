"""User profile endpoints."""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.auth.dependencies import get_current_user
from app.config import get_settings
from app.models.user import UserProfile, UserProfileUpdate
from app.services import firestore as db
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
