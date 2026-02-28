"""Core reference image generator.

Takes the user's raw photo and generates a clean studio-quality reference:
the same person wearing plain white basic clothing on a neutral studio
background. This core image is then used as the base for all virtual
try-on generations.

Primary: REVE API (POST /v1/image/remix)
Fallback: Google Gemini via google-genai SDK
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import uuid
from typing import Optional

import httpx
from google import genai
from google.genai.types import GenerateContentConfig, Modality, Part

from app.config import get_settings
from app.models.body import BodyVector
from app.services.storage import upload_image
from app.utils.image_processing import resize_image

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

def _format_measurement(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    return f"{value:.1f}"


def _build_measurement_hint(
    *,
    body_vector: Optional[BodyVector],
    height_cm: Optional[float],
    weight_kg: Optional[float],
    gender: Optional[str],
) -> str:
    hints: list[str] = []

    if gender:
        hints.append(f"gender presentation {gender}")
    if _format_measurement(height_cm):
        hints.append(f"height {_format_measurement(height_cm)} cm")
    if _format_measurement(weight_kg):
        hints.append(f"weight {_format_measurement(weight_kg)} kg")

    if body_vector:
        shoulder = body_vector.shoulder_width_cm or body_vector.shoulder_cm
        measured = [
            ("chest", body_vector.chest_cm),
            ("waist", body_vector.waist_cm),
            ("hip", body_vector.hip_cm),
            ("shoulder width", shoulder),
            ("arm length", body_vector.arm_length_cm),
            ("inseam", body_vector.inseam_cm),
            ("torso length", body_vector.torso_length_cm),
            ("neck", body_vector.neck_cm),
            ("thigh", body_vector.thigh_cm),
        ]
        for label, value in measured:
            formatted = _format_measurement(value)
            if formatted:
                hints.append(f"{label} {formatted} cm")

    if not hints:
        return ""

    return (
        "Use these body parameters to match this person's real proportions and silhouette: "
        + ", ".join(hints)
        + "."
    )


def _build_reve_prompt(
    *,
    body_vector: Optional[BodyVector],
    height_cm: Optional[float],
    weight_kg: Optional[float],
    gender: Optional[str],
) -> str:
    measurement_hint = _build_measurement_hint(
        body_vector=body_vector,
        height_cm=height_cm,
        weight_kg=weight_kg,
        gender=gender,
    )
    base_prompt = (
        "<img>0</img> Generate a photorealistic full-body studio portrait of this exact person. "
        "They are wearing a plain white fitted crew-neck t-shirt and light grey fitted trousers. "
        "Full body shot, front-facing, arms slightly away from body. "
        "Clean solid neutral grey studio background. Soft even studio lighting. "
        "CRITICAL: preserve face, hairstyle, skin tone, body shape exactly. "
        "The person has a warm, confident, natural smile with a relaxed pleasant expression. "
        "High resolution, editorial fashion photography quality."
    )
    if measurement_hint:
        return f"{base_prompt} {measurement_hint}"
    return base_prompt


def _build_gemini_prompt(
    *,
    body_vector: Optional[BodyVector],
    height_cm: Optional[float],
    weight_kg: Optional[float],
    gender: Optional[str],
) -> str:
    measurement_hint = _build_measurement_hint(
        body_vector=body_vector,
        height_cm=height_cm,
        weight_kg=weight_kg,
        gender=gender,
    )
    prompt = (
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
        "- The person has a warm, confident, natural smile with a relaxed pleasant expression.\n"
        "- Natural relaxed pose, looking straight at the camera.\n"
        "- High resolution, editorial quality.\n"
        "- Output only the image, no text or overlays."
    )
    if measurement_hint:
        return f"{prompt}\n- {measurement_hint}"
    return prompt

# ---------------------------------------------------------------------------
# REVE API generation
# ---------------------------------------------------------------------------


def _generate_via_reve(
    reference_bytes: bytes,
    prompt: str,
) -> Optional[bytes]:
    """Call the REVE API to generate a core studio image.

    Uses the documented Remix payload with base64-encoded ``reference_images``.

    Returns image bytes or ``None`` on failure.
    """
    settings = get_settings()
    if not settings.REVE_API_KEY:
        logger.info("REVE_API_KEY not configured, skipping REVE generation.")
        return None

    b64_ref = base64.b64encode(reference_bytes).decode("ascii")

    payload = {
        "prompt": prompt,
        "reference_images": [b64_ref],
        "aspect_ratio": settings.REVE_REMIX_ASPECT_RATIO,
        "version": settings.REVE_REMIX_VERSION,
    }
    if settings.REVE_TEST_TIME_SCALING > 1:
        payload["test_time_scaling"] = settings.REVE_TEST_TIME_SCALING

    try:
        logger.info(
            "Core image generation attempt: provider=reve, endpoint=%s",
            settings.REVE_API_URL,
        )
        resp = httpx.post(
            settings.REVE_API_URL,
            json=payload,
            headers={
                "Authorization": f"Bearer {settings.REVE_API_KEY}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            timeout=90.0,
        )
        request_id_header = resp.headers.get("X-Reve-Request-Id")

        if resp.status_code != 200:
            error_code = ""
            error_message = resp.text[:500] if resp.text else ""
            try:
                err_json = resp.json()
                error_code = str(err_json.get("error_code") or "")
                error_message = str(err_json.get("message") or error_message)
            except Exception:
                pass
            logger.warning(
                "REVE API HTTP error: status=%s request_id=%s error_code=%s message=%s",
                resp.status_code,
                request_id_header or "<none>",
                error_code or "<none>",
                error_message or "<empty>",
            )
            return None

        data = resp.json()
        request_id = str(data.get("request_id") or request_id_header or "<none>")
        violation_raw = data.get("content_violation")
        if violation_raw is None:
            violation_raw = resp.headers.get("X-Reve-Content-Violation")
        content_violation = str(violation_raw).lower() == "true"
        if content_violation:
            logger.warning(
                "REVE returned content violation for core image request_id=%s",
                request_id,
            )
            return None

        image_b64 = data.get("image")
        if not image_b64:
            logger.warning(
                "REVE API returned success without image payload: request_id=%s keys=%s",
                request_id,
                list(data.keys()),
            )
            return None

        try:
            image_bytes = base64.b64decode(image_b64, validate=True)
        except binascii.Error:
            image_bytes = base64.b64decode(image_b64)

        logger.info(
            "Core image from REVE API: request_id=%s bytes=%d credits_used=%s version=%s",
            request_id,
            len(image_bytes),
            data.get("credits_used"),
            data.get("version"),
        )
        if not image_bytes:
            logger.warning("REVE returned empty image bytes for request_id=%s", request_id)
            return None
        return image_bytes

    except ValueError as exc:
        logger.warning("REVE API response decode failed: %s", _format_model_error(exc))
        return None

    except httpx.TimeoutException:
        logger.warning("REVE API timed out after 90s.")
        return None
    except Exception as exc:
        logger.warning("REVE API call failed: %s", _format_model_error(exc))
        return None


# ---------------------------------------------------------------------------
# Gemini fallback generation
# ---------------------------------------------------------------------------

_gemini_client: Optional[genai.Client] = None


def _get_gemini_client() -> genai.Client:
    global _gemini_client
    if _gemini_client is not None:
        return _gemini_client
    settings = get_settings()
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", settings.GCP_PROJECT_ID)
    os.environ.setdefault("GOOGLE_CLOUD_LOCATION", settings.VERTEX_IMAGE_LOCATION)
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "True")
    _gemini_client = genai.Client()
    logger.info(
        "Core image fallback client initialised: provider=google, project=%s, location=%s",
        settings.GCP_PROJECT_ID,
        settings.VERTEX_IMAGE_LOCATION,
    )
    return _gemini_client


def _generate_via_gemini(reference_bytes: bytes, prompt: str) -> Optional[bytes]:
    """Fallback: generate core image via Gemini.

    Returns PNG bytes or ``None`` on failure.
    """
    client = _get_gemini_client()
    settings = get_settings()
    models_to_try = settings.core_image_models
    if not models_to_try:
        logger.error("Core image generation has no configured Gemini models.")
        return None

    image_part = Part.from_bytes(data=reference_bytes, mime_type="image/png")

    for mname in models_to_try:
        try:
            logger.info(
                "Core image fallback attempt: provider=google, model=%s, location=%s",
                mname,
                settings.VERTEX_IMAGE_LOCATION,
            )
            response = client.models.generate_content(
                model=mname,
                contents=[image_part, prompt],
                config=GenerateContentConfig(
                    temperature=0.3,
                    response_modalities=[Modality.TEXT, Modality.IMAGE],
                ),
            )

            if response.candidates:
                for part in response.candidates[0].content.parts:
                    if part.inline_data and part.inline_data.data:
                        data = part.inline_data.data
                        logger.info(
                            "Core image fallback success: provider=google, model=%s, bytes=%d",
                            mname,
                            len(data),
                        )
                        return data

            logger.warning(
                "Core image fallback produced no image: provider=google, model=%s",
                mname,
            )
        except Exception as exc:
            logger.warning(
                "Core image fallback failed: provider=google, model=%s, error=%s",
                mname,
                _format_model_error(exc),
            )
            continue

    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _format_model_error(exc: Exception) -> str:
    exc_name = type(exc).__name__
    message = str(exc).strip()
    message = " ".join(message.split())
    if len(message) > 240:
        message = f"{message[:240]}..."
    return f"{exc_name}: {message}" if message else exc_name


def _generate_core(
    reference_bytes: bytes,
    *,
    body_vector: Optional[BodyVector] = None,
    height_cm: Optional[float] = None,
    weight_kg: Optional[float] = None,
    gender: Optional[str] = None,
) -> Optional[bytes]:
    """Generate a core studio image — REVE first, then Gemini fallback.

    Returns image bytes or ``None`` on failure.
    """
    # Try REVE API first
    reve_prompt = _build_reve_prompt(
        body_vector=body_vector,
        height_cm=height_cm,
        weight_kg=weight_kg,
        gender=gender,
    )
    result = _generate_via_reve(reference_bytes, prompt=reve_prompt)
    if result is not None:
        logger.info("Core image provider selected: provider=reve, fallback_used=false")
        return result

    # Fallback to Gemini
    logger.info(
        "Core image provider fallback: primary=reve, secondary=google, reason=primary_failed_or_unavailable"
    )
    gemini_prompt = _build_gemini_prompt(
        body_vector=body_vector,
        height_cm=height_cm,
        weight_kg=weight_kg,
        gender=gender,
    )
    return _generate_via_gemini(reference_bytes, prompt=gemini_prompt)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def generate_core_image(
    user_id: str,
    reference_photo_url: str,
    body_vector: Optional[BodyVector] = None,
    height_cm: Optional[float] = None,
    weight_kg: Optional[float] = None,
    gender: Optional[str] = None,
) -> Optional[str]:
    """Generate a core reference image and upload it to GCS.

    Returns the public GCS URL or ``None`` on failure.
    """
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

    # Generate a body-aware core portrait.
    core_bytes = _generate_core(
        ref_bytes,
        body_vector=body_vector,
        height_cm=height_cm,
        weight_kg=weight_kg,
        gender=gender,
    )
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
