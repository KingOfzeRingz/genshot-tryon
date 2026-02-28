"""Core body-measurement pipeline.

Uses MediaPipe Pose to extract 33 landmarks from a front-facing photo,
then converts pixel distances to real-world centimetres using the user's
known height.  Circumferences are estimated with anatomical heuristics
(width * pi * gender-specific ratio) or, when a depth map is available,
via an elliptical cross-section model (Ramanujan approximation).
"""

from __future__ import annotations

import io
import logging
import math
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional, Tuple

import mediapipe as mp
import numpy as np
from PIL import Image

from app.models.body import BodyVector

logger = logging.getLogger(__name__)

# ── MediaPipe landmark indices ────────────────────────────────────────
# https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12
LEFT_ELBOW = 13
RIGHT_ELBOW = 14
LEFT_WRIST = 15
RIGHT_WRIST = 16
LEFT_HIP = 23
RIGHT_HIP = 24
LEFT_KNEE = 25
RIGHT_KNEE = 26
LEFT_ANKLE = 27
RIGHT_ANKLE = 28
LEFT_HEEL = 29
RIGHT_HEEL = 30
NOSE = 0
LEFT_EAR = 7
RIGHT_EAR = 8

# ── Gender-specific heuristic ratios ─────────────────────────────────
# These map the visible *front width* to a circumference.
# Circumference ~ front_width * ratio
# Derived from average body proportions in anthropometric studies.

_RATIOS: Dict[str, Dict[str, float]] = {
    "male": {
        "chest": 2.55,
        "waist": 2.50,
        "hip": 2.50,
        "neck": 2.80,
        "thigh": 2.60,
    },
    "female": {
        "chest": 2.60,
        "waist": 2.45,
        "hip": 2.60,
        "neck": 2.75,
        "thigh": 2.55,
    },
    "other": {
        "chest": 2.57,
        "waist": 2.47,
        "hip": 2.55,
        "neck": 2.77,
        "thigh": 2.57,
    },
}


@dataclass
class _Landmark:
    x: float  # normalised [0..1] within image
    y: float
    z: float = 0.0
    visibility: float = 0.0


@dataclass
class _MeasurementResult:
    body_vector: BodyVector = field(default_factory=BodyVector)
    confidence: float = 0.0
    issues: List[str] = field(default_factory=list)


def _pixel_dist(a: _Landmark, b: _Landmark, img_w: int, img_h: int) -> float:
    """Euclidean pixel distance between two landmarks."""
    dx = (a.x - b.x) * img_w
    dy = (a.y - b.y) * img_h
    return math.sqrt(dx * dx + dy * dy)


def _midpoint(a: _Landmark, b: _Landmark) -> _Landmark:
    return _Landmark(
        x=(a.x + b.x) / 2.0,
        y=(a.y + b.y) / 2.0,
        z=(a.z + b.z) / 2.0,
        visibility=min(a.visibility, b.visibility),
    )


def _ramanujan_ellipse_circumference(a: float, b: float) -> float:
    """Approximate circumference of an ellipse (Ramanujan's second approximation).

    Parameters are semi-axes *a* and *b*.
    """
    h = ((a - b) ** 2) / ((a + b) ** 2)
    return math.pi * (a + b) * (1 + (3 * h) / (10 + math.sqrt(4 - 3 * h)))


def _estimate_circumference_heuristic(
    front_width_cm: float,
    body_part: str,
    gender: str,
) -> float:
    """Estimate circumference from a front-view width using gender-specific ratios."""
    ratio = _RATIOS.get(gender, _RATIOS["other"]).get(body_part, 2.5)
    return round(front_width_cm * ratio, 1)


def _estimate_circumference_depth(
    front_half_width_cm: float,
    depth_half_width_cm: float,
) -> float:
    """Estimate circumference using the elliptical model when depth data is available."""
    return round(_ramanujan_ellipse_circumference(front_half_width_cm, depth_half_width_cm), 1)


