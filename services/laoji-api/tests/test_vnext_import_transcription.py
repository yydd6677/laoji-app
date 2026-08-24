from __future__ import annotations

import asyncio
import hashlib
import io
from pathlib import Path
import sqlite3
import time
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor

import pytest
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import device_v2
from app.config import settings
from app.services import (
    compact_transcription_service,
    device_identity,
    r2_storage_service,
    vnext_import_transcript_store,
    vnext_import_transcription_pipeline,
    vnext_realtime_store,
    vnext_task_store,
    vnext_upload_store,
    vnext_verified_media_cache,
)
from app.services.device_v2_identity import DeviceV2Context
from app.services.compact_transcription_service import SpeechAudio


BINDING_ID = "11111111-1111-4111-8111-111111111111"
BINDING_GENERATION = "a" * 32
ASSET_GENERATION = "b" * 32
TASK_ID = "v2-transcript-import-test"


class FakeR2:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.last_key: str | None = None

    def presign_put_object(self, *, object_key: str, mime_type=None) -> str:
        del mime_type
        self.last_key = object_key
        return f"https://r2.invalid/{object_key}"

    def object_head(self, *, object_key: str):
        content = self.objects.get(object_key)
        return None if content is None else {"content_length": len(content), "etag": "fake"}

    def stream_object_sha256(
        self,
        *,
        object_key: str,
        mirror_target: Path | None = None,
    ) -> tuple[str, int]:
        content = self.objects[object_key]
        if mirror_target is not None:
            mirror_target.write_bytes(content)
        return _digest(content), len(content)

    def delete_object(self, *, object_key: str) -> None:
        self.objects.pop(object_key, None)

    def abort_multipart_upload(self, *, object_key: str, upload_id: str) -> None:
        del object_key, upload_id


def _digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


@pytest.mark.parametrize(
    ("value", "expected"),
    [("0", 1), ("1", 1), ("3", 3), ("8", 4), ("invalid", 3)],
)
def test_import_worker_concurrency_is_bounded(value: str, expected: int) -> None:
    assert vnext_import_transcription_pipeline.configured_worker_concurrency(value) == expected


@pytest.mark.asyncio
async def test_import_worker_starts_configured_orchestration_lanes(monkeypatch) -> None:
    monkeypatch.setattr(vnext_import_transcription_pipeline, "WORKER_CONCURRENCY", 3)
    worker = vnext_import_transcription_pipeline.VNextImportTranscriptionWorker()
    worker.start()
    try:
        assert len(worker._tasks) == 3  # type: ignore[attr-defined]
        assert len({task.get_name() for task in worker._tasks}) == 3  # type: ignore[attr-defined]
    finally:
        await worker.stop()
    assert worker._tasks == []  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_import_worker_keeps_inflight_task_reserved(monkeypatch) -> None:
    monkeypatch.setattr(vnext_import_transcription_pipeline, "WORKER_CONCURRENCY", 3)
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def blocked_transcribe(_context, _source, *, attempt_id, lease_owner):
        del attempt_id, lease_owner

    worker = vnext_import_transcription_pipeline.VNextImportTranscriptionWorker(
        transcribe_source=blocked_transcribe,
    )

    async def blocked_process(_context, task_id):
        nonlocal calls
        assert task_id == TASK_ID
        calls += 1
        entered.set()
        await release.wait()

    monkeypatch.setattr(worker, "_process", blocked_process)
    source = {
        "task_id": TASK_ID,
        "device_id": "device-a",
        "epoch_id": "epoch-a",
    }
    worker.start()
    try:
        worker.notify(source)
        await entered.wait()
        worker.notify(source)
        await asyncio.sleep(0)
        assert calls == 1
        assert worker._queue.empty()  # type: ignore[attr-defined]
        assert TASK_ID in worker._queued  # type: ignore[attr-defined]
    finally:
        release.set()
        await worker.stop()


