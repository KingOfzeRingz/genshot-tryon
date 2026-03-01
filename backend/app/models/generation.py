"""Pydantic models for try-on image generation."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

from app.models.body import BodyVector


class FitScore(BaseModel):
    """Detailed fit analysis for one item."""

    overall: int = Field(..., ge=0, le=100, description="Overall fit score 0-100")
    recommended_size: str = Field(..., description="Best-matching size label")
    breakdown: Dict[str, float] = Field(
        default_factory=dict,
        description="Per-measurement fit scores, e.g. {'chest': 92.5}",
    )
    notes: List[str] = Field(default_factory=list, description="Human-readable fit notes")


class GenerationItemSelection(BaseModel):
    item_id: str = Field(..., min_length=1)
    size: str = Field(default="AUTO")


class GenerationSlotsRequest(BaseModel):
    top: Optional[GenerationItemSelection] = None
    bottom: Optional[GenerationItemSelection] = None
    outerwear: Optional[GenerationItemSelection] = None
    shoes: Optional[GenerationItemSelection] = None


class GenerationRequest(BaseModel):
    """Accepts both modern and legacy generation payloads."""

    # Modern payload shape
    items: Optional[GenerationSlotsRequest] = None
    auto_fill_missing: bool = True
    angles: List[str] = Field(default_factory=lambda: ["front", "profile", "three_quarter", "back"])
    render_style: str = "neutral"

    # Legacy payload shape
    user_id: Optional[str] = Field(default=None)
    item_ids: List[str] = Field(default_factory=list)
    body_vector: Optional[BodyVector] = None
    reference_photo_url: Optional[str] = Field(default=None)


class SavedSelectionEntry(BaseModel):
    slot: str
    template_key: Optional[str] = None
    template_title: Optional[str] = None
    item_id: Optional[str] = None
    item_title: Optional[str] = None
    size: Optional[str] = None


class SaveGenerationRequest(BaseModel):
    saved_selection: List[SavedSelectionEntry] = Field(default_factory=list)


class SaveGenerationResponse(BaseModel):
    generation_id: str
    saved: bool = True
    saved_at: datetime


class GenerationResult(BaseModel):
    """Persisted generation result."""

    id: str = ""
    user_id: str = ""
    status: str = "pending"
    stage: Optional[str] = None

    # Public final image URLs returned to app.
    images: List[Any] = Field(default_factory=list, description="Final image payload (URLs or angle/url objects)")

    fit_scores: List[FitScore] = Field(default_factory=list)
    error_message: Optional[str] = None

    saved: bool = False
    saved_at: Optional[datetime] = None
    saved_selection: List[SavedSelectionEntry] = Field(default_factory=list)

    created_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
