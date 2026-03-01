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


def _normalize_category(raw_category: str) -> str:
    """Map any raw category string to one of: top, bottom, outerwear, shoes."""
    key = raw_category.strip().lower()
    if key in {
        "shoe", "shoes", "sneaker", "sneakers", "boot", "boots",
        "footwear", "sandal", "sandals", "loafer", "loafers", "trainer", "trainers",
    }:
        return "shoes"
    if key in {
        "outerwear", "jacket", "jackets", "coat", "coats", "blazer", "blazers",
        "parka", "puffer", "trench", "waistcoat", "gilet", "vest",
    }:
        return "outerwear"
    if key in {
        "bottom", "bottoms", "pants", "pant", "trousers", "trouser",
        "jeans", "jean", "shorts", "short", "skirt", "skirts",
        "legging", "leggings", "chino", "chinos", "jogger", "joggers",
    }:
        return "bottom"
    if key in {
        "top", "tops", "shirt", "shirts", "t-shirt", "tshirt", "tee",
        "blouse", "dress", "dresses", "sweater", "knitwear", "knit",
        "hoodie", "sweatshirt", "polo", "cardigan", "pullover",
        "bodysuit", "jumpsuit", "romper", "jersey", "henley", "tank",
    }:
        return "top"
    return "top"


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


# Realistic Zara-style measurement tables indexed by letter size.
# Values in cm.  When the label is numeric (EU 36-46) we map it to the
# closest letter equivalent.
_ZARA_TOPS: Dict[str, Dict[str, float]] = {
    "XS": {"chest_cm": 88, "shoulder_cm": 42, "length_cm": 68, "sleeve_cm": 60},
    "S":  {"chest_cm": 92, "shoulder_cm": 44, "length_cm": 70, "sleeve_cm": 62},
    "M":  {"chest_cm": 98, "shoulder_cm": 46, "length_cm": 72, "sleeve_cm": 64},
    "L":  {"chest_cm": 104, "shoulder_cm": 48, "length_cm": 74, "sleeve_cm": 66},
    "XL": {"chest_cm": 110, "shoulder_cm": 50, "length_cm": 76, "sleeve_cm": 68},
    "XXL": {"chest_cm": 116, "shoulder_cm": 52, "length_cm": 78, "sleeve_cm": 70},
}

_ZARA_BOTTOMS: Dict[str, Dict[str, float]] = {
    "XS": {"waist_cm": 74, "hip_cm": 92, "inseam_cm": 76, "length_cm": 102},
    "S":  {"waist_cm": 78, "hip_cm": 96, "inseam_cm": 78, "length_cm": 104},
    "M":  {"waist_cm": 82, "hip_cm": 100, "inseam_cm": 80, "length_cm": 106},
    "L":  {"waist_cm": 86, "hip_cm": 104, "inseam_cm": 82, "length_cm": 108},
    "XL": {"waist_cm": 90, "hip_cm": 108, "inseam_cm": 82, "length_cm": 108},
    "XXL": {"waist_cm": 94, "hip_cm": 112, "inseam_cm": 82, "length_cm": 108},
    # EU numeric aliases
    "36": {"waist_cm": 74, "hip_cm": 92, "inseam_cm": 76, "length_cm": 102},
    "38": {"waist_cm": 78, "hip_cm": 96, "inseam_cm": 78, "length_cm": 104},
    "40": {"waist_cm": 82, "hip_cm": 100, "inseam_cm": 80, "length_cm": 106},
    "42": {"waist_cm": 86, "hip_cm": 104, "inseam_cm": 82, "length_cm": 108},
    "44": {"waist_cm": 90, "hip_cm": 108, "inseam_cm": 82, "length_cm": 108},
    "46": {"waist_cm": 94, "hip_cm": 112, "inseam_cm": 82, "length_cm": 108},
}

_ZARA_OUTERWEAR: Dict[str, Dict[str, float]] = {
    "XS": {"chest_cm": 94, "shoulder_cm": 44, "length_cm": 66, "sleeve_cm": 62},
    "S":  {"chest_cm": 98, "shoulder_cm": 46, "length_cm": 68, "sleeve_cm": 64},
    "M":  {"chest_cm": 104, "shoulder_cm": 48, "length_cm": 70, "sleeve_cm": 66},
    "L":  {"chest_cm": 110, "shoulder_cm": 50, "length_cm": 72, "sleeve_cm": 68},
    "XL": {"chest_cm": 116, "shoulder_cm": 52, "length_cm": 74, "sleeve_cm": 70},
    "XXL": {"chest_cm": 122, "shoulder_cm": 54, "length_cm": 76, "sleeve_cm": 72},
}