def test_r2_media_is_piped_through_ffmpeg_without_whole_file_copy(monkeypatch) -> None:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes((np.full(8_000, 400, dtype="<i2")).tobytes())
    media = buffer.getvalue()
    reads: list[int] = []
    max_speech_durations: list[int] = []

    def chunk_source(*, object_key: str):
        assert object_key == "private-object"
        for offset in range(0, len(media), 1_337):
            chunk = media[offset:offset + 1_337]
            reads.append(len(chunk))
            yield chunk

    class Segment:
        start_ms = 0
        end_ms = 500

        def __init__(self, audio_data):
            self.audio_data = audio_data

    class FakeVad:
        def __init__(self, _model, sample_rate: int):
            assert sample_rate == 16_000
            self.state = "idle"
            self.emitted = False

        def set_min_silence_duration(self, _value):
            return None

        def set_pre_roll_duration(self, _value, *, initial_duration_ms):
            del initial_duration_ms

        def set_max_speech_duration(self, value):
            max_speech_durations.append(int(value))

        def set_min_energy_threshold(self, _value):
            return None

        def feed(self, audio):
            if self.emitted or audio.size == 0 or not np.any(audio):
                return None
            self.emitted = True
            return Segment(audio.copy())

    monkeypatch.setattr(vnext_import_transcription_pipeline, "StreamingVAD", FakeVad)
    observed_duration: list[int] = []
    segments = list(vnext_import_transcription_pipeline.stream_r2_speech_segments(
        object_key="private-object",
        source_sha256="c" * 64,
        vad_model=object(),
        chunk_source=chunk_source,
        on_decoded_duration_ms=observed_duration.append,
    ))
    assert len(segments) == 1
    assert segments[0].start_ms == 0 and segments[0].end_ms == 500
    assert len(reads) > 2 and max(reads) <= 1_337
    assert observed_duration[-1] == 500
    assert max_speech_durations == [
        vnext_import_transcription_pipeline.ASR_OFFLINE_FIRST_BATCH_MAX_AUDIO_MS,
        vnext_import_transcription_pipeline.ASR_OFFLINE_SEGMENT_MAX_AUDIO_MS,
    ]


