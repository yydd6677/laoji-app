from __future__ import annotations

import hashlib

import pytest

from app.config import settings
from app.services import vnext_realtime_crypto


def test_realtime_spool_is_encrypted_atomic_and_replayable(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "VNEXT_REALTIME_SPOOL_PATH", str(tmp_path / "spool"))
    monkeypatch.setattr(settings, "SECRET_KEY", "realtime-test-secret-at-least-32-bytes")
    pcm = b"\x01\x02" * 800
    content_sha256 = "sha256:" + hashlib.sha256(pcm).hexdigest()
    kwargs = {
        "device_id": "device-1",
        "epoch_id": "epoch-1",
        "session_id": "session-1",
        "chunk_seq": 0,
        "content_sha256": content_sha256,
        "pcm_bytes": pcm,
    }

    locator = vnext_realtime_crypto.seal_chunk(**kwargs)
    path = next((tmp_path / "spool").rglob("*.bin"))
    assert pcm not in path.read_bytes()
    assert vnext_realtime_crypto.read_chunk(locator) == pcm
    assert vnext_realtime_crypto.seal_chunk(**kwargs) == locator

    with pytest.raises(ValueError, match="realtime_spool_replay_conflict"):
        vnext_realtime_crypto.seal_chunk(**{**kwargs, "pcm_bytes": b"different"})
    vnext_realtime_crypto.delete_chunk(locator)
    assert not path.exists()


def test_realtime_event_envelope_binds_event_identity(monkeypatch) -> None:
    monkeypatch.setattr(settings, "SECRET_KEY", "realtime-test-secret-at-least-32-bytes")
    payload = b'{"type":"transcript.stable"}'
    envelope = vnext_realtime_crypto.seal_event("session-1:event-1", payload)
    assert payload not in envelope
    assert vnext_realtime_crypto.open_event("session-1:event-1", envelope) == payload
    with pytest.raises(Exception):
        vnext_realtime_crypto.open_event("session-1:event-2", envelope)
