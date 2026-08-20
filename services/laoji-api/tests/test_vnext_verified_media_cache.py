from __future__ import annotations

import hashlib
import os

import pytest

from app.config import settings
from app.services import vnext_verified_media_cache as cache


def _sha(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_ENABLED", True)
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_PATH", str(tmp_path / "cache"))
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_MAX_SOURCE_BYTES", 1_024)
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_MAX_TOTAL_BYTES", 2_048)
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_PARTIAL_TTL_SECONDS", 60)
    monkeypatch.setattr(cache, "_RESERVED_BYTES", 0)


def _publish(asset_revision_id: str, payload: bytes):
    digest = _sha(payload)
    reservation = cache.reserve(
        asset_revision_id=asset_revision_id,
        source_sha256=digest,
        expected_size=len(payload),
    )
    assert reservation is not None
    reservation.partial_path.write_bytes(payload)
    published = cache.promote(
        reservation,
        actual_sha256=digest,
        actual_size=len(payload),
    )
    assert published is not None
    return digest, published


def test_promote_resolve_and_remove_verified_media() -> None:
    payload = b"verified-compressed-media"
    digest, published = _publish("asset-revision:one", payload)

    assert published.read_bytes() == payload
    assert cache.resolve(
        asset_revision_id="asset-revision:one",
        source_sha256=digest,
        expected_size=len(payload),
    ) == published
    assert cache.reserve(
        asset_revision_id="asset-revision:one",
        source_sha256=digest,
        expected_size=len(payload),
    ) is None
    assert cache.remove(
        asset_revision_id="asset-revision:one",
        source_sha256=digest,
    ) is True
    assert not published.exists()


def test_failed_promotion_releases_capacity_and_never_publishes(monkeypatch) -> None:
    payload = b"0123456789"
    digest = _sha(payload)
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_MAX_TOTAL_BYTES", len(payload))
    reservation = cache.reserve(
        asset_revision_id="asset-revision:bad",
        source_sha256=digest,
        expected_size=len(payload),
    )
    assert reservation is not None
    reservation.partial_path.write_bytes(payload[:-1])

    assert cache.promote(
        reservation,
        actual_sha256=digest,
        actual_size=len(payload),
    ) is None
    assert not reservation.final_path.exists()
    replacement = cache.reserve(
        asset_revision_id="asset-revision:replacement",
        source_sha256=digest,
        expected_size=len(payload),
    )
    assert replacement is not None
    cache.abort(replacement)


def test_prune_keeps_active_media_and_removes_terminal_and_stale_partial() -> None:
    active_digest, active_path = _publish("asset-revision:active", b"active")
    _terminal_digest, terminal_path = _publish("asset-revision:terminal", b"terminal")
    partial = cache.reserve(
        asset_revision_id="asset-revision:partial",
        source_sha256=_sha(b"partial"),
        expected_size=len(b"partial"),
    )
    assert partial is not None
    partial.partial_path.write_bytes(b"partial")
    os.utime(partial.partial_path, (1, 1))

    result = cache.prune(
        [("asset-revision:active", active_digest)],
        now_epoch=120,
    )

    assert result["removed_files"] == 2
    assert active_path.exists()
    assert not terminal_path.exists()
    assert not partial.partial_path.exists()
    cache.release_reservation(partial)
