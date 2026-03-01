"""Lightweight image helpers (resize, base64 encode/decode, face crop)."""

from __future__ import annotations

import base64
import io
import logging
from typing import Optional

from PIL import Image, ImageOps

logger = logging.getLogger(__name__)


def resize_image(image_bytes: bytes, max_size: int = 1024) -> bytes:
    """Resize an image so its longest side is at most *max_size* pixels.

    The image is returned as PNG bytes.  If the image is already within the
    size limit it is re-encoded but not scaled.
    """
    img = Image.open(io.BytesIO(image_bytes))
    # Apply EXIF orientation so portrait photos keep their intended rotation.
    img = ImageOps.exif_transpose(img)

    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")

    width, height = img.size
    if max(width, height) > max_size:
        scale = max_size / max(width, height)
        new_width = int(width * scale)
        new_height = int(height * scale)
        img = img.resize((new_width, new_height), Image.LANCZOS)
        logger.debug("Resized image from %dx%d to %dx%d", width, height, new_width, new_height)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def crop_face(
    image_bytes: bytes,
    padding: float = 0.4,
    max_size: int = 512,
) -> Optional[bytes]:
    """Extract a zoomed-in face crop from *image_bytes*.

    Uses MediaPipe face detection (full-range model) to locate the most
    prominent face, expands the bounding box by *padding* on each side,
    crops, and resizes so the longest edge is at most *max_size* pixels.

    Returns PNG bytes on success, ``None`` if no face is detected or on
    any error so the caller can fall back gracefully.
    """
    try:
        import numpy as np  # noqa: lazy
        import mediapipe as mp  # noqa: lazy

        img = Image.open(io.BytesIO(image_bytes))
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")

        img_np = np.array(img)
        w, h = img.size  # PIL uses (width, height)

        with mp.solutions.face_detection.FaceDetection(
            model_selection=1, min_detection_confidence=0.5
        ) as face_det:
            results = face_det.process(img_np)

        if not results or not results.detections:
            logger.info("crop_face: no face detected")
            return None

        # Use the first (highest-confidence) detection
        bbox = results.detections[0].location_data.relative_bounding_box
        # MediaPipe bbox: xmin, ymin, width, height (all relative 0-1)
        bx, by, bw, bh = bbox.xmin, bbox.ymin, bbox.width, bbox.height

        # Expand by padding
        pad_w = bw * padding
        pad_h = bh * padding
        x1 = max(0, bx - pad_w)
        y1 = max(0, by - pad_h)
        x2 = min(1.0, bx + bw + pad_w)
        y2 = min(1.0, by + bh + pad_h)

        # Convert to pixel coords
        left = int(x1 * w)
        upper = int(y1 * h)
        right = int(x2 * w)
        lower = int(y2 * h)

        cropped = img.crop((left, upper, right, lower))

        # Resize if larger than max_size
        cw, ch = cropped.size
        if max(cw, ch) > max_size:
            scale = max_size / max(cw, ch)
            cropped = cropped.resize(
                (int(cw * scale), int(ch * scale)), Image.LANCZOS
            )

        buf = io.BytesIO()
        cropped.save(buf, format="PNG", optimize=True)
        crop_bytes = buf.getvalue()
        logger.info("Face crop extracted: %d bytes", len(crop_bytes))
        return crop_bytes

    except Exception as exc:
        logger.warning("crop_face failed, continuing without face crop: %s", exc)
        return None


def image_to_base64(image_bytes: bytes) -> str:
    """Encode raw image bytes to a standard base64 string."""
    return base64.b64encode(image_bytes).decode("utf-8")


def base64_to_image(b64: str) -> bytes:
    """Decode a base64 string back to raw image bytes.

    Accepts both plain base64 and data-URI prefixed strings
    (``data:image/png;base64,...``).
    """
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    return base64.b64decode(b64)
