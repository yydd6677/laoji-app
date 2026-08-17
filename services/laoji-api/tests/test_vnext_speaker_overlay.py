from __future__ import annotations

import hashlib
import os
import sqlite3
import time
import uuid

import numpy as np
import pytest

from app.config import settings
from app.services import (
    device_identity,
    vnext_realtime_store,
    vnext_speaker_crypto,
    vnext_speaker_pipeline,
    vnext_speaker_store,
    vnext_task_store,
)
from app.services.device_v2_identity import DeviceV2Context


BINDING_ID = "11111111-1111-4111-8111-111111111111"
BINDING_GENERATION = "a" * 32
ASSET_GENERATION = "b" * 32
SESSION_ID = "realtime-speaker-session"
TRANSCRIPT_TASK_ID = "transcription-speaker-task"
WORKER_GENERATION = "c" * 32


def _digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


@pytest.fixture
def speaker_context(tmp_path, monkeypatch):
    database = tmp_path / "vnext-speaker.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setattr(settings, "VNEXT_SPEAKER_SPOOL_PATH", str(tmp_path / "speaker-spool"))
    monkeypatch.setattr(settings, "SECRET_KEY", "speaker-test-secret-at-least-32-bytes")
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    context = DeviceV2Context(str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)
    vnext_speaker_store.ensure_vnext_speaker_schema()
    vnext_task_store.register_binding(
        context,
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_epoch_seq=1,
    )
    session, _ = vnext_realtime_store.open_realtime_session(
        context,
        session_id=SESSION_ID,
        task_id=TRANSCRIPT_TASK_ID,
        client_operation_id="speaker-operation-1",
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        asset_id="speaker-asset-1",
        asset_generation=ASSET_GENERATION,
        codec_revision="pcm16-16000-mono-v1",
        expires_at_epoch=int(time.time()) + 900,
    )
    vnext_realtime_store.claim_realtime_worker(context, session["session_id"], WORKER_GENERATION)
    attempt = vnext_task_store.claim_attempt(
        context,
        TRANSCRIPT_TASK_ID,
        lease_owner=f"realtime:{SESSION_ID}",
    )
    assert attempt is not None
    return context, attempt


def _append_segment(
    context: DeviceV2Context,
    *,
    event_seq: int,
    stable_key: str,
    start_ms: int,
    end_ms: int,
    pcm: bytes,
) -> None:
    payload = f"stable:{stable_key}".encode("ascii")
    vnext_realtime_store.append_durable_event(
        context,
        SESSION_ID,
        event_seq=event_seq,
        event_kind="stable",
        stable_segment_key=stable_key,
        segment_revision=1,
        outcome="text",
        source_start_ms=start_ms,
        source_end_ms=end_ms,
        payload_sha256=_digest(payload),
        encrypted_payload=payload,
        worker_generation=WORKER_GENERATION,
    )
    content_sha256 = _digest(pcm)
    locator = vnext_speaker_crypto.seal_segment(
        device_id=context.device_id,
        epoch_id=context.epoch_id,
        session_id=SESSION_ID,
        stable_segment_key=stable_key,
        content_sha256=content_sha256,
        pcm_bytes=pcm,
    )
    vnext_speaker_store.collect_speaker_segment(
        context,
        SESSION_ID,
        stable_segment_key=stable_key,
        source_start_ms=start_ms,
        source_end_ms=end_ms,
        byte_size=len(pcm),
        content_sha256=content_sha256,
        encrypted_spool_locator=locator,
        worker_generation=WORKER_GENERATION,
    )


def _finish_text(context: DeviceV2Context, attempt: dict, event_seq: int, end_ms: int) -> None:
    payload = b"final-text"
    vnext_realtime_store.append_terminal_event_and_complete_task(
        context,
        SESSION_ID,
        event_seq=event_seq,
        outcome="text" if event_seq > 1 else "no_speech",
        source_start_ms=0,
        source_end_ms=end_ms,
        payload_sha256=_digest(payload),
        encrypted_payload=payload,
        consume_through_chunk_seq=None,
        worker_generation=WORKER_GENERATION,
        attempt_id=str(attempt["attempt_id"]),
        lease_owner=f"realtime:{SESSION_ID}",
    )


def test_speaker_spool_and_payload_are_encrypted(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "VNEXT_SPEAKER_SPOOL_PATH", str(tmp_path / "speaker-spool"))
    monkeypatch.setattr(settings, "SECRET_KEY", "speaker-test-secret-at-least-32-bytes")
    pcm = b"\x01\x02" * 20_000
    kwargs = {
        "device_id": "device-1",
        "epoch_id": "epoch-1",
        "session_id": "session-1",
        "stable_segment_key": "segment-1",
        "content_sha256": _digest(pcm),
        "pcm_bytes": pcm,
    }
    locator = vnext_speaker_crypto.seal_segment(**kwargs)
    path = next((tmp_path / "speaker-spool").rglob("*.bin"))
    assert pcm not in path.read_bytes()
    assert vnext_speaker_crypto.read_segment(locator) == pcm
    assert vnext_speaker_crypto.seal_segment(**kwargs) == locator
    envelope = vnext_speaker_crypto.seal_payload("profile:1", b"private-voiceprint")
    assert b"private-voiceprint" not in envelope
    assert vnext_speaker_crypto.open_payload("profile:1", envelope) == b"private-voiceprint"


