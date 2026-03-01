"""Generation endpoints for virtual try-on images."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, status

from app.auth.dependencies import get_current_user
from app.models.generation import (
    GenerationRequest,
    GenerationResult,
    SaveGenerationRequest,
    SaveGenerationResponse,
)
from app.services import firestore as db
from app.workers.generation_worker import run_generation

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/generations", tags=["Generations"])

_ALLOWED_ANGLES = {"front", "profile", "three_quarter", "back"}


def _extract_item_ids(payload: GenerationRequest) -> List[str]:
    item_ids = [item_id for item_id in payload.item_ids if item_id]

    if payload.items:
        for slot in [payload.items.top, payload.items.bottom, payload.items.outerwear, payload.items.shoes]:
            if slot and slot.item_id:
                item_ids.append(slot.item_id)

    # De-duplicate while preserving order
    deduped: List[str] = []
    seen: set[str] = set()
    for item_id in item_ids:
        if item_id in seen:
            continue
        seen.add(item_id)
        deduped.append(item_id)

    return deduped


def _sanitize_angles(angles: List[str] | None) -> List[str]:
    if not angles:
        return ["front", "profile", "three_quarter", "back"]

    normalized: List[str] = []
    for angle in angles:
        lower = angle.lower().strip()
        if lower in _ALLOWED_ANGLES and lower not in normalized:
            normalized.append(lower)

    return normalized or ["front", "profile", "three_quarter", "back"]


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Request a virtual try-on generation",
)
async def create_generation(
    payload: GenerationRequest,
    user_id: str = Depends(get_current_user),
) -> Dict[str, Any]:
    """Create a generation job and launch async processing."""

    item_ids = _extract_item_ids(payload)
    if not item_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No item IDs were provided.",
        )

    user_data = db.get_user(user_id) or {}

    # Validate that at least one referenced item exists for the user.
    found_items: List[str] = []
    for item_id in item_ids:
        item = db.get_item(user_id, item_id)
        if item:
            found_items.append(item_id)
        else:
            logger.warning("Item %s not found for user %s", item_id, user_id)

    if not found_items:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="None of the specified items were found in the user's wardrobe.",
        )

    body_vector_payload = (
        payload.body_vector.model_dump(exclude_none=True)
        if payload.body_vector is not None
        else (user_data.get("body_vector") or {})
    )

    reference_photo_url = (
        payload.reference_photo_url
        or user_data.get("core_image_url")
        or user_data.get("reference_photo_url")
        or ""
    )

    final_angles = _sanitize_angles(payload.angles)

    saved_selection = [
        {"slot": s, "item_id": sel.item_id, "size": sel.size}
        for s, sel in [
            ("top", payload.items.top),
            ("bottom", payload.items.bottom),
            ("outerwear", payload.items.outerwear),
            ("shoes", payload.items.shoes),
        ]
        if sel is not None
    ] if payload.items else []

    gen_data: Dict[str, Any] = {
        "user_id": user_id,
        "item_ids": found_items,
        "body_vector": body_vector_payload,
        "reference_photo_url": reference_photo_url,
        "final_angles": final_angles,
        "status": "pending",
        "stage": "queued",
        "images": [],
        "internal_reference_images": [],
        "final_images": [],
        "generation_context": {},
        "fit_scores": [],
        "error_message": None,
        "saved": False,
        "saved_selection": saved_selection,
    }

    created = db.create_generation(gen_data)
    generation_id: str = created["id"]

    asyncio.create_task(run_generation(generation_id))

    logger.info(
        "Generation %s created for user %s with %d items and angles=%s",
        generation_id,
        user_id,
        len(found_items),
        final_angles,
    )

    return {
        "generation_id": generation_id,
        "status": "pending",
    }


@router.post(
    "/{generation_id}/save",
    response_model=SaveGenerationResponse,
    summary="Save an outfit generation",
)
async def save_generation(
    generation_id: str,
    payload: SaveGenerationRequest,
    user_id: str = Depends(get_current_user),
) -> SaveGenerationResponse:
    """Mark a generation as saved and persist selected outfit metadata."""
    gen = db.get_generation(generation_id)
    if gen is None:
        raise HTTPException(status_code=404, detail="Generation not found.")

    if gen.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorised to save this generation.")

    saved_at = datetime.now(timezone.utc)

    db.save_generation(
        generation_id,
        saved_selection=[entry.model_dump(exclude_none=True) for entry in payload.saved_selection],
        saved_at=saved_at.isoformat(),
    )

    return SaveGenerationResponse(
        generation_id=generation_id,
        saved=True,
        saved_at=saved_at,
    )


@router.get(
    "/{generation_id}",
    response_model=GenerationResult,
    summary="Poll generation status",
)
async def get_generation(
    generation_id: str,
    user_id: str = Depends(get_current_user),
) -> GenerationResult:
    """Return the current state of a generation job (for polling)."""
    gen = db.get_generation(generation_id)
    if gen is None:
        raise HTTPException(status_code=404, detail="Generation not found.")

    if gen.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorised to view this generation.")

    return GenerationResult(**gen)


@router.get(
    "",
    response_model=List[GenerationResult],
    summary="List user's generations",
)
async def list_generations(
    user_id: str = Depends(get_current_user),
) -> List[GenerationResult]:
    """Return all generation records for the authenticated user."""
    raw_list = db.get_generations_for_user(user_id)
    return [GenerationResult(**g) for g in raw_list]