def test_seekable_r2_input_decodes_media_with_tail_index(tmp_path, monkeypatch) -> None:
    media = tmp_path / "seekable.wav"
    with wave.open(str(media), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes((np.full(8_000, 400, dtype="<i2")).tobytes())

    class Segment:
        start_ms = 0
        end_ms = 500

        def __init__(self, audio_data):
            self.audio_data = audio_data

    class FakeVad:
        def __init__(self, _model, sample_rate: int):
            assert sample_rate == 16_000
            self.state = "idle"
            self.emitted = False

        def set_min_silence_duration(self, _value):
            return None

        def set_pre_roll_duration(self, _value, *, initial_duration_ms):
            del initial_duration_ms

        def set_max_speech_duration(self, _value):
            return None

        def set_min_energy_threshold(self, _value):
            return None

        def feed(self, audio):
            if self.emitted or audio.size == 0 or not np.any(audio):
                return None
            self.emitted = True
            return Segment(audio.copy())

    monkeypatch.setattr(vnext_import_transcription_pipeline, "StreamingVAD", FakeVad)
    requested: list[str] = []

    def presign(*, object_key: str) -> str:
        requested.append(object_key)
        return media.as_uri()

    segments = list(vnext_import_transcription_pipeline.stream_r2_speech_segments(
        object_key="private-seekable-object",
        source_sha256="d" * 64,
        vad_model=object(),
        input_url_provider=presign,
    ))
    assert requested == ["private-seekable-object"]
    assert len(segments) == 1
    assert segments[0].start_ms == 0 and segments[0].end_ms == 500


@pytest.fixture
def import_context(tmp_path, monkeypatch):
    database = tmp_path / "vnext-import.db"
    monkeypatch.setattr(settings, "DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setattr(settings, "SECRET_KEY", "vnext-import-test-secret-at-least-32-bytes")
    monkeypatch.setattr(settings, "R2_ENABLED", True)
    monkeypatch.setattr(settings, "R2_UPLOAD_SESSION_TTL_HOURS", 24)
    monkeypatch.setattr(settings, "R2_PRESIGN_TTL_SECONDS", 60)
    monkeypatch.setattr(settings, "R2_PART_SIZE", 5 * 1024 * 1024)
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_ENABLED", False)
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_PATH", str(tmp_path / "media-cache"))
    monkeypatch.setattr(
        settings,
        "VNEXT_SPEAKER_SPOOL_PATH",
        str(tmp_path / "speaker-spool"),
    )
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
    context = DeviceV2Context(str(uuid.uuid4()), str(uuid.uuid4()), 1, 1)
    vnext_task_store.ensure_vnext_task_schema()
    vnext_task_store.register_binding(
        context,
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_epoch_seq=1,
    )
    fake = FakeR2()
    monkeypatch.setattr(vnext_upload_store.r2_storage_service, "r2_enabled", lambda: True)
    for name in (
        "presign_put_object",
        "object_head",
        "stream_object_sha256",
        "delete_object",
        "abort_multipart_upload",
    ):
        monkeypatch.setattr(vnext_upload_store.r2_storage_service, name, getattr(fake, name))
    return context, fake


def _verified_source(context: DeviceV2Context, fake: FakeR2, content: bytes) -> dict:
    source_sha256 = _digest(content)
    session, reused = vnext_upload_store.create_upload_session(
        context,
        session_id="v2-upload-import-test",
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        client_operation_id="v2-upload-operation-import-test",
        asset_id="asset-import-test",
        asset_generation=ASSET_GENERATION,
        expected_size=len(content),
        expected_sha256=source_sha256,
        mime_type="audio/wav",
    )
    assert reused is False and fake.last_key is not None
    fake.objects[fake.last_key] = content
    vnext_upload_store.complete_upload_session(
        context,
        session["session_id"],
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        parts=[],
        transcription_task_id=TASK_ID,
        transcription_generation_id="v2-transcript-generation-import-test",
        transcription_input_sha256=source_sha256,
    )
    source = vnext_upload_store.get_verified_transcription_source(context, TASK_ID)
    source["task_id"] = TASK_ID
    return source


def _running_attempt(context: DeviceV2Context, source: dict, owner: str = "import-test") -> str:
    vnext_import_transcript_store.ensure_run(context, source)
    attempt = vnext_task_store.claim_attempt(
        context,
        TASK_ID,
        lease_owner=owner,
        lease_seconds=30,
    )
    assert attempt is not None
    attempt_id = str(attempt["attempt_id"])
    assert vnext_import_transcript_store.mark_running(
        context,
        TASK_ID,
        attempt_id,
        owner,
    )
    return attempt_id


def test_first_event_poll_materializes_queued_run_after_upload_commit(import_context) -> None:
    """The phone must see queued, not a transient run-not-found response."""
    context, fake = import_context
    _verified_source(context, fake, b"poll-before-worker-scan")

    snapshot = vnext_import_transcript_store.get_event_snapshot(context, TASK_ID)

    assert snapshot is not None
    assert snapshot["state"] == "queued"
    assert snapshot["task_id"] == TASK_ID
    with device_identity.control_connection() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM vnext_import_transcript_runs WHERE task_id = ?",
            (TASK_ID,),
        ).fetchone()[0] == 1


def test_stable_events_are_recoverable_and_r2_waits_for_phone_ack(import_context) -> None:
    context, fake = import_context
    source = _verified_source(context, fake, b"private-audio")
    attempt_id = _running_attempt(context, source)
    first = vnext_import_transcript_store.append_stable_event(
        context,
        TASK_ID,
        attempt_id=attempt_id,
        lease_owner="import-test",
        stable_segment_key="segment-1",
        text="先确认需求。",
        source_start_ms=0,
        source_end_ms=1_500,
        model_revision="asr-test-r1",
    )
    replay = vnext_import_transcript_store.append_stable_event(
        context,
        TASK_ID,
        attempt_id=attempt_id,
        lease_owner="import-test",
        stable_segment_key="segment-1",
        text="先确认需求。",
        source_start_ms=0,
        source_end_ms=1_500,
        model_revision="asr-test-r1",
    )
    assert first["reused"] is False and replay["reused"] is True
    with pytest.raises(vnext_import_transcript_store.VNextImportTranscriptError) as conflict:
        vnext_import_transcript_store.append_stable_event(
            context,
            TASK_ID,
            attempt_id=attempt_id,
            lease_owner="import-test",
            stable_segment_key="segment-1",
            text="被篡改的文字",
            source_start_ms=0,
            source_end_ms=1_500,
            model_revision="asr-test-r1",
        )
    assert conflict.value.code == "TRANSCRIPT_EVENT_CONFLICT"
    final = vnext_import_transcript_store.commit_final(
        context,
        TASK_ID,
        attempt_id=attempt_id,
        lease_owner="import-test",
        outcome="text",
        source_duration_ms=1_500,
        model_revision="asr-test-r1",
    )
    assert final["state"] == "succeeded"
    snapshot = vnext_import_transcript_store.get_event_snapshot(context, TASK_ID)
    assert snapshot is not None
    assert [item["event_kind"] for item in snapshot["events"]] == ["stable", "final"]
    assert vnext_upload_store.process_cleanup_obligations(now_epoch=int(time.time())) == 0
    assert fake.last_key in fake.objects

    projection_sha256 = _digest(b"durable-phone-transcript-revision")
    ack = vnext_import_transcript_store.ack_events(
        context,
        TASK_ID,
        through_event_seq=2,
        projection_sha256=projection_sha256,
    )
    assert ack["reused"] is False and ack["cleanup_id"]
    replay_ack = vnext_import_transcript_store.ack_events(
        context,
        TASK_ID,
        through_event_seq=2,
        projection_sha256=projection_sha256,
    )
    assert replay_ack["reused"] is True
    after_ack = vnext_import_transcript_store.get_event_snapshot(context, TASK_ID)
    assert after_ack is not None and after_ack["events"] == []
    with device_identity.control_connection() as connection:
        cleanup_after = int(connection.execute(
            "SELECT not_before_epoch FROM vnext_object_cleanup_obligations"
        ).fetchone()[0])
    assert vnext_upload_store.process_cleanup_obligations(now_epoch=cleanup_after) == 1
    assert fake.last_key not in fake.objects
    upload = vnext_upload_store.get_upload_session(context, source["upload_session_id"])
    assert upload is not None and upload["state"] == "consumed"


def test_no_speech_is_successful_content_outcome(import_context) -> None:
    context, fake = import_context
    source = _verified_source(context, fake, b"silent-audio")
    attempt_id = _running_attempt(context, source)
    final = vnext_import_transcript_store.commit_final(
        context,
        TASK_ID,
        attempt_id=attempt_id,
        lease_owner="import-test",
        outcome="no_speech",
        source_duration_ms=0,
        model_revision="asr-test-r1",
    )
    assert final["state"] == "no_content"
    task = vnext_task_store.get_task(context, TASK_ID)
    assert task is not None
    assert task["state"] == "success" and task["result_kind"] == "content_outcome"
    snapshot = vnext_import_transcript_store.get_event_snapshot(context, TASK_ID)
    assert snapshot is not None
    assert snapshot["events"] == [{
        "schema_version": 2,
        "contract_revision": "transcript.stream.v2",
        "session_id": TASK_ID,
        "event_sequence": 1,
        "event_kind": "final",
        "stable_segment_key": None,
        "segment_revision": 1,
        "text_state": "final",
        "outcome": "no_speech",
        "text": "",
        "source_start_ms": 0,
        "source_end_ms": 0,
        "model_revision": "asr-test-r1",
    }]


def test_terminal_failure_queues_verified_source_cleanup(import_context) -> None:
    context, fake = import_context
    source = _verified_source(context, fake, b"terminal-failure-audio")
    attempt_id = _running_attempt(context, source)
    assert vnext_import_transcript_store.mark_failure(
        context,
        TASK_ID,
        attempt_id=attempt_id,
        lease_owner="import-test",
        error_code="AUDIO_DECODE_FAILED",
        retryable=False,
    )
    task = vnext_task_store.get_task(context, TASK_ID)
    assert task is not None and task["state"] == "failure"
    assert fake.last_key in fake.objects
    with device_identity.control_connection() as connection:
        cleanup_after = int(connection.execute(
            "SELECT not_before_epoch FROM vnext_object_cleanup_obligations"
        ).fetchone()[0])
    assert vnext_upload_store.process_cleanup_obligations(now_epoch=cleanup_after) == 1
    assert fake.last_key not in fake.objects


def test_binding_purge_accelerates_pending_consumed_cleanup(import_context) -> None:
    context, fake = import_context
    source = _verified_source(context, fake, b"purge-before-ack-audio")
    attempt_id = _running_attempt(context, source)
    vnext_import_transcript_store.commit_final(
        context,
        TASK_ID,
        attempt_id=attempt_id,
        lease_owner="import-test",
        outcome="no_speech",
        source_duration_ms=1_000,
        model_revision="asr-test-r1",
    )
    now_epoch = int(time.time())
    with device_identity.control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        assert vnext_upload_store.queue_scope_cleanup_in_transaction(
            connection,
            device_id=context.device_id,
            epoch_id=context.epoch_id,
            binding_id=BINDING_ID,
            binding_generation=BINDING_GENERATION,
            now_epoch=now_epoch,
        ) == 1
        obligation = connection.execute(
            "SELECT cleanup_reason, not_before_epoch FROM vnext_object_cleanup_obligations"
        ).fetchone()
        last_presign = connection.execute(
            "SELECT last_presign_expires_at_epoch FROM vnext_upload_sessions"
        ).fetchone()[0]
        connection.commit()
    assert tuple(obligation) == ("cancelled", max(now_epoch, int(last_presign)))
    assert vnext_upload_store.process_cleanup_obligations(now_epoch=int(last_presign)) == 1
    assert fake.last_key not in fake.objects


def test_terminal_event_payloads_expire_after_recovery_window(import_context) -> None:
    context, fake = import_context
    source = _verified_source(context, fake, b"event-ttl-audio")
    attempt_id = _running_attempt(context, source)
    vnext_import_transcript_store.commit_final(
        context,
        TASK_ID,
        attempt_id=attempt_id,
        lease_owner="import-test",
        outcome="no_speech",
        source_duration_ms=1_000,
        model_revision="asr-test-r1",
    )
    now_epoch = int(time.time())
    with device_identity.control_connection() as connection:
        connection.execute(
            "UPDATE vnext_import_transcript_runs SET terminal_at = datetime(?, 'unixepoch')",
            (now_epoch - vnext_import_transcript_store.EVENT_PAYLOAD_TTL_SECONDS - 1,),
        )
        connection.commit()
    assert vnext_import_transcript_store.purge_expired_event_payloads(now_epoch=now_epoch) == 1
    snapshot = vnext_import_transcript_store.get_event_snapshot(context, TASK_ID)
    assert snapshot is not None and snapshot["events"] == []


def test_two_upload_completions_and_realtime_session_keep_distinct_task_owners(
    import_context,
) -> None:
    context, fake = import_context
    sources: list[tuple[dict, str, str]] = []
    for ordinal in (1, 2):
        content = f"concurrent-audio-{ordinal}".encode()
        digest = _digest(content)
        session, _ = vnext_upload_store.create_upload_session(
            context,
            session_id=f"v2-upload-concurrent-{ordinal}",
            binding_id=BINDING_ID,
            binding_generation=BINDING_GENERATION,
            binding_revision=1,
            cancel_revision=0,
            client_operation_id=f"v2-upload-operation-concurrent-{ordinal}",
            asset_id=f"asset-concurrent-{ordinal}",
            asset_generation=f"{ordinal:x}" * 32,
            expected_size=len(content),
            expected_sha256=digest,
            mime_type="audio/wav",
        )
        assert fake.last_key is not None
        fake.objects[fake.last_key] = content
        sources.append((session, digest, f"v2-transcript-concurrent-{ordinal}"))

    realtime, reused = vnext_realtime_store.open_realtime_session(
        context,
        session_id="realtime-during-two-imports",
        task_id="v2-transcript-realtime-concurrent",
        client_operation_id="realtime-operation-concurrent",
        binding_id=BINDING_ID,
        binding_generation=BINDING_GENERATION,
        binding_revision=1,
        cancel_revision=0,
        asset_id="asset-realtime-concurrent",
        asset_generation="f" * 32,
        codec_revision="pcm16-16000-mono-v1",
        expires_at_epoch=int(time.time()) + 900,
    )
    assert reused is False and realtime["state"] == "open"

    def complete(item: tuple[dict, str, str]):
        session, digest, task_id = item
        return vnext_upload_store.complete_upload_session(
            context,
            session["session_id"],
            binding_generation=BINDING_GENERATION,
            binding_revision=1,
            cancel_revision=0,
            parts=[],
            transcription_task_id=task_id,
            transcription_generation_id=f"generation-{task_id}",
            transcription_input_sha256=digest,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        completed = list(pool.map(complete, sources))
    assert {item["task"]["task_id"] for item in completed} == {
        "v2-transcript-concurrent-1",
        "v2-transcript-concurrent-2",
    }
    with device_identity.control_connection() as connection:
        rows = connection.execute(
            "SELECT task_id, capability FROM vnext_tasks ORDER BY task_id"
        ).fetchall()
    assert {tuple(row) for row in rows} == {
        ("v2-transcript-concurrent-1", "transcript"),
        ("v2-transcript-concurrent-2", "transcript"),
        ("v2-transcript-realtime-concurrent", "transcript"),
    }


@pytest.mark.asyncio
async def test_worker_reclaims_expired_attempt_without_duplicate_final(import_context) -> None:
    context, fake = import_context
    source = _verified_source(context, fake, b"restart-audio")
    vnext_import_transcript_store.ensure_run(context, source)
    stale = vnext_task_store.claim_attempt(
        context,
        TASK_ID,
        lease_owner="dead-worker",
        lease_seconds=30,
    )
    assert stale is not None
    with device_identity.control_connection() as connection:
        connection.execute(
            "UPDATE vnext_task_attempts SET lease_expires_at_epoch = 0 WHERE attempt_id = ?",
            (stale["attempt_id"],),
        )
        connection.commit()

    calls = 0

    async def fake_transcribe(context_arg, source_arg, *, attempt_id, lease_owner):
        nonlocal calls
        calls += 1
        vnext_import_transcript_store.append_stable_event(
            context_arg,
            TASK_ID,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
            stable_segment_key="segment-recovered",
            text="恢复后只提交一次。",
            source_start_ms=0,
            source_end_ms=1_200,
            model_revision="asr-test-r1",
        )
        return vnext_import_transcript_store.commit_final(
            context_arg,
            TASK_ID,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
            outcome="text",
            source_duration_ms=1_200,
            model_revision="asr-test-r1",
        )

    worker = vnext_import_transcription_pipeline.VNextImportTranscriptionWorker(
        transcribe_source=fake_transcribe,
    )
    await worker._process(context, TASK_ID)  # type: ignore[attr-defined]
    await worker._process(context, TASK_ID)  # type: ignore[attr-defined]
    snapshot = vnext_import_transcript_store.get_event_snapshot(context, TASK_ID)
    assert snapshot is not None
    assert calls == 1
    assert [item["event_kind"] for item in snapshot["events"]] == ["stable", "final"]


def test_import_event_api_is_device_scoped_and_acknowledges_projection(import_context) -> None:
    context, fake = import_context
    source = _verified_source(context, fake, b"api-audio")
    attempt_id = _running_attempt(context, source)
    vnext_import_transcript_store.commit_final(
        context,
        TASK_ID,
        attempt_id=attempt_id,
        lease_owner="import-test",
        outcome="no_speech",
        source_duration_ms=0,
        model_revision="asr-test-r1",
    )
    app = FastAPI()
    app.include_router(device_v2.router, prefix="/api")
    app.dependency_overrides[device_v2.require_device_v2] = lambda: context
    client = TestClient(app)
    snapshot = client.get(f"/api/device/v2/tasks/{TASK_ID}/transcript-events")
    assert snapshot.status_code == 200
    assert snapshot.json()["state"] == "no_content"
    assert snapshot.json()["events"][0]["outcome"] == "no_speech"
    projection_sha256 = _digest(b"phone-no-speech-outcome")
    ack = client.post(
        f"/api/device/v2/tasks/{TASK_ID}/transcript-events/ack",
        json={
            "schema_version": 2,
            "through_event_seq": 1,
            "projection_sha256": projection_sha256,
        },
    )
    assert ack.status_code == 200
    assert ack.json()["through_event_seq"] == 1


@pytest.mark.asyncio
async def test_checkpoint_replay_republishes_stable_text_without_second_asr_call(
    import_context,
    tmp_path,
    monkeypatch,
) -> None:
    context, fake = import_context
    monkeypatch.setattr(settings, "AUDIO_STORAGE_PATH", str(tmp_path / "audio"))
    source = _verified_source(context, fake, b"recoverable-audio")
    first_attempt = _running_attempt(context, source, owner="recover-owner")
    speech = SpeechAudio(
        ordinal=0,
        segment_id="segment-checkpoint-replay",
        start_ms=0,
        end_ms=1_500,
        audio=np.full(24_000, 0.1, dtype=np.float32),
    )

    class FakeManager:
        async def initialize_vad(self) -> None:
            return None

        def create_vad_model(self):
            return object()

    manager = FakeManager()
    monkeypatch.setattr(
        vnext_import_transcription_pipeline.ModelManager,
        "get_instance",
        lambda: manager,
    )
    monkeypatch.setattr(
        vnext_import_transcription_pipeline,
        "stream_r2_speech_segments",
        lambda **_kwargs: iter([speech]),
    )
    asr_calls = 0

    def fake_ready():
        return {"ready": True, "model": "Qwen3-ASR", "model_revision": "asr-test-r1"}

    def fake_batch(*, items, priority, timeout_seconds):
        nonlocal asr_calls
        del timeout_seconds
        asr_calls += 1
        assert priority == "offline"
        return {
            "schema_version": 2,
            "contract_revision": "asr.batch.v2",
            "model": "Qwen3-ASR",
            "model_revision": "asr-test-r1",
            "priority": "offline",
            "queue_ms": 1,
            "infer_ms": 2,
            "items": [{
                "id": item["id"],
                "stable_segment_key": item["id"],
                "segment_revision": 1,
                "text_state": "stable",
                "outcome": "text",
                "text": "恢复后的稳定文字。",
                "language": "Chinese",
                "source_start_ms": item["source_start_ms"],
                "source_end_ms": item["source_end_ms"],
                "audio_ms": 1_500,
                "model_revision": "asr-test-r1",
                "queue_ms": 1,
                "infer_ms": 2,
            } for item in items],
        }

    monkeypatch.setattr(vnext_import_transcription_pipeline.vnext_asr_client, "ready_snapshot", fake_ready)
    monkeypatch.setattr(vnext_import_transcription_pipeline.vnext_asr_client, "transcribe_batch", fake_batch)

    async def fake_speaker_finalize(_context, _run_id):
        return {"state": "queued"}

    monkeypatch.setattr(
        vnext_import_transcription_pipeline.vnext_speaker_pipeline,
        "finalize_realtime_speaker",
        fake_speaker_finalize,
    )
    original_append = vnext_import_transcript_store.append_stable_event
    fail_once = True

    def interrupted_append(*args, **kwargs):
        nonlocal fail_once
        if fail_once:
            fail_once = False
            raise RuntimeError("simulated_process_interruption")
        return original_append(*args, **kwargs)

    monkeypatch.setattr(vnext_import_transcript_store, "append_stable_event", interrupted_append)
    with pytest.raises(RuntimeError, match="simulated_process_interruption"):
        await vnext_import_transcription_pipeline._transcribe_source(
            context,
            source,
            attempt_id=first_attempt,
            lease_owner="recover-owner",
        )
    assert vnext_import_transcript_store.mark_failure(
        context,
        TASK_ID,
        attempt_id=first_attempt,
        lease_owner="recover-owner",
        error_code="TRANSCRIPT_INTERRUPTED",
        retryable=True,
        retry_after_seconds=0,
    )
    second = vnext_task_store.claim_attempt(
        context,
        TASK_ID,
        lease_owner="recover-owner",
        lease_seconds=30,
    )
    assert second is not None
    second_attempt = str(second["attempt_id"])
    assert vnext_import_transcript_store.mark_running(
        context,
        TASK_ID,
        second_attempt,
        "recover-owner",
    )
    retry_snapshot = vnext_import_transcript_store.get_event_snapshot(context, TASK_ID)
    assert retry_snapshot is not None
    assert retry_snapshot["state"] == "running"
    assert retry_snapshot["error_code"] is None
    result = await vnext_import_transcription_pipeline._transcribe_source(
        context,
        source,
        attempt_id=second_attempt,
        lease_owner="recover-owner",
    )
    assert result["transcript"]["state"] == "succeeded"
    assert asr_calls == 1
    snapshot = vnext_import_transcript_store.get_event_snapshot(context, TASK_ID)
    assert snapshot is not None
    assert [event["event_kind"] for event in snapshot["events"]] == ["stable", "final"]


@pytest.mark.asyncio
async def test_verified_media_cache_is_local_and_removed_after_final(
    import_context,
    tmp_path,
    monkeypatch,
) -> None:
    context, fake = import_context
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_ENABLED", True)
    monkeypatch.setattr(settings, "VNEXT_VERIFIED_MEDIA_CACHE_PATH", str(tmp_path / "media-cache"))
    monkeypatch.setattr(settings, "AUDIO_STORAGE_PATH", str(tmp_path / "audio"))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(np.full(24_000, 600, dtype="<i2").tobytes())
    source = _verified_source(context, fake, buffer.getvalue())
    cached = vnext_verified_media_cache.resolve(
        asset_revision_id=str(source["asset_revision_id"]),
        source_sha256=str(source["source_sha256"]),
        expected_size=int(source["byte_size"]),
    )
    assert cached is not None and cached.is_file()
    attempt_id = _running_attempt(context, source, owner="cache-owner")
    speech = SpeechAudio(
        ordinal=0,
        segment_id="segment-local-cache",
        start_ms=0,
        end_ms=1_500,
        audio=np.full(24_000, 0.1, dtype=np.float32),
    )

    class FakeManager:
        async def initialize_vad(self) -> None:
            return None

        def create_vad_model(self):
            return object()

    manager = FakeManager()
    monkeypatch.setattr(
        vnext_import_transcription_pipeline.ModelManager,
        "get_instance",
        lambda: manager,
    )

    def local_segments(path, *, source_sha256, vad_model):
        assert Path(path) == cached
        assert source_sha256 == str(source["source_sha256"])[7:]
        assert vad_model is not None
        return iter([speech])

    monkeypatch.setattr(compact_transcription_service, "stream_speech_segments", local_segments)
    monkeypatch.setattr(compact_transcription_service, "_probe_duration_ms", lambda _path: 1_500)
    monkeypatch.setattr(
        vnext_import_transcription_pipeline,
        "stream_r2_speech_segments",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("R2 must not be read twice")),
    )
    monkeypatch.setattr(
        vnext_import_transcription_pipeline.vnext_asr_client,
        "ready_snapshot",
        lambda: {"ready": True, "model": "Qwen3-ASR", "model_revision": "asr-test-r1"},
    )

    def fake_batch(*, items, priority, timeout_seconds):
        del timeout_seconds
        assert priority == "offline"
        return {
            "schema_version": 2,
            "contract_revision": "asr.batch.v2",
            "model": "Qwen3-ASR",
            "model_revision": "asr-test-r1",
            "priority": priority,
            "queue_ms": 1,
            "infer_ms": 2,
            "items": [{
                "id": item["id"],
                "stable_segment_key": item["id"],
                "segment_revision": 1,
                "text_state": "stable",
                "outcome": "text",
                "text": "本地校验媒体只解码一次。",
                "language": "Chinese",
                "source_start_ms": item["source_start_ms"],
                "source_end_ms": item["source_end_ms"],
                "audio_ms": 1_500,
                "model_revision": "asr-test-r1",
                "queue_ms": 1,
                "infer_ms": 2,
            } for item in items],
        }

    monkeypatch.setattr(
        vnext_import_transcription_pipeline.vnext_asr_client,
        "transcribe_batch",
        fake_batch,
    )

    async def fake_speaker_finalize(_context, _run_id):
        return {"state": "queued"}

    monkeypatch.setattr(
        vnext_import_transcription_pipeline.vnext_speaker_pipeline,
        "finalize_realtime_speaker",
        fake_speaker_finalize,
    )
    result = await vnext_import_transcription_pipeline._transcribe_source(
        context,
        source,
        attempt_id=attempt_id,
        lease_owner="cache-owner",
    )

    assert result["transcript"]["state"] == "succeeded"
    assert not cached.exists()
