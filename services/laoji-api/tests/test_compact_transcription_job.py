from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import database
from app.asr import model_manager
from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_recording_asset import (
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.models.transcript import TranscriptLine
from app.services import compact_transcription_service as compact
from app.services import meeting_recording_asset_service as recording_service


class ReadyManager:
    def is_initialized(self):
        return True


async def _seed(sessions, source, *, old_text="已有可用文字"):
    checksum = f"sha256:{hashlib.sha256(source.read_bytes()).hexdigest()}"
    async with sessions() as db:
        db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="录音", status="ended"))
        db.add(
            MeetingRecordingAssetV2(
                id="asset-1",
                meeting_id="meeting-1",
                user_id=7,
                client_asset_id="client-asset-1",
                role="primary",
                origin="imported",
                revision=2,
                upload_state="uploaded",
                mime_type="audio/wav",
                file_name="recording.wav",
                byte_size=source.stat().st_size,
                duration_ms=2000,
                checksum_sha256=checksum,
                storage_path=str(source),
            )
        )
        db.add(
            MeetingRecordingTranscriptionJobV2(
                id="job-1",
                meeting_id="meeting-1",
                asset_id="asset-1",
                user_id=7,
                client_request_id="client-job-1",
                idempotency_key="operation-job-1",
                language="zh",
                status="queued",
                attempt=0,
                progress=0.0,
                retryable=0,
            )
        )
        db.add(
            TranscriptLine(
                id="old-line",
                meeting_id="meeting-1",
                recording_asset_id="asset-1",
                speaker_id="old-speaker",
                speaker_label="原讲话人",
                text=old_text,
                start_time=0.0,
                end_time=1.0,
                confidence=0.8,
            )
        )
        await db.commit()


@pytest.mark.asyncio
async def test_compact_job_replaces_transcript_only_after_success(monkeypatch, tmp_path):
    source = tmp_path / "source.wav"
    source.write_bytes(b"immutable recording")
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    await _seed(sessions, source)
    monkeypatch.setenv("LAOJI_COMPACT_TRANSCRIPTION_ENABLED", "1")
    monkeypatch.setattr(database, "async_session", sessions)
    monkeypatch.setattr(model_manager, "get_model_manager", lambda: ReadyManager())
    checkpoint_dir = tmp_path / "checkpoint"
    cleaned: list[str] = []
    monkeypatch.setattr(
        compact,
        "cleanup_checkpoint_dir",
        lambda path: cleaned.append(str(path)) or True,
    )
    monkeypatch.setattr(
        compact,
        "transcribe_recording_asset",
        lambda **_kwargs: compact.CompactTranscriptionResult(
            model="qwen",
            model_revision="revision-1",
            source_duration_ms=2000,
            turns=[
                {
                    "segment_id": "segment-1",
                    "speaker_id": "anonymous_1",
                    "speaker_label": "发言人 1",
                    "text": "新的简体文字",
                    "start_ms": 0,
                    "end_ms": 2000,
                    "confidence": 0.0,
                }
            ],
            checkpoint_dir=str(checkpoint_dir),
        ),
    )

    await recording_service._run_transcription_job_async("job-1")

    async with sessions() as db:
        lines = list(
            (
                await db.execute(
                    select(TranscriptLine).where(TranscriptLine.meeting_id == "meeting-1")
                )
            ).scalars()
        )
        job = await db.get(MeetingRecordingTranscriptionJobV2, "job-1")
        meeting = await db.get(Meeting, "meeting-1")
    assert [line.text for line in lines] == ["新的简体文字"]
    assert job.status == "completed"
    assert job.result_revision_id.startswith("recording-transcript:")
    assert meeting.status == "ended"
    assert source.read_bytes() == b"immutable recording"
    assert cleaned == [str(checkpoint_dir)]
    await engine.dispose()


@pytest.mark.asyncio
async def test_compact_job_failure_keeps_existing_transcript(monkeypatch, tmp_path):
    source = tmp_path / "source.wav"
    source.write_bytes(b"immutable recording")
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    await _seed(sessions, source)
    monkeypatch.setenv("LAOJI_COMPACT_TRANSCRIPTION_ENABLED", "1")
    monkeypatch.setattr(database, "async_session", sessions)
    monkeypatch.setattr(model_manager, "get_model_manager", lambda: ReadyManager())

    def fail(**_kwargs):
        raise compact.CompactTranscriptionError("asr_batch_failed")

    monkeypatch.setattr(compact, "transcribe_recording_asset", fail)

    await recording_service._run_transcription_job_async("job-1")

    async with sessions() as db:
        lines = list((await db.execute(select(TranscriptLine))).scalars())
        job = await db.get(MeetingRecordingTranscriptionJobV2, "job-1")
        meeting = await db.get(Meeting, "meeting-1")
    assert [line.text for line in lines] == ["已有可用文字"]
    assert job.status == "failed"
    assert job.error_code == "asr_batch_failed"
    assert job.retryable == 1
    assert meeting.status == "ended"
    assert source.read_bytes() == b"immutable recording"
    await engine.dispose()
