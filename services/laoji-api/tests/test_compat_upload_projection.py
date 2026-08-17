from __future__ import annotations

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_recording_asset import (
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.services.meeting_recording_asset_service import project_compat_media_upload


@pytest.mark.asyncio
async def test_compat_uploads_share_recording_asset_identity_and_queue_independently(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    first_source = tmp_path / "first.wav"
    first_source.write_bytes(b"first recording")
    second_source = tmp_path / "second.mp4"
    second_source.write_bytes(b"second recording")
    duplicate_source = tmp_path / "duplicate.wav"
    duplicate_source.write_bytes(first_source.read_bytes())

    async with sessions() as db:
        meeting = Meeting(id="meeting-1", user_id=7, app_owned=1, title="兼容上传")
        db.add(meeting)
        await db.commit()

        first_asset, first_job, first_submit = await project_compat_media_upload(
            db,
            meeting=meeting,
            user_id=7,
            source_path=first_source,
            file_name="first.wav",
            mime_type="audio/wav",
            duration_ms=1000,
            start_transcription=True,
        )
        await db.commit()
        assert first_asset["role"] == "primary"
        assert first_submit is True
        assert first_job["status"] == "queued"
        assert meeting.audio_path == str(first_source)

        second_asset, second_job, second_submit = await project_compat_media_upload(
            db,
            meeting=meeting,
            user_id=7,
            source_path=second_source,
            file_name="second.mp4",
            mime_type="video/mp4",
            duration_ms=2000,
            start_transcription=True,
        )
        await db.commit()
        assert second_asset["role"] == "secondary"
        assert second_submit is True
        assert second_job["job_id"] != first_job["job_id"]
        assert meeting.audio_path == str(first_source)
        assert first_source.exists() and second_source.exists()

        replay_asset, replay_job, replay_submit = await project_compat_media_upload(
            db,
            meeting=meeting,
            user_id=7,
            source_path=duplicate_source,
            file_name="duplicate.wav",
            mime_type="audio/wav",
            duration_ms=1000,
            start_transcription=True,
        )
        await db.commit()
        assert replay_asset["id"] == first_asset["id"]
        assert replay_job["job_id"] == first_job["job_id"]
        assert replay_submit is False
        assert not duplicate_source.exists()
        assert await db.scalar(select(func.count(MeetingRecordingAssetV2.id))) == 2
        assert await db.scalar(select(func.count(MeetingRecordingTranscriptionJobV2.id))) == 2

    await engine.dispose()
