"""Firestore CRUD helpers.

All functions operate on a Firestore client initialised by
``firebase_admin``.  Supports named databases via the
``FIRESTORE_DATABASE`` setting.  Collections used:

- ``users``            -- user profiles
- ``users/{uid}/items`` -- per-user wardrobe items (sub-collection)
- ``import_sessions``  -- temporary import sessions
- ``generations``      -- try-on generation jobs
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import firebase_admin
from google.cloud import firestore as gc_firestore
from google.cloud.firestore_v1 import DocumentReference, DocumentSnapshot

from app.config import get_settings

logger = logging.getLogger(__name__)

_firestore_client = None


def _db():
    """Return the Firestore client, using a named database if configured."""
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client

    settings = get_settings()
    db_id = settings.FIRESTORE_DATABASE

    # Use the named database via the google-cloud-firestore Client directly
    # so we can pass the `database` parameter.
    app = firebase_admin.get_app()
    credentials = app.credential.get_credential()
    _firestore_client = gc_firestore.Client(
        project=settings.GCP_PROJECT_ID,
        credentials=credentials,
        database=db_id,
    )
    logger.info("Firestore client initialised (project=%s, database=%s)", settings.GCP_PROJECT_ID, db_id)
    return _firestore_client


# ── Users ─────────────────────────────────────────────────────────────

def get_user(uid: str) -> Optional[Dict[str, Any]]:
    """Return the user document or ``None``."""
    doc: DocumentSnapshot = _db().collection("users").document(uid).get()
    if doc.exists:
        data = doc.to_dict()
        data["uid"] = doc.id
        return data
    return None


def create_or_update_user(uid: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Create or merge-update a user document.  Returns the written data."""
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    ref: DocumentReference = _db().collection("users").document(uid)
    if not ref.get().exists:
        data.setdefault("created_at", datetime.now(timezone.utc).isoformat())
    ref.set(data, merge=True)
    logger.info("Upserted user %s", uid)
    result = ref.get().to_dict()
    result["uid"] = uid
    return result


# ── Items (sub-collection under user) ────────────────────────────────

def _items_col(uid: str):
    return _db().collection("users").document(uid).collection("items")


def get_items_for_user(uid: str) -> List[Dict[str, Any]]:
    """Return all wardrobe items for a user."""
    docs = _items_col(uid).order_by("created_at").stream()
    items: List[Dict[str, Any]] = []
    for doc in docs:
        item = doc.to_dict()
        item["id"] = doc.id
        items.append(item)
    return items


def get_item(uid: str, item_id: str) -> Optional[Dict[str, Any]]:
    """Return a single item or ``None``."""
    doc = _items_col(uid).document(item_id).get()
    if doc.exists:
        data = doc.to_dict()
        data["id"] = doc.id
        return data
    return None


def add_item_to_user(uid: str, item: Dict[str, Any]) -> Dict[str, Any]:
    """Add an item to the user's wardrobe.  Returns the item with its id."""
    item["created_at"] = datetime.now(timezone.utc).isoformat()
    ref = _items_col(uid).document()
    ref.set(item)
    item["id"] = ref.id
    logger.info("Added item %s to user %s", ref.id, uid)
    return item


def remove_item(uid: str, item_id: str) -> bool:
    """Delete an item.  Returns ``True`` if it existed."""
    ref = _items_col(uid).document(item_id)
    doc = ref.get()
    if not doc.exists:
        return False
    ref.delete()
    logger.info("Removed item %s from user %s", item_id, uid)
    return True


# ── Import Sessions ──────────────────────────────────────────────────

def create_import_session(data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new import session and return it with its generated id."""
    data["created_at"] = datetime.now(timezone.utc).isoformat()
    data.setdefault("status", "pending")
    ref = _db().collection("import_sessions").document()
    ref.set(data)
    data["id"] = ref.id
    logger.info("Created import session %s", ref.id)
    return data


def get_import_session(sid: str) -> Optional[Dict[str, Any]]:
    """Return an import session or ``None``."""
    doc = _db().collection("import_sessions").document(sid).get()
    if doc.exists:
        data = doc.to_dict()
        data["id"] = doc.id
        return data
    return None


def update_import_session(sid: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Merge-update an import session."""
    ref = _db().collection("import_sessions").document(sid)
    ref.set(data, merge=True)
    result = ref.get().to_dict()
    result["id"] = sid
    return result


# ── Generations ──────────────────────────────────────────────────────

def create_generation(data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a generation record and return it with its id."""
    data["created_at"] = datetime.now(timezone.utc).isoformat()
    data.setdefault("status", "pending")
    ref = _db().collection("generations").document()
    ref.set(data)
    data["id"] = ref.id
    logger.info("Created generation %s", ref.id)
    return data


def get_generation(gen_id: str) -> Optional[Dict[str, Any]]:
    """Return a single generation or ``None``."""
    doc = _db().collection("generations").document(gen_id).get()
    if doc.exists:
        data = doc.to_dict()
        data["id"] = doc.id
        return data
    return None


def update_generation(gen_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Merge-update a generation record."""
    ref = _db().collection("generations").document(gen_id)
    ref.set(data, merge=True)
    result = ref.get().to_dict()
    result["id"] = gen_id
    return result


def get_generations_for_user(uid: str) -> List[Dict[str, Any]]:
    """Return all generations for a user, newest first."""
    docs = (
        _db()
        .collection("generations")
        .where("user_id", "==", uid)
        .order_by("created_at", direction=gc_firestore.Query.DESCENDING)
        .stream()
    )
    results: List[Dict[str, Any]] = []
    for doc in docs:
        item = doc.to_dict()
        item["id"] = doc.id
        results.append(item)
    return results
