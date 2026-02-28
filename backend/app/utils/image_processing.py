"""Lightweight image helpers (resize, base64 encode/decode)."""

from __future__ import annotations

import base64
import io
import logging

from PIL import Image

logger = logging.getLogger(__name__)


def resize_image(image_bytes: bytes, max_size: int = 1024) -> bytes:
    """Resize an image so its longest side is at most *max_size* pixels.

    The image is returned as PNG bytes.  If the image is already within the
    size limit it is re-encoded but not scaled.
    """
    img = Image.open(io.BytesIO(image_bytes))

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
