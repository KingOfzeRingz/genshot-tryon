"""Google Cloud Storage helpers."""

from __future__ import annotations

import datetime
import logging
from typing import Optional

from google.cloud import storage as gcs

logger = logging.getLogger(__name__)

_client: Optional[gcs.Client] = None


def _get_client() -> gcs.Client:
    global _client
    if _client is None:
        _client = gcs.Client()
    return _client


def upload_image(
    bucket_name: str,
    path: str,
    image_bytes: bytes,
    content_type: str = "image/png",
) -> str:
    """Upload raw image bytes to GCS and return the public URL.

    Parameters
    ----------
    bucket_name:
        Name of the GCS bucket.
    path:
        Object path inside the bucket (e.g. ``users/abc/ref.png``).
    image_bytes:
        Raw bytes of the image.
    content_type:
        MIME type.  Defaults to ``image/png``.

    Returns
    -------
    str
        The public URL of the uploaded object.
    """
    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(path)
    blob.upload_from_string(image_bytes, content_type=content_type)
    blob.make_public()
    logger.info("Uploaded image to gs://%s/%s", bucket_name, path)
    return blob.public_url


def upload_file(
    bucket_name: str,
    path: str,
    file,  # SpooledTemporaryFile / file-like
    content_type: str = "application/octet-stream",
) -> str:
    """Upload a file-like object to GCS and return the public URL."""
    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(path)
    blob.upload_from_file(file, content_type=content_type, rewind=True)
    blob.make_public()
    logger.info("Uploaded file to gs://%s/%s", bucket_name, path)
    return blob.public_url


def generate_signed_url(
    bucket_name: str,
    path: str,
    expiration_minutes: int = 60,
) -> str:
    """Generate a v4 signed URL for private object access.

    Parameters
    ----------
    bucket_name:
        Name of the GCS bucket.
    path:
        Object path inside the bucket.
    expiration_minutes:
        How many minutes the signed URL remains valid.

    Returns
    -------
    str
        A signed URL granting temporary read access.
    """
    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(path)
    url = blob.generate_signed_url(
        version="v4",
        expiration=datetime.timedelta(minutes=expiration_minutes),
        method="GET",
    )
    logger.debug("Generated signed URL for gs://%s/%s (expires in %d min)", bucket_name, path, expiration_minutes)
    return url
