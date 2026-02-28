"""Constraint-based fit scoring engine.

Given a user's ``BodyVector`` and an ``Item`` with a size grid, this module
computes a per-size fit score and recommends the best size.
"""

from __future__ import annotations

import logging
import math
import re
from typing import Dict, List, Optional, Tuple

from app.models.body import BodyVector
from app.models.generation import FitScore
from app.models.item import Item, SizeOption

logger = logging.getLogger(__name__)

# ── Category-specific measurement weights ─────────────────────────────
# Keys match the canonical ``_cm`` names in SizeOption.measurements.

_TOP_WEIGHTS: Dict[str, float] = {
    "chest_cm": 0.35,
    "shoulder_width_cm": 0.25,
    "waist_cm": 0.20,
    "arm_length_cm": 0.10,
    "torso_length_cm": 0.10,
}

_BOTTOM_WEIGHTS: Dict[str, float] = {
    "waist_cm": 0.30,
    "hip_cm": 0.30,
    "inseam_cm": 0.20,
    "thigh_cm": 0.20,
}

_OUTERWEAR_WEIGHTS: Dict[str, float] = {
    "chest_cm": 0.30,
    "shoulder_width_cm": 0.30,
    "waist_cm": 0.15,
    "arm_length_cm": 0.15,
    "torso_length_cm": 0.10,
}

_CATEGORY_WEIGHTS = {
    "top": _TOP_WEIGHTS,
    "bottom": _BOTTOM_WEIGHTS,
    "outerwear": _OUTERWEAR_WEIGHTS,
    "shoes": {},
    "accessory": {},
}

# ── Ease preferences (ideal extra cm the garment should have) ─────────
_EASE: Dict[str, Tuple[float, float]] = {
    "chest_cm": (2.0, 4.0),
    "waist_cm": (1.0, 2.0),
    "hip_cm": (1.0, 3.0),
    "shoulder_width_cm": (0.5, 1.5),
    "arm_length_cm": (0.0, 1.0),
    "inseam_cm": (0.0, 1.0),
    "thigh_cm": (1.0, 2.5),
    "neck_cm": (0.5, 1.0),
    "torso_length_cm": (0.0, 2.0),
}

# ── Stretch tolerance by material ─────────────────────────────────────

_STRETCH_PATTERNS: List[Tuple[str, float]] = [
    (r"jersey|knit|stretch|spandex|elastane|lycra", 0.15),
    (r"cotton.?blend|modal|rayon", 0.08),
    (r"denim|jeans", 0.05),
    (r"leather|suede", 0.02),
    (r"wool|tweed|linen|silk", 0.03),
]


def _stretch_factor(material: str) -> float:
    """Return a multiplicative stretch tolerance (0..1) based on material keywords."""
    mat_lower = material.lower()
    for pattern, factor in _STRETCH_PATTERNS:
        if re.search(pattern, mat_lower):
            return factor
    return 0.04  # default small tolerance


def _body_value(body: BodyVector, key: str) -> Optional[float]:
    """Get a measurement from the BodyVector by canonical key name."""
    return getattr(body, key, None)


def _score_measurement(
    body_cm: float,
    garment_cm: float,
    ease_min: float,
    ease_max: float,
    stretch: float,
) -> float:
    """Score a single measurement (0-100).

    100 = perfect fit in the ease range.
    Deductions grow quadratically as the garment deviates from ideal.
    """
    effective_garment = garment_cm * (1.0 + stretch)

    diff = effective_garment - body_cm  # positive = garment is bigger
    ideal_mid = (ease_min + ease_max) / 2.0

    # How far from the ideal ease centre?
    deviation = abs(diff - ideal_mid)
    tolerance = (ease_max - ease_min) / 2.0 + 1.0  # +1cm grace

    if deviation <= tolerance:
        score = 100.0
    else:
        overshoot = deviation - tolerance
        # Quadratic falloff: -2 points per cm, then accelerating
        penalty = min(100.0, 2.0 * overshoot + 0.5 * overshoot ** 2)
        score = max(0.0, 100.0 - penalty)

    # Extra penalty if garment is *smaller* than body (negative ease)
    if diff < 0 and abs(diff) > stretch * garment_cm:
        too_tight = abs(diff)
        score = max(0.0, score - too_tight * 5.0)

    return round(score, 1)


def _generate_notes(
    body: BodyVector,
    best_size: SizeOption,
    per_measurement: Dict[str, float],
    stretch: float,
) -> List[str]:
    """Produce human-readable fit notes."""
    notes: List[str] = []

    for key, score in per_measurement.items():
        # key in breakdown is without _cm suffix (e.g. "chest"); body attrs
        # and size_grid measurements use the _cm suffix.
        canonical = key if key.endswith("_cm") else key + "_cm"
        body_val = _body_value(body, canonical)
        garment_val = best_size.measurements.get(canonical)
        if body_val is None or garment_val is None:
            continue

        diff = garment_val - body_val
        label = key.replace("_cm", "").replace("_", " ").title()

        if score < 50:
            if diff < 0:
                notes.append(f"{label} may be too tight ({abs(diff):.1f} cm smaller than body).")
            else:
                notes.append(f"{label} may be too loose ({diff:.1f} cm larger than body).")
        elif score < 75:
            if diff < 0:
                notes.append(f"{label} is slightly snug.")
            elif diff > 5:
                notes.append(f"{label} is somewhat loose -- consider sizing down if you prefer a fitted look.")

    if stretch >= 0.10:
        notes.append("This fabric has good stretch, which adds comfort.")
    elif stretch <= 0.03:
        notes.append("This fabric has minimal stretch -- size accuracy matters more.")

    if not notes:
        notes.append("Good overall fit for this size.")

    return notes


def score_fit(body: BodyVector, item: Item) -> FitScore:
    """Compute the best size and overall fit score for *body* vs *item*.

    Returns a ``FitScore`` with the recommended size, overall 0-100 score,
    per-measurement breakdown, and advisory notes.
    """
    weights = _CATEGORY_WEIGHTS.get(item.category, _TOP_WEIGHTS)
    stretch = _stretch_factor(item.material)

    if not item.size_grid:
        logger.warning("Item %s has no size grid -- returning default score.", item.id)
        return FitScore(
            overall=50,
            recommended_size="N/A",
            breakdown={},
            notes=["No size chart available for this item."],
        )

    best_score = -1.0
    best_size: Optional[SizeOption] = None
    best_breakdown: Dict[str, float] = {}

    for size_opt in item.size_grid:
        per_measurement: Dict[str, float] = {}
        weighted_sum = 0.0
        total_weight = 0.0

        for key, weight in weights.items():
            body_val = _body_value(body, key)
            garment_val = size_opt.measurements.get(key)

            if body_val is None or garment_val is None:
                continue

            ease_min, ease_max = _EASE.get(key, (1.0, 3.0))
            mscore = _score_measurement(body_val, garment_val, ease_min, ease_max, stretch)
            per_measurement[key.replace("_cm", "")] = mscore
            weighted_sum += mscore * weight
            total_weight += weight

        if total_weight > 0:
            overall = weighted_sum / total_weight
        else:
            overall = 50.0  # can't evaluate

        if overall > best_score:
            best_score = overall
            best_size = size_opt
            best_breakdown = per_measurement

    if best_size is None:
        best_size = item.size_grid[0]
        best_score = 50.0

    overall_int = max(0, min(100, int(round(best_score))))
    notes = _generate_notes(body, best_size, best_breakdown, stretch)

    return FitScore(
        overall=overall_int,
        recommended_size=best_size.size_label,
        breakdown=best_breakdown,
        notes=notes,
    )
