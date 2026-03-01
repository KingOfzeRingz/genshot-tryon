"""Import session endpoints.

Sessions are created by the browser extension (no auth) and claimed by the
mobile app (auth required).
"""

from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.auth.dependencies import get_current_user
from app.config import get_settings
from app.models.item import ImportCodeClaim, ImportSession, ImportSessionClaim, ImportSessionCreate, Item
from app.services import firestore as db
from app.utils.qr import (
    generate_qr_payload,
    generate_qr_payload_legacy,
    sign_session,
    verify_signature,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/import-sessions", tags=["Import Sessions"])


def _as_string(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def _as_optional_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalize_demo_category(raw_category: str) -> str:
    key = raw_category.strip().lower()
    if key in {"shoe", "shoes", "sneaker", "sneakers", "boot", "boots", "footwear"}:
        return "shoes"
    if key in {"outerwear", "jacket", "coat", "blazer"}:
        return "outerwear"
    if key in {"bottom", "bottoms", "pants", "trousers", "jeans", "shorts", "skirt"}:
        return "bottom"
    if key in {"top", "tops", "shirt", "t-shirt", "tshirt", "tee", "blouse", "dress"}:
        return "top"
    return "top"


def _demo_name_for_category(category: str) -> str:
    return {
        "top": "T-Shirt",
        "bottom": "Pants",
        "outerwear": "Jacket",
        "shoes": "Sneakers",
    }.get(category, "T-Shirt")


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
        image_url = _as_string(raw.get("image_url"), "")
        if not image_url:
            images = raw.get("images")
            if isinstance(images, list):
                image_url = next(
                    (_as_string(candidate, "") for candidate in images if _as_string(candidate, "")),
                    "",
                )

        # Resolve product_url: extension sends `productUrl` (camelCase)
        product_url = _as_string(raw.get("product_url"), "") or _as_string(raw.get("productUrl"), "")

        # Demo simplification: map all imported garments into 4 canonical categories.
        # Input can come in as `category`, `garment_type`, or `garmentType`.
        source_category = (
            _as_string(raw.get("category"), "")
            or _as_string(raw.get("garment_type"), "")
            or _as_string(raw.get("garmentType"), "")
        )
        category = _normalize_demo_category(source_category)
        normalized_name = _demo_name_for_category(category)

        item = Item(
            name=normalized_name,
            brand=_as_string(raw.get("brand"), ""),
            category=category,
            image_url=image_url,
            product_url=product_url,
            price=_as_optional_float(raw.get("price")),
            currency=_as_string(raw.get("currency"), "USD"),
            color=_as_string(raw.get("color"), ""),
            material=_as_string(raw.get("material"), ""),
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

    # Generate a unique 4-digit import code
    import_code: Optional[str] = None
    for _ in range(5):
        candidate = f"{random.randint(0, 9999):04d}"
        if db.find_pending_session_by_code(candidate) is None:
            import_code = candidate
            break

    code_expires_at: Optional[str] = None
    if import_code:
        code_expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        db.update_import_session(session_id, {
            "import_code": import_code,
            "code_expires_at": code_expires_at,
        })

    logger.info("Created import session %s with %d items (code=%s)", session_id, len(items), import_code)

    return {
        "session_id": session_id,
        "sig": sig,
        "qr_payload": qr,
        "qr_payload_legacy": qr_legacy,
        "item_count": len(items),
        "import_code": import_code,
        "code_expires_at": code_expires_at,
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


@router.post(
    "/claim-by-code",
    summary="Claim an import session by 4-digit code (auth required)",
)
async def claim_import_session_by_code(
    payload: ImportCodeClaim,
    user_id: str = Depends(get_current_user),
) -> Dict[str, Any]:
    """Called by the mobile app with a 4-digit code entered by the user."""
    session = db.find_pending_session_by_code(payload.code)
    if session is None:
        raise HTTPException(status_code=404, detail="Invalid code.")

    # Check expiry
    expires_str = session.get("code_expires_at", "")
    if expires_str:
        expires_at = datetime.fromisoformat(expires_str)
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > expires_at:
            raise HTTPException(status_code=410, detail="Code expired.")

    if session.get("status") == "claimed":
        raise HTTPException(status_code=409, detail="Already imported.")

    session_id = session["id"]

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
        "Import session claimed by code: session=%s user=%s items=%d",
        session_id,
        user_id,
        len(claimed_items),
    )

    return {
        "session_id": session_id,
        "status": "claimed",
        "items": claimed_items,
    }