_ZARA_SHOES: Dict[str, Dict[str, float]] = {
    "38": {"foot_length_cm": 24.0},
    "39": {"foot_length_cm": 24.5},
    "40": {"foot_length_cm": 25.5},
    "41": {"foot_length_cm": 26.0},
    "42": {"foot_length_cm": 27.0},
    "43": {"foot_length_cm": 27.5},
    "44": {"foot_length_cm": 28.5},
    "45": {"foot_length_cm": 29.0},
    "46": {"foot_length_cm": 29.5},
}

_ZARA_TABLES: Dict[str, Dict[str, Dict[str, float]]] = {
    "top": _ZARA_TOPS,
    "bottom": _ZARA_BOTTOMS,
    "outerwear": _ZARA_OUTERWEAR,
    "shoes": _ZARA_SHOES,
}

# ---------------------------------------------------------------------------
# H&M measurement tables (cm).  H&M sizing is slightly roomier than Zara.
# ---------------------------------------------------------------------------
_HM_TOPS: Dict[str, Dict[str, float]] = {
    "XS":  {"chest_cm": 90,  "shoulder_cm": 43, "length_cm": 69, "sleeve_cm": 61},
    "S":   {"chest_cm": 96,  "shoulder_cm": 45, "length_cm": 71, "sleeve_cm": 63},
    "M":   {"chest_cm": 102, "shoulder_cm": 47, "length_cm": 73, "sleeve_cm": 65},
    "L":   {"chest_cm": 108, "shoulder_cm": 49, "length_cm": 75, "sleeve_cm": 67},
    "XL":  {"chest_cm": 114, "shoulder_cm": 51, "length_cm": 77, "sleeve_cm": 69},
    "XXL": {"chest_cm": 120, "shoulder_cm": 53, "length_cm": 79, "sleeve_cm": 71},
}

_HM_BOTTOMS: Dict[str, Dict[str, float]] = {
    "XS":  {"waist_cm": 72,  "hip_cm": 94,  "inseam_cm": 78, "length_cm": 104},
    "S":   {"waist_cm": 76,  "hip_cm": 98,  "inseam_cm": 80, "length_cm": 106},
    "M":   {"waist_cm": 82,  "hip_cm": 102, "inseam_cm": 81, "length_cm": 107},
    "L":   {"waist_cm": 88,  "hip_cm": 106, "inseam_cm": 82, "length_cm": 108},
    "XL":  {"waist_cm": 94,  "hip_cm": 112, "inseam_cm": 82, "length_cm": 108},
    "XXL": {"waist_cm": 100, "hip_cm": 118, "inseam_cm": 82, "length_cm": 108},
    # Numeric waist sizes (inches → letter mapping handled below)
    "28": {"waist_cm": 72, "hip_cm": 92,  "inseam_cm": 78, "length_cm": 104},
    "29": {"waist_cm": 74, "hip_cm": 94,  "inseam_cm": 79, "length_cm": 105},
    "30": {"waist_cm": 76, "hip_cm": 96,  "inseam_cm": 80, "length_cm": 106},
    "31": {"waist_cm": 79, "hip_cm": 99,  "inseam_cm": 80, "length_cm": 106},
    "32": {"waist_cm": 82, "hip_cm": 102, "inseam_cm": 81, "length_cm": 107},
    "33": {"waist_cm": 85, "hip_cm": 104, "inseam_cm": 81, "length_cm": 107},
    "34": {"waist_cm": 88, "hip_cm": 106, "inseam_cm": 82, "length_cm": 108},
    "36": {"waist_cm": 94, "hip_cm": 112, "inseam_cm": 82, "length_cm": 108},
}

