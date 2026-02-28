"""Pydantic models for user profiles."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.models.body import BodyVector


class UserProfile(BaseModel):
    """Full user profile stored in Firestore."""

    uid: str
    email: str = ""
    display_name: str = ""
    gender: Optional[Literal["male", "female", "other"]] = None
    height_cm: Optional[float] = Field(None, gt=0, le=300)
    weight_kg: Optional[float] = Field(None, gt=0, le=500)
    body_vector: Optional[BodyVector] = None
    reference_photo_url: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class UserProfileUpdate(BaseModel):
    """Partial update payload for user profiles."""

    gender: Optional[Literal["male", "female", "other"]] = None
    height_cm: Optional[float] = Field(None, gt=0, le=300)
    weight_kg: Optional[float] = Field(None, gt=0, le=500)
    body_vector: Optional[BodyVector] = None
    display_name: Optional[str] = None
