"""Body scan endpoint.

Accepts a photo (and optional depth map), runs the measurement pipeline,
and stores the resulting ``BodyVector`` on the user profile.
"""

from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.auth.dependencies import get_current_user
from app.models.body import BodyScanResponse, BodyVector
from app.services import firestore as db
from app.services.body_measurement import measure_body

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/body-scan", tags=["Body Scan"])


@router.post(
    "",
    response_model=BodyScanResponse,
    status_code=status.HTTP_200_OK,
    summary="Run body measurement from a photo",
)
async def body_scan(
    image: UploadFile = File(..., description="Front-facing full-body photo"),
    height_cm: float = Form(..., gt=0, le=300),
    weight_kg: float = Form(..., gt=0, le=500),
    gender: Literal["male", "female", "other"] = Form("other"),
    depth_map: Optional[UploadFile] = File(None, description="Optional depth map image"),
    user_id: str = Depends(get_current_user),
) -> BodyScanResponse:
    """Accept a multipart upload with the user's photo and metadata.

    Runs the MediaPipe-based measurement pipeline and stores the resulting
    body vector on the user's Firestore profile.
    """
    # Read uploaded files
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty image file.",
        )

    depth_bytes: Optional[bytes] = None
    if depth_map is not None:
        depth_bytes = await depth_map.read()
        if not depth_bytes:
            depth_bytes = None

    # Run measurement pipeline
    try:
        result = measure_body(
            image_bytes=image_bytes,
            height_cm=height_cm,
            gender=gender,
            depth_map_bytes=depth_bytes,
        )
    except Exception as exc:
        logger.error("Body measurement pipeline error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Body measurement failed: {exc}",
        ) from exc

    body_vector = result.body_vector
    confidence = result.confidence
    method: Literal["scan", "manual", "hybrid"] = "scan"
    if depth_bytes:
        method = "hybrid"

    # Persist to Firestore
    db.create_or_update_user(user_id, {
        "body_vector": body_vector.model_dump(exclude_none=True),
        "height_cm": height_cm,
        "weight_kg": weight_kg,
        "gender": gender,
    })

    logger.info(
        "Body scan complete for user %s: confidence=%.2f method=%s",
        user_id, confidence, method,
    )

    return BodyScanResponse(
        body_vector=body_vector,
        confidence=confidence,
        method=method,
    )
