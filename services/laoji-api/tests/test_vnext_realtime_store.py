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


@pytest.mark.parametrize('retain_for_quality', [False, True])
def test_realtime_quality_copy_obeys_permission_without_changing_event(realtime_context, retain_for_quality):
    import json
    from app.services import generation_retention, vnext_realtime_crypto
    generation_retention.set_preference(realtime_context, retain_for_quality)
    session, _ = open_session(realtime_context)
    generation = 'c' * 32
    vnext_realtime_store.claim_realtime_worker(realtime_context, session['session_id'], generation)
    payload = {'text': '先确认需求。', 'model_revision': 'test'}
    plaintext = json.dumps(payload, ensure_ascii=False).encode()
    sealed = vnext_realtime_crypto.seal_event(f"{session['session_id']}:event:1", plaintext)
    vnext_realtime_store.append_durable_event(realtime_context, session['session_id'], event_seq=1,
        event_kind='stable', stable_segment_key='s1', segment_revision=1, outcome='text',
        source_start_ms=0, source_end_ms=1000, payload_sha256=digest(plaintext),
        encrypted_payload=sealed, worker_generation=generation)
    saved = generation_retention.read_retained_results(realtime_context)
    assert len(saved) == int(retain_for_quality)
    if saved:
        assert saved[0]['output'] == payload
    generation_retention.set_preference(realtime_context, False)
    snapshot = vnext_realtime_store.get_realtime_snapshot(realtime_context, session['session_id'])
    assert snapshot['session']['last_durable_event_seq'] == 1
    with device_identity.control_connection() as connection:
        row = connection.execute('SELECT encrypted_payload FROM vnext_realtime_event_ledger WHERE session_id=?',
            (session['session_id'],)).fetchone()
        assert vnext_realtime_crypto.open_event(f"{session['session_id']}:event:1", bytes(row[0])) == plaintext


def _extra_session(context, number):
    return vnext_realtime_store.open_realtime_session(
        context, session_id=f'session-{number}', task_id=f'task-{number}',
        client_operation_id=f'operation-{number}', binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION, binding_revision=1, cancel_revision=0,
        asset_id=f'asset-{number}', asset_generation=f'{number:032x}',
        codec_revision='pcm16-16000-mono-v1', expires_at_epoch=int(time.time()) + 900,
    )[0]


def test_capacity_counts_live_workers_not_resumable_sessions(realtime_context):
    sessions = [_extra_session(realtime_context, number) for number in range(1, 5)]
    for session in sessions[:2]:
        vnext_realtime_store.claim_realtime_worker(realtime_context, session['session_id'], 'c' * 32)
    with pytest.raises(vnext_realtime_store.VNextRealtimeError, match='会话较多'):
        vnext_realtime_store.claim_realtime_worker(realtime_context, sessions[2]['session_id'], 'd' * 32)
    # An old disconnect cannot release a successor socket's admission.
    vnext_realtime_store.release_realtime_worker(realtime_context, sessions[0]['session_id'], 'a' * 32)
    with pytest.raises(vnext_realtime_store.VNextRealtimeError, match='会话较多'):
        vnext_realtime_store.claim_realtime_worker(realtime_context, sessions[2]['session_id'], 'd' * 32)
    vnext_realtime_store.release_realtime_worker(realtime_context, sessions[0]['session_id'], 'c' * 32)
    vnext_realtime_store.claim_realtime_worker(realtime_context, sessions[2]['session_id'], 'd' * 32)
    snapshot = vnext_realtime_store.get_realtime_snapshot(realtime_context, sessions[0]['session_id'])
    assert snapshot['session']['state'] == 'reconnecting'  # retained, not deleted/cancelled
    assert 'worker_admission_expires' not in snapshot['session']


def test_expired_worker_releases_capacity_and_cannot_publish(realtime_context, monkeypatch):
    session = _extra_session(realtime_context, 1)
    vnext_realtime_store.claim_realtime_worker(realtime_context, session['session_id'], 'c' * 32)
    now = time.time()
    monkeypatch.setattr(time, 'time', lambda: now + 91)
    for number in (2, 3):
        other = _extra_session(realtime_context, number)
        vnext_realtime_store.claim_realtime_worker(realtime_context, other['session_id'], 'd' * 32)
    with pytest.raises(vnext_realtime_store.VNextRealtimeError) as error:
        vnext_realtime_store.renew_realtime_worker(realtime_context, session['session_id'], 'c' * 32)
    assert error.value.code == 'REALTIME_WORKER_FENCED'


