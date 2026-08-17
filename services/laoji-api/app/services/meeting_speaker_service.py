from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.meeting import Meeting
from app.models.meeting_note_root import MeetingNoteRootV2
from app.models.meeting_recording_asset import (
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.models.meeting_speaker import (
    MeetingSpeakerAssignmentV2,
    MeetingSpeakerCorrectionV2,
    MeetingSpeakerReprocessJobV2,
)
from app.models.transcript import TranscriptLine
from app.services.speaker_db_service import get_speaker_db


SPEAKER_MODEL_VERSION = "campplus-v1"
MIN_PROFILE_SAMPLE_SECONDS = 2.0
MAX_PROFILE_SAMPLE_SECONDS = 15.0
MIN_REPROCESS_COSINE = 0.35
_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="laoji-speaker")


@dataclass(frozen=True)
class SpeakerContractConflict(Exception):
    code: str
    status_code: int
    current_revision: int | None = None
    current: dict[str, Any] | None = None


@dataclass(frozen=True)
class SpeakerMutationResult:
    status_code: int
    payload: dict[str, Any]
    correction_id: str | None = None


def _stable_hash(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def speaker_correction_request_hash(meeting_id: str, mutation: dict[str, Any]) -> str:
    return _stable_hash({"meeting_id": meeting_id, "mutation": mutation})


def speaker_reprocess_request_hash(speaker_profile_id: str) -> str:
    return _stable_hash({"speaker_profile_id": speaker_profile_id, "scope": "all_owned_meetings"})


def correction_payload(correction: MeetingSpeakerCorrectionV2) -> dict[str, Any]:
    try:
        segment_ids = json.loads(correction.segment_ids_json)
    except json.JSONDecodeError:
        segment_ids = []
    return {
        "schema_version": 2,
        "client_request_id": correction.client_request_id,
        "assignment_revision": correction.assignment_revision,
        "transcript_revision_id": correction.transcript_revision_id,
        "scope": correction.scope,
        "segment_ids": segment_ids,
        "cluster_id": correction.cluster_id,
        "speaker_profile_id": correction.speaker_profile_id,
        "display_name": correction.display_name,
        "profile_revision": correction.profile_revision,
        "sample_state": correction.sample_state,
        "sample_error_code": correction.sample_error_code,
        "model_version": correction.model_version,
    }


def reprocess_job_payload(job: MeetingSpeakerReprocessJobV2) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "job_id": job.id,
        "speaker_profile_id": job.speaker_profile_id,
        "status": job.status,
        "attempt": job.attempt,
        "progress": job.progress,
        "total_meetings": job.total_meetings,
        "processed_meetings": job.processed_meetings,
        "matched_segments": job.matched_segments,
        "skipped_locked_segments": job.skipped_locked_segments,
        "error_code": job.error_code,
        "retryable": bool(job.retryable),
        "profile_revision": job.profile_revision,
        "model_version": job.model_version,
        "result_speaker_revision_id": job.result_speaker_revision_id,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
    }


async def speaker_schema_ready(db: AsyncSession) -> bool:
    try:
        await db.execute(select(MeetingSpeakerCorrectionV2.id).limit(1))
        await db.execute(select(MeetingSpeakerAssignmentV2.id).limit(1))
        await db.execute(select(MeetingSpeakerReprocessJobV2.id).limit(1))
        return True
    except Exception:
        await db.rollback()
        return False


async def current_transcript_revision_id(
    db: AsyncSession,
    meeting_id: str,
) -> str | None:
    total = int((await db.execute(
        select(func.count(TranscriptLine.id)).where(TranscriptLine.meeting_id == meeting_id)
    )).scalar() or 0)
    if total <= 0:
        return None
    jobs = list((await db.execute(
        select(MeetingRecordingTranscriptionJobV2)
        .where(MeetingRecordingTranscriptionJobV2.meeting_id == meeting_id)
        .order_by(
            MeetingRecordingTranscriptionJobV2.created_at,
            MeetingRecordingTranscriptionJobV2.id,
        )
    )).scalars().all())
    latest_by_asset: dict[str, MeetingRecordingTranscriptionJobV2] = {}
    for job in jobs:
        latest_by_asset[job.asset_id] = job
    if any(job.status in ("queued", "running") for job in latest_by_asset.values()):
        return None
    material = "|".join(
        [meeting_id, str(total)]
        + sorted(
            f"{job.asset_id}:{job.result_revision_id or ''}"
            for job in latest_by_asset.values()
            if job.status == "completed"
        )
    )
    return f"meeting-transcript:{hashlib.sha256(material.encode()).hexdigest()}"


