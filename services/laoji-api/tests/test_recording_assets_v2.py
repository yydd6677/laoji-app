import asyncio
from io import BytesIO
import hashlib
import json

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import app_meeting_v2, app_recording_v2
from app.models import Base
from app.models.meeting import Meeting
from app.models.meeting_recording_asset import (
    MeetingRecordingAssetOperationV2,
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.services import meeting_recording_asset_service as service


def test_transient_asr_failure_retries_without_user_action(monkeypatch):
    calls = []
    delays = []

    def transcribe(**kwargs):
        calls.append(kwargs)
        if len(calls) < 3:
            raise RuntimeError("asr_batch_failed")
        return "completed"

    async def no_wait(delay):
        delays.append(delay)

    monkeypatch.setenv("LAOJI_ASR_TRANSIENT_RETRIES", "3")
    monkeypatch.setattr(service.asyncio, "sleep", no_wait)

    result = asyncio.run(
        service._transcribe_with_transient_retry(transcribe, source_path="sample.wav")
    )

    assert result == "completed"
    assert len(calls) == 3
    assert delays == [1.0, 2.0]


def test_non_transient_transcription_failure_is_not_retried(monkeypatch):
    calls = 0

    def transcribe(**_kwargs):
        nonlocal calls
        calls += 1
        raise RuntimeError("recording_checksum_invalid")

    monkeypatch.setenv("LAOJI_ASR_TRANSIENT_RETRIES", "8")
    with pytest.raises(RuntimeError, match="recording_checksum_invalid"):
        asyncio.run(service._transcribe_with_transient_retry(transcribe))

    assert calls == 1


def test_startup_removes_only_interrupted_upload_parts(tmp_path, monkeypatch):
    nested = tmp_path / "app-meetings" / "user-7"
    nested.mkdir(parents=True)
    interrupted = nested / ".meeting.wav.part"
    interrupted.write_bytes(b"partial")
    completed = nested / "meeting.wav"
    completed.write_bytes(b"complete")
    unrelated = nested / ".metadata.json"
    unrelated.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(service.settings, "AUDIO_STORAGE_PATH", str(tmp_path))

    assert service.cleanup_interrupted_upload_parts() == 1
    assert not interrupted.exists()
    assert completed.read_bytes() == b"complete"
    assert unrelated.read_text(encoding="utf-8") == "{}"


def response_json(response):
    return json.loads(response.body)


def registration(client_asset_id: str, role: str, content: bytes, *, checksum=True):
    return app_recording_v2.RecordingAssetV2Register(
        schema_version=2,
        client_asset_id=client_asset_id,
        role=role,
        origin="captured" if role == "primary" else "recovered",
        mime_type="audio/wav",
        file_name=f"{client_asset_id}.wav",
        byte_size=len(content),
        duration_ms=1000,
        checksum_sha256=(
            f"sha256:{hashlib.sha256(content).hexdigest()}" if checksum else None
        ),
    )


@pytest.mark.asyncio
async def test_recording_assets_v2_multi_asset_upload_replay_and_legacy_projection(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setattr(app_recording_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    monkeypatch.setattr(app_recording_v2, "_probe_duration_sec", lambda _path: 1.0)
    monkeypatch.setattr(
        app_recording_v2,
        "recording_asset_storage_path",
        lambda **values: tmp_path / f"{values['asset_id']}{values['suffix']}",
    )
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    primary_bytes = b"RIFF-primary-recording"
    secondary_bytes = b"RIFF-secondary-recording"
    try:
        async with sessions() as db:
            db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="多录音"))
            await db.commit()

            primary_registered = await app_recording_v2.post_recording_asset_v2(
                "meeting-1",
                registration("local-primary", "primary", primary_bytes),
                idempotency_key="asset-register-primary",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            primary = response_json(primary_registered)
            assert primary_registered.status_code == 201
            assert primary_registered.headers["etag"] == '"1"'

            replay = await app_recording_v2.post_recording_asset_v2(
                "meeting-1",
                registration("local-primary", "primary", primary_bytes),
                idempotency_key="asset-register-primary",
                current_user={"id": 7},
                db=db,
            )
            assert response_json(replay) == primary

            uploaded = await app_recording_v2.put_recording_asset_content_v2(
                primary["id"],
                UploadFile(filename="primary.wav", file=BytesIO(primary_bytes)),
                if_match='"1"',
                idempotency_key="asset-content-primary",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            uploaded_body = response_json(uploaded)
            assert uploaded_body["revision"] == 2
            assert uploaded_body["result"] == "uploaded"
            assert uploaded_body["checksum_sha256"].endswith(hashlib.sha256(primary_bytes).hexdigest())

            content_replay = await app_recording_v2.put_recording_asset_content_v2(
                primary["id"],
                UploadFile(filename="primary.wav", file=BytesIO(primary_bytes)),
                if_match='"1"',
                idempotency_key="asset-content-primary",
                current_user={"id": 7},
                db=db,
            )
            assert content_replay.headers["x-idempotent-replay"] == "true"
            assert response_json(content_replay) == uploaded_body

            secondary_registered = await app_recording_v2.post_recording_asset_v2(
                "meeting-1",
                registration("local-secondary", "secondary", secondary_bytes),
                idempotency_key="asset-register-secondary",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            secondary = response_json(secondary_registered)
            secondary_uploaded = await app_recording_v2.put_recording_asset_content_v2(
                secondary["id"],
                UploadFile(filename="secondary.wav", file=BytesIO(secondary_bytes)),
                if_match='"1"',
                idempotency_key="asset-content-secondary",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            assert response_json(secondary_uploaded)["revision"] == 2

            listed = await app_recording_v2.get_recording_assets_v2(
                "meeting-1", current_user={"id": 7}, db=db,
            )
            assert [item["role"] for item in listed["items"]] == ["primary", "secondary"]
            assert all(item["content_url"] for item in listed["items"])
            meeting = await db.get(Meeting, "meeting-1")
            assert meeting.audio_path == str(tmp_path / f"{primary['id']}.wav")
            assert meeting.audio_file_name == "local-primary.wav"
            assert await db.scalar(select(func.count(MeetingRecordingAssetV2.id))) == 2
            assert await db.scalar(select(func.count(MeetingRecordingAssetOperationV2.id))) == 4

            stale = await app_recording_v2.put_recording_asset_content_v2(
                primary["id"],
                UploadFile(filename="primary.wav", file=BytesIO(primary_bytes)),
                if_match='"1"',
                idempotency_key="asset-content-stale",
                current_user={"id": 7},
                db=db,
            )
            assert stale.status_code == 412
            assert response_json(stale)["current"]["revision"] == 2

            with pytest.raises(HTTPException) as hidden:
                await app_recording_v2.get_recording_assets_v2(
                    "meeting-1", current_user={"id": 8}, db=db,
                )
            assert hidden.value.status_code == 404

            capabilities = await app_meeting_v2.get_laoji_capabilities(db)
            assert capabilities["recording_assets_v2"] is True
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_recording_asset_v2_checksum_and_transcription_identity(monkeypatch, tmp_path):
    monkeypatch.setattr(app_recording_v2, "is_user_meeting_tombstoned", lambda _user_id: False)
    monkeypatch.setattr(app_recording_v2, "_probe_duration_sec", lambda _path: 1.0)
    monkeypatch.setattr(
        app_recording_v2,
        "recording_asset_storage_path",
        lambda **values: tmp_path / f"{values['asset_id']}{values['suffix']}",
    )
    submitted = []
    monkeypatch.setattr(app_recording_v2, "submit_transcription_job", submitted.append)
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    content = b"RIFF-recording-content"
    try:
        async with sessions() as db:
            db.add(Meeting(id="meeting-1", user_id=7, app_owned=1, title="转写身份"))
            await db.commit()
            registered_response = await app_recording_v2.post_recording_asset_v2(
                "meeting-1",
                registration("asset-1", "primary", content),
                idempotency_key="asset-register-1",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            registered = response_json(registered_response)

            bad = await app_recording_v2.put_recording_asset_content_v2(
                registered["id"],
                UploadFile(filename="asset.wav", file=BytesIO(b"wrong-content")),
                if_match='"1"',
                idempotency_key="asset-content-bad",
                current_user={"id": 7},
                db=db,
            )
            assert bad.status_code == 409
            assert response_json(bad)["error"]["code"] in {
                "asset_size_mismatch",
                "asset_checksum_mismatch",
            }
            assert list(tmp_path.iterdir()) == []

            uploaded = await app_recording_v2.put_recording_asset_content_v2(
                registered["id"],
                UploadFile(filename="asset.wav", file=BytesIO(content)),
                if_match='"1"',
                idempotency_key="asset-content-good",
                current_user={"id": 7},
                db=db,
            )
            await db.commit()
            assert response_json(uploaded)["upload_state"] == "uploaded"

            job_response = await app_recording_v2.post_recording_asset_transcription_v2(
                registered["id"],
                app_recording_v2.RecordingAssetTranscriptionV2Create(
                    schema_version=2,
                    client_request_id="transcription-request-1",
                    language="zh",
                ),
                idempotency_key="transcription-operation-1",
                current_user={"id": 7},
                db=db,
            )
            job = response_json(job_response)
            assert job_response.status_code == 202
            assert job["recording_asset_id"] == registered["id"]
            assert job["meeting_id"] == "meeting-1"
            assert job["stage"] == "transcript"
            assert submitted == [job["job_id"]]
            assert await db.scalar(select(func.count(MeetingRecordingTranscriptionJobV2.id))) == 1

            job_replay = await app_recording_v2.post_recording_asset_transcription_v2(
                registered["id"],
                app_recording_v2.RecordingAssetTranscriptionV2Create(
                    schema_version=2,
                    client_request_id="transcription-request-1",
                    language="zh",
                ),
                idempotency_key="transcription-operation-1",
                current_user={"id": 7},
                db=db,
            )
            assert job_replay.status_code == 200
            assert response_json(job_replay)["job_id"] == job["job_id"]
            assert submitted == [job["job_id"]]
    finally:
        await engine.dispose()
