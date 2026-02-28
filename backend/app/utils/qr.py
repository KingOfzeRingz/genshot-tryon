"""QR / HMAC utilities for import sessions."""

from __future__ import annotations

import hashlib
import hmac
import logging
from urllib.parse import urlencode

logger = logging.getLogger(__name__)


def sign_session(session_id: str, secret: str) -> str:
    """Produce an HMAC-SHA256 hex digest for *session_id*."""
    return hmac.new(
        secret.encode("utf-8"),
        session_id.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_signature(session_id: str, sig: str, secret: str) -> bool:
    """Verify an HMAC signature using constant-time comparison."""
    expected = sign_session(session_id, secret)
    return hmac.compare_digest(expected, sig)


def generate_qr_payload(session_id: str, sig: str) -> str:
    """Return a deep-link URI for the mobile app.

    Format: ``genshot-fit://import?sid=<session_id>&sig=<sig>``
    """
    params = urlencode({"sid": session_id, "sig": sig})
    return f"genshot-fit://import?{params}"