_HM_OUTERWEAR: Dict[str, Dict[str, float]] = {
    "XS":  {"chest_cm": 96,  "shoulder_cm": 45, "length_cm": 67, "sleeve_cm": 63},
    "S":   {"chest_cm": 102, "shoulder_cm": 47, "length_cm": 69, "sleeve_cm": 65},
    "M":   {"chest_cm": 108, "shoulder_cm": 49, "length_cm": 71, "sleeve_cm": 67},
    "L":   {"chest_cm": 114, "shoulder_cm": 51, "length_cm": 73, "sleeve_cm": 69},
    "XL":  {"chest_cm": 120, "shoulder_cm": 53, "length_cm": 75, "sleeve_cm": 71},
    "XXL": {"chest_cm": 126, "shoulder_cm": 55, "length_cm": 77, "sleeve_cm": 73},
}

_HM_SHOES: Dict[str, Dict[str, float]] = {
    "38": {"foot_length_cm": 24.0},
    "39": {"foot_length_cm": 24.5},
    "40": {"foot_length_cm": 25.5},
    "41": {"foot_length_cm": 26.0},
    "42": {"foot_length_cm": 27.0},
    "43": {"foot_length_cm": 27.5},
    "44": {"foot_length_cm": 28.5},
    "45": {"foot_length_cm": 29.0},
    "46": {"foot_length_cm": 29.5},
}

_HM_TABLES: Dict[str, Dict[str, Dict[str, float]]] = {
    "top": _HM_TOPS,
    "bottom": _HM_BOTTOMS,
    "outerwear": _HM_OUTERWEAR,
    "shoes": _HM_SHOES,
}

# Brand → tables mapping.  Defaults to Zara.
_BRAND_TABLES: Dict[str, Dict[str, Dict[str, Dict[str, float]]]] = {
    "zara": _ZARA_TABLES,
    "h&m": _HM_TABLES,
    "hm": _HM_TABLES,
    "h & m": _HM_TABLES,
}

# Map EU numeric clothing sizes to letter equivalents for lookup.
_EU_TO_LETTER = {"36": "XS", "38": "S", "40": "M", "42": "L", "44": "XL", "46": "XXL"}


def _generate_measurements(category: str, size_label: str, brand: str = "") -> Dict[str, float]:
    """Return realistic measurements for a given category + size label.

    Uses brand-specific tables when available (H&M, Zara), falling back
    to Zara tables as default.
    """
    brand_key = brand.strip().lower()
    tables = _BRAND_TABLES.get(brand_key, _ZARA_TABLES)
    table = tables.get(category, tables.get("top", _ZARA_TOPS))
    label = size_label.strip().upper()

    # Direct lookup
    if label in table:
        return dict(table[label])

    # Try EU numeric → letter conversion (for non-shoe categories)
    if category != "shoes" and label in _EU_TO_LETTER:
        letter = _EU_TO_LETTER[label]
        if letter in table:
            return dict(table[letter])

    return {}


_STANDARD_CLOTHING_SIZES = ["XS", "S", "M", "L", "XL", "XXL"]
_STANDARD_SHOE_SIZES = ["38", "39", "40", "41", "42", "43", "44", "45", "46"]


def _parse_size_grid(raw: Dict[str, Any], category: str, brand: str = "") -> List[Dict[str, Any]]:
    """Return standard sizes with brand-appropriate measurements.

    Always uses a fixed set of sizes (letter sizes for clothing, EU numeric
    for shoes) so the demo experience is consistent regardless of what the
    extension extracted.
    """
    labels = _STANDARD_SHOE_SIZES if category == "shoes" else _STANDARD_CLOTHING_SIZES
    return [
        {"size_label": label, "measurements": _generate_measurements(category, label, brand)}
        for label in labels
    ]


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

        # Resolve category from various extension field names.
        source_category = (
            _as_string(raw.get("category"), "")
            or _as_string(raw.get("garment_type"), "")
            or _as_string(raw.get("garmentType"), "")
        )
        category = _normalize_category(source_category)

        # Use actual product name from the extension; fall back to category label.
        item_name = _as_string(raw.get("name"), "")
        if not item_name:
            item_name = {
                "top": "Top", "bottom": "Pants",
                "outerwear": "Jacket", "shoes": "Shoes",
            }.get(category, "Item")

        brand = _as_string(raw.get("brand"), "")
        size_grid_data = _parse_size_grid(raw, category, brand)

        item = Item(
            name=item_name,
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