@pytest.mark.asyncio
async def test_recovered_worker_commits_named_overlay_and_revoke_redacts(
    speaker_context,
) -> None:
    context, transcript_attempt = speaker_context
    vnext_speaker_store.create_profile(
        context,
        speaker_id="speaker-alice",
        display_name="张敏",
    )
    vnext_speaker_store.save_profile_embedding(
        context,
        speaker_id="speaker-alice",
        embedding=np.array([1.0, 0.0], dtype=np.float32),
        model_revision="campplus-test",
    )
    pcm = (np.ones(24_000, dtype="<i2") * 120).tobytes()
    _append_segment(
        context,
        event_seq=1,
        stable_key="segment-1",
        start_ms=0,
        end_ms=1_500,
        pcm=pcm,
    )
    _append_segment(
        context,
        event_seq=2,
        stable_key="segment-2",
        start_ms=1_600,
        end_ms=3_100,
        pcm=pcm + b"\x00\x00",
    )
    _finish_text(context, transcript_attempt, 3, 3_100)
    queued = vnext_speaker_store.finalize_speaker_run(
        context,
        SESSION_ID,
        model_revision="campplus-test",
    )
    assert queued["state"] == "queued"

    async def fake_embedding(_pcm: bytes):
        return np.array([1.0, 0.0], dtype=np.float32), "campplus-test"

    # A fresh worker instance has no in-memory embedding cache. Completing the
    # durable task therefore exercises process-restart recovery from encrypted PCM.
    worker = vnext_speaker_pipeline.VNextSpeakerOverlayWorker(embedding_call=fake_embedding)
    await worker._process_final(context, SESSION_ID)  # type: ignore[attr-defined]
    snapshot = vnext_speaker_store.get_overlay_snapshot(context, SESSION_ID)
    assert snapshot is not None and snapshot["state"] == "succeeded"
    assert snapshot["overlay"] is not None
    assert {item["automatic_label"] for item in snapshot["overlay"]["assignments"]} == {"张敏"}
    assert {item["speaker_profile_id"] for item in snapshot["overlay"]["assignments"]} == {"speaker-alice"}
    assert vnext_speaker_store.referenced_spool_locators() == set()

    assert vnext_speaker_store.revoke_profile(context, "speaker-alice")
    redacted = vnext_speaker_store.get_overlay_snapshot(context, SESSION_ID)
    assert redacted is not None and redacted["overlay"] is not None
    assert {item["automatic_label"] for item in redacted["overlay"]["assignments"]} == {"发言人 1"}
    assert {item["speaker_profile_id"] for item in redacted["overlay"]["assignments"]} == {None}


def test_unknown_and_short_segments_never_force_registered_name() -> None:
    profiles = [{
        "speaker_id": "speaker-a",
        "name": "登记讲话人",
        "profile_revision": 4,
        "embedding": np.array([1.0, 0.0], dtype=np.float32),
    }]
    source = [
        {
            "stable_segment_key": "short",
            "source_start_ms": 0,
            "source_end_ms": 800,
        },
        {
            "stable_segment_key": "unknown",
            "source_start_ms": 2_000,
            "source_end_ms": 3_500,
        },
    ]
    assignments = vnext_speaker_pipeline.assign_speaker_overlay(
        source,
        {
            "short": np.array([1.0, 0.0], dtype=np.float32),
            "unknown": np.array([0.0, 1.0], dtype=np.float32),
        },
        profiles,
    )
    assert all(item["speaker_profile_id"] is None for item in assignments)
    assert all(item["automatic_label"].startswith("发言人 ") for item in assignments)


def test_no_speech_closes_empty_overlay_without_speaker_attempt(speaker_context) -> None:
    context, transcript_attempt = speaker_context
    _finish_text(context, transcript_attempt, 1, 0)
    result = vnext_speaker_store.finalize_speaker_run(
        context,
        SESSION_ID,
        model_revision="campplus-test",
    )
    assert result["state"] == "no_content" and result["task_id"] is None
    snapshot = vnext_speaker_store.get_overlay_snapshot(context, SESSION_ID)
    assert snapshot is not None and snapshot["state"] == "no_content"
    assert snapshot["overlay"] is not None
    assert snapshot["overlay"]["assignments"] == []


def test_orphan_cleanup_keeps_referenced_segment(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "VNEXT_SPEAKER_SPOOL_PATH", str(tmp_path / "speaker-spool"))
    monkeypatch.setattr(settings, "SECRET_KEY", "speaker-test-secret-at-least-32-bytes")
    common = {
        "device_id": "device-1",
        "epoch_id": "epoch-1",
        "session_id": "session-1",
        "content_sha256": _digest(b"pcm"),
        "pcm_bytes": b"pcm",
    }
    kept = vnext_speaker_crypto.seal_segment(
        **common,
        stable_segment_key="segment-kept",
    )
    orphan = vnext_speaker_crypto.seal_segment(
        **common,
        stable_segment_key="segment-orphan",
    )
    orphan_path = vnext_speaker_crypto._segment_path(orphan)  # type: ignore[attr-defined]
    os.utime(orphan_path, (1, 1))
    result = vnext_speaker_crypto.delete_orphan_segments({kept}, older_than_epoch=2)
    assert result["files"] == 1
    assert vnext_speaker_crypto.read_segment(kept) == b"pcm"
    assert not orphan_path.exists()