def test_worker_heartbeat_renews_both_resource_and_task_lease(realtime_context, monkeypatch):
    session = _extra_session(realtime_context, 1)
    attempt = vnext_task_store.claim_attempt(realtime_context, session['task_id'], lease_owner='realtime:session-1')
    vnext_realtime_store.claim_realtime_worker(realtime_context, session['session_id'], 'c' * 32)
    now = time.time()
    monkeypatch.setattr(time, 'time', lambda: now + 70)
    vnext_realtime_store.renew_realtime_worker(realtime_context, session['session_id'], 'c' * 32)
    with device_identity.control_connection() as connection:
        deadline = connection.execute('SELECT lease_expires_at_epoch FROM vnext_task_attempts WHERE attempt_id=?', (attempt['attempt_id'],)).fetchone()[0]
    assert deadline > now + 200
    monkeypatch.setattr(time, 'time', lambda: now + 120)
    vnext_realtime_store.renew_realtime_worker(realtime_context, session['session_id'], 'c' * 32)


def test_disconnect_resumes_same_attempt_without_spending_failure_budget(realtime_context):
    session, _ = open_session(realtime_context)
    owner = f"realtime:{session['session_id']}"
    original = None
    for number in range(6):
        generation = f"{number + 1:032x}"
        vnext_realtime_store.claim_realtime_worker(realtime_context, session["session_id"], generation)
        attempt = vnext_task_store.claim_attempt(realtime_context, TASK_ID, lease_owner=owner)
        original = original or attempt["attempt_id"]
        assert attempt["attempt_id"] == original and attempt["attempt_number"] == 1
        vnext_realtime_store.release_realtime_worker(realtime_context, session["session_id"], generation)
        with device_identity.control_connection() as c:
            row = c.execute("SELECT * FROM vnext_task_attempts WHERE attempt_id=?", (original,)).fetchone()
        assert row["state"] == "queued" and row["lease_owner"] is None
        assert row["lease_expires_at_epoch"] is None
        assert vnext_task_store.get_task(realtime_context, TASK_ID)["state"] == "active"


def test_recovery_requires_both_leases_and_preserves_input(realtime_context):
    session, _ = open_session(realtime_context)
    generation = "c" * 32
    owner = f"realtime:{session['session_id']}"
    vnext_realtime_store.claim_realtime_worker(realtime_context, session["session_id"], generation)
    attempt = vnext_task_store.claim_attempt(realtime_context, TASK_ID, lease_owner=owner)
    vnext_realtime_store.append_chunk_checkpoint(realtime_context, session["session_id"],
        chunk_seq=0, start_ms=0, end_ms=100, byte_size=3200,
        content_sha256=digest(b"checkpoint"), encrypted_spool_locator="sealed:preserved",
        worker_generation=generation)
    now = time.time()
    assert vnext_realtime_store.recover_expired_realtime_workers(now_epoch=now + 100) == 0
    assert vnext_realtime_store.recover_expired_realtime_workers(now_epoch=now + 181) == 1
    assert vnext_realtime_store.recover_expired_realtime_workers(now_epoch=now + 181) == 0
    snapshot = vnext_realtime_store.get_realtime_snapshot(realtime_context, session["session_id"])
    assert snapshot["session"]["state"] == "reconnecting"
    assert snapshot["session"]["last_contiguous_chunk_seq"] == 0
    assert len(vnext_realtime_store.get_unconsumed_chunks(realtime_context, session["session_id"])) == 1
    with pytest.raises(vnext_realtime_store.VNextRealtimeError) as caught:
        vnext_realtime_store.renew_realtime_worker(realtime_context, session["session_id"], generation)
    assert caught.value.code == "REALTIME_WORKER_FENCED"
    successor = "d" * 32
    vnext_realtime_store.claim_realtime_worker(realtime_context, session["session_id"], successor)
    resumed = vnext_task_store.claim_attempt(realtime_context, TASK_ID, lease_owner=owner)
    assert resumed["attempt_id"] == attempt["attempt_id"]
    vnext_realtime_store.release_realtime_worker(realtime_context, session["session_id"], generation)
    vnext_realtime_store.renew_realtime_worker(realtime_context, session["session_id"], successor)


