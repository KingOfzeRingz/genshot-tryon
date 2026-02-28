"""Deterministic HTML size-chart parsers for popular brands.

Each parser accepts raw HTML (or a relevant snippet) and returns a list
of ``SizeOption`` objects.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional

from bs4 import BeautifulSoup, Tag

from app.models.item import SizeOption

logger = logging.getLogger(__name__)

# ── Helpers ───────────────────────────────────────────────────────────

_CM_PATTERN = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:cm)?", re.IGNORECASE)


def _extract_number(text: str) -> Optional[float]:
    """Pull the first numeric value from *text*."""
    m = _CM_PATTERN.search(text.replace(",", "."))
    if m:
        return float(m.group(1))
    return None


def _normalise_key(raw: str) -> str:
    """Map a measurement label to a canonical ``_cm`` key.

    E.g. ``"Chest"`` -> ``"chest_cm"``, ``"Hip"`` -> ``"hip_cm"``.
    """
    key = raw.strip().lower()
    mapping = {
        "chest": "chest_cm",
        "bust": "chest_cm",
        "waist": "waist_cm",
        "hip": "hip_cm",
        "hips": "hip_cm",
        "shoulder": "shoulder_width_cm",
        "shoulders": "shoulder_width_cm",
        "shoulder width": "shoulder_width_cm",
        "arm length": "arm_length_cm",
        "sleeve": "arm_length_cm",
        "sleeve length": "arm_length_cm",
        "inseam": "inseam_cm",
        "inside leg": "inseam_cm",
        "thigh": "thigh_cm",
        "neck": "neck_cm",
        "length": "torso_length_cm",
        "body length": "torso_length_cm",
        "torso": "torso_length_cm",
    }
    for label, canonical in mapping.items():
        if label in key:
            return canonical
    return key.replace(" ", "_") + "_cm"


# ── Generic table parser ─────────────────────────────────────────────

def _parse_table(table: Tag) -> List[SizeOption]:
    """Parse an HTML ``<table>`` where the first column is the size label
    and the header row contains measurement names."""
    rows = table.find_all("tr")
    if len(rows) < 2:
        return []

    # Header
    headers: List[str] = []
    header_cells = rows[0].find_all(["th", "td"])
    for cell in header_cells:
        headers.append(cell.get_text(strip=True))

    if not headers:
        return []

    results: List[SizeOption] = []
    for row in rows[1:]:
        cells = row.find_all(["td", "th"])
        if not cells:
            continue
        size_label = cells[0].get_text(strip=True)
        if not size_label:
            continue

        measurements: Dict[str, float] = {}
        for i, cell in enumerate(cells[1:], start=1):
            if i >= len(headers):
                break
            val = _extract_number(cell.get_text(strip=True))
            if val is not None:
                key = _normalise_key(headers[i])
                measurements[key] = val

        if measurements:
            results.append(SizeOption(size_label=size_label, measurements=measurements))

    return results


def _parse_all_tables(html: str) -> List[SizeOption]:
    """Find all tables in *html* and parse them.  Return the first non-empty result."""
    soup = BeautifulSoup(html, "html.parser")
    for table in soup.find_all("table"):
        options = _parse_table(table)
        if options:
            return options
    return []


# ── Brand-specific parsers ────────────────────────────────────────────

def parse_zara_size_chart(html: str) -> List[SizeOption]:
    """Parse Zara's product-page size chart HTML.

    Zara often uses ``<div class="size-chart">`` or structured ``<table>``
    elements.  We first try table parsing, then fall back to a div-based
    approach.
    """
    # Try generic table
    options = _parse_all_tables(html)
    if options:
        return options

    # Fallback: Zara sometimes uses repeated div blocks
    soup = BeautifulSoup(html, "html.parser")
    size_blocks = soup.find_all("div", class_=re.compile(r"size", re.IGNORECASE))
    results: List[SizeOption] = []

    for block in size_blocks:
        label_el = block.find(class_=re.compile(r"label|name|size", re.IGNORECASE))
        if not label_el:
            continue
        label = label_el.get_text(strip=True)
        if not label or len(label) > 20:
            continue

        measurements: Dict[str, float] = {}
        rows = block.find_all(class_=re.compile(r"row|measure|value", re.IGNORECASE))
        for row in rows:
            text = row.get_text(" ", strip=True)
            for known_label in [
                "chest", "bust", "waist", "hip", "shoulder",
                "sleeve", "inseam", "thigh", "neck", "length",
            ]:
                if known_label in text.lower():
                    val = _extract_number(text)
                    if val:
                        measurements[_normalise_key(known_label)] = val
        if measurements:
            results.append(SizeOption(size_label=label, measurements=measurements))

    return results


def parse_hm_size_chart(html: str) -> List[SizeOption]:
    """Parse H&M's product-page size chart HTML.

    H&M typically renders a standard ``<table>`` or ``<dl>`` structure.
    """
    # Try generic table first
    options = _parse_all_tables(html)
    if options:
        return options

    # Fallback: H&M sometimes uses definition lists
    soup = BeautifulSoup(html, "html.parser")
    dls = soup.find_all("dl")
    results: List[SizeOption] = []

    for dl in dls:
        dts = dl.find_all("dt")
        dds = dl.find_all("dd")
        if len(dts) != len(dds):
            continue

        current_label = ""
        measurements: Dict[str, float] = {}

        for dt, dd in zip(dts, dds):
            key_text = dt.get_text(strip=True).lower()
            val_text = dd.get_text(strip=True)

            if "size" in key_text:
                if current_label and measurements:
                    results.append(SizeOption(size_label=current_label, measurements=measurements))
                current_label = val_text
                measurements = {}
            else:
                val = _extract_number(val_text)
                if val is not None:
                    measurements[_normalise_key(key_text)] = val

        if current_label and measurements:
            results.append(SizeOption(size_label=current_label, measurements=measurements))

    return results


def detect_and_parse(html: str, brand: str = "") -> List[SizeOption]:
    """Route to the most appropriate parser based on the brand name.

    Falls back to generic table parsing if the brand is unknown.
    """
    brand_lower = brand.lower().strip()

    if "zara" in brand_lower:
        logger.info("Using Zara-specific parser")
        return parse_zara_size_chart(html)
    if "h&m" in brand_lower or "hm" in brand_lower:
        logger.info("Using H&M-specific parser")
        return parse_hm_size_chart(html)

    # Generic fallback
    logger.info("Using generic table parser for brand='%s'", brand)
    options = _parse_all_tables(html)
    if options:
        return options

    logger.warning("No size chart data found in HTML for brand='%s'", brand)
    return []
