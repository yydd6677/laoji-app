from __future__ import annotations

import hashlib
import sqlite3
import time
import uuid

import pytest

from app.config import settings
from app.services import (
    device_identity,
    vnext_realtime_store,
    vnext_task_store,
)
from app.services.device_v2_identity import DeviceV2Context


BINDING_ID = "11111111-1111-4111-8111-111111111111"
BINDING_GENERATION = "a" * 32
ASSET_ID = "asset-realtime-1"
ASSET_GENERATION = "b" * 32
TASK_ID = "transcription-task-realtime-1"


@pytest.fixture
def realtime_context(tmp_path, monkeypatch):
    database = tmp_path / "vnext-realtime.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setattr(settings, "VNEXT_REALTIME_SPOOL_PATH", str(tmp_path / "spool"))
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    context = DeviceV2Context(str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)
    vnext_realtime_store.ensure_vnext_realtime_schema()
    vnext_task_store.register_binding(
        context,
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_epoch_seq=1,
    )
    return context


def open_session(context):
    return vnext_realtime_store.open_realtime_session(
        context,
        session_id="realtime-session-1",
        task_id=TASK_ID,
        client_operation_id="realtime-operation-1",
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        asset_id=ASSET_ID,
        asset_generation=ASSET_GENERATION,
        codec_revision="pcm16-16000-mono-v1",
        expires_at_epoch=int(time.time()) + 900,
    )


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def test_realtime_session_chunk_and_event_cursors_survive_replay(realtime_context) -> None:
    session, reused = open_session(realtime_context)
    assert reused is False
    assert session["last_contiguous_chunk_seq"] == -1
    replay, reused = open_session(realtime_context)
    assert reused is True and replay["session_id"] == session["session_id"]
    worker_generation = "c" * 32
    vnext_realtime_store.claim_realtime_worker(
        realtime_context, session["session_id"], worker_generation,
    )
    lease_owner = f"realtime:{session['session_id']}"
    attempt = vnext_task_store.claim_attempt(
        realtime_context, TASK_ID, lease_owner=lease_owner,
    )
    assert attempt is not None

    chunk = vnext_realtime_store.append_chunk_checkpoint(
        realtime_context,
        session["session_id"],
        chunk_seq=0,
        start_ms=0,
        end_ms=100,
        byte_size=3200,
        content_sha256=digest(b"chunk-0"),
        encrypted_spool_locator="sealed:chunk-0",
        worker_generation=worker_generation,
    )
    assert chunk["last_contiguous_chunk_seq"] == 0 and chunk["reused"] is False
    replayed_chunk = vnext_realtime_store.append_chunk_checkpoint(
        realtime_context,
        session["session_id"],
        chunk_seq=0,
        start_ms=0,
        end_ms=100,
        byte_size=3200,
        content_sha256=digest(b"chunk-0"),
        encrypted_spool_locator="sealed:chunk-0",
        worker_generation=worker_generation,
    )
    assert replayed_chunk["reused"] is True
    with pytest.raises(vnext_realtime_store.VNextRealtimeError, match="实时音频分块序号不连续"):
        vnext_realtime_store.append_chunk_checkpoint(
            realtime_context,
            session["session_id"],
            chunk_seq=2,
            start_ms=200,
            end_ms=300,
            byte_size=3200,
            content_sha256=digest(b"chunk-2"),
            encrypted_spool_locator="sealed:chunk-2",
            worker_generation=worker_generation,
        )

    stable_payload = b"encrypted-stable-event"
    stable = vnext_realtime_store.append_durable_event(
        realtime_context,
        session["session_id"],
        event_seq=1,
        event_kind="stable",
        stable_segment_key="segment-0-100",
        segment_revision=1,
        outcome="text",
        source_start_ms=0,
        source_end_ms=100,
        payload_sha256=digest(stable_payload),
        encrypted_payload=stable_payload,
        worker_generation=worker_generation,
        consume_through_chunk_seq=0,
    )
    assert stable["reused"] is False
    assert vnext_realtime_store.get_unconsumed_chunks(
        realtime_context, session["session_id"],
    ) == []
    stable_replay = vnext_realtime_store.append_durable_event(
        realtime_context,
        session["session_id"],
        event_seq=1,
        event_kind="stable",
        stable_segment_key="segment-0-100",
        segment_revision=1,
        outcome="text",
        source_start_ms=0,
        source_end_ms=100,
        payload_sha256=digest(stable_payload),
        encrypted_payload=stable_payload,
        worker_generation=worker_generation,
        consume_through_chunk_seq=0,
    )
    assert stable_replay["reused"] is True

    revised_payload = b"encrypted-stable-event-r2"
    revised = vnext_realtime_store.append_durable_event(
        realtime_context,
        session["session_id"],
        event_seq=2,
        event_kind="stable",
        stable_segment_key="segment-0-100",
        segment_revision=2,
        outcome="text",
        source_start_ms=0,
        source_end_ms=100,
        payload_sha256=digest(revised_payload),
        encrypted_payload=revised_payload,
        worker_generation=worker_generation,
    )
    assert revised["event_seq"] == 2

    final_payload = b"encrypted-no-speech-final"
    final = vnext_realtime_store.append_terminal_event_and_complete_task(
        realtime_context,
        session["session_id"],
        event_seq=3,
        outcome="no_speech",
        source_start_ms=0,
        source_end_ms=100,
        payload_sha256=digest(final_payload),
        encrypted_payload=final_payload,
        consume_through_chunk_seq=None,
        worker_generation=worker_generation,
        attempt_id=str(attempt["attempt_id"]),
        lease_owner=lease_owner,
    )
    assert final["event_seq"] == 3
    snapshot = vnext_realtime_store.get_realtime_snapshot(
        realtime_context,
        session["session_id"],
        after_event_seq=1,
    )
    assert snapshot is not None
    assert snapshot["session"]["state"] == "succeeded"
    assert [event["event_seq"] for event in snapshot["events"]] == [2, 3]
    acknowledged = vnext_realtime_store.acknowledge_events(
        realtime_context,
        session["session_id"],
        3,
    )
    assert acknowledged["acked_through"] == 3
    task = vnext_task_store.get_task(realtime_context, TASK_ID)
    assert task is not None
    assert task["state"] == "success"
    assert task["result_kind"] == "content_outcome"
    assert task["result"]["code"] == "NO_SPEECH"


