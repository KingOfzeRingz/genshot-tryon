"""Generation endpoints for virtual try-on images."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, status

from app.auth.dependencies import get_current_user
from app.models.generation import GenerationRequest, GenerationResult
from app.services import firestore as db
from app.workers.generation_worker import run_generation

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/generations", tags=["Generations"])


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Request a virtual try-on generation",
)
async def create_generation(
    payload: GenerationRequest,
    user_id: str = Depends(get_current_user),
) -> Dict[str, Any]:
    """Validate the request, create a generation record, and launch the
    background worker.  Returns immediately with the generation ID and
    ``status=pending``.
    """
    # Validate that at least some items exist
    found_items: List[str] = []
    for item_id in payload.item_ids:
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

    gen_data: Dict[str, Any] = {
        "user_id": user_id,
        "item_ids": found_items,
        "body_vector": payload.body_vector.model_dump(exclude_none=True),
        "reference_photo_url": payload.reference_photo_url,
        "status": "pending",
        "images": [],
        "fit_scores": [],
        "error_message": None,
    }

    created = db.create_generation(gen_data)
    generation_id: str = created["id"]

    # Fire-and-forget background task
    asyncio.create_task(run_generation(generation_id))

    logger.info("Generation %s created for user %s with %d items", generation_id, user_id, len(found_items))

    return {
        "generation_id": generation_id,
        "status": "pending",
    }


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
