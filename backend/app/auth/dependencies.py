"""FastAPI dependency functions for authentication."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.firebase_auth import FirebaseAuthError, verify_firebase_token

logger = logging.getLogger(__name__)

_bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
) -> str:
    """Extract and verify the Bearer token, returning the Firebase UID.

    Raises ``401`` if the token is missing or invalid.
    """
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        decoded = await verify_firebase_token(credentials.credentials)
        uid: str = decoded["uid"]
        return uid
    except FirebaseAuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


async def optional_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
) -> Optional[str]:
    """Same as ``get_current_user`` but returns ``None`` when no token is supplied.

    Useful for endpoints that work with or without authentication.
    """
    if credentials is None or not credentials.credentials:
        return None

    try:
        decoded = await verify_firebase_token(credentials.credentials)
        return decoded["uid"]
    except FirebaseAuthError:
        return None
