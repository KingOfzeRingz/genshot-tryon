"""Pydantic models for try-on image generation."""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Literal, Optional

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


class GenerationRequest(BaseModel):
    """Client request to generate virtual try-on images."""

    user_id: str = Field(..., min_length=1)
    item_ids: List[str] = Field(..., min_length=1)
    body_vector: BodyVector
    reference_photo_url: str = Field(..., min_length=1)


class GenerationResult(BaseModel):
    """Persisted generation result."""

    id: str = ""
    user_id: str = ""
    status: Literal["pending", "processing", "completed", "failed"] = "pending"
    images: List[str] = Field(default_factory=list, description="GCS public URLs of generated images")
    fit_scores: List[FitScore] = Field(default_factory=list)
    error_message: Optional[str] = None
    created_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
