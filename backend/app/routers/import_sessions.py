"""Import session endpoints.

Sessions are created by the browser extension (no auth) and claimed by the
mobile app (auth required).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.auth.dependencies import get_current_user
from app.config import get_settings
from app.models.item import ImportSession, ImportSessionClaim, ImportSessionCreate, Item
from app.services import firestore as db
from app.utils.qr import (
    generate_qr_payload,
    generate_qr_payload_legacy,
    sign_session,
    verify_signature,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/import-sessions", tags=["Import Sessions"])


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    summary="Create an import session (no auth)",
)
async def create_import_session(payload: ImportSessionCreate) -> Dict[str, Any]:
    """Called by the browser extension to push scraped items.

    Returns the ``session_id``, ``sig`` (HMAC), and a ``qr_payload`` deep link.
    """
    settings = get_settings()

    # Convert raw dicts to Item objects (tolerant parsing).
    # The Chrome extension sends camelCase fields (e.g. productUrl, images)
    # while the backend models use snake_case.  Handle both.
    items: List[Dict[str, Any]] = []
    for raw in payload.items:
        # Resolve image_url: extension sends `images` (array), backend wants `image_url` (string)
        image_url = raw.get("image_url", "")
        if not image_url:
            images = raw.get("images", [])
            if isinstance(images, list) and images:
                image_url = images[0]

        # Resolve product_url: extension sends `productUrl` (camelCase)
        product_url = raw.get("product_url", "") or raw.get("productUrl", "")

        # Validate category against allowed values
        category = raw.get("category", "top")
        valid_categories = {"top", "bottom", "outerwear", "shoes", "accessory"}
        if category not in valid_categories:
            category = "top"

        item = Item(
            name=raw.get("name", "Unknown Item"),
            brand=raw.get("brand", ""),
            category=category,
            image_url=image_url,
            product_url=product_url,
            price=raw.get("price"),
            currency=raw.get("currency", "USD"),
            color=raw.get("color", ""),
            material=raw.get("material", ""),
            size_grid=[],  # will be enriched later via size chart parsing
        )
        items.append(item.model_dump(mode="json"))

    session_data: Dict[str, Any] = {
        "items": items,
        "status": "pending",
        "user_id": None,
    }

    created = db.create_import_session(session_data)
    session_id: str = created["id"]

    sig = sign_session(session_id, settings.HMAC_SECRET)
    db.update_import_session(session_id, {"sig": sig})

    qr = generate_qr_payload(session_id, sig)
    qr_legacy = generate_qr_payload_legacy(session_id, sig)

    logger.info("Created import session %s with %d items", session_id, len(items))

    return {
        "session_id": session_id,
        "sig": sig,
        "qr_payload": qr,
        "qr_payload_legacy": qr_legacy,
        "item_count": len(items),
    }


@router.post(
    "/{session_id}/claim",
    summary="Claim an import session (auth required)",
)
async def claim_import_session(
    session_id: str,
    sig: str = Query("", description="HMAC signature from QR payload"),
    _body: ImportSessionClaim = ImportSessionClaim(),
    user_id: str = Depends(get_current_user),
) -> Dict[str, Any]:
    """Called by the mobile app after scanning the QR code.

    Verifies the HMAC signature, marks the session as claimed, and copies
    all items into the user's wardrobe.
    """
    settings = get_settings()

    session = db.get_import_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Import session not found.")

    if session.get("status") == "claimed":
        raise HTTPException(status_code=409, detail="Session already claimed.")

    if session.get("status") == "expired":
        raise HTTPException(status_code=410, detail="Session has expired.")

    # Verify signature in dual mode:
    # - legacy: incoming sig from QR
    # - compact: no sig in QR, validate using stored signature
    stored_sig = session.get("sig", "")
    mode = "legacy" if sig else "compact"
    incoming_sig = sig or stored_sig
    if not incoming_sig or not verify_signature(session_id, incoming_sig, settings.HMAC_SECRET):
        logger.warning(
            "Import session claim rejected: session=%s user=%s mode=%s reason=invalid_signature",
            session_id,
            user_id,
            mode,
        )
        raise HTTPException(status_code=403, detail="Invalid session signature.")

    # Copy items to user's wardrobe
    raw_items: List[Dict[str, Any]] = session.get("items", [])
    claimed_items: List[Dict[str, Any]] = []

    for raw in raw_items:
        added = db.add_item_to_user(user_id, raw)
        claimed_items.append(added)

    # Mark session as claimed
    db.update_import_session(session_id, {
        "status": "claimed",
        "user_id": user_id,
        "claimed_at": datetime.now(timezone.utc).isoformat(),
    })

    logger.info(
        "Import session claimed: session=%s user=%s mode=%s items=%d",
        session_id,
        user_id,
        mode,
        len(claimed_items),
    )

    return {
        "session_id": session_id,
        "status": "claimed",
        "items": claimed_items,
    }