def test_health_is_read_only_and_separates_detached_input(realtime_context):
    from app.services.vnext_task_health import task_runtime_snapshot
    session, _ = open_session(realtime_context)
    generation = "c" * 32
    vnext_realtime_store.claim_realtime_worker(realtime_context, session["session_id"], generation)
    vnext_task_store.claim_attempt(realtime_context, TASK_ID, lease_owner=f"realtime:{session['session_id']}")
    assert task_runtime_snapshot()["counts"]["running"] == 1
    vnext_realtime_store.release_realtime_worker(realtime_context, session["session_id"], generation)
    before = vnext_task_store.get_task(realtime_context, TASK_ID)
    state = task_runtime_snapshot()
    assert state["ready"] and state["counts"]["waiting_for_client"] == 1
    assert state["queue_depth"] == state["active_leases"] == state["expired_leases"] == 0
    assert "active_tasks" not in state
    assert before == vnext_task_store.get_task(realtime_context, TASK_ID)


def test_readiness_does_not_heal_expired_leases(realtime_context):
    from app.services.vnext_task_health import task_runtime_snapshot
    session, _ = open_session(realtime_context)
    vnext_realtime_store.claim_realtime_worker(realtime_context, session["session_id"], "c" * 32)
    attempt = vnext_task_store.claim_attempt(realtime_context, TASK_ID, lease_owner=f"realtime:{session['session_id']}")
    with device_identity.control_connection() as c:
        c.execute("UPDATE vnext_task_attempts SET lease_expires_at_epoch=0 WHERE attempt_id=?", (attempt["attempt_id"],))
        c.commit()
    for _ in range(2):
        state = task_runtime_snapshot()
        assert not state["ready"] and state["expired_leases"] == 1
        assert state["counts"]["running"] == 1
    with device_identity.control_connection() as c:
        assert c.execute("SELECT state FROM vnext_task_attempts WHERE attempt_id=?", (attempt["attempt_id"],)).fetchone()[0] == "running"


def test_cancelled_task_is_never_requeued(realtime_context):
    session, _ = open_session(realtime_context)
    generation = "c" * 32
    vnext_realtime_store.claim_realtime_worker(realtime_context, session["session_id"], generation)
    vnext_task_store.claim_attempt(realtime_context, TASK_ID, lease_owner=f"realtime:{session['session_id']}")
    vnext_task_store.cancel_task(realtime_context, TASK_ID)
    vnext_realtime_store.release_realtime_worker(realtime_context, session["session_id"], generation)
    assert vnext_realtime_store.recover_expired_realtime_workers(now_epoch=time.time() + 500) == 0
    assert vnext_task_store.get_task(realtime_context, TASK_ID)["state"] == "cancelled"


def test_ttl_is_terminal_without_deleting_recovery_payload(realtime_context):
    session, _ = open_session(realtime_context)
    generation = "c" * 32
    vnext_realtime_store.claim_realtime_worker(realtime_context, session["session_id"], generation)
    vnext_task_store.claim_attempt(realtime_context, TASK_ID, lease_owner=f"realtime:{session['session_id']}")
    vnext_realtime_store.append_chunk_checkpoint(realtime_context, session["session_id"],
        chunk_seq=0, start_ms=0, end_ms=100, byte_size=3200,
        content_sha256=digest(b"checkpoint"), encrypted_spool_locator="sealed:preserved",
        worker_generation=generation)
    assert vnext_realtime_store.recover_expired_realtime_workers(now_epoch=session["expires_at_epoch"] + 1) == 1
    task = vnext_task_store.get_task(realtime_context, TASK_ID)
    assert task["state"] == "failure" and task["error_code"] == "REALTIME_SESSION_EXPIRED"
    assert vnext_realtime_store.recover_expired_realtime_workers(now_epoch=session["expires_at_epoch"] + 1) == 0
    snapshot = vnext_realtime_store.get_realtime_snapshot(realtime_context, session["session_id"])
    assert snapshot["session"]["state"] == "expired"
    assert len(vnext_realtime_store.get_unconsumed_chunks(realtime_context, session["session_id"])) == 1


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
