"""Firebase ID-token verification."""

from __future__ import annotations

import logging

from firebase_admin import auth as firebase_auth

logger = logging.getLogger(__name__)


class FirebaseAuthError(Exception):
    """Raised when a Firebase token cannot be verified."""


async def verify_firebase_token(token: str) -> dict:
    """Verify a Firebase ID token and return the decoded claims.

    Parameters
    ----------
    token:
        The raw Firebase ID token (JWT) sent by the client.

    Returns
    -------
    dict
        Decoded token payload.  At minimum contains ``uid``, ``email``,
        ``name``, etc.

    Raises
    ------
    FirebaseAuthError
        If the token is invalid, expired or revoked.
    """
    try:
        decoded = firebase_auth.verify_id_token(token)
        uid = decoded.get("uid")
        if not uid:
            raise FirebaseAuthError("Token does not contain a uid claim.")
        logger.debug("Verified Firebase token for uid=%s", uid)
        return decoded
    except firebase_auth.InvalidIdTokenError as exc:
        logger.warning("Invalid Firebase token: %s", exc)
        raise FirebaseAuthError(f"Invalid token: {exc}") from exc
    except firebase_auth.ExpiredIdTokenError as exc:
        logger.warning("Expired Firebase token: %s", exc)
        raise FirebaseAuthError(f"Expired token: {exc}") from exc
    except firebase_auth.RevokedIdTokenError as exc:
        logger.warning("Revoked Firebase token: %s", exc)
        raise FirebaseAuthError(f"Revoked token: {exc}") from exc
    except firebase_auth.CertificateFetchError as exc:
        logger.error("Could not fetch Firebase certificates: %s", exc)
        raise FirebaseAuthError(f"Certificate fetch error: {exc}") from exc
    except Exception as exc:
        logger.error("Unexpected error verifying Firebase token: %s", exc)
        raise FirebaseAuthError(f"Verification failed: {exc}") from exc
