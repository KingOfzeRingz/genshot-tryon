"""Pydantic models for body measurement data."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class BodyVector(BaseModel):
    """Anthropometric measurements in centimetres."""

    height_cm: Optional[float] = Field(None, ge=0, description="Height in cm")
    chest_cm: Optional[float] = Field(None, ge=0, description="Chest circumference in cm")
    waist_cm: Optional[float] = Field(None, ge=0, description="Waist circumference in cm")
    hip_cm: Optional[float] = Field(None, ge=0, description="Hip circumference in cm")
    shoulder_width_cm: Optional[float] = Field(None, ge=0, description="Shoulder width in cm")
    shoulder_cm: Optional[float] = Field(None, ge=0, description="Shoulder width in cm (alias)")
    arm_length_cm: Optional[float] = Field(None, ge=0, description="Arm length in cm")
    inseam_cm: Optional[float] = Field(None, ge=0, description="Inseam length in cm")
    thigh_cm: Optional[float] = Field(None, ge=0, description="Thigh circumference in cm")
    neck_cm: Optional[float] = Field(None, ge=0, description="Neck circumference in cm")
    torso_length_cm: Optional[float] = Field(None, ge=0, description="Torso length in cm")
    source: Optional[str] = Field(None, description="AR, LIDAR, MANUAL, or HYBRID")
    confidence: Optional[dict] = Field(None, description="Per-metric confidence dict")


class BodyScanRequest(BaseModel):
    """Input payload for the body scan endpoint."""

    user_id: str = Field(..., min_length=1)
    height_cm: float = Field(..., gt=0, le=300)
    weight_kg: float = Field(..., gt=0, le=500)
    gender: Literal["male", "female", "other"] = "other"


class BodyScanResponse(BaseModel):
    """Returned after a successful body scan."""

    body_vector: BodyVector
    confidence: float = Field(..., ge=0.0, le=1.0)
    method: Literal["scan", "manual", "hybrid", "lidar", "skeleton"] = "scan"
