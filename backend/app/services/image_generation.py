"""Virtual try-on image generation orchestrator.

Uses Gemini models via Vertex AI with native image generation capabilities:
  - Primary:  gemini-3.1-pro-preview  (best quality)
  - Backup:   gemini-3-pro-preview
  - Fallback: Vertex AI Imagen 3 (front view only)

Each model is tried in order; the first successful result is used.
"""

from __future__ import annotations

import io
import logging
import uuid
from typing import List, Optional

import vertexai
from vertexai.generative_models import GenerativeModel, GenerationConfig, Part, Image
from PIL import Image as PILImage

from app.config import get_settings
from app.models.body import BodyVector
from app.models.item import Item
from app.models.user import UserProfile
from app.services.storage import upload_image
from app.utils.image_processing import resize_image

logger = logging.getLogger(__name__)

# Ordered by preference — first working model wins.
_GEMINI_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
]

_vertexai_initialized = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ensure_vertexai() -> None:
    """Initialise the Vertex AI SDK once."""
    global _vertexai_initialized
    if _vertexai_initialized:
        return
    settings = get_settings()
    vertexai.init(
        project=settings.GCP_PROJECT_ID,
        location=settings.VERTEX_LOCATION,
    )
    _vertexai_initialized = True
    logger.info("Vertex AI initialised (project=%s, location=%s)",
                settings.GCP_PROJECT_ID, settings.VERTEX_LOCATION)


def _download_reference_photo(url: str) -> bytes:
    """Download the user's reference photo from a public / signed URL."""
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


def _build_body_description(body: BodyVector) -> str:
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


# ---------------------------------------------------------------------------
# Gemini native image generation via Vertex AI
# ---------------------------------------------------------------------------

def _generate_with_gemini(
    reference_bytes: bytes,
    garment_description: str,
    body_description: str,
    angle: str = "front-facing",
    model_name: Optional[str] = None,
) -> Optional[bytes]:
    """Generate a try-on image via Gemini native image generation.

    Tries each model in ``_GEMINI_MODELS`` until one succeeds, or uses
    the specific *model_name* if provided.

    Returns PNG bytes or ``None`` on failure.
    """
    _ensure_vertexai()

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

    # Build the image part from raw bytes
    image_part = Part.from_data(data=reference_bytes, mime_type="image/png")

    models_to_try = [model_name] if model_name else _GEMINI_MODELS

    for mname in models_to_try:
        try:
            logger.info("Attempting image generation with %s (%s)", mname, angle)
            model = GenerativeModel(mname)
            response = model.generate_content(
                [image_part, prompt],
                generation_config=GenerationConfig(
                    temperature=0.4,
                    max_output_tokens=8192,
                    response_mime_type="image/png",
                ),
            )

            # Extract inline image from response parts
            if response.candidates:
                for part in response.candidates[0].content.parts:
                    if part.inline_data and part.inline_data.data:
                        data = part.inline_data.data
                        if isinstance(data, str):
                            import base64
                            data = base64.b64decode(data)
                        logger.info("Got image from %s (%s): %d bytes", mname, angle, len(data))
                        return data

            logger.warning("%s returned no inline image for %s angle.", mname, angle)

        except Exception as exc:
            logger.warning("Image generation with %s failed (%s): %s", mname, angle, exc)
            continue

    return None


# ---------------------------------------------------------------------------
# Vertex AI Imagen fallback
# ---------------------------------------------------------------------------

def _try_vertex_imagen(
    reference_bytes: bytes,
    garment_description: str,
    body_description: str,
) -> Optional[bytes]:
    """Fallback: Vertex AI Imagen 3 for front-facing try-on."""
    try:
        _ensure_vertexai()

        from vertexai.preview.vision_models import ImageGenerationModel

        model = ImageGenerationModel.from_pretrained("imagen-3.0-generate-001")
        prompt = (
            f"Virtual try-on: dress the person in {garment_description}. "
            f"The person has these proportions: {body_description}. "
            "Photorealistic result, natural lighting, front-facing view. "
            "Keep the person's face, hairstyle, and skin tone exactly the same."
        )
        response = model.generate_images(prompt=prompt, number_of_images=1)

        if response.images:
            img = response.images[0]
            buf = io.BytesIO()
            img._pil_image.save(buf, format="PNG")
            return buf.getvalue()

        logger.warning("Imagen returned no images.")
        return None
    except ImportError:
        logger.info("vertexai vision_models not available for Imagen.")
        return None
    except Exception as exc:
        logger.warning("Vertex Imagen failed: %s", exc)
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
      1. Front-facing image  — Gemini 3.1 Pro → Gemini 3 Pro → Imagen
      2. 45-degree image     — Gemini 3.1 Pro → Gemini 3 Pro
      3. Close-up detail     — Gemini 3.1 Pro → Gemini 3 Pro

    Returns a list of public GCS URLs.  Partial results are returned
    when some views fail.
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

    urls: List[str] = []
    gen_id = uuid.uuid4().hex[:12]

    # ── Front-facing image ────────────────────────────────────────────
    front_bytes = _generate_with_gemini(ref_bytes, garment_desc, body_desc, angle="front-facing")
    if front_bytes is None:
        # Fallback to Vertex AI Imagen
        front_bytes = _try_vertex_imagen(ref_bytes, garment_desc, body_desc)

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
