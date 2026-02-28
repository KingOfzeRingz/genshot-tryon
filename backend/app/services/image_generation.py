"""Virtual try-on image generation orchestrator.

Uses the google-genai SDK with Vertex AI backend for native image generation.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import List, Optional

from google import genai
from google.genai.types import GenerateContentConfig, Modality, Part

from app.config import get_settings
from app.models.body import BodyVector
from app.models.item import Item
from app.models.user import UserProfile
from app.services.storage import upload_image
from app.utils.image_processing import resize_image

logger = logging.getLogger(__name__)

_client: Optional[genai.Client] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_client() -> genai.Client:
    """Return a cached genai Client configured for Vertex AI."""
    global _client
    if _client is not None:
        return _client
    settings = get_settings()
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", settings.GCP_PROJECT_ID)
    os.environ.setdefault("GOOGLE_CLOUD_LOCATION", settings.VERTEX_IMAGE_LOCATION)
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "True")
    _client = genai.Client()
    logger.info(
        "google-genai client initialised (project=%s, location=%s)",
        settings.GCP_PROJECT_ID,
        settings.VERTEX_IMAGE_LOCATION,
    )
    return _client


def _format_model_error(exc: Exception) -> str:
    exc_name = type(exc).__name__
    message = str(exc).strip()
    message = " ".join(message.split())
    if len(message) > 240:
        message = f"{message[:240]}..."
    return f"{exc_name}: {message}" if message else exc_name


def _download_reference_photo(url: str) -> bytes:
    import httpx
    resp = httpx.get(url, timeout=30.0, follow_redirects=True)
    resp.raise_for_status()
    return resp.content


def _build_garment_description(items: List[Item]) -> str:
    parts: List[str] = []
    for item in items:
        desc = item.name
        if item.brand:
            desc = f"{item.brand} {desc}"
        if item.color:
            desc = f"{item.color} {desc}"
        if item.material:
            desc += f" ({item.material})"
        parts.append(desc)
    return ", ".join(parts)


def _build_body_description(body: BodyVector, user: Optional[UserProfile] = None) -> str:
    lines: List[str] = []
    effective_height = body.height_cm or (user.height_cm if user else None)
    if effective_height:
        lines.append(f"height {effective_height} cm")
    if user and user.weight_kg:
        lines.append(f"weight {user.weight_kg} kg")
    if body.chest_cm:
        lines.append(f"chest {body.chest_cm} cm")
    if body.waist_cm:
        lines.append(f"waist {body.waist_cm} cm")
    if body.hip_cm:
        lines.append(f"hip {body.hip_cm} cm")
    shoulder_width = body.shoulder_width_cm or body.shoulder_cm
    if shoulder_width:
        lines.append(f"shoulder width {shoulder_width} cm")
    if body.torso_length_cm:
        lines.append(f"torso length {body.torso_length_cm} cm")
    if body.arm_length_cm:
        lines.append(f"arm length {body.arm_length_cm} cm")
    if body.inseam_cm:
        lines.append(f"inseam {body.inseam_cm} cm")
    return ", ".join(lines) if lines else "average build"


# ---------------------------------------------------------------------------
# Gemini native image generation via google-genai
# ---------------------------------------------------------------------------

def _generate_with_gemini(
    reference_bytes: bytes,
    garment_description: str,
    body_description: str,
    angle: str = "front-facing",
    model_name: Optional[str] = None,
) -> Optional[bytes]:
    """Generate a try-on image via Gemini native image generation.

    Returns PNG bytes or ``None`` on failure.
    """
    client = _get_client()

    prompt = (
        "You are a virtual try-on system. Generate a single photorealistic image "
        "of the person in the reference photo wearing the following clothing: "
        f"{garment_description}. "
        f"Body proportions: {body_description}. "
        f"Camera angle: {angle} view. "
        "CRITICAL: preserve the person's face, hairstyle, skin tone, and body shape "
        "exactly as in the reference photo. "
        "Natural studio lighting, clean neutral background. "
        "High-quality editorial fashion photography style. "
        "Output only the image, no text."
    )

    image_part = Part.from_bytes(data=reference_bytes, mime_type="image/png")

    settings = get_settings()
    models_to_try = [model_name] if model_name else settings.tryon_image_models
    if not models_to_try:
        logger.error("Try-on image generation has no configured models.")
        return None

    total_models = len(models_to_try)
    for index, mname in enumerate(models_to_try, start=1):
        try:
            logger.info(
                "Try-on generation attempt: provider=google, model=%s, location=%s, angle=%s, attempt=%d/%d",
                mname,
                settings.VERTEX_IMAGE_LOCATION,
                angle,
                index,
                total_models,
            )
            response = client.models.generate_content(
                model=mname,
                contents=[image_part, prompt],
                config=GenerateContentConfig(
                    temperature=0.4,
                    response_modalities=[Modality.TEXT, Modality.IMAGE],
                ),
            )

            if response.candidates:
                for part in response.candidates[0].content.parts:
                    if part.inline_data and part.inline_data.data:
                        data = part.inline_data.data
                        logger.info(
                            "Try-on generation success: provider=google, model=%s, angle=%s, bytes=%d",
                            mname,
                            angle,
                            len(data),
                        )
                        return data

            logger.warning(
                "Try-on generation returned no inline image: provider=google, model=%s, angle=%s",
                mname,
                angle,
            )

        except Exception as exc:
            logger.warning(
                "Try-on generation failed: provider=google, model=%s, angle=%s, error=%s",
                mname,
                angle,
                _format_model_error(exc),
            )
            if index < total_models:
                logger.info(
                    "Try-on generation fallback: angle=%s, next_attempt=%d/%d",
                    angle,
                    index + 1,
                    total_models,
                )
            continue

    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def generate_tryon_images(
    user: UserProfile,
    items: List[Item],
    body_vector: BodyVector,
) -> List[str]:
    """Generate virtual try-on images and upload them to GCS.

    Pipeline:
      1. Front-facing image  — configured Google model chain
      2. 45-degree image     — configured Google model chain
      3. Close-up detail     — configured Google model chain

    Returns a list of public GCS URLs.
    """
    settings = get_settings()
    if not settings.tryon_image_models:
        raise ValueError(
            "TRYON_IMAGE_MODELS is required and must contain at least one model id."
        )

    logger.info(
        "Try-on generation run config: user=%s, models=%s, location=%s",
        user.uid,
        settings.tryon_image_models,
        settings.VERTEX_IMAGE_LOCATION,
    )

    garment_desc = _build_garment_description(items)
    body_desc = _build_body_description(body_vector, user=user)

    if not user.reference_photo_url:
        logger.error("User %s has no reference photo.", user.uid)
        return []

    try:
        ref_bytes = _download_reference_photo(user.reference_photo_url)
        ref_bytes = resize_image(ref_bytes, max_size=1024)
    except Exception as exc:
        logger.error("Failed to fetch reference photo: %s", exc)
        return []

    urls: List[str] = []
    gen_id = uuid.uuid4().hex[:12]

    # ── Front-facing image ────────────────────────────────────────────
    front_bytes = _generate_with_gemini(ref_bytes, garment_desc, body_desc, angle="front-facing")
    if front_bytes:
        path = f"generations/{user.uid}/{gen_id}_front.png"
        url = upload_image(settings.GCS_BUCKET, path, front_bytes, "image/png")
        urls.append(url)
        logger.info("Uploaded front try-on image: %s", url)
    else:
        logger.warning("Front-facing image generation failed entirely.")

    # ── 45-degree angle image ─────────────────────────────────────────
    side_bytes = _generate_with_gemini(
        ref_bytes, garment_desc, body_desc, angle="45-degree three-quarter"
    )
    if side_bytes:
        path = f"generations/{user.uid}/{gen_id}_side.png"
        url = upload_image(settings.GCS_BUCKET, path, side_bytes, "image/png")
        urls.append(url)
        logger.info("Uploaded 45-degree try-on image: %s", url)
    else:
        logger.warning("45-degree image generation failed.")

    # ── Close-up detail image ─────────────────────────────────────────
    detail_bytes = _generate_with_gemini(
        ref_bytes, garment_desc, body_desc,
        angle="close-up torso detail showing fabric texture and fit"
    )
    if detail_bytes:
        path = f"generations/{user.uid}/{gen_id}_detail.png"
        url = upload_image(settings.GCS_BUCKET, path, detail_bytes, "image/png")
        urls.append(url)
        logger.info("Uploaded detail try-on image: %s", url)
    else:
        logger.warning("Detail image generation failed.")

    return urls
