"""Import session endpoints.

Sessions are created by the browser extension (no auth) and claimed by the
mobile app (auth required).
"""

from __future__ import annotations

import logging
import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.auth.dependencies import get_current_user
from app.config import get_settings
from app.models.item import ImportCodeClaim, ImportSession, ImportSessionClaim, ImportSessionCreate, Item
from app.services import firestore as db
from app.services.storage import upload_image
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


def _cache_image_to_gcs(image_url: str, session_id: str, index: int) -> Optional[str]:
    """Download an image and upload it to GCS. Returns GCS URL or None on failure."""
    import httpx

    if not image_url:
        return None
    try:
        settings = get_settings()
        resp = httpx.get(
            image_url,
            timeout=15.0,
            follow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
        )
        resp.raise_for_status()
        if not resp.content:
            return None

        content_type = resp.headers.get("content-type", "image/jpeg")
        # Determine extension from content type
        ext = "jpg"
        if "png" in content_type:
            ext = "png"
        elif "webp" in content_type:
            ext = "webp"

        path = f"imports/{session_id}/{index}.{ext}"
        gcs_url = upload_image(settings.GCS_BUCKET, path, resp.content, content_type)
        logger.info("Cached image to GCS: %s -> %s", image_url[:80], path)
        return gcs_url
    except Exception as exc:
        logger.warning("Failed to cache image to GCS: url=%s error=%s", image_url[:80], exc)
        return None


def _parse_measurement_value(text: str) -> Optional[float]:
    """Extract a numeric cm value from a measurement string like '96 cm' or '96-100'."""
    import re

    if not isinstance(text, str):
        try:
            return float(text)
        except (TypeError, ValueError):
            return None

    text = text.strip().lower().replace(",", ".")
    # Range like "96-100" → take the midpoint
    range_match = re.match(r"(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)", text)
    if range_match:
        lo, hi = float(range_match.group(1)), float(range_match.group(2))
        return round((lo + hi) / 2, 1)
    # Single value like "96 cm" or "96"
    num_match = re.match(r"(\d+(?:\.\d+)?)", text)
    if num_match:
        return float(num_match.group(1))
    return None


def _parse_size_grid(raw: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Build a size_grid from the extension's sizes / sizeChart fields."""
    size_chart = raw.get("sizeChart") or []
    sizes = raw.get("sizes") or []

    grid: List[Dict[str, Any]] = []

    if size_chart and isinstance(size_chart, list):
        for entry in size_chart:
            label = _as_string(entry.get("size"), "")
            if not label:
                continue
            raw_measurements = entry.get("measurements", {})
            measurements: Dict[str, float] = {}
            if isinstance(raw_measurements, dict):
                for key, val in raw_measurements.items():
                    parsed = _parse_measurement_value(val)
                    if parsed is not None:
                        # Normalize key: "Chest" → "chest_cm", "Hip" → "hip_cm"
                        norm_key = key.strip().lower().replace(" ", "_")
                        if not norm_key.endswith("_cm"):
                            norm_key += "_cm"
                        measurements[norm_key] = parsed
            grid.append({"size_label": label, "measurements": measurements})
    elif sizes and isinstance(sizes, list):
        # Extension only sent labels (no measurement data)
        for entry in sizes:
            if isinstance(entry, dict):
                label = _as_string(entry.get("label"), "")
                available = entry.get("available", True)
            elif isinstance(entry, str):
                label = entry.strip()
                available = True
            else:
                continue
            if label and available:
                grid.append({"size_label": label, "measurements": {}})

    return grid


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
    batch_id = uuid.uuid4().hex[:12]
    items: List[Dict[str, Any]] = []
    for idx, raw in enumerate(payload.items):
        # Resolve image_url: extension sends `images` (array), backend wants `image_url` (string)
        image_url = _as_string(raw.get("image_url"), "")
        if not image_url:
            images = raw.get("images")
            if isinstance(images, list):
                image_url = next(
                    (_as_string(candidate, "") for candidate in images if _as_string(candidate, "")),
                    "",
                )

        # Cache image to GCS to avoid 403s when fetching from retailer CDNs later
        if image_url:
            cached_url = _cache_image_to_gcs(image_url, batch_id, idx)
            if cached_url:
                image_url = cached_url

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

        size_grid_data = _parse_size_grid(raw)

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
            size_grid=size_grid_data,
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