def test_realtime_binding_fence_rejects_late_chunk(realtime_context) -> None:
    session, _ = open_session(realtime_context)
    worker_generation = "f" * 32
    vnext_realtime_store.claim_realtime_worker(
        realtime_context, session["session_id"], worker_generation,
    )
    with device_identity.control_connection() as connection:
        connection.execute(
            """UPDATE vnext_bindings SET binding_revision = 2, cancel_revision = 1
               WHERE binding_id = ?""",
            (BINDING_ID,),
        )
        connection.commit()
    with pytest.raises(vnext_realtime_store.VNextRealtimeError) as caught:
        vnext_realtime_store.append_chunk_checkpoint(
            realtime_context,
            session["session_id"],
            chunk_seq=0,
            start_ms=0,
            end_ms=100,
            byte_size=3200,
            content_sha256=digest(b"late-chunk"),
            encrypted_spool_locator="sealed:late-chunk",
            worker_generation=worker_generation,
        )
    assert caught.value.code == "BINDING_REVISION_CHANGED"


def test_realtime_new_worker_fences_late_pipeline(realtime_context) -> None:
    session, _ = open_session(realtime_context)
    first_worker = "c" * 32
    second_worker = "d" * 32
    vnext_realtime_store.claim_realtime_worker(
        realtime_context, session["session_id"], first_worker,
    )
    vnext_realtime_store.claim_realtime_worker(
        realtime_context, session["session_id"], second_worker,
    )
    with pytest.raises(vnext_realtime_store.VNextRealtimeError) as chunk_error:
        vnext_realtime_store.append_chunk_checkpoint(
            realtime_context,
            session["session_id"],
            chunk_seq=0,
            start_ms=0,
            end_ms=100,
            byte_size=3200,
            content_sha256=digest(b"late-worker-chunk"),
            encrypted_spool_locator="sealed:late-worker-chunk",
            worker_generation=first_worker,
        )
    assert chunk_error.value.code == "REALTIME_WORKER_FENCED"
    with pytest.raises(vnext_realtime_store.VNextRealtimeError) as caught:
        vnext_realtime_store.append_durable_event(
            realtime_context,
            session["session_id"],
            event_seq=1,
            event_kind="stable",
            stable_segment_key="segment-late-worker",
            segment_revision=1,
            outcome="text",
            source_start_ms=0,
            source_end_ms=100,
            payload_sha256=digest(b"late-worker"),
            encrypted_payload=b"late-worker",
            worker_generation=first_worker,
        )
    assert caught.value.code == "REALTIME_WORKER_FENCED"