async def _owned_active_meeting(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
) -> Meeting | None:
    row = (await db.execute(
        select(Meeting)
        .join(MeetingNoteRootV2, MeetingNoteRootV2.meeting_id == Meeting.id)
        .where(
            Meeting.id == meeting_id,
            Meeting.user_id == user_id,
            MeetingNoteRootV2.user_id == user_id,
            MeetingNoteRootV2.lifecycle == "active",
        )
    )).scalar_one_or_none()
    return row


async def submit_speaker_correction(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    idempotency_key: str,
    request_hash: str,
    mutation: dict[str, Any],
) -> SpeakerMutationResult:
    existing = (await db.execute(
        select(MeetingSpeakerCorrectionV2).where(
            MeetingSpeakerCorrectionV2.user_id == user_id,
            or_(
                MeetingSpeakerCorrectionV2.client_request_id == mutation["client_request_id"],
                MeetingSpeakerCorrectionV2.idempotency_key == idempotency_key,
            ),
        )
    )).scalars().first()
    if existing is not None:
        if (
            existing.request_hash != request_hash
            or existing.client_request_id != mutation["client_request_id"]
            or existing.idempotency_key != idempotency_key
        ):
            raise SpeakerContractConflict(
                "speaker_request_reused",
                409,
                existing.assignment_revision,
                correction_payload(existing),
            )
        return SpeakerMutationResult(200, correction_payload(existing), existing.id)

    if await _owned_active_meeting(db, user_id=user_id, meeting_id=meeting_id) is None:
        raise LookupError("meeting_missing")
    remote_transcript_revision = await current_transcript_revision_id(db, meeting_id)
    if remote_transcript_revision is None:
        raise SpeakerContractConflict("transcript_not_stable", 409)
    if remote_transcript_revision != mutation["transcript_revision_id"]:
        raise SpeakerContractConflict(
            "transcript_revision_changed",
            409,
            current=None,
        )

    current_revision = int((await db.execute(
        select(func.max(MeetingSpeakerCorrectionV2.assignment_revision)).where(
            MeetingSpeakerCorrectionV2.meeting_id == meeting_id,
            MeetingSpeakerCorrectionV2.user_id == user_id,
        )
    )).scalar() or 0)
    if mutation["base_revision"] != current_revision:
        latest = (await db.execute(
            select(MeetingSpeakerCorrectionV2)
            .where(
                MeetingSpeakerCorrectionV2.meeting_id == meeting_id,
                MeetingSpeakerCorrectionV2.user_id == user_id,
            )
            .order_by(MeetingSpeakerCorrectionV2.assignment_revision.desc())
            .limit(1)
        )).scalar_one_or_none()
        raise SpeakerContractConflict(
            "assignment_revision_conflict",
            412,
            current_revision,
            correction_payload(latest) if latest else None,
        )

    segment_ids = mutation["segment_ids"]
    lines = list((await db.execute(
        select(TranscriptLine).where(
            TranscriptLine.meeting_id == meeting_id,
            TranscriptLine.id.in_(segment_ids),
        )
    )).scalars().all())
    if len(lines) != len(segment_ids) or {line.id for line in lines} != set(segment_ids):
        raise SpeakerContractConflict("speaker_segments_changed", 409, current_revision)
    lines_by_id = {line.id: line for line in lines}
    ordered_lines = [lines_by_id[line_id] for line_id in segment_ids]

    scope = mutation["scope"]
    cluster_id = mutation.get("cluster_id")
    if scope in ("cluster", "future_profile"):
        if not cluster_id or any(line.speaker_id != cluster_id for line in ordered_lines):
            raise SpeakerContractConflict("speaker_cluster_changed", 409, current_revision)

    profile_revision = None
    profile = None
    if scope == "future_profile":
        profile = get_speaker_db().load_speaker_for_owner(
            user_id,
            mutation["speaker_profile_id"],
        )
        if profile is None:
            raise LookupError("speaker_profile_missing")
        if str(profile.get("name") or "").strip() != mutation["display_name"]:
            raise SpeakerContractConflict("speaker_profile_name_changed", 409, current_revision)
        profile_revision = max(1, int(profile.get("profile_revision") or 1))

    now = datetime.utcnow()
    assignment_revision = current_revision + 1
    correction = MeetingSpeakerCorrectionV2(
        id=str(uuid.uuid4()),
        user_id=user_id,
        meeting_id=meeting_id,
        client_request_id=mutation["client_request_id"],
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        transcript_revision_id=mutation["transcript_revision_id"],
        scope=scope,
        segment_ids_json=json.dumps(segment_ids, ensure_ascii=False, separators=(",", ":")),
        cluster_id=cluster_id,
        speaker_profile_id=mutation.get("speaker_profile_id"),
        display_name=mutation["display_name"],
        consent_to_profile_update=1 if mutation["consent_to_profile_update"] else 0,
        base_revision=current_revision,
        assignment_revision=assignment_revision,
        profile_revision=profile_revision,
        sample_state="queued" if scope == "future_profile" else "not_requested",
        model_version=(str(profile.get("model_version") or SPEAKER_MODEL_VERSION) if profile else None),
        created_at=now,
        updated_at=now,
    )
    db.add(correction)
    # The assignments carry the correction ID directly rather than through an
    # ORM relationship, so make the parent row visible before child inserts.
    await db.flush()
    for line in ordered_lines:
        db.add(MeetingSpeakerAssignmentV2(
            id=str(uuid.uuid4()),
            correction_id=correction.id,
            reprocess_job_id=None,
            user_id=user_id,
            meeting_id=meeting_id,
            transcript_line_id=line.id,
            speaker_profile_id=mutation.get("speaker_profile_id"),
            display_name=mutation["display_name"],
            assignment_revision=assignment_revision,
            source="manual",
            user_locked=1,
            model_version=correction.model_version,
            profile_revision=profile_revision,
            confidence=None,
            created_at=now,
        ))
        line.speaker_label = mutation["display_name"]
        if scope == "future_profile":
            line.speaker_id = mutation["speaker_profile_id"]
    await db.commit()
    await db.refresh(correction)
    return SpeakerMutationResult(201, correction_payload(correction), correction.id)


