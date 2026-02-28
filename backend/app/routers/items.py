"""Wardrobe item CRUD endpoints."""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, status

from app.auth.dependencies import get_current_user
from app.models.item import Item
from app.services import firestore as db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/items", tags=["Items"])


@router.get(
    "",
    response_model=List[Item],
    summary="List wardrobe items",
)
async def list_items(
    user_id: str = Depends(get_current_user),
) -> List[Item]:
    """Return every item in the authenticated user's wardrobe."""
    raw = db.get_items_for_user(user_id)
    return [Item(**i) for i in raw]


@router.get(
    "/{item_id}",
    response_model=Item,
    summary="Get a single item",
)
async def get_item(
    item_id: str,
    user_id: str = Depends(get_current_user),
) -> Item:
    """Return a single wardrobe item by ID."""
    raw = db.get_item(user_id, item_id)
    if raw is None:
        raise HTTPException(status_code=404, detail="Item not found.")
    return Item(**raw)


@router.post(
    "",
    response_model=Item,
    status_code=status.HTTP_201_CREATED,
    summary="Manually add an item",
)
async def create_item(
    payload: Item,
    user_id: str = Depends(get_current_user),
) -> Item:
    """Manually add an item to the user's wardrobe."""
    item_data = payload.model_dump(mode="json", exclude={"id"})
    created = db.add_item_to_user(user_id, item_data)
    logger.info("User %s added item %s", user_id, created.get("id"))
    return Item(**created)


@router.delete(
    "/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove an item",
)
async def delete_item(
    item_id: str,
    user_id: str = Depends(get_current_user),
) -> None:
    """Delete an item from the user's wardrobe."""
    removed = db.remove_item(user_id, item_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Item not found.")
    logger.info("User %s deleted item %s", user_id, item_id)