def _extract_landmarks(image_bytes: bytes) -> Tuple[List[_Landmark], int, int]:
    """Run MediaPipe Pose and return the 33 normalised landmarks + image size."""
    img = Image.open(io.BytesIO(image_bytes))
    if img.mode != "RGB":
        img = img.convert("RGB")
    img_w, img_h = img.size
    img_array = np.array(img)

    mp_pose = mp.solutions.pose
    with mp_pose.Pose(
        static_image_mode=True,
        model_complexity=2,
        min_detection_confidence=0.5,
    ) as pose:
        results = pose.process(img_array)

    if results.pose_landmarks is None:
        raise ValueError("MediaPipe could not detect a pose in the image.")

    landmarks: List[_Landmark] = []
    for lm in results.pose_landmarks.landmark:
        landmarks.append(
            _Landmark(x=lm.x, y=lm.y, z=lm.z, visibility=lm.visibility)
        )

    return landmarks, img_w, img_h


def _compute_pixel_height(
    landmarks: List[_Landmark],
    img_w: int,
    img_h: int,
) -> float:
    """Approximate full-body pixel height from the topmost to bottommost visible points."""
    # Head top estimate: midpoint of ears, shifted up by nose-ear distance
    nose = landmarks[NOSE]
    l_ear = landmarks[LEFT_EAR]
    r_ear = landmarks[RIGHT_EAR]
    head_top_y = nose.y - abs(nose.y - min(l_ear.y, r_ear.y)) * 1.5

    # Foot bottom: lowest heel
    l_heel = landmarks[LEFT_HEEL]
    r_heel = landmarks[RIGHT_HEEL]
    foot_bottom_y = max(l_heel.y, r_heel.y)

    pixel_height = (foot_bottom_y - head_top_y) * img_h
    if pixel_height <= 0:
        # Fallback: shoulder to ankle
        mid_shoulder = _midpoint(landmarks[LEFT_SHOULDER], landmarks[RIGHT_SHOULDER])
        mid_ankle = _midpoint(landmarks[LEFT_ANKLE], landmarks[RIGHT_ANKLE])
        pixel_height = _pixel_dist(mid_shoulder, mid_ankle, img_w, img_h) * 1.3

    return max(pixel_height, 1.0)


def _parse_depth_map(depth_bytes: bytes, img_w: int, img_h: int) -> Optional[np.ndarray]:
    """Attempt to load a depth map as a single-channel image.  Returns None on failure."""
    try:
        depth_img = Image.open(io.BytesIO(depth_bytes)).convert("L")
        depth_img = depth_img.resize((img_w, img_h), Image.LANCZOS)
        return np.array(depth_img, dtype=np.float32)
    except Exception as exc:
        logger.warning("Could not parse depth map: %s", exc)
        return None


def _depth_width_at_landmark(
    depth_map: np.ndarray,
    lm_left: _Landmark,
    lm_right: _Landmark,
    img_w: int,
    img_h: int,
    cm_per_pixel: float,
) -> float:
    """Estimate the depth-axis half-width at a horizontal slice through the body.

    Uses average depth variation across the torso width as a proxy for the
    front-to-back dimension.
    """
    y_px = int(((lm_left.y + lm_right.y) / 2) * img_h)
    x_left = int(lm_left.x * img_w)
    x_right = int(lm_right.x * img_w)
    x_left, x_right = min(x_left, x_right), max(x_left, x_right)

    y_px = max(0, min(y_px, img_h - 1))
    x_left = max(0, x_left)
    x_right = min(x_right, img_w - 1)

    if x_right <= x_left:
        return 0.0

    slice_depths = depth_map[y_px, x_left:x_right + 1]
    depth_range = float(np.max(slice_depths) - np.min(slice_depths))

    # Convert depth-pixel range to cm (rough heuristic: depth pixel range maps
    # linearly to real depth via same scale factor as frontal).
    depth_cm = depth_range * cm_per_pixel * 0.8  # damping factor
    return max(depth_cm / 2.0, 1.0)


