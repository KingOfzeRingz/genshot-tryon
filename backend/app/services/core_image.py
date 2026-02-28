"""Core reference image generator.

Takes the user's raw photo and generates a clean studio-quality reference:
the same person wearing plain white basic clothing on a neutral studio
background. This core image is then used as the base for all virtual
try-on generations.

Uses the google-genai SDK with response_modalities for native image output.
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Optional

from google import genai
from google.genai.types import GenerateContentConfig, Modality, Part

from app.config import get_settings
from app.services.storage import upload_image
from app.utils.image_processing import resize_image

logger = logging.getLogger(__name__)

_CORE_IMAGE_PROMPT = (
    "You are a professional fashion photography studio system. "
    "Generate a single photorealistic studio portrait of the EXACT same person "
    "shown in the reference photo. "
    "\n\n"
    "REQUIREMENTS:\n"
    "- The person must wear a plain white fitted crew-neck t-shirt and "
    "simple neutral-toned fitted trousers (light grey or beige).\n"
    "- Full body shot from head to mid-shin, front-facing, arms slightly "
    "away from the body so the silhouette is clear.\n"
    "- Clean, solid neutral grey studio background (#E0E0E0).\n"
    "- Soft, even studio lighting — no harsh shadows.\n"
    "- CRITICAL: preserve the person's face, hairstyle, skin tone, body shape, "
    "and proportions EXACTLY as in the reference photo.\n"
    "- Natural relaxed pose, looking straight at the camera.\n"
    "- High resolution, editorial quality.\n"
    "- Output only the image, no text or overlays."
)

_client: Optional[genai.Client] = None


def _get_client() -> genai.Client:
    global _client
    if _client is not None:
        return _client
    settings = get_settings()
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", settings.GCP_PROJECT_ID)
    os.environ.setdefault("GOOGLE_CLOUD_LOCATION", settings.VERTEX_LOCATION)
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "True")
    _client = genai.Client()
    return _client


def _format_model_error(exc: Exception) -> str:
    exc_name = type(exc).__name__
    message = str(exc).strip()
    message = " ".join(message.split())
    if len(message) > 240:
        message = f"{message[:240]}..."
    return f"{exc_name}: {message}" if message else exc_name


def _generate_core(reference_bytes: bytes) -> Optional[bytes]:
    """Generate a core studio image from the raw reference photo.

    Returns PNG bytes or ``None`` on failure.
    """
    client = _get_client()
    settings = get_settings()
    models_to_try = settings.CORE_IMAGE_MODELS
    if not models_to_try:
        logger.error("Core image generation has no configured models.")
        return None

    image_part = Part.from_bytes(data=reference_bytes, mime_type="image/png")

    for mname in models_to_try:
        try:
            logger.info("Core image generation: trying %s", mname)
            response = client.models.generate_content(
                model=mname,
                contents=[image_part, _CORE_IMAGE_PROMPT],
                config=GenerateContentConfig(
                    temperature=0.3,
                    response_modalities=[Modality.TEXT, Modality.IMAGE],
                ),
            )

            if response.candidates:
                for part in response.candidates[0].content.parts:
                    if part.inline_data and part.inline_data.data:
                        data = part.inline_data.data
                        logger.info("Core image from %s: %d bytes", mname, len(data))
                        return data

            logger.warning("%s returned no image for core generation.", mname)
        except Exception as exc:
            logger.warning("Core image generation with %s failed: %s", mname, _format_model_error(exc))
            continue

    return None


async def generate_core_image(
    user_id: str,
    reference_photo_url: str,
) -> Optional[str]:
    """Generate a core reference image and upload it to GCS.

    Returns the public GCS URL or ``None`` on failure.
    """
    import httpx

    settings = get_settings()

    # Download original reference photo
    try:
        resp = httpx.get(reference_photo_url, timeout=30.0, follow_redirects=True)
        resp.raise_for_status()
        raw_bytes = resp.content
    except Exception as exc:
        logger.error("Failed to download reference photo for core image: %s", exc)
        return None

    # Resize for the model
    ref_bytes = resize_image(raw_bytes, max_size=1024)

    # Generate
    core_bytes = _generate_core(ref_bytes)
    if core_bytes is None:
        logger.error("Core image generation failed for user %s.", user_id)
        return None

    # Upload to GCS
    filename = f"{uuid.uuid4().hex[:12]}.png"
    gcs_path = f"users/{user_id}/core/{filename}"
    try:
        public_url = upload_image(
            settings.GCS_BUCKET,
            gcs_path,
            core_bytes,
            "image/png",
        )
        logger.info("Core image uploaded for user %s: %s", user_id, public_url)
        return public_url
    except Exception as exc:
        logger.error("Failed to upload core image: %s", exc)
        return None
