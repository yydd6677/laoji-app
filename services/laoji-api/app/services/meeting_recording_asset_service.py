from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.meeting import Meeting
from app.models.meeting_note_root import MeetingNoteRootV2
from app.models.meeting_recording_asset import (
    MeetingMediaClipJobV1,
    MeetingRecordingAssetOperationV2,
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.models.meeting_recording_transcript_draft import MeetingRecordingTranscriptDraftV1


MEDIA_CLIP_MINIMUM_DURATION_MS = 1_000
MEDIA_CLIP_MAXIMUM_DURATION_MS = 300_000
MEDIA_CLIP_ADJUSTMENT_STEP_MS = 1_000
_MEDIA_CLIP_STALE_RUNNING_AFTER = timedelta(minutes=10)
_RECORDING_QUEUE: asyncio.Queue[tuple[str, str]] | None = None
_RECORDING_WORKER_TASK: asyncio.Task | None = None
_TRANSIENT_TRANSCRIPTION_ERRORS = frozenset({
    "asr_unavailable",
    "asr_not_ready",
    "asr_batch_failed",
})


@dataclass(frozen=True)
class RecordingAssetMutationResult:
    status_code: int
    payload: dict


class RecordingAssetConflict(Exception):
    def __init__(self, code: str, current: dict | None = None, *, status_code: int = 409):
        super().__init__(code)
        self.code = code
        self.current = current
        self.status_code = status_code


def recording_request_hash(kind: str, identity: str, payload: dict) -> str:
    encoded = json.dumps(
        {"kind": kind, "identity": identity, "payload": payload},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def normalize_checksum(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if len(normalized) == 64:
        normalized = f"sha256:{normalized}"
    if len(normalized) != 71 or not normalized.startswith("sha256:"):
        raise ValueError("录音校验值无效")
    if any(character not in "0123456789abcdef" for character in normalized[7:]):
        raise ValueError("录音校验值无效")
    return normalized


def asset_payload(asset: MeetingRecordingAssetV2) -> dict:
    uploaded = asset.upload_state == "uploaded" and bool(asset.storage_path)
    return {
        "schema_version": 2,
        "id": asset.id,
        "meeting_id": asset.meeting_id,
        "client_asset_id": asset.client_asset_id,
        "revision": asset.revision,
        "role": asset.role,
        "origin": asset.origin,
        "upload_state": asset.upload_state,
        "mime_type": asset.mime_type,
        "file_name": asset.file_name,
        "byte_size": asset.byte_size,
        "duration_ms": asset.duration_ms,
        "checksum_sha256": asset.checksum_sha256,
        "content_url": f"/api/laoji/v2/recording-assets/{asset.id}/content" if uploaded else None,
        "requires_auth": True,
        "created_at": _server_time(asset.created_at),
        "updated_at": _server_time(asset.updated_at),
    }


def job_payload(job: MeetingRecordingTranscriptionJobV2) -> dict:
    return {
        "schema_version": 2,
        "job_id": job.id,
        "meeting_id": job.meeting_id,
        "recording_asset_id": job.asset_id,
        "stage": "transcript",
        "status": job.status,
        "attempt": job.attempt,
        "progress": job.progress,
        "error_code": job.error_code,
        "retryable": bool(job.retryable),
        "result_revision_id": job.result_revision_id,
        "created_at": _server_time(job.created_at),
        "updated_at": _server_time(job.updated_at),
    }


async def persist_transcript_draft_batch(
    *,
    job_id: str,
    meeting_id: str,
    asset_id: str,
    user_id: int,
    data_epoch_id: str | None,
    rows: list[dict],
    progress: float,
) -> None:
    """Publish one completed ASR batch without touching canonical final lines.

    The ASR worker runs in a thread.  This helper owns a short-lived database
    session so partial text is durable while the worker continues processing;
    summary and question services never read this table.
    """
    from app.database import async_session

    if not rows:
        return
    now = datetime.utcnow()
    async with async_session() as db:
        job = await db.get(MeetingRecordingTranscriptionJobV2, job_id)
        if job is None or job.status not in {"queued", "running"}:
            return
        existing_result = await db.execute(
            select(MeetingRecordingTranscriptDraftV1).where(
                MeetingRecordingTranscriptDraftV1.job_id == job_id,
                MeetingRecordingTranscriptDraftV1.segment_id.in_(
                    [str(item.get("segment_id") or "") for item in rows]
                ),
            )
        )
        existing = {
            row.segment_id: row
            for row in existing_result.scalars().all()
        }
        for item in rows:
            segment_id = str(item.get("segment_id") or "").strip()
            text_value = str(item.get("text") or "").strip()
            if not segment_id or not text_value:
                continue
            row = existing.get(segment_id)
            if row is None:
                row = MeetingRecordingTranscriptDraftV1(
                    id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"laoji:transcript-draft:{job_id}:{segment_id}")),
                    meeting_id=meeting_id,
                    asset_id=asset_id,
                    job_id=job_id,
                    user_id=user_id,
                    data_epoch_id=data_epoch_id,
                    ordinal=max(0, int(item.get("ordinal") or 0)),
                    segment_id=segment_id,
                    speaker_id="unknown",
                    speaker_label="未识别讲话人",
                    text=text_value,
                    language=str(item.get("language") or "") or None,
                    model_revision=str(item.get("model_revision") or ""),
                    start_ms=max(0, int(item.get("start_ms") or 0)),
                    end_ms=max(0, int(item.get("end_ms") or 0)),
                    confidence=max(0.0, min(1.0, float(item.get("confidence") or 0.0))),
                    created_at=now,
                    updated_at=now,
                )
                db.add(row)
            else:
                row.ordinal = max(0, int(item.get("ordinal") or row.ordinal))
                row.text = text_value
                row.language = str(item.get("language") or "") or None
                row.model_revision = str(item.get("model_revision") or row.model_revision)
                row.start_ms = max(0, int(item.get("start_ms") or row.start_ms))
                row.end_ms = max(0, int(item.get("end_ms") or row.end_ms))
                row.confidence = max(0.0, min(1.0, float(item.get("confidence") or row.confidence)))
                row.updated_at = now
        job.progress = max(0.0, min(1.0, float(progress)))
        job.updated_at = now
        await db.commit()


async def clear_transcript_drafts(job_id: str) -> None:
    """Remove provisional rows once a terminal final result is committed."""
    from sqlalchemy import delete
    from app.database import async_session

    async with async_session() as db:
        await db.execute(
            delete(MeetingRecordingTranscriptDraftV1).where(
                MeetingRecordingTranscriptDraftV1.job_id == job_id
            )
        )
        await db.commit()


def _server_time(value: datetime) -> str:
    return value.isoformat(timespec="microseconds") + "Z"


async def owned_active_meeting(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> Meeting | None:
    return (
        await db.execute(
            select(Meeting)
            .outerjoin(MeetingNoteRootV2, MeetingNoteRootV2.meeting_id == Meeting.id)
            .where(
                Meeting.id == meeting_id,
                Meeting.user_id == user_id,
                (MeetingNoteRootV2.lifecycle.is_(None))
                | (MeetingNoteRootV2.lifecycle != "deleted"),
            )
        )
    ).scalar_one_or_none()


async def find_asset(
    db: AsyncSession,
    *,
    user_id: int,
    asset_id: str,
    data_epoch_id: str | None = None,
) -> MeetingRecordingAssetV2 | None:
    conditions = [
        MeetingRecordingAssetV2.id == asset_id,
        MeetingRecordingAssetV2.user_id == user_id,
    ]
    if data_epoch_id is not None:
        conditions.append(MeetingRecordingAssetV2.data_epoch_id == data_epoch_id)
    return (
        await db.execute(
            select(MeetingRecordingAssetV2).where(*conditions)
        )
    ).scalar_one_or_none()


async def list_assets(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> list[MeetingRecordingAssetV2]:
    meeting = await owned_active_meeting(db, user_id=user_id, meeting_id=meeting_id)
    if meeting is None:
        raise LookupError("meeting_missing")
    return list(
        (
            await db.execute(
                select(MeetingRecordingAssetV2)
                .where(
                    MeetingRecordingAssetV2.user_id == user_id,
                    MeetingRecordingAssetV2.meeting_id == meeting_id,
                )
                .order_by(
                    case((MeetingRecordingAssetV2.role == "primary", 0), else_=1),
                    MeetingRecordingAssetV2.created_at,
                    MeetingRecordingAssetV2.id,
                )
            )
        ).scalars().all()
    )


async def register_asset(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    idempotency_key: str,
    request_hash: str,
    mutation: dict,
    data_epoch_id: str | None = None,
) -> RecordingAssetMutationResult:
    replay = await _operation_replay(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        data_epoch_id=data_epoch_id,
    )
    if replay is not None:
        return replay
    meeting = await owned_active_meeting(db, user_id=user_id, meeting_id=meeting_id)
    if meeting is None:
        raise LookupError("meeting_missing")
    existing = (
        await db.execute(
            select(MeetingRecordingAssetV2).where(
                MeetingRecordingAssetV2.user_id == user_id,
                MeetingRecordingAssetV2.client_asset_id == mutation["client_asset_id"],
                *([MeetingRecordingAssetV2.data_epoch_id == data_epoch_id] if data_epoch_id is not None else []),
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        current = asset_payload(existing)
        expected = {
            "meeting_id": meeting_id,
            "client_asset_id": mutation["client_asset_id"],
            "role": mutation["role"],
            "origin": mutation["origin"],
            "mime_type": mutation["mime_type"],
            "file_name": mutation["file_name"],
            "byte_size": mutation["byte_size"],
            "duration_ms": mutation["duration_ms"],
            "checksum_sha256": mutation["checksum_sha256"],
        }
        observed = {key: current.get(key) for key in expected}
        if observed != expected:
            raise RecordingAssetConflict("asset_identity_mismatch", current)
        result = RecordingAssetMutationResult(200, current)
        await _save_operation(
            db,
            user_id=user_id,
            asset_id=existing.id,
            operation_kind="register",
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            result=result,
            data_epoch_id=data_epoch_id,
        )
        return result
    if mutation["role"] == "primary":
        current_primary = (
            await db.execute(
                select(MeetingRecordingAssetV2).where(
                    MeetingRecordingAssetV2.user_id == user_id,
                    MeetingRecordingAssetV2.meeting_id == meeting_id,
                    MeetingRecordingAssetV2.role == "primary",
                    *([MeetingRecordingAssetV2.data_epoch_id == data_epoch_id] if data_epoch_id is not None else []),
                )
            )
        ).scalar_one_or_none()
        if current_primary is not None:
            raise RecordingAssetConflict("primary_asset_exists", asset_payload(current_primary))
    now = datetime.utcnow()
    asset = MeetingRecordingAssetV2(
        id=str(uuid.uuid4()),
        meeting_id=meeting_id,
        user_id=user_id,
        data_epoch_id=data_epoch_id,
        client_asset_id=mutation["client_asset_id"],
        role=mutation["role"],
        origin=mutation["origin"],
        revision=1,
        upload_state="registered",
        mime_type=mutation["mime_type"],
        file_name=mutation["file_name"],
        byte_size=mutation["byte_size"],
        duration_ms=mutation["duration_ms"],
        checksum_sha256=mutation["checksum_sha256"],
        created_at=now,
        updated_at=now,
    )
    db.add(asset)
    await db.flush()
    result = RecordingAssetMutationResult(201, asset_payload(asset))
    await _save_operation(
        db,
        user_id=user_id,
        asset_id=asset.id,
        operation_kind="register",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        result=result,
        data_epoch_id=data_epoch_id,
    )
    return result


async def prepare_content_upload(
    db: AsyncSession,
    *,
    user_id: int,
    asset_id: str,
    expected_revision: int,
    idempotency_key: str,
    request_hash: str,
    data_epoch_id: str | None = None,
) -> tuple[MeetingRecordingAssetV2, RecordingAssetMutationResult | None]:
    replay = await _operation_replay(
        db,
        user_id=user_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        data_epoch_id=data_epoch_id,
    )
    asset = await find_asset(db, user_id=user_id, asset_id=asset_id, data_epoch_id=data_epoch_id)
    if asset is None:
        raise LookupError("asset_missing")
    meeting = await owned_active_meeting(db, user_id=user_id, meeting_id=asset.meeting_id)
    if meeting is None:
        raise LookupError("asset_missing")
    if replay is not None:
        return asset, replay
    if asset.revision != expected_revision:
        raise RecordingAssetConflict(
            "revision_conflict",
            asset_payload(asset),
            status_code=412,
        )
    if asset.upload_state == "uploaded":
        raise RecordingAssetConflict("asset_content_immutable", asset_payload(asset))
    return asset, None


async def complete_content_upload(
    db: AsyncSession,
    *,
    user_id: int,
    asset_id: str,
    expected_revision: int,
    idempotency_key: str,
    request_hash: str,
    storage_path: str,
    actual_byte_size: int,
    actual_checksum: str,
    duration_ms: int | None,
    data_epoch_id: str | None = None,
) -> RecordingAssetMutationResult:
    asset = await find_asset(db, user_id=user_id, asset_id=asset_id, data_epoch_id=data_epoch_id)
    if asset is None:
        raise LookupError("asset_missing")
    if asset.revision != expected_revision or asset.upload_state != "registered":
        raise RecordingAssetConflict(
            "revision_conflict",
            asset_payload(asset),
            status_code=412,
        )
    if asset.byte_size is not None and asset.byte_size != actual_byte_size:
        raise RecordingAssetConflict("asset_size_mismatch", asset_payload(asset))
    if asset.checksum_sha256 is not None and asset.checksum_sha256 != actual_checksum:
        raise RecordingAssetConflict("asset_checksum_mismatch", asset_payload(asset))
    now = datetime.utcnow()
    asset.byte_size = actual_byte_size
    asset.checksum_sha256 = actual_checksum
    if duration_ms is not None:
        asset.duration_ms = duration_ms
    asset.storage_path = storage_path
    asset.upload_state = "uploaded"
    asset.revision += 1
    asset.updated_at = now
    asset.content_updated_at = now
    if asset.role == "primary":
        meeting = await owned_active_meeting(db, user_id=user_id, meeting_id=asset.meeting_id)
        if meeting is None:
            raise LookupError("meeting_missing")
        meeting.audio_path = storage_path
        meeting.audio_file_name = asset.file_name
        meeting.audio_mime_type = asset.mime_type
        meeting.audio_duration_sec = (
            round(asset.duration_ms / 1000.0, 3) if asset.duration_ms is not None else None
        )
        meeting.updated_at = now
    await db.flush()
    payload = {**asset_payload(asset), "result": "uploaded"}
    result = RecordingAssetMutationResult(200, payload)
    await _save_operation(
        db,
        user_id=user_id,
        asset_id=asset.id,
        operation_kind="content",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        result=result,
        data_epoch_id=data_epoch_id,
    )
    return result


async def create_transcription_job(
    db: AsyncSession,
    *,
    user_id: int,
    asset_id: str,
    client_request_id: str,
    idempotency_key: str,
    language: str,
    data_epoch_id: str | None = None,
) -> RecordingAssetMutationResult:
    existing = (
        await db.execute(
            select(MeetingRecordingTranscriptionJobV2).where(
                MeetingRecordingTranscriptionJobV2.user_id == user_id,
                MeetingRecordingTranscriptionJobV2.client_request_id == client_request_id,
                *([MeetingRecordingTranscriptionJobV2.data_epoch_id == data_epoch_id] if data_epoch_id is not None else []),
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if (
            existing.asset_id != asset_id
            or existing.idempotency_key != idempotency_key
            or existing.language != language
        ):
            raise RecordingAssetConflict("transcription_request_reused", job_payload(existing))
        return RecordingAssetMutationResult(200, job_payload(existing))
    asset = await find_asset(db, user_id=user_id, asset_id=asset_id, data_epoch_id=data_epoch_id)
    if asset is None or asset.upload_state != "uploaded" or not asset.storage_path:
        raise LookupError("asset_not_uploaded")
    active = (
        await db.execute(
            select(MeetingRecordingTranscriptionJobV2).where(
                MeetingRecordingTranscriptionJobV2.user_id == user_id,
                MeetingRecordingTranscriptionJobV2.asset_id == asset_id,
                MeetingRecordingTranscriptionJobV2.status.in_(("queued", "running")),
                *([MeetingRecordingTranscriptionJobV2.data_epoch_id == data_epoch_id] if data_epoch_id is not None else []),
            )
        )
    ).scalar_one_or_none()
    if active is not None:
        raise RecordingAssetConflict("transcription_already_running", job_payload(active))
    now = datetime.utcnow()
    job = MeetingRecordingTranscriptionJobV2(
        id=str(uuid.uuid4()),
        meeting_id=asset.meeting_id,
        asset_id=asset.id,
        user_id=user_id,
        data_epoch_id=data_epoch_id,
        client_request_id=client_request_id,
        idempotency_key=idempotency_key,
        language=language,
        status="queued",
        attempt=0,
        progress=0.0,
        retryable=0,
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    await db.flush()
    return RecordingAssetMutationResult(202, job_payload(job))


async def find_job(
    db: AsyncSession,
    *,
    user_id: int,
    job_id: str,
    data_epoch_id: str | None = None,
) -> MeetingRecordingTranscriptionJobV2 | None:
    return (
        await db.execute(
            select(MeetingRecordingTranscriptionJobV2).where(
                MeetingRecordingTranscriptionJobV2.id == job_id,
                MeetingRecordingTranscriptionJobV2.user_id == user_id,
                *([MeetingRecordingTranscriptionJobV2.data_epoch_id == data_epoch_id] if data_epoch_id is not None else []),
            )
        )
    ).scalar_one_or_none()


async def queue_job_retry(
    db: AsyncSession,
    *,
    user_id: int,
    job_id: str,
) -> RecordingAssetMutationResult:
    job = await find_job(db, user_id=user_id, job_id=job_id)
    if job is None:
        raise LookupError("job_missing")
    if job.status in ("queued", "running"):
        return RecordingAssetMutationResult(200, job_payload(job))
    if job.status != "failed" or not job.retryable:
        raise RecordingAssetConflict("job_not_retryable", job_payload(job))
    job.status = "queued"
    job.progress = 0.0
    job.error_code = None
    job.retryable = 0
    job.updated_at = datetime.utcnow()
    await db.flush()
    return RecordingAssetMutationResult(202, job_payload(job))


def submit_transcription_job(job_id: str) -> None:
    _recording_queue().put_nowait(("transcription", job_id))


def _recording_queue() -> asyncio.Queue[tuple[str, str]]:
    global _RECORDING_QUEUE, _RECORDING_WORKER_TASK
    loop = asyncio.get_running_loop()
    if _RECORDING_WORKER_TASK is None or _RECORDING_WORKER_TASK.done():
        _RECORDING_QUEUE = asyncio.Queue()
        _RECORDING_WORKER_TASK = loop.create_task(
            _recording_worker_loop(),
            name="laoji-recording-worker",
        )
    assert _RECORDING_QUEUE is not None
    return _RECORDING_QUEUE


def cleanup_interrupted_upload_parts() -> int:
    """Remove fragments left when the single-worker API exits mid-upload."""
    root = Path(settings.audio_storage_abs_path)
    if not root.is_dir():
        return 0
    removed = 0
    for path in root.rglob(".*.part"):
        try:
            if path.is_file() or path.is_symlink():
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


async def cleanup_completed_transcription_checkpoints() -> int:
    """Delete completed and DB-orphaned checkpoint trees; keep failed jobs."""
    from app.database import async_session
    from app.services.compact_transcription_service import cleanup_checkpoint_dir

    root = Path(settings.audio_storage_abs_path) / ".transcription-checkpoints"
    if not root.is_dir():
        return 0
    async with async_session() as db:
        rows = list(
            (
                await db.execute(
                    select(
                        MeetingRecordingTranscriptionJobV2.id,
                        MeetingRecordingTranscriptionJobV2.status,
                    )
                )
            ).all()
        )
    statuses = {str(job_id): str(status) for job_id, status in rows}
    removed = 0
    for child in root.iterdir():
        if not child.is_dir() or child.name.startswith("."):
            continue
        status = statuses.get(child.name)
        if status is not None and status != "completed":
            continue
        if cleanup_checkpoint_dir(child):
            removed += 1
    return removed


async def _recording_worker_loop() -> None:
    assert _RECORDING_QUEUE is not None
    queue = _RECORDING_QUEUE
    while True:
        kind, job_id = await queue.get()
        try:
            if kind == "transcription":
                await _run_transcription_job_async(job_id)
            elif kind == "media_clip":
                await _run_media_clip_job_async(job_id)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            print(
                "[RecordingWorker] 任务执行失败 kind=%s error=%s"
                % (kind, type(error).__name__),
                flush=True,
            )
        finally:
            queue.task_done()


async def stop_recording_worker() -> None:
    global _RECORDING_QUEUE, _RECORDING_WORKER_TASK
    task = _RECORDING_WORKER_TASK
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    _RECORDING_WORKER_TASK = None
    _RECORDING_QUEUE = None


def _transcription_retry_limit() -> int:
    try:
        value = int(os.getenv("LAOJI_ASR_TRANSIENT_RETRIES", "8"))
    except ValueError:
        value = 8
    return min(20, max(0, value))


def _transcription_retry_delay(attempt: int) -> float:
    return min(10.0, float(2 ** max(0, min(4, attempt - 1))))


def _transcription_error_code(error: Exception) -> str:
    return str(error).strip().split(":", 1)[0][:160] or type(error).__name__


async def _transcribe_with_transient_retry(transcribe, /, **kwargs):
    retry_limit = _transcription_retry_limit()
    retries = 0
    while True:
        try:
            return await asyncio.to_thread(transcribe, **kwargs)
        except Exception as error:
            code = _transcription_error_code(error)
            if code not in _TRANSIENT_TRANSCRIPTION_ERRORS or retries >= retry_limit:
                raise
            retries += 1
            delay = _transcription_retry_delay(retries)
            print(
                "[RecordingWorker] 语音识别服务暂时不可用，"
                f"{delay:g} 秒后恢复任务 retry={retries}/{retry_limit}",
                flush=True,
            )
            await asyncio.sleep(delay)


async def recover_interrupted_transcription_jobs() -> int:
    """Requeue jobs whose in-process executor disappeared during a restart."""
    from app.database import async_session

    async with async_session() as db:
        jobs = list(
            (
                await db.execute(
                    select(MeetingRecordingTranscriptionJobV2)
                    .where(MeetingRecordingTranscriptionJobV2.status.in_(("queued", "running")))
                    .order_by(
                        MeetingRecordingTranscriptionJobV2.created_at,
                        MeetingRecordingTranscriptionJobV2.id,
                    )
                )
            ).scalars()
        )
        now = datetime.utcnow()
        for job in jobs:
            job.status = "queued"
            job.progress = 0.0
            job.error_code = None
            job.retryable = 0
            job.updated_at = now
        job_ids = [job.id for job in jobs]
        if jobs:
            await db.commit()
    for job_id in job_ids:
        submit_transcription_job(job_id)
    return len(job_ids)


async def _run_transcription_job_async(job_id: str) -> None:
    from app.database import async_session

    processing_path: Path | None = None
    owner_user_id: int | None = None
    source_checksum: str | None = None
    meeting_id: str | None = None
    asset_id: str | None = None
    data_epoch_id: str | None = None
    language = "zh"
    async with async_session() as db:
        job = await db.get(MeetingRecordingTranscriptionJobV2, job_id)
        if job is None or job.status != "queued":
            return
        asset = await db.get(MeetingRecordingAssetV2, job.asset_id)
        meeting = await db.get(Meeting, job.meeting_id)
        if asset is None or meeting is None or not asset.storage_path:
            job.status = "failed"
            job.error_code = "recording_asset_missing"
            job.retryable = 0
            job.updated_at = datetime.utcnow()
            await db.commit()
            return
        source = Path(asset.storage_path)
        if not source.is_file():
            job.status = "failed"
            job.error_code = "recording_content_missing"
            job.retryable = 0
            job.updated_at = datetime.utcnow()
            await db.commit()
            return
        owner_user_id = int(meeting.user_id) if meeting.user_id is not None else None
        source_checksum = asset.checksum_sha256
        processing_path = source
        meeting_id = job.meeting_id
        asset_id = job.asset_id
        data_epoch_id = job.data_epoch_id
        language = job.language
        job.status = "running"
        job.attempt += 1
        job.progress = 0.0
        job.error_code = None
        job.retryable = 0
        job.updated_at = datetime.utcnow()
        meeting.status = "processing"
        meeting.updated_at = datetime.utcnow()
        await db.commit()
    processing_result: dict | None = None
    transcription_error_code: str | None = None
    try:
        if owner_user_id is None or source_checksum is None:
            raise RuntimeError("recording_identity_incomplete")
        from app.asr.model_manager import get_model_manager
        from app.services.compact_transcription_service import (
            transcribe_recording_asset,
        )

        manager = get_model_manager()
        if not manager.is_initialized():
            await manager.initialize()
        loop = asyncio.get_running_loop()

        def publish_partial(rows: list[dict], progress: float, _processed_end_ms: int) -> None:
            # ``transcribe_recording_asset`` runs in a worker thread.  Commit
            # each completed ASR batch on the event loop, but never make a
            # temporary-draft write failure discard an otherwise valid ASR
            # result; the final atomic transcript remains authoritative.
            if not meeting_id or not asset_id:
                return
            future = asyncio.run_coroutine_threadsafe(
                persist_transcript_draft_batch(
                    job_id=job_id,
                    meeting_id=meeting_id,
                    asset_id=asset_id,
                    user_id=int(owner_user_id or 0),
                    data_epoch_id=data_epoch_id,
                    rows=rows,
                    progress=progress,
                ),
                loop,
            )
            try:
                future.result(timeout=15)
            except Exception as error:
                print(
                    "[RecordingWorker] 增量文字暂存失败，继续完成最终转写 "
                    f"job={job_id} error={type(error).__name__}",
                    flush=True,
                )

        compact_result = await _transcribe_with_transient_retry(
            transcribe_recording_asset,
            source_path=str(processing_path),
            source_sha256=source_checksum,
            job_id=job.id,
            owner_user_id=owner_user_id,
            language=language,
            model_manager=manager,
            partial=publish_partial,
        )
        revision_material = _canonical_transcript_revision_material(
            job_id=job.id,
            asset_id=job.asset_id,
            model_revision=compact_result.model_revision,
            turns=compact_result.turns,
        )
        processing_result = {
            "success": True,
            "turns": compact_result.turns,
            "checkpoint_dir": compact_result.checkpoint_dir,
            "result_revision_id": (
                "recording-transcript:"
                f"{hashlib.sha256(revision_material).hexdigest()}"
            ),
        }
    except Exception as error:
        transcription_error_code = str(error)[:160]
        processing_result = None
    async with async_session() as db:
        job = await db.get(MeetingRecordingTranscriptionJobV2, job_id)
        meeting = await db.get(Meeting, job.meeting_id) if job is not None else None
        if job is None:
            return
        now = datetime.utcnow()
        if processing_result and processing_result.get("success"):
            from sqlalchemy import delete
            from app.models.transcript import TranscriptLine

            turns = processing_result.get("turns") or []
            await db.execute(
                delete(TranscriptLine).where(
                    TranscriptLine.meeting_id == job.meeting_id,
                    TranscriptLine.recording_asset_id == job.asset_id,
                )
            )
            await db.execute(
                delete(MeetingRecordingTranscriptDraftV1).where(
                    MeetingRecordingTranscriptDraftV1.job_id == job.id
                )
            )
            for turn in turns:
                segment_id = str(turn["segment_id"])
                db.add(
                    TranscriptLine(
                        id=str(
                            uuid.uuid5(
                                uuid.NAMESPACE_URL,
                                f"laoji:{job.id}:{segment_id}",
                            )
                        ),
                        meeting_id=job.meeting_id,
                        recording_asset_id=job.asset_id,
                        transcription_job_id=job.id,
                        speaker_id=str(turn["speaker_id"]),
                        speaker_label=str(turn["speaker_label"]),
                        text=str(turn["text"]),
                        start_time=int(turn["start_ms"]) / 1000.0,
                        end_time=int(turn["end_ms"]) / 1000.0,
                        confidence=float(turn.get("confidence") or 0.0),
                    )
                )
            job.status = "completed"
            job.progress = 1.0
            job.error_code = None
            job.retryable = 0
            job.result_revision_id = processing_result.get("result_revision_id")
            job.completed_at = now
            if meeting is not None:
                meeting.status = "ended"
                meeting.updated_at = now
        else:
            job.status = "failed"
            job.progress = None
            job.error_code = transcription_error_code or "transcription_failed"
            job.retryable = 0 if job.error_code == "no_speech" else 1
            if job.error_code == "no_speech":
                from sqlalchemy import delete
                await db.execute(
                    delete(MeetingRecordingTranscriptDraftV1).where(
                        MeetingRecordingTranscriptDraftV1.job_id == job.id
                    )
                )
            if meeting is not None:
                from sqlalchemy import func, select
                from app.models.transcript import TranscriptLine

                existing_count = (
                    await db.execute(
                        select(func.count(TranscriptLine.id)).where(
                            TranscriptLine.meeting_id == job.meeting_id,
                            TranscriptLine.recording_asset_id == job.asset_id,
                        )
                    )
                ).scalar_one()
                meeting.status = (
                    "ended"
                    if existing_count or job.error_code == "no_speech"
                    else "failed"
                )
                meeting.updated_at = now
        job.updated_at = now
        await db.commit()
        # Device-primary meetings intentionally do not retain source audio on
        # the service once transcription has reached a terminal state.  The
        # phone remains the owner of the original recording; the server keeps
        # only generated transcript/summary data.  Legacy account meetings
        # keep their existing playback behaviour.
        if meeting is not None and meeting.data_epoch_id and (
            processing_result and processing_result.get("success")
            or job.error_code == "no_speech"
        ):
            source_to_remove = processing_path
            if source_to_remove is not None:
                try:
                    source_to_remove.unlink(missing_ok=True)
                except OSError:
                    pass
            asset = await db.get(MeetingRecordingAssetV2, job.asset_id)
            if asset is not None:
                asset.storage_path = None
                asset.upload_state = "processed"
                asset.updated_at = datetime.utcnow()
            meeting.audio_path = None
            meeting.updated_at = datetime.utcnow()
            await db.commit()
        if processing_result and processing_result.get("success"):
            from app.services.compact_transcription_service import cleanup_checkpoint_dir

            if cleanup_checkpoint_dir(str(processing_result.get("checkpoint_dir") or "")):
                print(
                    "[RecordingWorker] 已清理已完成转写检查点 job=%s" % job_id,
                    flush=True,
                )


def _canonical_transcript_revision_material(
    *,
    job_id: str,
    asset_id: str,
    model_revision: str,
    turns: list[dict],
) -> bytes:
    return json.dumps(
        {
            "job_id": job_id,
            "asset_id": asset_id,
            "model_revision": model_revision,
            "turns": [
                {
                    "segment_id": turn.get("segment_id"),
                    "speaker_id": turn.get("speaker_id"),
                    "text_sha256": hashlib.sha256(
                        str(turn.get("text") or "").encode("utf-8")
                    ).hexdigest(),
                    "start_ms": turn.get("start_ms"),
                    "end_ms": turn.get("end_ms"),
                }
                for turn in turns
            ],
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


async def _operation_replay(
    db: AsyncSession,
    *,
    user_id: int,
    idempotency_key: str,
    request_hash: str,
    data_epoch_id: str | None = None,
) -> RecordingAssetMutationResult | None:
    conditions = [
        MeetingRecordingAssetOperationV2.user_id == user_id,
        MeetingRecordingAssetOperationV2.idempotency_key == idempotency_key,
    ]
    if data_epoch_id is not None:
        conditions.append(MeetingRecordingAssetOperationV2.data_epoch_id == data_epoch_id)
    operation = (
        await db.execute(
            select(MeetingRecordingAssetOperationV2).where(*conditions)
        )
    ).scalar_one_or_none()
    if operation is None:
        return None
    if operation.request_hash != request_hash:
        raise RecordingAssetConflict("idempotency_key_reused")
    return RecordingAssetMutationResult(
        operation.response_status,
        json.loads(operation.response_json),
    )


async def _save_operation(
    db: AsyncSession,
    *,
    user_id: int,
    asset_id: str,
    operation_kind: str,
    idempotency_key: str,
    request_hash: str,
    result: RecordingAssetMutationResult,
    data_epoch_id: str | None = None,
) -> None:
    db.add(
        MeetingRecordingAssetOperationV2(
            id=str(uuid.uuid4()),
            user_id=user_id,
            data_epoch_id=data_epoch_id,
            asset_id=asset_id,
            operation_kind=operation_kind,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            response_status=result.status_code,
            response_json=json.dumps(
                result.payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ),
            created_at=datetime.utcnow(),
        )
    )
    await db.flush()


def recording_asset_storage_path(
    *,
    user_id: int,
    meeting_id: str,
    asset_id: str,
    suffix: str,
) -> Path:
    directory = (
        Path(settings.audio_storage_abs_path)
        / "app-meeting-assets-v2"
        / f"user-{user_id}"
        / meeting_id
    )
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{asset_id}{suffix}"


async def project_compat_media_upload(
    db: AsyncSession,
    *,
    meeting: Meeting,
    user_id: int,
    source_path: Path,
    file_name: str,
    mime_type: str,
    duration_ms: int | None,
    start_transcription: bool,
    language: str = "zh",
) -> tuple[dict, dict | None, bool]:
    """Project a legacy upload into the RecordingAsset v2 source of truth.

    A repeated upload of identical bytes reuses the same asset.  If a meeting
    already has a primary asset, compatibility uploads become secondary assets
    and never replace or delete the primary recording.
    """

    if not source_path.is_file() or source_path.stat().st_size < 1:
        raise LookupError("asset_content_missing")
    checksum = _sha256_file(source_path)
    checksum_hex = checksum.removeprefix("sha256:")
    client_asset_id = f"compat:{meeting.id}:{checksum_hex}"
    existing = (
        await db.execute(
            select(MeetingRecordingAssetV2).where(
                MeetingRecordingAssetV2.user_id == user_id,
                MeetingRecordingAssetV2.client_asset_id == client_asset_id,
            )
        )
    ).scalar_one_or_none()
    primary = (
        await db.execute(
            select(MeetingRecordingAssetV2).where(
                MeetingRecordingAssetV2.user_id == user_id,
                MeetingRecordingAssetV2.meeting_id == meeting.id,
                MeetingRecordingAssetV2.role == "primary",
            )
        )
    ).scalar_one_or_none()
    role = existing.role if existing is not None else ("secondary" if primary else "primary")
    mutation = (
        {
            "client_asset_id": existing.client_asset_id,
            "role": existing.role,
            "origin": existing.origin,
            "mime_type": existing.mime_type,
            "file_name": existing.file_name,
            "byte_size": existing.byte_size,
            "duration_ms": existing.duration_ms,
            "checksum_sha256": existing.checksum_sha256,
        }
        if existing is not None
        else {
            "client_asset_id": client_asset_id,
            "role": role,
            "origin": "imported",
            "mime_type": mime_type,
            "file_name": file_name,
            "byte_size": source_path.stat().st_size,
            "duration_ms": duration_ms,
            "checksum_sha256": checksum,
        }
    )
    register_key = f"compat-register:{user_id}:{meeting.id}:{checksum_hex}"
    registered = await register_asset(
        db,
        user_id=user_id,
        meeting_id=meeting.id,
        idempotency_key=register_key,
        request_hash=recording_request_hash("register", meeting.id, mutation),
        mutation=mutation,
    )
    asset_id = str(registered.payload["id"])
    asset = await find_asset(db, user_id=user_id, asset_id=asset_id)
    if asset is None:
        raise LookupError("asset_missing")
    if asset.upload_state == "uploaded" and asset.storage_path:
        existing_path = Path(asset.storage_path)
        if existing_path != source_path:
            source_path.unlink(missing_ok=True)
        effective_path = existing_path
    else:
        completed = await complete_content_upload(
            db,
            user_id=user_id,
            asset_id=asset.id,
            expected_revision=asset.revision,
            idempotency_key=f"compat-content:{user_id}:{meeting.id}:{checksum_hex}",
            request_hash=recording_request_hash("content", asset.id, {}),
            storage_path=str(source_path),
            actual_byte_size=source_path.stat().st_size,
            actual_checksum=checksum,
            duration_ms=duration_ms,
        )
        effective_path = source_path
        asset = await find_asset(db, user_id=user_id, asset_id=asset.id)
        if asset is None:
            raise LookupError("asset_missing")
        registered = completed

    if role == "primary":
        meeting.audio_path = str(effective_path)
        meeting.audio_file_name = asset.file_name
        meeting.audio_mime_type = asset.mime_type
        meeting.audio_duration_sec = (
            round(asset.duration_ms / 1000.0, 3)
            if asset.duration_ms is not None
            else None
        )
    elif primary is not None and primary.storage_path:
        meeting.audio_path = primary.storage_path
        meeting.audio_file_name = primary.file_name
        meeting.audio_mime_type = primary.mime_type
        meeting.audio_duration_sec = (
            round(primary.duration_ms / 1000.0, 3)
            if primary.duration_ms is not None
            else None
        )
    meeting.updated_at = datetime.utcnow()

    job_result: RecordingAssetMutationResult | None = None
    should_submit = False
    if start_transcription:
        job_result = await create_transcription_job(
            db,
            user_id=user_id,
            asset_id=asset.id,
            client_request_id=f"compat-transcription:{meeting.id}:{checksum_hex}",
            idempotency_key=f"compat-transcription:{user_id}:{meeting.id}:{checksum_hex}",
            language=language,
        )
        should_submit = job_result.status_code == 202
        meeting.status = "processing" if should_submit else meeting.status
        meeting.mode = "offline"
        meeting.updated_at = datetime.utcnow()
    return asset_payload(asset), job_result.payload if job_result else None, should_submit


def media_clip_job_payload(job: MeetingMediaClipJobV1) -> dict:
    completed = (
        job.status == "completed"
        and bool(job.output_path)
        and bool(job.mime_type)
        and bool(job.file_name)
        and job.byte_size is not None
        and bool(job.checksum_sha256)
    )
    return {
        "schema_version": 1,
        "job_id": job.id,
        "meeting_id": job.meeting_id,
        "recording_asset_id": job.asset_id,
        "client_clip_id": job.client_clip_id,
        "revision": job.revision,
        "stage": "media_clip",
        "status": job.status,
        "attempt": job.attempt,
        "progress": job.progress,
        "start_ms": job.start_ms,
        "end_ms": job.end_ms,
        "error_code": job.error_code,
        "retryable": bool(job.retryable),
        "mime_type": job.mime_type if completed else None,
        "file_name": job.file_name if completed else None,
        "byte_size": job.byte_size if completed else None,
        "checksum_sha256": job.checksum_sha256 if completed else None,
        "content_url": f"/api/laoji/v2/media-clip-jobs/{job.id}/content" if completed else None,
        "requires_auth": True,
        "created_at": _server_time(job.created_at),
        "updated_at": _server_time(job.updated_at),
    }


async def create_media_clip_job(
    db: AsyncSession,
    *,
    user_id: int,
    asset_id: str,
    client_clip_id: str,
    idempotency_key: str,
    start_ms: int,
    end_ms: int,
) -> RecordingAssetMutationResult:
    request_hash = recording_request_hash(
        "media_clip",
        asset_id,
        {"client_clip_id": client_clip_id, "start_ms": start_ms, "end_ms": end_ms},
    )
    by_key = (
        await db.execute(
            select(MeetingMediaClipJobV1).where(
                MeetingMediaClipJobV1.user_id == user_id,
                MeetingMediaClipJobV1.idempotency_key == idempotency_key,
            )
        )
    ).scalar_one_or_none()
    if by_key is not None:
        if by_key.request_hash != request_hash:
            raise RecordingAssetConflict("idempotency_key_reused", media_clip_job_payload(by_key))
        return RecordingAssetMutationResult(200, media_clip_job_payload(by_key))
    by_client = (
        await db.execute(
            select(MeetingMediaClipJobV1).where(
                MeetingMediaClipJobV1.user_id == user_id,
                MeetingMediaClipJobV1.client_clip_id == client_clip_id,
            )
        )
    ).scalar_one_or_none()
    if by_client is not None:
        raise RecordingAssetConflict("media_clip_identity_mismatch", media_clip_job_payload(by_client))
    asset = await find_asset(db, user_id=user_id, asset_id=asset_id)
    if asset is None or asset.upload_state != "uploaded" or not asset.storage_path:
        raise LookupError("asset_not_uploaded")
    if end_ms <= start_ms or start_ms < 0:
        raise ValueError("片段时间范围无效")
    duration_ms = end_ms - start_ms
    if duration_ms < MEDIA_CLIP_MINIMUM_DURATION_MS or duration_ms > MEDIA_CLIP_MAXIMUM_DURATION_MS:
        raise ValueError("片段时长超出支持范围")
    if asset.duration_ms is not None and end_ms > asset.duration_ms:
        raise ValueError("片段结束时间超过录音时长")
    source = Path(asset.storage_path)
    if not source.is_file():
        raise LookupError("asset_content_missing")
    now = datetime.utcnow()
    job = MeetingMediaClipJobV1(
        id=str(uuid.uuid4()),
        meeting_id=asset.meeting_id,
        asset_id=asset.id,
        user_id=user_id,
        client_clip_id=client_clip_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        source_asset_revision=asset.revision,
        source_checksum_sha256=asset.checksum_sha256,
        start_ms=start_ms,
        end_ms=end_ms,
        revision=1,
        status="queued",
        attempt=0,
        progress=0.0,
        retryable=0,
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    await db.flush()
    return RecordingAssetMutationResult(202, media_clip_job_payload(job))


async def find_media_clip_job(
    db: AsyncSession,
    *,
    user_id: int,
    job_id: str,
) -> MeetingMediaClipJobV1 | None:
    return (
        await db.execute(
            select(MeetingMediaClipJobV1).where(
                MeetingMediaClipJobV1.id == job_id,
                MeetingMediaClipJobV1.user_id == user_id,
            )
        )
    ).scalar_one_or_none()


async def recover_stale_media_clip_job(
    db: AsyncSession,
    *,
    user_id: int,
    job_id: str,
) -> tuple[MeetingMediaClipJobV1 | None, bool]:
    job = await find_media_clip_job(db, user_id=user_id, job_id=job_id)
    if job is None:
        return None, False
    should_submit = job.status == "queued"
    if job.status == "running" and job.updated_at <= datetime.utcnow() - _MEDIA_CLIP_STALE_RUNNING_AFTER:
        job.status = "queued"
        job.progress = 0.0
        job.error_code = None
        job.retryable = 0
        job.revision += 1
        job.updated_at = datetime.utcnow()
        await db.flush()
        should_submit = True
    return job, should_submit


async def queue_media_clip_retry(
    db: AsyncSession,
    *,
    user_id: int,
    job_id: str,
) -> RecordingAssetMutationResult:
    job = await find_media_clip_job(db, user_id=user_id, job_id=job_id)
    if job is None:
        raise LookupError("media_clip_job_missing")
    if job.status in ("queued", "running"):
        return RecordingAssetMutationResult(200, media_clip_job_payload(job))
    if job.status != "failed" or not job.retryable:
        raise RecordingAssetConflict("media_clip_not_retryable", media_clip_job_payload(job))
    job.status = "queued"
    job.progress = 0.0
    job.error_code = None
    job.retryable = 0
    job.revision += 1
    job.updated_at = datetime.utcnow()
    await db.flush()
    return RecordingAssetMutationResult(202, media_clip_job_payload(job))


async def delete_media_clip_job(
    db: AsyncSession,
    *,
    user_id: int,
    job_id: str,
) -> tuple[Path, Path] | None:
    job = await find_media_clip_job(db, user_id=user_id, job_id=job_id)
    if job is None:
        return None
    final_path = media_clip_storage_path(
        user_id=job.user_id,
        meeting_id=job.meeting_id,
        job_id=job.id,
    )
    temporary_path = final_path.with_suffix(".wav.part")
    await db.delete(job)
    await db.flush()
    return final_path, temporary_path


def delete_media_clip_files(paths: tuple[Path, Path] | None) -> None:
    if paths is None:
        return
    for path in paths:
        path.unlink(missing_ok=True)
    directory = paths[0].parent
    try:
        directory.rmdir()
    except OSError:
        pass


def submit_media_clip_job(job_id: str) -> None:
    _recording_queue().put_nowait(("media_clip", job_id))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _export_media_clip(source: Path, target: Path, start_ms: int, end_ms: int) -> tuple[int, str]:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg_unavailable")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".wav.part")
    temporary.unlink(missing_ok=True)
    command = [
        ffmpeg,
        "-nostdin",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-ss",
        f"{start_ms / 1000.0:.3f}",
        "-t",
        f"{(end_ms - start_ms) / 1000.0:.3f}",
        "-vn",
        "-map_metadata",
        "-1",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        str(temporary),
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=600)
        if not temporary.is_file() or temporary.stat().st_size <= 44:
            raise RuntimeError("media_clip_output_invalid")
        temporary.replace(target)
        return target.stat().st_size, _sha256_file(target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        raise


async def _fail_media_clip_job(job_id: str, error_code: str, retryable: bool) -> None:
    from app.database import async_session

    async with async_session() as db:
        job = await db.get(MeetingMediaClipJobV1, job_id)
        if job is None:
            return
        job.status = "failed"
        job.progress = None
        job.error_code = error_code
        job.retryable = 1 if retryable else 0
        job.revision += 1
        job.updated_at = datetime.utcnow()
        await db.commit()


async def _run_media_clip_job_async(job_id: str) -> None:
    from app.database import async_session

    final_path: Path | None = None
    source_path: Path | None = None
    start_ms = 0
    end_ms = 0
    async with async_session() as db:
        job = await db.get(MeetingMediaClipJobV1, job_id)
        if job is None or job.status != "queued":
            return
        asset = await db.get(MeetingRecordingAssetV2, job.asset_id)
        if (
            asset is None
            or asset.user_id != job.user_id
            or asset.meeting_id != job.meeting_id
            or asset.upload_state != "uploaded"
            or not asset.storage_path
            or asset.revision != job.source_asset_revision
            or asset.checksum_sha256 != job.source_checksum_sha256
        ):
            job.status = "failed"
            job.progress = None
            job.error_code = "recording_asset_changed"
            job.retryable = 0
            job.revision += 1
            job.updated_at = datetime.utcnow()
            await db.commit()
            return
        source_path = Path(asset.storage_path)
        if not source_path.is_file():
            job.status = "failed"
            job.progress = None
            job.error_code = "recording_content_missing"
            job.retryable = 0
            job.revision += 1
            job.updated_at = datetime.utcnow()
            await db.commit()
            return
        final_path = media_clip_storage_path(
            user_id=job.user_id,
            meeting_id=job.meeting_id,
            job_id=job.id,
        )
        start_ms = job.start_ms
        end_ms = job.end_ms
        job.status = "running"
        job.attempt += 1
        job.progress = None
        job.error_code = None
        job.retryable = 0
        job.revision += 1
        job.updated_at = datetime.utcnow()
        await db.commit()
    try:
        byte_size, checksum = await asyncio.to_thread(
            _export_media_clip,
            source_path,
            final_path,
            start_ms,
            end_ms,
        )
    except subprocess.TimeoutExpired:
        await _fail_media_clip_job(job_id, "media_clip_timeout", True)
        return
    except Exception:
        await _fail_media_clip_job(job_id, "media_clip_export_failed", True)
        return
    async with async_session() as db:
        job = await db.get(MeetingMediaClipJobV1, job_id)
        if job is None or job.status != "running":
            final_path.unlink(missing_ok=True)
            return
        now = datetime.utcnow()
        job.status = "completed"
        job.progress = 1.0
        job.error_code = None
        job.retryable = 0
        job.output_path = str(final_path)
        job.mime_type = "audio/wav"
        job.file_name = f"meeting-clip-{job.id}.wav"
        job.byte_size = byte_size
        job.checksum_sha256 = checksum
        job.revision += 1
        job.updated_at = now
        job.completed_at = now
        await db.commit()


def media_clip_storage_path(*, user_id: int, meeting_id: str, job_id: str) -> Path:
    directory = (
        Path(settings.audio_storage_abs_path)
        / "app-media-clips-v1"
        / f"user-{user_id}"
        / meeting_id
    )
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{job_id}.wav"
