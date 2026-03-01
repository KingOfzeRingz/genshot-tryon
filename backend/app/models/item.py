"""Pydantic models for wardrobe items and import sessions."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class SizeOption(BaseModel):
    """A single row in a garment's size grid."""

    size_label: str = Field(..., min_length=1, description="Size label, e.g. 'M', '38', 'US 10'")
    measurements: Dict[str, float] = Field(
        default_factory=dict,
        description="Measurement name -> value in cm, e.g. {'chest_cm': 102}",
    )


class Item(BaseModel):
    """A wardrobe item (garment, shoe, accessory)."""

    id: str = Field(default="", description="Firestore document ID")
    name: str = Field(..., min_length=1)
    brand: str = ""
    category: Literal["top", "bottom", "outerwear", "shoes", "accessory"] = "top"
    image_url: str = ""
    product_url: str = ""
    price: Optional[float] = None
    currency: str = "USD"
    color: str = ""
    material: str = ""
    size_grid: List[SizeOption] = Field(default_factory=list)
    created_at: Optional[datetime] = None


class ImportSessionCreate(BaseModel):
    """Payload sent by the browser extension to start an import session."""

    items: List[Dict[str, Any]] = Field(
        ...,
        min_length=1,
        description="Raw item data scraped by the extension",
    )


class ImportSessionClaim(BaseModel):
    """Body for claiming a session -- user_id comes from the auth token."""

    pass


class ImportCodeClaim(BaseModel):
    """Body for claiming a session by 4-digit code."""

    code: str = Field(..., min_length=4, max_length=4, pattern=r"^\d{4}$")


class ImportSession(BaseModel):
    """Persisted import session."""

    id: str = ""
    items: List[Item] = Field(default_factory=list)
    sig: str = ""
    user_id: Optional[str] = None
    status: Literal["pending", "claimed", "expired"] = "pending"
    created_at: Optional[datetime] = None
