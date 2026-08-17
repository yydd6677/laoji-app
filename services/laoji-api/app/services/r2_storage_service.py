"""Small synchronous Cloudflare R2 adapter used off the ASGI event loop.

The mobile app never receives R2 credentials.  The API creates a scoped
multipart upload and returns short-lived presigned part URLs.  All methods in
this module are synchronous because boto3 is synchronous; callers must use
``asyncio.to_thread`` for network or filesystem operations.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path
from typing import Any, Iterable

from app.config import settings

try:  # Optional until the operator enables the R2 path.
    import boto3
    from botocore.config import Config as BotoConfig
    from botocore.exceptions import ClientError
except ImportError:  # pragma: no cover - exercised by dependency-free checks
    boto3 = None  # type: ignore[assignment]
    BotoConfig = None  # type: ignore[assignment,misc]
    ClientError = Exception  # type: ignore[assignment,misc]


class R2StorageUnavailable(RuntimeError):
    """Raised when R2 is disabled or incompletely configured."""


@dataclass(frozen=True)
class R2Part:
    part_number: int
    etag: str


def r2_enabled() -> bool:
    """Return true only when every secret/configuration prerequisite exists."""
    return bool(
        settings.R2_ENABLED
        and boto3 is not None
        and settings.R2_ACCOUNT_ID.strip()
        and settings.R2_BUCKET.strip()
        and settings.R2_ACCESS_KEY_ID.strip()
        and settings.R2_SECRET_ACCESS_KEY.strip()
        and r2_endpoint().strip()
    )


def r2_endpoint() -> str:
    configured = settings.R2_ENDPOINT_URL.strip()
    if configured:
        return configured.rstrip("/")
    account_id = settings.R2_ACCOUNT_ID.strip()
    return f"https://{account_id}.r2.cloudflarestorage.com" if account_id else ""


def require_r2() -> None:
    if not r2_enabled():
        raise R2StorageUnavailable("r2_upload_unavailable")


@lru_cache(maxsize=1)
def _client():
    require_r2()
    assert boto3 is not None
    assert BotoConfig is not None
    # Keep SDK retries small.  The mobile client already retries missing
    # parts, while a long SDK retry would hold an API worker unnecessarily.
    return boto3.client(
        "s3",
        endpoint_url=r2_endpoint(),
        aws_access_key_id=settings.R2_ACCESS_KEY_ID.strip(),
        aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY.strip(),
        region_name="auto",
        config=BotoConfig(
            signature_version="s3v4",
            retries={"max_attempts": 2, "mode": "standard"},
            connect_timeout=15,
            read_timeout=120,
        ),
    )


def validate_part_layout(total_bytes: int) -> tuple[int, int]:
    require_r2()
    if total_bytes < 1 or total_bytes > settings.MEETING_AUDIO_MAX_BYTES:
        raise ValueError("r2_total_bytes_invalid")
    part_size = int(settings.R2_PART_SIZE)
    total_parts = (total_bytes + part_size - 1) // part_size
    if total_parts < 1 or total_parts > 10_000:
        raise ValueError("r2_part_layout_invalid")
    return part_size, total_parts


def create_multipart_upload(*, object_key: str, mime_type: str) -> str:
    response = _client().create_multipart_upload(
        Bucket=settings.R2_BUCKET.strip(),
        Key=object_key,
        ContentType=mime_type,
        Metadata={"laoji-source": "device-recording"},
    )
    upload_id = str(response.get("UploadId") or "").strip()
    if not upload_id:
        raise R2StorageUnavailable("r2_upload_id_missing")
    return upload_id


def presign_upload_parts(
    *, object_key: str, upload_id: str, total_parts: int
) -> list[dict[str, Any]]:
    client = _client()
    expires = int(settings.R2_PRESIGN_TTL_SECONDS)
    return [
        {
            "part_number": part_number,
            "url": client.generate_presigned_url(
                "upload_part",
                Params={
                    "Bucket": settings.R2_BUCKET.strip(),
                    "Key": object_key,
                    "UploadId": upload_id,
                    "PartNumber": part_number,
                },
                ExpiresIn=expires,
                HttpMethod="PUT",
            ),
        }
        for part_number in range(1, total_parts + 1)
    ]


def presign_put_object(*, object_key: str, mime_type: str | None = None) -> str:
    """Return one short-lived PUT URL for small recordings.

    Multipart is valuable for long recordings, but its create/list/complete
    round trips dominate a short one-part upload.  Keep the content type out
    of the signature unless explicitly supplied so native uploaders can use a
    provider/content URI without header differences.
    """
    params: dict[str, Any] = {
        "Bucket": settings.R2_BUCKET.strip(),
        "Key": object_key,
    }
    if mime_type:
        params["ContentType"] = mime_type
    return _client().generate_presigned_url(
        "put_object",
        Params=params,
        ExpiresIn=int(settings.R2_PRESIGN_TTL_SECONDS),
        HttpMethod="PUT",
    )


def list_uploaded_parts(*, object_key: str, upload_id: str) -> list[R2Part]:
    client = _client()
    parts: list[R2Part] = []
    marker: int | None = None
    while True:
        params: dict[str, Any] = {
            "Bucket": settings.R2_BUCKET.strip(),
            "Key": object_key,
            "UploadId": upload_id,
        }
        if marker is not None:
            params["PartNumberMarker"] = marker
        try:
            response = client.list_parts(**params)
        except ClientError as error:
            code = str((getattr(error, "response", {}) or {}).get("Error", {}).get("Code", ""))
            if code in {"NoSuchUpload", "NoSuchKey", "404"}:
                return []
            raise
        for part in response.get("Parts") or []:
            number = int(part.get("PartNumber") or 0)
            etag = str(part.get("ETag") or "").strip()
            if number > 0 and etag:
                parts.append(R2Part(number, etag))
        if not response.get("IsTruncated"):
            break
        marker = int(response.get("NextPartNumberMarker") or 0)
        if marker <= 0:
            break
    return sorted(parts, key=lambda item: item.part_number)


def complete_multipart_upload(
    *, object_key: str, upload_id: str, parts: Iterable[R2Part]
) -> None:
    normalized = sorted(
        [{"PartNumber": int(part.part_number), "ETag": str(part.etag)} for part in parts],
        key=lambda item: item["PartNumber"],
    )
    if not normalized:
        raise ValueError("r2_parts_missing")
    _client().complete_multipart_upload(
        Bucket=settings.R2_BUCKET.strip(),
        Key=object_key,
        UploadId=upload_id,
        MultipartUpload={"Parts": normalized},
    )


def abort_multipart_upload(*, object_key: str, upload_id: str) -> None:
    try:
        _client().abort_multipart_upload(
            Bucket=settings.R2_BUCKET.strip(),
            Key=object_key,
            UploadId=upload_id,
        )
    except ClientError as error:
        code = str((getattr(error, "response", {}) or {}).get("Error", {}).get("Code", ""))
        if code not in {"NoSuchUpload", "NoSuchKey", "404"}:
            raise


def download_object(*, object_key: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    _client().download_file(settings.R2_BUCKET.strip(), object_key, str(target))


def object_exists(*, object_key: str) -> bool:
    """Return whether an object is still present without exposing its metadata."""
    try:
        _client().head_object(Bucket=settings.R2_BUCKET.strip(), Key=object_key)
    except ClientError as error:
        code = str((getattr(error, "response", {}) or {}).get("Error", {}).get("Code", ""))
        if code in {"NoSuchKey", "NotFound", "404"}:
            return False
        raise
    return True


def object_head(*, object_key: str) -> dict[str, Any] | None:
    """Return minimal size/etag metadata for a transient object."""
    try:
        response = _client().head_object(
            Bucket=settings.R2_BUCKET.strip(),
            Key=object_key,
        )
    except ClientError as error:
        code = str((getattr(error, "response", {}) or {}).get("Error", {}).get("Code", ""))
        if code in {"NoSuchKey", "NotFound", "404"}:
            return None
        raise
    return {
        "content_length": int(response.get("ContentLength") or 0),
        "etag": str(response.get("ETag") or "").strip(),
    }


def delete_object(*, object_key: str) -> None:
    try:
        _client().delete_object(Bucket=settings.R2_BUCKET.strip(), Key=object_key)
    except ClientError as error:
        code = str((getattr(error, "response", {}) or {}).get("Error", {}).get("Code", ""))
        if code not in {"NoSuchKey", "404"}:
            raise


def clear_client_cache() -> None:
    """Test/deployment helper; no credentials or URLs are returned."""
    _client.cache_clear()
