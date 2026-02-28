"""Virtual try-on image generation orchestrator.

Attempts to use Vertex AI Imagen for the primary front-facing try-on image
and falls back to Gemini image generation when Imagen is unavailable.
A second, 45-degree angle image is always generated via Gemini.
"""

from __future__ import annotations

import io
import logging
import uuid
from typing import List, Optional

import google.generativeai as genai
from google.cloud import storage as gcs

from app.config import get_settings
from app.models.body import BodyVector
from app.models.item import Item
from app.models.user import UserProfile
from app.services.storage import upload_image
from app.utils.image_processing import image_to_base64, resize_image

logger = logging.getLogger(__name__)

_GEMINI_MODEL = "gemini-2.0-flash-exp"


def _configure_genai() -> None:
    settings = get_settings()
    try:
        genai.configure(project=settings.GCP_PROJECT_ID)
    except Exception:
        logger.debug("genai.configure() fell through -- using ADC.")


def _download_reference_photo(url: str) -> bytes:
    """Download the user's reference photo from GCS (public URL) or signed URL."""
    import httpx

    resp = httpx.get(url, timeout=30.0, follow_redirects=True)
    resp.raise_for_status()
    return resp.content


def _build_garment_description(items: List[Item]) -> str:
    """Create a natural-language description of the garments for the prompt."""
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


def _build_body_description(body: BodyVector) -> str:
    """Summarise the body proportions for the image generation prompt."""
    lines: List[str] = []
    if body.chest_cm:
        lines.append(f"chest {body.chest_cm} cm")
    if body.waist_cm:
        lines.append(f"waist {body.waist_cm} cm")
    if body.hip_cm:
        lines.append(f"hip {body.hip_cm} cm")
    if body.shoulder_width_cm:
        lines.append(f"shoulder width {body.shoulder_width_cm} cm")
    if body.torso_length_cm:
        lines.append(f"torso length {body.torso_length_cm} cm")
    if body.arm_length_cm:
        lines.append(f"arm length {body.arm_length_cm} cm")
    if body.inseam_cm:
        lines.append(f"inseam {body.inseam_cm} cm")
    return ", ".join(lines) if lines else "average build"


def _try_vertex_imagen(
    reference_bytes: bytes,
    garment_description: str,
    body_description: str,
) -> Optional[bytes]:
    """Attempt Vertex AI Imagen virtual try-on.

    Returns generated image bytes or None if Imagen is unavailable.
    """
    try:
        from google.cloud import aiplatform

        settings = get_settings()
        aiplatform.init(
            project=settings.GCP_PROJECT_ID,
            location=settings.VERTEX_LOCATION,
        )

        # Vertex AI Imagen edit / virtual-try-on endpoint
        from vertexai.preview.vision_models import ImageGenerationModel

        model = ImageGenerationModel.from_pretrained("imagen-3.0-generate-001")
        prompt = (
            f"Virtual try-on: dress the person in {garment_description}. "
            f"The person has these proportions: {body_description}. "
            "Photorealistic result, natural lighting, front-facing view. "
            "Keep the person's face, hairstyle, and skin tone exactly the same."
        )
        response = model.generate_images(
            prompt=prompt,
            number_of_images=1,
        )

        if response.images:
            img = response.images[0]
            buf = io.BytesIO()
            img._pil_image.save(buf, format="PNG")
            return buf.getvalue()

        logger.warning("Imagen returned no images.")
        return None
    except ImportError:
        logger.info("vertexai package not available for Imagen try-on.")
        return None
    except Exception as exc:
        logger.warning("Vertex Imagen try-on failed: %s", exc)
        return None


def _generate_with_gemini(
    reference_b64: str,
    garment_description: str,
    body_description: str,
    angle: str = "front-facing",
) -> Optional[bytes]:
    """Generate a try-on image via Gemini multimodal generation.

    Returns PNG bytes or None on failure.
    """
    _configure_genai()

    prompt = (
        f"Generate a photorealistic virtual try-on image. "
        f"The person in the reference photo should be shown wearing: {garment_description}. "
        f"Body proportions: {body_description}. "
        f"Camera angle: {angle} view. "
        f"Keep the person's face, hairstyle, skin tone, and body shape exactly the same as in the reference. "
        f"Natural studio lighting, clean background. High quality fashion photography style."
    )

    try:
        model = genai.GenerativeModel(_GEMINI_MODEL)
        response = model.generate_content(
            [
                {"mime_type": "image/png", "data": reference_b64},
                prompt,
            ],
            generation_config=genai.GenerationConfig(
                temperature=0.4,
                max_output_tokens=8192,
            ),
        )

        # Gemini image generation returns inline images in parts
        for part in response.parts:
            if hasattr(part, "inline_data") and part.inline_data:
                return part.inline_data.data

        # If no inline image, the model may have returned only text
        logger.warning("Gemini did not return an inline image for %s angle.", angle)
        return None

    except Exception as exc:
        logger.error("Gemini image generation failed (%s angle): %s", angle, exc)
        return None


async def generate_tryon_images(
    user: UserProfile,
    items: List[Item],
    body_vector: BodyVector,
) -> List[str]:
    """Generate virtual try-on images and upload them to GCS.

    Returns a list of public image URLs.  Partial results are returned
    when some generations fail.
    """
    settings = get_settings()
    garment_desc = _build_garment_description(items)
    body_desc = _build_body_description(body_vector)

    # Download & resize reference photo
    if not user.reference_photo_url:
        logger.error("User %s has no reference photo.", user.uid)
        return []

    try:
        ref_bytes = _download_reference_photo(user.reference_photo_url)
        ref_bytes = resize_image(ref_bytes, max_size=1024)
    except Exception as exc:
        logger.error("Failed to fetch reference photo: %s", exc)
        return []

    ref_b64 = image_to_base64(ref_bytes)
    urls: List[str] = []
    gen_id = uuid.uuid4().hex[:12]

    # ── Front-facing image ────────────────────────────────────────────
    front_bytes = _try_vertex_imagen(ref_bytes, garment_desc, body_desc)
    if front_bytes is None:
        front_bytes = _generate_with_gemini(ref_b64, garment_desc, body_desc, angle="front-facing")

    if front_bytes:
        path = f"generations/{user.uid}/{gen_id}_front.png"
        url = upload_image(settings.GCS_BUCKET, path, front_bytes, "image/png")
        urls.append(url)
        logger.info("Uploaded front try-on image: %s", url)
    else:
        logger.warning("Front-facing image generation failed entirely.")

    # ── 45-degree angle image (always Gemini) ─────────────────────────
    side_bytes = _generate_with_gemini(
        ref_b64, garment_desc, body_desc, angle="45-degree three-quarter"
    )
    if side_bytes:
        path = f"generations/{user.uid}/{gen_id}_side.png"
        url = upload_image(settings.GCS_BUCKET, path, side_bytes, "image/png")
        urls.append(url)
        logger.info("Uploaded 45-degree try-on image: %s", url)
    else:
        logger.warning("45-degree image generation failed.")

    return urls
