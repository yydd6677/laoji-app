from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import uuid

from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.meeting import Meeting
from app.models.meeting_recording_asset import (
    MeetingRecordingAssetOperationV2,
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.models.meeting_recording_transcript_draft import MeetingRecordingTranscriptDraftV1
from app.privacy_logging import privacy_log


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


def _sha256_file(path: Path) -> str:
    """Hash a recording asset without loading it into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def asset_payload(asset: MeetingRecordingAssetV2) -> dict:
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
            .where(
                Meeting.id == meeting_id,
                Meeting.user_id == user_id,
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
                privacy_log(
                    "transcription_draft_persist_failed",
                    capability="media.upload",
                    error_type=type(error).__name__,
                    status="degraded",
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
                privacy_log(
                    "transcription_checkpoint_cleaned",
                    capability="media.upload",
                    status="completed",
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
        / "device-meeting-assets"
        / f"principal-{user_id}"
        / meeting_id
    )
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{asset_id}{suffix}"