async def find_speaker_correction(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    correction_id: str,
) -> MeetingSpeakerCorrectionV2 | None:
    return (await db.execute(
        select(MeetingSpeakerCorrectionV2).where(
            MeetingSpeakerCorrectionV2.id == correction_id,
            MeetingSpeakerCorrectionV2.user_id == user_id,
            MeetingSpeakerCorrectionV2.meeting_id == meeting_id,
        )
    )).scalar_one_or_none()


def _decode_audio_window(path: str, start_sec: float, end_sec: float) -> np.ndarray:
    duration = max(0.0, min(MAX_PROFILE_SAMPLE_SECONDS, end_sec - start_sec))
    if duration <= 0:
        return np.zeros(0, dtype=np.float32)
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", f"{max(0.0, start_sec):.3f}", "-t", f"{duration:.3f}",
            "-i", path, "-vn", "-ac", "1", "-ar", "16000",
            "-f", "f32le", "pipe:1",
        ],
        capture_output=True,
        timeout=90,
        check=False,
    )
    if result.returncode != 0 or not result.stdout:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(result.stdout, dtype="<f4").copy()


async def _profile_sample_audio(
    db: AsyncSession,
    correction: MeetingSpeakerCorrectionV2,
) -> np.ndarray:
    rows = (await db.execute(
        select(TranscriptLine, MeetingRecordingAssetV2)
        .join(
            MeetingSpeakerAssignmentV2,
            MeetingSpeakerAssignmentV2.transcript_line_id == TranscriptLine.id,
        )
        .outerjoin(
            MeetingRecordingAssetV2,
            MeetingRecordingAssetV2.id == TranscriptLine.recording_asset_id,
        )
        .where(MeetingSpeakerAssignmentV2.correction_id == correction.id)
        .order_by(TranscriptLine.start_time, TranscriptLine.id)
    )).all()
    chunks: list[np.ndarray] = []
    remaining = MAX_PROFILE_SAMPLE_SECONDS
    for line, asset in rows:
        if asset is None or not asset.storage_path or not Path(asset.storage_path).is_file():
            continue
        overlap_count = int((await db.execute(
            select(func.count(TranscriptLine.id)).where(
                TranscriptLine.meeting_id == line.meeting_id,
                TranscriptLine.recording_asset_id == line.recording_asset_id,
                TranscriptLine.id != line.id,
                TranscriptLine.start_time < float(line.end_time) - 0.05,
                TranscriptLine.end_time > float(line.start_time) + 0.05,
            )
        )).scalar() or 0)
        if overlap_count > 0:
            continue
        duration = min(remaining, max(0.0, float(line.end_time) - float(line.start_time)))
        if duration < 0.8:
            continue
        chunk = await asyncio.to_thread(
            _decode_audio_window,
            asset.storage_path,
            float(line.start_time),
            float(line.start_time) + duration,
        )
        if chunk.size:
            chunks.append(chunk)
            remaining -= len(chunk) / 16000.0
        if remaining <= 0.05:
            break
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


