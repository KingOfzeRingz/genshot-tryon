"""Virtual try-on image generation orchestrator.

Uses a two-stage pipeline for consistency:
1) Generate internal reference outfit images (front + profile)
2) Generate final multi-angle outputs conditioned on those references
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

from google import genai
from google.genai.types import GenerateContentConfig, Modality, Part

from app.config import get_settings
from app.models.body import BodyVector
from app.models.item import Item
from app.models.user import UserProfile
from app.services.storage import upload_image
from app.utils.image_processing import crop_face, resize_image

logger = logging.getLogger(__name__)

_client: Optional[genai.Client] = None
_executor = ThreadPoolExecutor(max_workers=4)

_INTERNAL_REFERENCE_ANGLES: List[Tuple[str, str]] = [
    ("front", "full body front-facing, head to feet, neutral stance"),
    ("profile", "full body right-side profile, neutral stance"),
]

_FINAL_ANGLE_INSTRUCTIONS: Dict[str, str] = {
    "front": "full body front-facing, head to feet, natural neutral pose",
    "profile": "full body side profile, head to feet, natural neutral pose",
    "three_quarter": "full body 45-degree three-quarter view, natural pose",
    "back": "full body back-facing, head to feet, natural neutral pose",
}


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


def _download_image(url: str) -> Optional[bytes]:
    """Download an image. Returns None on failure."""
    import httpx

    try:
        resp = httpx.get(url, timeout=30.0, follow_redirects=True)
        resp.raise_for_status()
        return resp.content if resp.content else None
    except Exception as exc:
        logger.warning("Image download failed: url=%s error=%s", url[:120], exc)
        return None


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
    if user and user.gender:
        lines.append(user.gender)

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

    shoulder = body.shoulder_width_cm or body.shoulder_cm
    if shoulder:
        lines.append(f"shoulder width {shoulder} cm")
    if body.torso_length_cm:
        lines.append(f"torso length {body.torso_length_cm} cm")
    if body.arm_length_cm:
        lines.append(f"arm length {body.arm_length_cm} cm")
    if body.inseam_cm:
        lines.append(f"inseam {body.inseam_cm} cm")
    if body.neck_cm:
        lines.append(f"neck {body.neck_cm} cm")
    if body.thigh_cm:
        lines.append(f"thigh {body.thigh_cm} cm")

    return ", ".join(lines) if lines else "average build"


def _sanitize_final_angles(final_angles: Optional[List[str]]) -> List[str]:
    if not final_angles:
        return ["front", "profile", "three_quarter", "back"]

    ordered: List[str] = []
    for angle in final_angles:
        key = angle.lower().strip()
        if key in _FINAL_ANGLE_INSTRUCTIONS and key not in ordered:
            ordered.append(key)

    return ordered or ["front", "profile", "three_quarter", "back"]


def _generate_with_gemini(
    reference_images: List[bytes],
    garment_images: List[Tuple[Item, bytes]],
    garment_description: str,
    body_description: str,
    angle_name: str,
    angle_instruction: str,
    stage: str,
    has_face_crop: bool = False,
) -> Optional[bytes]:
    """Generate an image with Gemini image models.

    ``stage`` is either ``internal_reference`` or ``final_tryon``.
    When *has_face_crop* is True the prompt tells the model that the first
    reference image is a close-up face crop for identity anchoring.
    """
    client = _get_client()
    settings = get_settings()

    face_anchor = (
        "The first provided image is a close-up face and head-shoulders reference "
        "of the person — use it as a strict anchor for facial identity, skin tone, "
        "facial features, and hairstyle across every generated angle. "
        if has_face_crop
        else ""
    )

    if stage == "internal_reference":
        prompt = (
            f"{face_anchor}"
            "Generate a photorealistic reference image of the person wearing the requested clothes. "
            f"Use this camera framing: {angle_instruction}. "
            f"Garments: {garment_description}. "
            f"Body measurements and proportions: {body_description}. "
            "Keep face, body shape, and identity exactly consistent with the provided person reference image. "
            "Natural studio lighting, neutral background, no text."
        )
    else:
        prompt = (
            f"{face_anchor}"
            "Generate a photorealistic final virtual try-on image using the provided internal reference images "
            "as strict consistency anchors for face, body shape, clothing fit, and garment details. "
            f"Camera framing: {angle_instruction}. "
            f"Garments: {garment_description}. "
            f"Body measurements and proportions: {body_description}. "
            "Keep identity and fit fully consistent across all angles. "
            "Natural studio lighting, neutral background, no text."
        )

    contents: List[Any] = [
        Part.from_bytes(data=image_bytes, mime_type="image/png")
        for image_bytes in reference_images
    ]
    for _item, image_bytes in garment_images:
        contents.append(Part.from_bytes(data=image_bytes, mime_type="image/png"))
    contents.append(prompt)

    models_to_try = settings.tryon_image_models
    if not models_to_try:
        logger.error("Try-on generation has no configured models.")
        return None

    total = len(models_to_try)
    for idx, model_name in enumerate(models_to_try, start=1):
        try:
            logger.info(
                "Try-on attempt: stage=%s model=%s angle=%s attempt=%d/%d",
                stage,
                model_name,
                angle_name,
                idx,
                total,
            )
            response = client.models.generate_content(
                model=model_name,
                contents=contents,
                config=GenerateContentConfig(
                    temperature=0.35,
                    response_modalities=[Modality.TEXT, Modality.IMAGE],
                ),
            )

            if response.candidates:
                for part in response.candidates[0].content.parts:
                    if part.inline_data and part.inline_data.data:
                        data = part.inline_data.data
                        logger.info(
                            "Try-on success: stage=%s model=%s angle=%s bytes=%d",
                            stage,
                            model_name,
                            angle_name,
                            len(data),
                        )
                        return data

            logger.warning(
                "Try-on no image returned: stage=%s model=%s angle=%s",
                stage,
                model_name,
                angle_name,
            )
        except Exception as exc:
            logger.warning(
                "Try-on failed: stage=%s model=%s angle=%s error=%s",
                stage,
                model_name,
                angle_name,
                _format_model_error(exc),
            )
            continue

    return None


async def _generate_angle_batch(
    reference_images: List[bytes],
    garment_images: List[Tuple[Item, bytes]],
    garment_description: str,
    body_description: str,
    angle_defs: List[Tuple[str, str]],
    stage: str,
    has_face_crop: bool = False,
) -> Dict[str, bytes]:
    """Generate a batch of angles concurrently."""
    loop = asyncio.get_running_loop()

    async def _run_angle(angle_name: str, instruction: str) -> Tuple[str, Optional[bytes]]:
        image = await loop.run_in_executor(
            _executor,
            lambda: _generate_with_gemini(
                reference_images,
                garment_images,
                garment_description,
                body_description,
                angle_name,
                instruction,
                stage,
                has_face_crop,
            ),
        )
        return angle_name, image

    tasks = [_run_angle(name, instruction) for name, instruction in angle_defs]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    images_by_angle: Dict[str, bytes] = {}
    for result in results:
        if isinstance(result, BaseException):
            logger.error("Angle generation exception (%s): %s", stage, result)
            continue
        angle_name, image_bytes = result
        if image_bytes:
            images_by_angle[angle_name] = image_bytes
        else:
            logger.warning("No generated image for stage=%s angle=%s", stage, angle_name)

    # Retry any missing angles (one at a time to avoid model overload)
    missing = [
        (name, instr) for name, instr in angle_defs
        if name not in images_by_angle
    ]
    for angle_name, instruction in missing:
        logger.info("Retrying failed angle: stage=%s angle=%s", stage, angle_name)
        retry_name, retry_bytes = await _run_angle(angle_name, instruction)
        if retry_bytes:
            images_by_angle[retry_name] = retry_bytes
        else:
            logger.warning("Retry also failed for stage=%s angle=%s", stage, angle_name)

    return images_by_angle


def _upload_image_set(
    user_id: str,
    gen_id: str,
    stage_prefix: str,
    ordered_angles: List[str],
    images_by_angle: Dict[str, bytes],
) -> List[Dict[str, str]]:
    uploaded: List[Dict[str, str]] = []

    for angle_name in ordered_angles:
        image_bytes = images_by_angle.get(angle_name)
        if image_bytes is None:
            continue

        path = f"generations/{user_id}/{gen_id}_{stage_prefix}_{angle_name}.png"
        try:
            url = upload_image(get_settings().GCS_BUCKET, path, image_bytes, "image/png")
            uploaded.append({"angle": angle_name, "url": url})
        except Exception as exc:
            logger.error("Upload failed: stage=%s angle=%s error=%s", stage_prefix, angle_name, exc)

    return uploaded


async def generate_tryon_images(
    user: UserProfile,
    items: List[Item],
    body_vector: BodyVector,
    final_angles: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Generate virtual try-on images using a two-stage consistency pipeline.

    Returns
    -------
    Dict with keys:
      - internal_reference_images: [{angle, url}]
      - final_images: [{angle, url}]
      - final_image_urls: [url]
      - body_vector_used: dict
      - final_angles: [angle]
    """
    settings = get_settings()
    if not settings.tryon_image_models:
        raise ValueError("TRYON_IMAGE_MODELS is required and must contain at least one model id.")

    logger.info(
        "Try-on generation start: user=%s items=%d models=%s",
        user.uid,
        len(items),
        settings.tryon_image_models,
    )

    if not user.reference_photo_url:
        logger.error("User %s has no reference photo.", user.uid)
        return {
            "internal_reference_images": [],
            "final_images": [],
            "final_image_urls": [],
            "body_vector_used": body_vector.model_dump(exclude_none=True),
            "final_angles": _sanitize_final_angles(final_angles),
        }

    reference_raw = _download_image(user.reference_photo_url)
    if reference_raw is None:
        logger.error("Failed to download reference photo for user %s.", user.uid)
        return {
            "internal_reference_images": [],
            "final_images": [],
            "final_image_urls": [],
            "body_vector_used": body_vector.model_dump(exclude_none=True),
            "final_angles": _sanitize_final_angles(final_angles),
        }

    try:
        base_reference = resize_image(reference_raw, max_size=1024)
    except Exception as exc:
        logger.error("Failed to resize reference photo: %s", exc)
        return {
            "internal_reference_images": [],
            "final_images": [],
            "final_image_urls": [],
            "body_vector_used": body_vector.model_dump(exclude_none=True),
            "final_angles": _sanitize_final_angles(final_angles),
        }

    # Extract face crop for identity anchoring
    face_crop = crop_face(base_reference, padding=0.4, max_size=512)
    has_face = face_crop is not None
    if has_face:
        logger.info("Face crop extracted for user %s: %d bytes", user.uid, len(face_crop))
    else:
        logger.info("No face crop available for user %s, using full-body only", user.uid)

    garment_images: List[Tuple[Item, bytes]] = []
    for item in items:
        if not item.image_url:
            continue
        image = _download_image(item.image_url)
        if image:
            try:
                image = resize_image(image, max_size=768)
            except Exception:
                pass
            garment_images.append((item, image))

    garment_desc = _build_garment_description(items)
    body_desc = _build_body_description(body_vector, user=user)
    final_angle_list = _sanitize_final_angles(final_angles)
    gen_id = uuid.uuid4().hex[:12]

    logger.info(
        "Try-on context: garment_images=%d/%d body=%s final_angles=%s",
        len(garment_images),
        len(items),
        body_desc[:140],
        final_angle_list,
    )

    # Stage A: internal references (front + profile)
    stage_a_refs = ([face_crop] + [base_reference]) if has_face else [base_reference]
    internal_by_angle = await _generate_angle_batch(
        reference_images=stage_a_refs,
        garment_images=garment_images,
        garment_description=garment_desc,
        body_description=body_desc,
        angle_defs=_INTERNAL_REFERENCE_ANGLES,
        stage="internal_reference",
        has_face_crop=has_face,
    )

    internal_order = [angle for angle, _ in _INTERNAL_REFERENCE_ANGLES]
    internal_uploaded = _upload_image_set(
        user.uid,
        gen_id,
        "internal",
        internal_order,
        internal_by_angle,
    )

    internal_refs: List[bytes] = []
    if "front" in internal_by_angle:
        internal_refs.append(internal_by_angle["front"])
    if "profile" in internal_by_angle:
        internal_refs.append(internal_by_angle["profile"])
    if not internal_refs:
        internal_refs = [base_reference]

    # Stage B: final outputs based on internal references
    stage_b_refs = ([face_crop] if has_face else []) + internal_refs
    final_defs = [(angle, _FINAL_ANGLE_INSTRUCTIONS[angle]) for angle in final_angle_list]
    final_by_angle = await _generate_angle_batch(
        reference_images=stage_b_refs,
        garment_images=garment_images,
        garment_description=garment_desc,
        body_description=body_desc,
        angle_defs=final_defs,
        stage="final_tryon",
        has_face_crop=has_face,
    )

    final_uploaded = _upload_image_set(
        user.uid,
        gen_id,
        "final",
        final_angle_list,
        final_by_angle,
    )

    logger.info(
        "Try-on generation complete: user=%s internal_refs=%d final=%d",
        user.uid,
        len(internal_uploaded),
        len(final_uploaded),
    )

    return {
        "internal_reference_images": internal_uploaded,
        "final_images": final_uploaded,
        "final_image_urls": [entry["url"] for entry in final_uploaded],
        "body_vector_used": body_vector.model_dump(exclude_none=True),
        "final_angles": final_angle_list,
    }