def test_realtime_final_rolls_back_without_owned_attempt(realtime_context) -> None:
    session, _ = open_session(realtime_context)
    worker_generation = "e" * 32
    vnext_realtime_store.claim_realtime_worker(
        realtime_context, session["session_id"], worker_generation,
    )
    payload = b"terminal-without-attempt"
    with pytest.raises(vnext_realtime_store.VNextRealtimeError) as caught:
        vnext_realtime_store.append_terminal_event_and_complete_task(
            realtime_context,
            session["session_id"],
            event_seq=1,
            outcome="no_speech",
            source_start_ms=0,
            source_end_ms=0,
            payload_sha256=digest(payload),
            encrypted_payload=payload,
            consume_through_chunk_seq=None,
            worker_generation=worker_generation,
            attempt_id="missing-attempt",
            lease_owner=f"realtime:{session['session_id']}",
        )
    assert caught.value.code == "TASK_ATTEMPT_FENCED"
    snapshot = vnext_realtime_store.get_realtime_snapshot(
        realtime_context, session["session_id"],
    )
    assert snapshot is not None
    assert snapshot["events"] == []
    assert snapshot["session"]["state"] != "succeeded"


def test_realtime_expiry_terminates_active_task(realtime_context) -> None:
    session, _ = open_session(realtime_context)
    result = vnext_realtime_store.cleanup_realtime_payloads(
        now_epoch=int(session["expires_at_epoch"]) + 1,
        orphan_grace_seconds=60,
    )
    assert result["expired_sessions"] == 1
    snapshot = vnext_realtime_store.get_realtime_snapshot(
        realtime_context, session["session_id"],
    )
    assert snapshot is not None
    assert snapshot["session"]["state"] == "expired"
    task = vnext_task_store.get_task(realtime_context, TASK_ID)
    assert task is not None
    assert task["state"] == "failure"
    assert task["error_code"] == "REALTIME_SESSION_EXPIRED"


def test_realtime_pipeline_failure_releases_attempt_for_retry(realtime_context) -> None:
    session, _ = open_session(realtime_context)
    worker_generation = "1" * 32
    vnext_realtime_store.claim_realtime_worker(
        realtime_context, session["session_id"], worker_generation,
    )
    lease_owner = f"realtime:{session['session_id']}"
    first = vnext_task_store.claim_attempt(
        realtime_context, TASK_ID, lease_owner=lease_owner,
    )
    assert first is not None
    assert vnext_realtime_store.mark_realtime_attempt_failure(
        realtime_context,
        session["session_id"],
        worker_generation=worker_generation,
        attempt_id=str(first["attempt_id"]),
        lease_owner=lease_owner,
        error_code="REALTIME_PIPELINE_UNAVAILABLE",
    )
    task = vnext_task_store.get_task(realtime_context, TASK_ID)
    assert task is not None and task["state"] == "active"
    second = vnext_task_store.claim_attempt(
        realtime_context, TASK_ID, lease_owner=lease_owner,
    )
    assert second is not None
    assert second["attempt_number"] == 2
