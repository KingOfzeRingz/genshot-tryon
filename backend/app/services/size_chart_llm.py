"""LLM-powered size chart extraction using Google Gemini.

Used as a fallback when the deterministic parsers in
``size_chart_parser`` cannot handle a particular brand's markup.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List

import google.generativeai as genai

from app.config import get_settings
from app.models.item import SizeOption

logger = logging.getLogger(__name__)

_MODEL_NAME = "gemini-2.0-flash"

_SYSTEM_PROMPT = """\
You are a structured-data extraction assistant.  Given an HTML snippet that
contains a clothing size chart, extract every size option with its
measurements.

Return ONLY a JSON array where each element has the schema:
{
  "size_label": "<string, e.g. 'M', '40', 'US 10'>",
  "measurements": {
    "<measurement_key>": <number in cm>,
    ...
  }
}

Measurement keys MUST use this naming convention (all in cm):
  chest_cm, waist_cm, hip_cm, shoulder_width_cm, arm_length_cm,
  inseam_cm, thigh_cm, neck_cm, torso_length_cm

If a measurement is given in inches, convert it to centimetres
(multiply by 2.54).

If you cannot find a size chart in the HTML, return an empty JSON array: []

Output ONLY the JSON array -- no markdown fences, no explanation.
"""


def _configure_client() -> None:
    """Ensure the Gemini client is configured with the project's API key / ADC."""
    settings = get_settings()
    try:
        genai.configure(project=settings.GCP_PROJECT_ID)
    except Exception:
        # If Application Default Credentials are set, the library
        # auto-configures.  We log but do not raise.
        logger.debug("genai.configure() call fell through -- relying on ADC.")


async def parse_size_chart_with_llm(
    html_snippet: str,
    brand: str = "",
) -> List[SizeOption]:
    """Send an HTML snippet to Gemini and return structured size options.

    Parameters
    ----------
    html_snippet:
        Raw HTML that is expected to contain a size chart (can be a page
        fragment).
    brand:
        Optional brand name to give the model extra context.

    Returns
    -------
    list[SizeOption]
        Extracted size options.  Returns an empty list on failure.
    """
    _configure_client()

    user_message = f"Brand: {brand}\n\nHTML:\n{html_snippet[:12000]}"

    try:
        model = genai.GenerativeModel(
            _MODEL_NAME,
            system_instruction=_SYSTEM_PROMPT,
        )
        response = model.generate_content(
            user_message,
            generation_config=genai.GenerationConfig(
                temperature=0.0,
                max_output_tokens=4096,
            ),
        )

        raw_text = response.text.strip()
        logger.debug("Gemini raw response (first 500 chars): %s", raw_text[:500])

        # Strip markdown code fences if present
        if raw_text.startswith("```"):
            lines = raw_text.splitlines()
            lines = [l for l in lines if not l.strip().startswith("```")]
            raw_text = "\n".join(lines).strip()

        data: List[Dict[str, Any]] = json.loads(raw_text)
        if not isinstance(data, list):
            logger.warning("Gemini returned non-list JSON; wrapping.")
            data = [data]

        results: List[SizeOption] = []
        for entry in data:
            label = entry.get("size_label", "")
            measurements = entry.get("measurements", {})
            if label and isinstance(measurements, dict):
                # Ensure all values are floats
                clean_measurements: Dict[str, float] = {}
                for k, v in measurements.items():
                    try:
                        clean_measurements[str(k)] = float(v)
                    except (ValueError, TypeError):
                        continue
                if clean_measurements:
                    results.append(
                        SizeOption(size_label=str(label), measurements=clean_measurements)
                    )

        logger.info("Gemini extracted %d size options for brand='%s'", len(results), brand)
        return results

    except json.JSONDecodeError as exc:
        logger.error("Failed to parse Gemini response as JSON: %s", exc)
        return []
    except Exception as exc:
        logger.error("Gemini size chart extraction failed: %s", exc)
        return []