def measure_body(
    image_bytes: bytes,
    height_cm: float,
    gender: Literal["male", "female", "other"] = "other",
    depth_map_bytes: Optional[bytes] = None,
) -> _MeasurementResult:
    """Run the full measurement pipeline.

    Parameters
    ----------
    image_bytes:
        JPEG/PNG of a front-facing full-body photo.
    height_cm:
        User's actual height in centimetres.
    gender:
        Used to select heuristic ratios.
    depth_map_bytes:
        Optional depth-map image (single channel).  If provided, circumferences
        are estimated via the elliptical model for improved accuracy.

    Returns
    -------
    _MeasurementResult
        Contains ``body_vector``, ``confidence``, and a list of issues.
    """
    result = _MeasurementResult()

    # 1. Extract landmarks
    try:
        landmarks, img_w, img_h = _extract_landmarks(image_bytes)
    except ValueError as exc:
        logger.error("Pose detection failed: %s", exc)
        result.issues.append(str(exc))
        result.confidence = 0.0
        return result

    # 2. Compute scale factor: cm per pixel
    pixel_height = _compute_pixel_height(landmarks, img_w, img_h)
    cm_per_pixel = height_cm / pixel_height
    logger.debug("pixel_height=%.1f  cm_per_pixel=%.4f", pixel_height, cm_per_pixel)

    # 3. Optionally parse depth map
    depth_map: Optional[np.ndarray] = None
    use_depth = False
    if depth_map_bytes:
        depth_map = _parse_depth_map(depth_map_bytes, img_w, img_h)
        if depth_map is not None:
            use_depth = True
            logger.info("Depth map available -- using elliptical circumference model.")

    # Helper: compute a circumference for a horizontal body slice
    def _circ(
        lm_left: _Landmark,
        lm_right: _Landmark,
        body_part: str,
    ) -> Optional[float]:
        front_width_px = _pixel_dist(lm_left, lm_right, img_w, img_h)
        front_width_cm = front_width_px * cm_per_pixel

        if use_depth and depth_map is not None:
            depth_half = _depth_width_at_landmark(
                depth_map, lm_left, lm_right, img_w, img_h, cm_per_pixel,
            )
            front_half = front_width_cm / 2.0
            return _estimate_circumference_depth(front_half, depth_half)
        else:
            return _estimate_circumference_heuristic(front_width_cm, body_part, gender)

    confidence_factors: List[float] = []

    # 4. Shoulder width (point-to-point, not circumference)
    l_sh = landmarks[LEFT_SHOULDER]
    r_sh = landmarks[RIGHT_SHOULDER]
    if l_sh.visibility > 0.5 and r_sh.visibility > 0.5:
        shoulder_w = _pixel_dist(l_sh, r_sh, img_w, img_h) * cm_per_pixel
        result.body_vector.shoulder_width_cm = round(shoulder_w, 1)
        confidence_factors.append(min(l_sh.visibility, r_sh.visibility))
    else:
        result.issues.append("Shoulders not clearly visible.")

    # 5. Chest: horizontal slice at ~1/4 down from shoulders to hips
    l_hip = landmarks[LEFT_HIP]
    r_hip = landmarks[RIGHT_HIP]
    if l_sh.visibility > 0.4 and r_sh.visibility > 0.4:
        chest_y_frac = l_sh.y + (l_hip.y - l_sh.y) * 0.25
        chest_left = _Landmark(x=l_sh.x, y=chest_y_frac, visibility=l_sh.visibility)
        chest_right = _Landmark(x=r_sh.x, y=chest_y_frac, visibility=r_sh.visibility)
        chest_circ = _circ(chest_left, chest_right, "chest")
        if chest_circ:
            result.body_vector.chest_cm = chest_circ
            confidence_factors.append(0.85)

    # 6. Waist: horizontal slice at ~midpoint between shoulders and hips
    if l_sh.visibility > 0.4 and l_hip.visibility > 0.4:
        waist_y = (l_sh.y + l_hip.y) / 2.0
        # Waist is narrower; interpolate x between shoulder and hip
        waist_left_x = l_sh.x + (l_hip.x - l_sh.x) * 0.5
        waist_right_x = r_sh.x + (r_hip.x - r_sh.x) * 0.5
        waist_left = _Landmark(x=waist_left_x, y=waist_y, visibility=0.8)
        waist_right = _Landmark(x=waist_right_x, y=waist_y, visibility=0.8)
        waist_circ = _circ(waist_left, waist_right, "waist")
        if waist_circ:
            result.body_vector.waist_cm = waist_circ
            confidence_factors.append(0.8)

    # 7. Hip circumference
    if l_hip.visibility > 0.4 and r_hip.visibility > 0.4:
        hip_circ = _circ(l_hip, r_hip, "hip")
        if hip_circ:
            result.body_vector.hip_cm = hip_circ
            confidence_factors.append(min(l_hip.visibility, r_hip.visibility))
    else:
        result.issues.append("Hips not clearly visible.")

    # 8. Neck circumference
    nose = landmarks[NOSE]
    mid_shoulder = _midpoint(l_sh, r_sh)
    if nose.visibility > 0.5 and mid_shoulder.visibility > 0.3:
        # Estimate neck width as ~40% of shoulder width
        neck_half_w = (abs(l_sh.x - r_sh.x) * img_w * 0.20)
        neck_y = (nose.y + mid_shoulder.y) / 2.0
        neck_left = _Landmark(x=mid_shoulder.x - neck_half_w / img_w, y=neck_y)
        neck_right = _Landmark(x=mid_shoulder.x + neck_half_w / img_w, y=neck_y)
        neck_circ = _circ(neck_left, neck_right, "neck")
        if neck_circ:
            result.body_vector.neck_cm = neck_circ
            confidence_factors.append(0.65)

    # 9. Arm length (shoulder -> elbow -> wrist)
    l_elbow = landmarks[LEFT_ELBOW]
    l_wrist = landmarks[LEFT_WRIST]
    r_elbow = landmarks[RIGHT_ELBOW]
    r_wrist = landmarks[RIGHT_WRIST]

    arm_lengths: List[float] = []
    for sh, el, wr, side in [
        (l_sh, l_elbow, l_wrist, "left"),
        (r_sh, r_elbow, r_wrist, "right"),
    ]:
        if sh.visibility > 0.4 and el.visibility > 0.4 and wr.visibility > 0.4:
            upper = _pixel_dist(sh, el, img_w, img_h) * cm_per_pixel
            lower = _pixel_dist(el, wr, img_w, img_h) * cm_per_pixel
            arm_lengths.append(round(upper + lower, 1))
            confidence_factors.append(min(sh.visibility, el.visibility, wr.visibility))

    if arm_lengths:
        result.body_vector.arm_length_cm = round(sum(arm_lengths) / len(arm_lengths), 1)

    # 10. Torso length (mid-shoulder to mid-hip)
    mid_hip = _midpoint(l_hip, r_hip)
    if mid_shoulder.visibility > 0.3 and mid_hip.visibility > 0.3:
        torso_len = _pixel_dist(mid_shoulder, mid_hip, img_w, img_h) * cm_per_pixel
        result.body_vector.torso_length_cm = round(torso_len, 1)
        confidence_factors.append(0.85)

    # 11. Inseam (mid-hip to ankle)
    l_ankle = landmarks[LEFT_ANKLE]
    r_ankle = landmarks[RIGHT_ANKLE]
    inseam_vals: List[float] = []
    for hip, ankle, side in [
        (l_hip, l_ankle, "left"),
        (r_hip, r_ankle, "right"),
    ]:
        if hip.visibility > 0.4 and ankle.visibility > 0.4:
            inseam_vals.append(_pixel_dist(hip, ankle, img_w, img_h) * cm_per_pixel)
            confidence_factors.append(min(hip.visibility, ankle.visibility))
    if inseam_vals:
        result.body_vector.inseam_cm = round(sum(inseam_vals) / len(inseam_vals), 1)

    # 12. Thigh circumference
    l_knee = landmarks[LEFT_KNEE]
    r_knee = landmarks[RIGHT_KNEE]
    thigh_circs: List[float] = []
    for hip, knee, side in [
        (l_hip, l_knee, "left"),
        (r_hip, r_knee, "right"),
    ]:
        if hip.visibility > 0.4 and knee.visibility > 0.4:
            thigh_y = hip.y + (knee.y - hip.y) * 0.3
            half_thigh_w = abs(hip.x - knee.x) * 0.6
            th_left = _Landmark(x=hip.x - half_thigh_w, y=thigh_y)
            th_right = _Landmark(x=hip.x + half_thigh_w, y=thigh_y)
            tc = _circ(th_left, th_right, "thigh")
            if tc:
                thigh_circs.append(tc)
    if thigh_circs:
        result.body_vector.thigh_cm = round(sum(thigh_circs) / len(thigh_circs), 1)
        confidence_factors.append(0.7)

    # 13. Aggregate confidence
    if confidence_factors:
        result.confidence = round(sum(confidence_factors) / len(confidence_factors), 2)
    else:
        result.confidence = 0.1
        result.issues.append("Very few landmarks detected with sufficient confidence.")

    # Boost confidence when depth is available
    if use_depth:
        result.confidence = min(1.0, round(result.confidence * 1.15, 2))

    logger.info(
        "Body measurement complete: confidence=%.2f  issues=%d",
        result.confidence,
        len(result.issues),
    )
    return result
