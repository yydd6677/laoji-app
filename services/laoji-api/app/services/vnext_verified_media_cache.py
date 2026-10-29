"""Bounded transient cache for an already verified R2 media object.

Upload completion already reads every R2 byte to verify the device SHA-256.
Keeping that same byte stream in a private, bounded cache lets the import
worker decode the compressed media locally instead of opening a second public
Range connection.  R2 remains the recoverable source of truth: a missing,
stale, or invalid cache entry simply falls back to the sealed object.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import threading
import time
import uuid
from typing import Iterable

from app.config import settings


_CACHE_LOCK = threading.Lock()
_RESERVED_BYTES = 0


@dataclass(frozen=True)
class CacheReservation:
    asset_revision_id: str
    source_sha256: str
    expected_size: int
    final_path: Path
    partial_path: Path


def _normalized_sha256(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized.startswith("sha256:") or len(normalized) != 71:
        raise ValueError("verified_media_cache_sha256_invalid")
    int(normalized[7:], 16)
    return normalized


def _cache_root() -> Path:
    configured = str(settings.VNEXT_VERIFIED_MEDIA_CACHE_PATH or "").strip()
    if not configured:
        raise ValueError("verified_media_cache_path_missing")
    root = Path(configured).expanduser()
    if not root.is_absolute():
        root = Path(__file__).resolve().parents[2] / root
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        root.chmod(0o700)
    except OSError:
        pass
    return root.resolve()


def _identity_digest(asset_revision_id: str, source_sha256: str) -> str:
    normalized_asset = str(asset_revision_id or "").strip()
    if not normalized_asset:
        raise ValueError("verified_media_cache_asset_invalid")
    normalized_sha = _normalized_sha256(source_sha256)
    material = f"{normalized_asset}\0{normalized_sha}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def cache_path(asset_revision_id: str, source_sha256: str) -> Path:
    return _cache_root() / f"{_identity_digest(asset_revision_id, source_sha256)}.media"


def _current_cache_bytes(root: Path) -> int:
    total = 0
    for path in root.glob("*.media"):
        try:
            if path.is_file():
                total += max(0, int(path.stat().st_size))
        except OSError:
            continue
    return total


def reserve(
    *,
    asset_revision_id: str,
    source_sha256: str,
    expected_size: int,
) -> CacheReservation | None:
    """Reserve one bounded cache write without serializing the network read."""
    global _RESERVED_BYTES
    expected = int(expected_size)
    if (
        not settings.VNEXT_VERIFIED_MEDIA_CACHE_ENABLED
        or expected < 1
        or expected > int(settings.VNEXT_VERIFIED_MEDIA_CACHE_MAX_SOURCE_BYTES)
    ):
        return None
    root = _cache_root()
    final_path = cache_path(asset_revision_id, source_sha256)
    if final_path.is_file() and final_path.stat().st_size == expected:
        return None
    with _CACHE_LOCK:
        total_limit = int(settings.VNEXT_VERIFIED_MEDIA_CACHE_MAX_TOTAL_BYTES)
        if _current_cache_bytes(root) + _RESERVED_BYTES + expected > total_limit:
            return None
        _RESERVED_BYTES += expected
    partial_path = root / (
        f"{_identity_digest(asset_revision_id, source_sha256)}."
        f"{os.getpid()}.{uuid.uuid4().hex}.partial"
    )
    return CacheReservation(
        asset_revision_id=str(asset_revision_id),
        source_sha256=_normalized_sha256(source_sha256),
        expected_size=expected,
        final_path=final_path,
        partial_path=partial_path,
    )


def release_reservation(reservation: CacheReservation) -> None:
    global _RESERVED_BYTES
    with _CACHE_LOCK:
        _RESERVED_BYTES = max(0, _RESERVED_BYTES - reservation.expected_size)


def abort(reservation: CacheReservation) -> None:
    try:
        reservation.partial_path.unlink(missing_ok=True)
    finally:
        release_reservation(reservation)


def promote(reservation: CacheReservation, *, actual_sha256: str, actual_size: int) -> Path | None:
    """Publish a cache file only after the same stream passed size and hash."""
    try:
        if (
            _normalized_sha256(actual_sha256) != reservation.source_sha256
            or int(actual_size) != reservation.expected_size
            or not reservation.partial_path.is_file()
            or reservation.partial_path.stat().st_size != reservation.expected_size
        ):
            reservation.partial_path.unlink(missing_ok=True)
            return None
        os.replace(reservation.partial_path, reservation.final_path)
        try:
            reservation.final_path.chmod(0o600)
        except OSError:
            pass
        return reservation.final_path
    finally:
        release_reservation(reservation)


def resolve(
    *,
    asset_revision_id: str,
    source_sha256: str,
    expected_size: int,
) -> Path | None:
    if not settings.VNEXT_VERIFIED_MEDIA_CACHE_ENABLED:
        return None
    path = cache_path(asset_revision_id, source_sha256)
    try:
        if path.is_file() and path.stat().st_size == int(expected_size):
            return path
    except OSError:
        return None
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    return None


def remove(*, asset_revision_id: str, source_sha256: str) -> bool:
    try:
        path = cache_path(asset_revision_id, source_sha256)
        existed = path.exists()
        path.unlink(missing_ok=True)
        return existed
    except (OSError, ValueError):
        return False


def prune(
    active_identities: Iterable[tuple[str, str]],
    *,
    now_epoch: float | None = None,
) -> dict[str, int]:
    """Remove terminal cache entries and abandoned partial writes.

    Final entries are retained only while their Task remains active.  Partial
    files have no durable owner and are removed after a short crash-recovery
    window.  File names and return values contain no source or user content.
    """
    if not settings.VNEXT_VERIFIED_MEDIA_CACHE_ENABLED:
        return {"removed_files": 0, "removed_bytes": 0}
    root = _cache_root()
    active_names = {
        f"{_identity_digest(asset_revision_id, source_sha256)}.media"
        for asset_revision_id, source_sha256 in active_identities
    }
    now = time.time() if now_epoch is None else float(now_epoch)
    partial_ttl = int(settings.VNEXT_VERIFIED_MEDIA_CACHE_PARTIAL_TTL_SECONDS)
    removed_files = 0
    removed_bytes = 0
    for path in root.iterdir():
        if not path.is_file():
            continue
        remove_entry = path.name.endswith(".media") and path.name not in active_names
        if path.name.endswith(".partial"):
            try:
                remove_entry = now - path.stat().st_mtime >= partial_ttl
            except OSError:
                remove_entry = False
        if not remove_entry:
            continue
        try:
            size = max(0, int(path.stat().st_size))
            path.unlink(missing_ok=True)
        except OSError:
            continue
        removed_files += 1
        removed_bytes += size
    return {"removed_files": removed_files, "removed_bytes": removed_bytes}