async def _set_profile_sample_state(
    correction_id: str,
    state: str,
    error_code: str | None,
    profile_revision: int | None = None,
) -> None:
    async with async_session() as db:
        correction = await db.get(MeetingSpeakerCorrectionV2, correction_id)
        if correction is None:
            return
        correction.sample_state = state
        correction.sample_error_code = error_code
        if profile_revision is not None:
            correction.profile_revision = profile_revision
        correction.updated_at = datetime.utcnow()
        await db.commit()


async def _run_profile_sample_update_async(correction_id: str) -> None:
    try:
        async with async_session() as db:
            correction = await db.get(MeetingSpeakerCorrectionV2, correction_id)
            if (
                correction is None
                or correction.scope != "future_profile"
                or correction.sample_state != "queued"
                or correction.speaker_profile_id is None
            ):
                return
            correction.sample_state = "processing"
            correction.sample_error_code = None
            correction.updated_at = datetime.utcnow()
            await db.commit()
            audio = await _profile_sample_audio(db, correction)
            user_id = correction.user_id
            speaker_profile_id = correction.speaker_profile_id
        if len(audio) / 16000.0 < MIN_PROFILE_SAMPLE_SECONDS:
            await _set_profile_sample_state(correction_id, "rejected_quality", "sample_too_short")
            return
        from app.api.app_speakers import (
            MIN_SUPPLEMENT_COSINE,
            _embedding_cosine,
            _voiceprint_features,
        )
        embedding, quality, _level, _description, _issues, _suggestions = (
            await _voiceprint_features(audio)
        )
        profile = get_speaker_db().load_speaker_for_owner(user_id, speaker_profile_id)
        if profile is None or profile.get("embedding") is None:
            await _set_profile_sample_state(correction_id, "failed_permanent", "profile_unavailable")
            return
        if _embedding_cosine(profile["embedding"], embedding) < MIN_SUPPLEMENT_COSINE:
            await _set_profile_sample_state(correction_id, "rejected_quality", "profile_mismatch")
            return
        if not get_speaker_db().supplement_audio_for_owner(
            user_id,
            speaker_profile_id,
            embedding,
            quality=quality,
        ):
            await _set_profile_sample_state(correction_id, "failed_retryable", "profile_changed")
            return
        updated = get_speaker_db().load_speaker_for_owner(user_id, speaker_profile_id)
        await _set_profile_sample_state(
            correction_id,
            "accepted",
            None,
            max(1, int((updated or {}).get("profile_revision") or 1)),
        )
    except HTTPException as error:
        state = "rejected_quality" if error.status_code == 400 else "failed_retryable"
        code = "sample_quality_rejected" if error.status_code == 400 else "speaker_model_unavailable"
        await _set_profile_sample_state(correction_id, state, code)
    except Exception:
        await _set_profile_sample_state(correction_id, "failed_retryable", "speaker_sample_failed")


def schedule_profile_sample_update(correction_id: str) -> None:
    def runner() -> None:
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_run_profile_sample_update_async(correction_id))
        finally:
            loop.close()
    _worker.submit(runner)


async def retry_profile_sample(
    db: AsyncSession,
    *,
    user_id: int,
    meeting_id: str,
    correction_id: str,
) -> MeetingSpeakerCorrectionV2:
    correction = await find_speaker_correction(
        db,
        user_id=user_id,
        meeting_id=meeting_id,
        correction_id=correction_id,
    )
    if correction is None:
        raise LookupError("correction_missing")
    if correction.sample_state not in ("failed_retryable", "rejected_quality"):
        return correction
    correction.sample_state = "queued"
    correction.sample_error_code = None
    correction.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(correction)
    return correction


async def create_reprocess_job(
    db: AsyncSession,
    *,
    user_id: int,
    speaker_profile_id: str,
    idempotency_key: str,
    request_hash: str,
) -> SpeakerMutationResult:
    existing = (await db.execute(
        select(MeetingSpeakerReprocessJobV2).where(
            MeetingSpeakerReprocessJobV2.user_id == user_id,
            MeetingSpeakerReprocessJobV2.idempotency_key == idempotency_key,
        )
    )).scalar_one_or_none()
    if existing is not None:
        if existing.request_hash != request_hash or existing.speaker_profile_id != speaker_profile_id:
            raise SpeakerContractConflict("speaker_reprocess_request_reused", 409)
        return SpeakerMutationResult(200, reprocess_job_payload(existing))
    profile = get_speaker_db().load_speaker_for_owner(user_id, speaker_profile_id)
    if profile is None:
        raise LookupError("speaker_profile_missing")
    now = datetime.utcnow()
    job = MeetingSpeakerReprocessJobV2(
        id=str(uuid.uuid4()),
        user_id=user_id,
        speaker_profile_id=speaker_profile_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        status="queued",
        attempt=0,
        progress=0.0,
        total_meetings=0,
        processed_meetings=0,
        matched_segments=0,
        skipped_locked_segments=0,
        error_code=None,
        retryable=0,
        profile_revision=max(1, int(profile.get("profile_revision") or 1)),
        model_version=str(profile.get("model_version") or SPEAKER_MODEL_VERSION),
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return SpeakerMutationResult(202, reprocess_job_payload(job))


async def find_reprocess_job(
    db: AsyncSession,
    *,
    user_id: int,
    speaker_profile_id: str,
    job_id: str,
) -> MeetingSpeakerReprocessJobV2 | None:
    return (await db.execute(
        select(MeetingSpeakerReprocessJobV2).where(
            MeetingSpeakerReprocessJobV2.id == job_id,
            MeetingSpeakerReprocessJobV2.user_id == user_id,
            MeetingSpeakerReprocessJobV2.speaker_profile_id == speaker_profile_id,
        )
    )).scalar_one_or_none()


async def find_latest_reprocess_job(
    db: AsyncSession,
    *,
    user_id: int,
    speaker_profile_id: str,
) -> MeetingSpeakerReprocessJobV2 | None:
    return (await db.execute(
        select(MeetingSpeakerReprocessJobV2)
        .where(
            MeetingSpeakerReprocessJobV2.user_id == user_id,
            MeetingSpeakerReprocessJobV2.speaker_profile_id == speaker_profile_id,
        )
        .order_by(
            MeetingSpeakerReprocessJobV2.created_at.desc(),
            MeetingSpeakerReprocessJobV2.id.desc(),
        )
        .limit(1)
    )).scalar_one_or_none()


async def retry_reprocess_job(
    db: AsyncSession,
    *,
    user_id: int,
    speaker_profile_id: str,
    job_id: str,
) -> MeetingSpeakerReprocessJobV2:
    job = await find_reprocess_job(
        db,
        user_id=user_id,
        speaker_profile_id=speaker_profile_id,
        job_id=job_id,
    )
    if job is None:
        raise LookupError("job_missing")
    if job.status != "failed" or not job.retryable:
        return job
    job.status = "queued"
    job.progress = 0.0
    job.error_code = None
    job.retryable = 0
    job.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(job)
    return job


async def _mark_reprocess_failed(job_id: str, error_code: str, retryable: bool) -> None:
    async with async_session() as db:
        job = await db.get(MeetingSpeakerReprocessJobV2, job_id)
        if job is None:
            return
        job.status = "failed"
        job.progress = None
        job.error_code = error_code
        job.retryable = 1 if retryable else 0
        job.updated_at = datetime.utcnow()
        await db.commit()


async def _run_reprocess_job_async(job_id: str) -> None:
    try:
        async with async_session() as db:
            job = await db.get(MeetingSpeakerReprocessJobV2, job_id)
            if job is None or job.status != "queued":
                return
            profile = get_speaker_db().load_speaker_for_owner(job.user_id, job.speaker_profile_id)
            if profile is None or profile.get("embedding") is None:
                job.status = "failed"
                job.error_code = "speaker_profile_unavailable"
                job.retryable = 0
                job.updated_at = datetime.utcnow()
                await db.commit()
                return
            if max(1, int(profile.get("profile_revision") or 1)) != job.profile_revision:
                job.status = "failed"
                job.error_code = "speaker_profile_changed"
                job.retryable = 1
                job.updated_at = datetime.utcnow()
                await db.commit()
                return
            job.status = "running"
            job.attempt += 1
            job.progress = 0.0
            job.error_code = None
            job.retryable = 0
            job.updated_at = datetime.utcnow()
            await db.commit()

            rows = (await db.execute(
                select(TranscriptLine, MeetingRecordingAssetV2)
                .join(Meeting, Meeting.id == TranscriptLine.meeting_id)
                .join(MeetingNoteRootV2, MeetingNoteRootV2.meeting_id == Meeting.id)
                .outerjoin(
                    MeetingRecordingAssetV2,
                    MeetingRecordingAssetV2.id == TranscriptLine.recording_asset_id,
                )
                .where(
                    Meeting.user_id == job.user_id,
                    MeetingNoteRootV2.user_id == job.user_id,
                    MeetingNoteRootV2.lifecycle == "active",
                )
                .order_by(TranscriptLine.meeting_id, TranscriptLine.start_time, TranscriptLine.id)
            )).all()
            locked_ids = set((await db.execute(
                select(MeetingSpeakerAssignmentV2.transcript_line_id).where(
                    MeetingSpeakerAssignmentV2.user_id == job.user_id,
                    MeetingSpeakerAssignmentV2.user_locked == 1,
                )
            )).scalars().all())
            meeting_ids = sorted({line.meeting_id for line, _asset in rows})
            job.total_meetings = len(meeting_ids)
            await db.commit()

            from app.asr.model_manager import SpeakerEmbeddingExtractor, get_model_manager
            manager = get_model_manager()
            if not manager.is_initialized():
                await manager.initialize()
            model = manager.get_camp_model()
            if model is None:
                raise RuntimeError("speaker model unavailable")
            extractor = SpeakerEmbeddingExtractor(model, device=manager.device)
            profile_embedding = np.asarray(profile["embedding"], dtype=np.float32)
            matched = 0
            skipped_locked = 0
            processed_meetings: set[str] = set()
            revision_counter = 0
            for line, asset in rows:
                if line.id in locked_ids:
                    skipped_locked += 1
                    continue
                if asset is None or not asset.storage_path or not Path(asset.storage_path).is_file():
                    continue
                audio = await asyncio.to_thread(
                    _decode_audio_window,
                    asset.storage_path,
                    float(line.start_time),
                    float(line.end_time),
                )
                if len(audio) / 16000.0 < 0.8:
                    continue
                embedding = await asyncio.to_thread(extractor.extract, audio)
                if embedding is None:
                    continue
                cosine = float(
                    np.dot(profile_embedding, embedding)
                    / (np.linalg.norm(profile_embedding) * np.linalg.norm(embedding) + 1e-8)
                )
                if cosine >= MIN_REPROCESS_COSINE:
                    revision_counter += 1
                    line.speaker_id = job.speaker_profile_id
                    line.speaker_label = str(profile.get("name") or job.speaker_profile_id)
                    db.add(MeetingSpeakerAssignmentV2(
                        id=str(uuid.uuid4()),
                        correction_id=None,
                        reprocess_job_id=job.id,
                        user_id=job.user_id,
                        meeting_id=line.meeting_id,
                        transcript_line_id=line.id,
                        speaker_profile_id=job.speaker_profile_id,
                        display_name=line.speaker_label,
                        assignment_revision=revision_counter,
                        source="reprocessed",
                        user_locked=0,
                        model_version=job.model_version,
                        profile_revision=job.profile_revision,
                        confidence=cosine,
                        created_at=datetime.utcnow(),
                    ))
                    matched += 1
                processed_meetings.add(line.meeting_id)
                job.processed_meetings = len(processed_meetings)
                job.matched_segments = matched
                job.skipped_locked_segments = skipped_locked
                job.progress = (
                    min(1.0, len(processed_meetings) / max(1, len(meeting_ids)))
                    if meeting_ids else 1.0
                )
                job.updated_at = datetime.utcnow()
            material = f"{job.id}|{job.profile_revision}|{matched}|{skipped_locked}"
            job.status = "completed"
            job.progress = 1.0
            job.processed_meetings = len(processed_meetings)
            job.matched_segments = matched
            job.skipped_locked_segments = skipped_locked
            job.result_speaker_revision_id = (
                f"speaker-reprocess:{hashlib.sha256(material.encode()).hexdigest()}"
            )
            job.completed_at = datetime.utcnow()
            job.updated_at = job.completed_at
            await db.commit()
    except RuntimeError:
        await _mark_reprocess_failed(job_id, "speaker_model_unavailable", True)
    except Exception:
        await _mark_reprocess_failed(job_id, "speaker_reprocess_failed", True)


def schedule_reprocess_job(job_id: str) -> None:
    def runner() -> None:
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_run_reprocess_job_async(job_id))
        finally:
            loop.close()
    _worker.submit(runner)
