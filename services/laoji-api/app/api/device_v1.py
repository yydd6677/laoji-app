"""Device-primary API surface.

This router is intentionally small and explicit.  It does not expose account
or synchronization semantics; the device/epoch pair is the only owner
boundary visible to a mobile client.
"""

from __future__ import annotations

import base64
import asyncio
import hashlib
import json
import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
import uuid

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.meeting import Meeting
from app.models.meeting_recording_asset import (
    MeetingRecordingAssetOperationV2,
    MeetingRecordingAssetV2,
    MeetingRecordingTranscriptionJobV2,
)
from app.models.meeting_recording_r2_upload import MeetingRecordingR2UploadV1
from app.models.meeting_recording_transcript_draft import MeetingRecordingTranscriptDraftV1
from app.models.transcript import TranscriptLine
from app.api.app_meetings import (
    MeetingQuestionContextTurn,
    MeetingQuestionManualNoteSource,
    MeetingQuestionRequest,
    MeetingQuestionSummarySource,
    MeetingQuestionTranscriptSource,
)
from app.services import device_identity, vnext_capability_cutover
from app.services.device_identity import DeviceContext, DeviceIdentityError
from app.services.meeting_recording_asset_service import (
    RecordingAssetConflict,
    asset_payload,
    complete_content_upload,
    create_transcription_job,
    find_asset,
    find_job,
    job_payload,
    recording_asset_storage_path,
    recording_request_hash,
    register_asset,
    submit_transcription_job,
    _sha256_file,
)
from app.services import r2_storage_service
from app.services.schedule_parser_service import (
    apply_schedule_clarification,
    parse_schedule_audio,
    parse_schedule_text,
)
from app.services.app_meeting_question import (
    INSUFFICIENT_ANSWER,
    generate_meeting_question_answer,
    meeting_question_input_fingerprint,
    meeting_question_request_hash,
)
from app.workers.summary_tasks import (
    get_summary_template,
    submit_device_final_summary,
    submit_device_summary_v3,
    wait_for_submitted_summary_status,
)
from app.services.summary_task_store import latest_device_summary_result
from app.schemas.meeting_facts_v3 import PROMPT_REVISION
from app.services.summary_v3_evidence import normalize_sources, source_hash_matches
from app.services.summary_v3_generator import model_revision as summary_v3_model_revision
from app.services.summary_v3_store import (
    SummaryV3StoreError,
    delete_source_payload,
    find_document_by_identity,
    latest_document as latest_summary_v3_document,
    save_source_payload,
)
from app.services import vnext_task_store
from app.config import settings


router = APIRouter(prefix="/device/v1", tags=["device-v1"])
security = HTTPBearer(auto_error=False)

_DEVICE_MEDIA_IMPORT_MIME_TYPES = [
    "audio/wav",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-matroska",
]


def _delete_device_owned_files(paths: list[str]) -> None:
    """Remove device-owned source files without following paths outside storage."""
    root = Path(settings.audio_storage_abs_path).resolve()
    resolved_paths: list[Path] = []
    for raw in paths:
        value = str(raw or '').strip()
        if not value:
            continue
        candidate = Path(value)
        resolved = (candidate if candidate.is_absolute() else root / candidate).resolve(strict=False)
        if resolved == root or root not in resolved.parents:
            raise ValueError('device_storage_path_outside_root')
        resolved_paths.append(resolved)
    for resolved in sorted(set(resolved_paths)):
        if resolved.exists():
            if not resolved.is_file():
                raise ValueError('device_storage_path_not_regular_file')
            resolved.unlink()
        parent = resolved.parent
        while parent != root and root in parent.parents:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent


class DeviceRegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    device_id: str = Field(min_length=36, max_length=36)
    device_secret: str = Field(min_length=43, max_length=64)
    epoch_id: str = Field(min_length=36, max_length=36)


class EpochCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1


class DeviceMeetingCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1


class ScheduleParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    text: str = Field(min_length=1, max_length=20_000)
    reference_datetime: str | None = Field(default=None, max_length=80)
    timezone: str | None = Field(default=None, max_length=80)
    client_rule_status: Literal["not_run", "unresolved"] = "not_run"
    client_intent: Literal["create", "clarify", "query", "delete", "reject"] = "create"


class ScheduleAudioParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    audio_base64: str = Field(min_length=1, max_length=16 * 1024 * 1024)
    filename: str = Field(default="schedule.m4a", min_length=1, max_length=120)
    reference_datetime: str | None = Field(default=None, max_length=80)
    timezone: str | None = Field(default=None, max_length=80)


class ScheduleClarifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    current: dict[str, Any]
    answer: str = Field(min_length=1, max_length=1_000)
    reference_datetime: str | None = Field(default=None, max_length=80)
    timezone: str | None = Field(default=None, max_length=80)


class DeviceAssetRegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    client_asset_id: str = Field(min_length=1, max_length=512)
    role: Literal["primary", "secondary"] = "primary"
    origin: Literal["realtime", "file_import", "video_import", "schedule"] = "file_import"
    mime_type: str = Field(min_length=1, max_length=160)
    byte_size: int | None = Field(default=None, ge=1, le=1024 * 1024 * 1024)
    duration_ms: int | None = Field(default=None, ge=0, le=7_200_000)
    checksum_sha256: str | None = Field(default=None, max_length=71)


class DeviceTranscriptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    client_request_id: str = Field(min_length=1, max_length=512)
    language: Literal["zh", "en", "auto"] = "zh"


class DeviceChunkCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    upload_id: str = Field(min_length=1, max_length=512)
    total_bytes: int = Field(ge=1, le=1024 * 1024 * 1024)
    total_chunks: int = Field(ge=1, le=4096)
    checksum_sha256: str | None = Field(default=None, max_length=71)


class DeviceR2UploadInitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    client_upload_id: str = Field(min_length=1, max_length=512)
    total_bytes: int = Field(ge=1, le=1024 * 1024 * 1024)
    checksum_sha256: str | None = Field(default=None, max_length=71)


class DeviceR2UploadPart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    part_number: int = Field(ge=1, le=10_000)
    etag: str = Field(min_length=1, max_length=512)


class DeviceR2UploadCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    upload_id: str = Field(min_length=1, max_length=512)
    total_bytes: int = Field(ge=1, le=1024 * 1024 * 1024)
    parts: list[DeviceR2UploadPart] = Field(min_length=1, max_length=10_000)
    checksum_sha256: str | None = Field(default=None, max_length=71)


class DeviceSummaryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    template_id: str = Field(default="general", min_length=1, max_length=40)
    template_revision: int | None = Field(default=None, ge=1, le=2_147_483_647)
    force: bool = False
    retain_generated_result: bool = False


class DeviceSummaryV3ManualNote(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=0, le=9_007_199_254_740_991)
    content_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    content: str = Field(default="", max_length=200_000)


class DeviceSummaryV3Attachment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attachment_id: str = Field(min_length=1, max_length=512)
    revision: int = Field(ge=0, le=9_007_199_254_740_991)
    position_ms: int | None = Field(default=None, ge=0, le=604_800_000)
    content_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    content: str = Field(min_length=1, max_length=200_000)


class DeviceSummaryV3Request(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[3] = 3
    transcript_revision: str = Field(min_length=1, max_length=512)
    manual_note: DeviceSummaryV3ManualNote
    attachments: list[DeviceSummaryV3Attachment] = Field(default_factory=list, max_length=20)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=512)
    force: bool = False


class DeviceQuestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    client_thread_id: str = Field(min_length=1, max_length=512)
    client_request_id: str = Field(min_length=1, max_length=512)
    expected_ordinal: int = Field(ge=0, le=10_000)
    question: str = Field(min_length=1, max_length=2_000)
    summary_version_id: str | None = Field(default=None, max_length=512)
    summary_sections: list[MeetingQuestionSummarySource] = Field(default_factory=list, max_length=200)
    include_manual_note: bool = False
    manual_note: DeviceSummaryV3ManualNote | None = None
    context: list[MeetingQuestionContextTurn] = Field(default_factory=list, max_length=12)
    retain_generated_result: bool = False


class DeviceVNextBindingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    binding_generation: str = Field(min_length=1, max_length=256)


class DeviceVNextTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    task_id: str = Field(min_length=1, max_length=512)
    binding_id: str = Field(min_length=1, max_length=512)
    binding_generation: str = Field(min_length=1, max_length=256)
    capability: str = Field(min_length=1, max_length=120)
    entity_id: str = Field(min_length=1, max_length=512)
    entity_revision: int = Field(ge=1, le=9_007_199_254_740_991)
    input_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    generation_id: str = Field(min_length=1, max_length=512)
    predecessor_task_id: str | None = Field(default=None, max_length=512)
    creation_reason: Literal["original", "retry", "regenerate"] = "original"


class DeviceVNextTaskResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    attempt_id: str = Field(min_length=1, max_length=512)
    lease_owner: str = Field(min_length=1, max_length=200)
    result_kind: Literal["artifact", "content_outcome"] = "artifact"
    result: Any


class DeviceVNextTaskFailureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    attempt_id: str = Field(min_length=1, max_length=512)
    lease_owner: str = Field(min_length=1, max_length=200)
    error_code: str = Field(min_length=1, max_length=160)
    retryable: bool = False


def _device_question_candidate_is_current(
    value: object,
    *,
    meeting_id: str,
    client_thread_id: str,
    client_request_id: str,
    expected_ordinal: int,
    input_fingerprint: str,
    transcript_revision_id: str,
    allowed_source_ids: set[str],
    summary_version_id: str | None,
    allowed_summary_source_ids: set[str],
    manual_note_revision: int | None,
) -> bool:
    """Validate a retained device answer before idempotent replay.

    Retained quality candidates predate the current fail-closed citation
    checks, and the control store intentionally keeps them for a short review
    window.  A cache hit is therefore not evidence that its source snapshot is
    still the one in this request.  Treat every field that binds an answer to
    a meeting revision as part of the replay contract, and reject the whole
    candidate if one citation is foreign, duplicated, or malformed.
    """
    if not isinstance(value, dict):
        return False
    if value.get("schema_version") != 1:
        return False
    if value.get("client_meeting_id") != meeting_id:
        return False
    if value.get("client_thread_id") != client_thread_id:
        return False
    if value.get("client_request_id") != client_request_id:
        return False
    if value.get("ordinal") != expected_ordinal:
        return False
    if value.get("input_fingerprint") != input_fingerprint:
        return False
    if value.get("transcript_revision_id") != transcript_revision_id:
        return False
    if value.get("summary_version_id") != summary_version_id:
        return False
    if value.get("manual_note_revision") != manual_note_revision:
        return False
    answer = value.get("answer")
    if not isinstance(answer, str) or not answer.strip() or len(answer) > 20_000:
        return False
    answer_scope = value.get("answer_scope")
    answer_kind = value.get("answer_kind")
    if answer_scope not in {"meeting", "general"}:
        return False
    if answer_kind not in {"answer", "insufficient"}:
        return False
    citations = value.get("citations")
    if not isinstance(citations, list) or len(citations) > 20:
        return False
    seen: set[tuple[str, str]] = set()
    for citation in citations:
        if not isinstance(citation, dict):
            return False
        kind = citation.get("kind")
        source_id = citation.get("source_id")
        if not isinstance(source_id, str) or not source_id.strip():
            return False
        identity = (str(kind), source_id)
        allowed = (
            kind == "transcript" and source_id in allowed_source_ids
        ) or (
            kind == "summary" and source_id in allowed_summary_source_ids
        ) or (
            kind == "manual_note"
            and manual_note_revision is not None
            and source_id == f"manual-note:{manual_note_revision}"
        )
        if not allowed or identity in seen:
            return False
        seen.add(identity)
    if answer_scope == "general":
        return answer_kind == "answer" and not citations
    if answer_kind == "answer":
        return bool(citations)
    return answer == INSUFFICIENT_ANSWER and not citations


class DeviceSpeakerRegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    speaker_id: str | None = Field(default=None, max_length=160)
    # Kept optional for old clients.  Device-owned display names are never
    # persisted or returned by this API; the phone stores its own mapping.
    name: str | None = Field(default=None, max_length=30)
    embedding: list[float] = Field(min_length=1, max_length=4096)
    consent_version: str = Field(default="voiceprint-v1", min_length=1, max_length=80)


class DeviceSpeakerNameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    name: str = Field(min_length=1, max_length=30)


def _error(error: DeviceIdentityError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


def _guard_legacy_media_submit() -> None:
    try:
        vnext_capability_cutover.guard_legacy_media_upload_submit()
    except vnext_capability_cutover.VNextCapabilityCutoverError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": error.message},
        ) from error


def _guard_legacy_generation(capability: str, contract_revision: str) -> None:
    """Fence device-v1 summary/question/schedule producers after cutover."""
    try:
        vnext_capability_cutover.guard_legacy_submit(capability, contract_revision)
    except vnext_capability_cutover.VNextCapabilityCutoverError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": error.message},
        ) from error


async def require_device(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    header_epoch_id: str | None = Header(default=None, alias="X-Laoji-Data-Epoch"),
) -> DeviceContext:
    try:
        device_id, secret = device_identity.parse_bearer(
            f"{credentials.scheme} {credentials.credentials}" if credentials else None
        )
        if not header_epoch_id:
            raise DeviceIdentityError("EPOCH_REQUIRED", "缺少本机数据域", 428)
        return device_identity.authenticate(device_id, secret, header_epoch_id)
    except DeviceIdentityError as error:
        raise _error(error) from error


@router.post("/register", status_code=201)
async def register_device(
    payload: DeviceRegisterRequest,
    bootstrap: str | None = Header(default=None, alias="X-Laoji-Device-Bootstrap"),
) -> dict[str, Any]:
    if not device_identity.bootstrap_allowed(bootstrap):
        raise HTTPException(status_code=403, detail={
            "code": "DEVICE_BOOTSTRAP_INVALID",
            "message": "设备注册凭据无效",
        })
    try:
        return device_identity.register_device(
            payload.device_id,
            payload.device_secret,
            payload.epoch_id,
        )
    except DeviceIdentityError as error:
        raise _error(error) from error


@router.get("/capabilities")
async def device_capabilities(context: DeviceContext = Depends(require_device)) -> dict[str, Any]:
    del context
    r2_available = r2_storage_service.r2_enabled()
    return {
        "schema_version": 1,
        "device_api": True,
        "data_epoch": True,
        "meeting_bindings": True,
        "resumable_uploads": True,
        "chunk_bytes": 4 * 1024 * 1024,
        "r2_upload": r2_available,
        "r2_part_size": settings.R2_PART_SIZE if r2_available else None,
        "max_asset_bytes": 1024 * 1024 * 1024,
        "media_import": {
            "mime_types": _DEVICE_MEDIA_IMPORT_MIME_TYPES,
            "max_bytes": settings.MEETING_AUDIO_MAX_BYTES,
        } if shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None else None,
        "retained_results": ["transcript", "summary", "question_answer"],
        "public_links": False,
        "cross_device": False,
        "summary_contract_v3": True,
        "summary_attachments_text": True,
    }


def _vnext_error(error: vnext_task_store.VNextTaskError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


@router.put("/vnext/bindings/{binding_id}", status_code=201)
async def register_vnext_binding(
    binding_id: str,
    payload: DeviceVNextBindingRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    try:
        binding = await asyncio.to_thread(
            vnext_task_store.register_binding,
            context,
            binding_id=binding_id,
            binding_generation=payload.binding_generation,
        )
        return {"schema_version": 1, "binding": binding}
    except vnext_task_store.VNextTaskError as error:
        raise _vnext_error(error) from error


@router.post("/vnext/tasks", status_code=201)
async def create_vnext_task(
    payload: DeviceVNextTaskRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    try:
        task, reused = await asyncio.to_thread(
            vnext_task_store.create_task,
            context,
            task_id=payload.task_id,
            binding_id=payload.binding_id,
            binding_generation=payload.binding_generation,
            capability=payload.capability,
            entity_id=payload.entity_id,
            entity_revision=payload.entity_revision,
            input_sha256=payload.input_sha256,
            generation_id=payload.generation_id,
            predecessor_task_id=payload.predecessor_task_id,
            creation_reason=payload.creation_reason,
        )
        return {"schema_version": 1, "reused": reused, "task": task}
    except vnext_task_store.VNextTaskError as error:
        raise _vnext_error(error) from error


@router.get("/vnext/tasks/{task_id}")
async def get_vnext_task(
    task_id: str,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    try:
        task = await asyncio.to_thread(vnext_task_store.get_task, context, task_id)
    except vnext_task_store.VNextTaskError as error:
        raise _vnext_error(error) from error
    if task is None:
        raise HTTPException(status_code=404, detail={"code": "TASK_NOT_FOUND", "message": "任务不存在"})
    return {"schema_version": 1, "task": task}


@router.post("/vnext/tasks/{task_id}/attempts/claim")
async def claim_vnext_task_attempt(
    task_id: str,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    try:
        attempt = await asyncio.to_thread(vnext_task_store.claim_attempt, context, task_id)
    except vnext_task_store.VNextTaskError as error:
        raise _vnext_error(error) from error
    if attempt is None:
        raise HTTPException(status_code=409, detail={"code": "TASK_NOT_ADMITTED", "message": "任务当前不可执行"})
    return {"schema_version": 1, "attempt": attempt}


@router.post("/vnext/tasks/{task_id}/attempts/success")
async def finish_vnext_task_success(
    task_id: str,
    payload: DeviceVNextTaskResultRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    try:
        committed = await asyncio.to_thread(
            vnext_task_store.mark_success,
            context,
            task_id,
            payload.attempt_id,
            payload.result,
            result_kind=payload.result_kind,
            lease_owner=payload.lease_owner,
        )
    except vnext_task_store.VNextTaskError as error:
        raise _vnext_error(error) from error
    if not committed:
        raise HTTPException(status_code=409, detail={"code": "TASK_COMMIT_REJECTED", "message": "任务结果已过期"})
    return {"schema_version": 1, "committed": True}


@router.post("/vnext/tasks/{task_id}/attempts/failure")
async def finish_vnext_task_failure(
    task_id: str,
    payload: DeviceVNextTaskFailureRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    try:
        committed = await asyncio.to_thread(
            vnext_task_store.mark_failure,
            context,
            task_id,
            payload.attempt_id,
            payload.error_code,
            retryable=payload.retryable,
            lease_owner=payload.lease_owner,
        )
    except vnext_task_store.VNextTaskError as error:
        raise _vnext_error(error) from error
    if not committed:
        raise HTTPException(status_code=409, detail={"code": "TASK_COMMIT_REJECTED", "message": "任务结果已过期"})
    return {"schema_version": 1, "committed": True}


@router.post("/vnext/tasks/{task_id}/cancel")
async def cancel_vnext_task(
    task_id: str,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    try:
        cancelled = await asyncio.to_thread(vnext_task_store.cancel_task, context, task_id)
    except vnext_task_store.VNextTaskError as error:
        raise _vnext_error(error) from error
    if not cancelled:
        raise HTTPException(status_code=409, detail={"code": "TASK_NOT_ACTIVE", "message": "任务已结束或不存在"})
    return {"schema_version": 1, "cancelled": True}


@router.put("/epochs/{epoch_id}")
async def create_epoch(
    epoch_id: str,
    payload: EpochCreateRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    del payload
    try:
        if not device_identity.valid_uuid(epoch_id):
            raise DeviceIdentityError("EPOCH_INVALID", "本机数据域无效", 422)
        # Registering a fresh epoch is deliberately idempotent.  The current
        # epoch header may still point at the previous one during cutover.
        return device_identity.activate_epoch(context, epoch_id)
    except DeviceIdentityError as error:
        raise _error(error) from error
    return {"schema_version": 1, "epoch_id": epoch_id.lower(), "status": "active"}


@router.delete("/epochs/{epoch_id}")
async def delete_epoch(
    epoch_id: str,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    try:
        result = device_identity.close_epoch(context, epoch_id)
        cancelled_tasks = await asyncio.to_thread(vnext_task_store.cancel_epoch_tasks, context)
        return {**result, "vnext_tasks_cancelled": cancelled_tasks}
    except DeviceIdentityError as error:
        raise _error(error) from error


@router.put("/meetings/{binding_id}", status_code=201)
async def create_meeting_binding(
    binding_id: str,
    payload: DeviceMeetingCreateRequest,
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    del payload
    if not device_identity.valid_uuid(binding_id):
        raise HTTPException(status_code=422, detail={"code": "BINDING_INVALID", "message": "会议服务标识无效"})
    binding_id = binding_id.lower()
    existing = (
        await db.execute(
            select(Meeting).where(
                Meeting.id == binding_id,
                Meeting.user_id == context.principal_id,
                Meeting.data_epoch_id == context.epoch_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return {
            "schema_version": 1,
            "binding_id": binding_id,
            "epoch_id": context.epoch_id,
            "created": False,
        }
    try:
        db.add(
            Meeting(
                id=binding_id,
                user_id=context.principal_id,
                data_epoch_id=context.epoch_id,
                app_owned=1,
                client_request_id=f"device:{binding_id}",
                title="",
                description=None,
                location=None,
                status="created",
                mode="qwen",
                participants=None,
            )
        )
        await db.flush()
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(status_code=409, detail={
            "code": "BINDING_CONFLICT",
            "message": "会议服务标识已被占用",
        }) from error
    return {
        "schema_version": 1,
        "binding_id": binding_id,
        "epoch_id": context.epoch_id,
        "created": True,
    }


@router.delete("/meetings/{binding_id}")
async def delete_meeting_binding(
    binding_id: str,
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if not device_identity.valid_uuid(binding_id):
        raise HTTPException(status_code=422, detail={"code": "BINDING_INVALID", "message": "会议服务标识无效"})
    binding_id = binding_id.lower()
    meeting = (
        await db.execute(
            select(Meeting).where(
                Meeting.id == binding_id,
                Meeting.user_id == context.principal_id,
                Meeting.data_epoch_id == context.epoch_id,
            )
        )
    ).scalar_one_or_none()
    if meeting is not None:
        # A failed device transcription may still have a temporary source
        # file.  The client owns the original recording, so delete those
        # files before removing the database rows; otherwise a local-first
        # delete could strand private audio with no meeting row for the
        # retention worker to discover.
        asset_paths = (
            await db.execute(
                select(MeetingRecordingAssetV2.storage_path).where(
                    MeetingRecordingAssetV2.meeting_id == binding_id,
                    MeetingRecordingAssetV2.user_id == context.principal_id,
                    MeetingRecordingAssetV2.data_epoch_id == context.epoch_id,
                    MeetingRecordingAssetV2.storage_path.is_not(None),
                )
            )
        ).scalars().all()
        paths = [str(path) for path in asset_paths if path]
        if meeting.audio_path:
            paths.append(str(meeting.audio_path))
        if paths:
            try:
                await asyncio.to_thread(_delete_device_owned_files, paths)
            except (OSError, ValueError) as error:
                raise HTTPException(
                    status_code=503,
                    detail={"code": "DEVICE_SOURCE_CLEANUP_FAILED", "message": "设备录音文件暂时无法清理"},
                ) from error
        # Legacy compact tables use NO ACTION for a few meeting children.
        # Delete those rows explicitly so local-first device deletion cannot
        # surface a foreign-key 500 after an otherwise successful transcript.
        for table in ("transcript_lines", "meeting_segments", "period_summaries", "final_summaries"):
            await db.execute(
                text(f"DELETE FROM {table} WHERE meeting_id = :meeting_id"),
                {"meeting_id": binding_id},
            )
        await db.delete(meeting)
        await db.flush()
        # ``record_meeting_tombstone`` uses the control SQLite connection.  A
        # separate connection cannot write while this SQLAlchemy transaction
        # still owns a pending DELETE, so commit the service-owned deletion
        # before recording the idempotent device marker.
        await db.commit()
    await asyncio.to_thread(vnext_task_store.cancel_binding_tasks, context, binding_id)
    device_identity.record_meeting_tombstone(context, binding_id)
    device_identity.complete_meeting_delete(context, binding_id)
    return {"schema_version": 1, "binding_id": binding_id, "deleted": True}


@router.post("/schedule/parse")
async def parse_device_schedule(
    payload: ScheduleParseRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    del context
    _guard_legacy_generation(
        vnext_capability_cutover.SCHEDULE_GRAPH_CAPABILITY,
        vnext_capability_cutover.SCHEDULE_GRAPH_CONTRACT_REVISION,
    )
    result = await parse_schedule_text(
        payload.text,
        payload.reference_datetime,
        payload.timezone,
        model_only=(
            payload.client_rule_status == "unresolved"
            and payload.client_intent == "create"
        ),
    )
    if result is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "SCHEDULE_MODEL_NO_RESULT"
                if payload.client_rule_status == "unresolved"
                else "NOT_SCHEDULE",
                "message": "没有识别到可创建的日程，请补充具体安排。",
            },
        )
    return {"schema_version": 1, "result": result}


@router.post("/schedule/parse-audio")
async def parse_device_schedule_audio(
    payload: ScheduleAudioParseRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    del context
    _guard_legacy_generation(
        vnext_capability_cutover.SCHEDULE_GRAPH_CAPABILITY,
        vnext_capability_cutover.SCHEDULE_GRAPH_CONTRACT_REVISION,
    )
    try:
        raw = base64.b64decode(payload.audio_base64, validate=True)
    except Exception as error:
        raise HTTPException(status_code=422, detail={"code": "AUDIO_INVALID", "message": "语音内容无效"}) from error
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail={"code": "AUDIO_TOO_LARGE", "message": "语音文件过大"})
    encoded = base64.b64encode(raw).decode("ascii")
    result = await parse_schedule_audio(encoded, payload.filename, payload.reference_datetime, payload.timezone)
    return {"schema_version": 1, "result": result}


@router.post("/schedule/clarify")
async def clarify_device_schedule(
    payload: ScheduleClarifyRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    del context
    _guard_legacy_generation(
        vnext_capability_cutover.SCHEDULE_GRAPH_CAPABILITY,
        vnext_capability_cutover.SCHEDULE_GRAPH_CONTRACT_REVISION,
    )
    result = await asyncio.to_thread(
        apply_schedule_clarification,
        payload.current,
        payload.answer,
        payload.reference_datetime,
        payload.timezone,
    )
    if result is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_SCHEDULE", "message": "没有理解这次补充，请直接填写具体日期或时间"},
        )
    return {"schema_version": 1, "result": result}


def _device_identifier(value: str, label: str, maximum: int = 512) -> str:
    normalized = str(value or "").strip()
    if (
        not normalized
        or len(normalized) > maximum
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        raise HTTPException(status_code=422, detail={"code": "IDENTIFIER_INVALID", "message": f"{label}无效"})
    return normalized


def _idempotency_key(value: str | None, label: str) -> str:
    if value is None:
        raise HTTPException(status_code=428, detail={"code": "IDEMPOTENCY_REQUIRED", "message": f"缺少{label}"})
    return _device_identifier(value, label, 512)


async def _device_meeting(
    db: AsyncSession,
    context: DeviceContext,
    meeting_id: str,
) -> Meeting:
    normalized = _device_identifier(meeting_id, "会议服务标识", 160)
    if not device_identity.valid_uuid(normalized):
        raise HTTPException(status_code=422, detail={"code": "MEETING_INVALID", "message": "会议服务标识无效"})
    meeting = (
        await db.execute(
            select(Meeting).where(
                Meeting.id == normalized.lower(),
                Meeting.user_id == context.principal_id,
                Meeting.data_epoch_id == context.epoch_id,
            )
        )
    ).scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=404, detail={"code": "MEETING_NOT_FOUND", "message": "会议记录不存在"})
    return meeting


def _meeting_payload(meeting: Meeting, transcript_count: int = 0) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "meeting_id": meeting.id,
        "status": meeting.status,
        "mode": meeting.mode,
        "created_at": meeting.created_at.isoformat() if meeting.created_at else None,
        "updated_at": meeting.updated_at.isoformat() if meeting.updated_at else None,
        "transcript_count": transcript_count,
        "summary_available": False,
        # Device-primary privacy: title/location/participants/audio filename
        # stay on the phone and are never projected through this contract.
    }


def _device_asset_payload(asset: MeetingRecordingAssetV2) -> dict[str, Any]:
    payload = asset_payload(asset)
    payload.pop("content_url", None)
    payload.pop("file_name", None)
    payload["content_url"] = None
    payload["file_name"] = None
    payload["device_owned"] = bool(asset.data_epoch_id)
    return payload


def _device_job_payload(job: MeetingRecordingTranscriptionJobV2) -> dict[str, Any]:
    payload = job_payload(job)
    payload["device_owned"] = bool(job.data_epoch_id)
    return payload


async def _mark_asset_epoch(
    db: AsyncSession,
    asset_id: str,
    context: DeviceContext,
    idempotency_key: str | None = None,
) -> MeetingRecordingAssetV2 | None:
    asset = await db.get(MeetingRecordingAssetV2, asset_id)
    if asset is None or asset.user_id != context.principal_id:
        return None
    meeting = await _device_meeting(db, context, asset.meeting_id)
    asset.data_epoch_id = context.epoch_id
    if idempotency_key:
        operation = (
            await db.execute(
                select(MeetingRecordingAssetOperationV2).where(
                    MeetingRecordingAssetOperationV2.user_id == context.principal_id,
                    MeetingRecordingAssetOperationV2.idempotency_key == idempotency_key,
                )
            )
        ).scalar_one_or_none()
        if operation is not None:
            operation.data_epoch_id = context.epoch_id
    del meeting
    await db.flush()
    return asset


@router.get("/meetings")
async def list_device_meetings(
    page: int = Query(default=1, ge=1, le=10000),
    size: int = Query(default=50, ge=1, le=100),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    total = int(
        (
            await db.execute(
                select(func.count(Meeting.id)).where(
                    Meeting.user_id == context.principal_id,
                    Meeting.data_epoch_id == context.epoch_id,
                )
            )
        ).scalar_one()
        or 0
    )
    rows = list(
        (
            await db.execute(
                select(Meeting)
                .where(
                    Meeting.user_id == context.principal_id,
                    Meeting.data_epoch_id == context.epoch_id,
                )
                .order_by(func.coalesce(Meeting.recorded_at, Meeting.created_at).desc(), Meeting.id.desc())
                .offset((page - 1) * size)
                .limit(size)
            )
        ).scalars().all()
    )
    counts = dict(
        (
            await db.execute(
                select(TranscriptLine.meeting_id, func.count(TranscriptLine.id))
                .where(TranscriptLine.meeting_id.in_([row.id for row in rows]))
                .group_by(TranscriptLine.meeting_id)
            )
        ).all()
    ) if rows else {}
    return {
        "schema_version": 1,
        "items": [_meeting_payload(row, int(counts.get(row.id, 0))) for row in rows],
        "total": total,
        "page": page,
        "size": size,
    }


@router.get("/meetings/{binding_id}")
async def get_device_meeting(
    binding_id: str,
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    meeting = await _device_meeting(db, context, binding_id)
    count = int(
        (
            await db.execute(
                select(func.count(TranscriptLine.id)).where(TranscriptLine.meeting_id == meeting.id)
            )
        ).scalar_one()
        or 0
    )
    payload = _meeting_payload(meeting, count)
    payload["summary_available"] = latest_device_summary_result(
        task_scope=f"device:{context.principal_id}:{context.epoch_id}",
        meeting_id=meeting.id,
    ) is not None
    return payload


@router.get("/meetings/{binding_id}/status")
async def get_device_meeting_status(
    binding_id: str,
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    meeting = await _device_meeting(db, context, binding_id)
    return {
        "schema_version": 1,
        "meeting_id": meeting.id,
        "status": meeting.status,
        "updated_at": meeting.updated_at.isoformat() if meeting.updated_at else None,
    }


@router.post("/meetings/{binding_id}/assets", status_code=201)
async def register_device_asset(
    binding_id: str,
    payload: DeviceAssetRegisterRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _guard_legacy_media_submit()
    meeting = await _device_meeting(db, context, binding_id)
    key = _idempotency_key(idempotency_key, "录音资产请求标识")
    client_asset_id = _device_identifier(payload.client_asset_id, "本机录音资产标识")
    checksum = payload.checksum_sha256
    if checksum:
        from app.services.meeting_recording_asset_service import normalize_checksum

        try:
            checksum = normalize_checksum(checksum)
        except ValueError as error:
            raise HTTPException(status_code=422, detail={"code": "CHECKSUM_INVALID", "message": "录音校验值无效"}) from error
    mutation = {
        "client_asset_id": client_asset_id,
        "role": payload.role,
        "origin": payload.origin,
        # Do not persist the original user filename on the service.
        "mime_type": payload.mime_type,
        "file_name": "device-recording",
        "byte_size": payload.byte_size,
        "duration_ms": payload.duration_ms,
        "checksum_sha256": checksum,
    }
    request_hash = recording_request_hash("device-register", f"{context.epoch_id}:{meeting.id}:{client_asset_id}", mutation)
    try:
        result = await register_asset(
            db,
            user_id=context.principal_id,
            meeting_id=meeting.id,
            idempotency_key=key,
            request_hash=request_hash,
            mutation=mutation,
            data_epoch_id=context.epoch_id,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail={"code": "MEETING_NOT_FOUND", "message": "会议记录不存在"}) from error
    except RecordingAssetConflict as error:
        return JSONResponse(status_code=error.status_code, content={"error": {"code": error.code, "message": "录音资产请求冲突"}, "current": error.current})
    asset = await _mark_asset_epoch(db, result.payload["id"], context, key)
    if asset is None:
        raise HTTPException(status_code=500, detail={"code": "ASSET_EPOCH_FAILED", "message": "录音资产数据域绑定失败"})
    return {**_device_asset_payload(asset), "created": result.status_code == 201}


def _upload_suffix(mime_type: str) -> str:
    mapping = {
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mpeg": ".mp3",
        "audio/mp4": ".m4a",
        "audio/aac": ".aac",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
    }
    return mapping.get(mime_type.lower(), ".bin")


def _device_chunk_staging_dir(
    context: DeviceContext,
    asset_id: str,
    upload_id: str,
) -> Path:
    """Return a private, non-user-controlled staging directory for chunks."""
    root = Path(settings.audio_storage_abs_path).resolve()
    digest = hashlib.sha256(
        f"{context.principal_id}:{context.epoch_id}:{asset_id}:{upload_id}".encode("utf-8")
    ).hexdigest()
    return root / ".device-upload-parts" / str(context.principal_id) / context.epoch_id / digest


def _cleanup_device_chunk_dir(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        return


def _r2_object_key(context: DeviceContext, asset_id: str) -> str:
    # Do not put a phone filename, title, coordinates, or transcript data in
    # an object key.  The key is opaque to the client and is deleted after
    # ingestion; the short digest also avoids exposing the device principal.
    scope = hashlib.sha256(
        f"{context.principal_id}:{context.epoch_id}".encode("utf-8")
    ).hexdigest()[:24]
    return f"transient/device-{scope}/{asset_id}/{uuid.uuid4().hex}.audio"


def _r2_etag(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > 512:
        raise HTTPException(status_code=422, detail={"code": "R2_ETAG_INVALID", "message": "录音分片校验标识无效"})
    if any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise HTTPException(status_code=422, detail={"code": "R2_ETAG_INVALID", "message": "录音分片校验标识无效"})
    return normalized


def _r2_upload_payload(
    upload: MeetingRecordingR2UploadV1,
    *,
    parts: list[r2_storage_service.R2Part] | None = None,
    urls: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    mode = "single" if str(upload.multipart_upload_id).startswith("single:") else "multipart"
    return {
        "schema_version": 1,
        "upload_id": upload.id,
        "mode": mode,
        "status": upload.status,
        "part_size": int(upload.part_size),
        "total_bytes": int(upload.total_bytes),
        "total_parts": int(upload.total_parts),
        "expires_at": upload.expires_at.replace(tzinfo=timezone.utc).isoformat(),
        "completed_at": upload.completed_at.replace(tzinfo=timezone.utc).isoformat() if upload.completed_at else None,
        "uploaded_parts": [
            {"part_number": int(part.part_number), "etag": part.etag}
            for part in (parts or [])
        ],
        "parts": urls or [],
    }


def _r2_is_single(upload: MeetingRecordingR2UploadV1) -> bool:
    return str(upload.multipart_upload_id).startswith("single:")


async def _find_device_r2_upload(
    db: AsyncSession,
    context: DeviceContext,
    asset_id: str,
    upload_id: str | None = None,
) -> MeetingRecordingR2UploadV1 | None:
    conditions = [
        MeetingRecordingR2UploadV1.user_id == context.principal_id,
        MeetingRecordingR2UploadV1.asset_id == asset_id,
        MeetingRecordingR2UploadV1.data_epoch_id == context.epoch_id,
    ]
    if upload_id is not None:
        conditions.append(MeetingRecordingR2UploadV1.id == upload_id)
    return (await db.execute(select(MeetingRecordingR2UploadV1).where(*conditions))).scalar_one_or_none()


def _r2_part_map(parts: list[DeviceR2UploadPart], total_parts: int) -> list[r2_storage_service.R2Part]:
    if len(parts) != total_parts:
        raise HTTPException(status_code=409, detail={"code": "R2_PARTS_INCOMPLETE", "message": "录音仍有分片未上传"})
    seen: set[int] = set()
    normalized: list[r2_storage_service.R2Part] = []
    for part in parts:
        number = int(part.part_number)
        if number in seen or number < 1 or number > total_parts:
            raise HTTPException(status_code=422, detail={"code": "R2_PARTS_INVALID", "message": "录音分片清单无效"})
        seen.add(number)
        normalized.append(r2_storage_service.R2Part(number, _r2_etag(part.etag)))
    if len(seen) != total_parts:
        raise HTTPException(status_code=409, detail={"code": "R2_PARTS_INCOMPLETE", "message": "录音仍有分片未上传"})
    return sorted(normalized, key=lambda item: item.part_number)


@router.post("/assets/{asset_id}/r2-upload", status_code=201)
async def initialize_device_r2_upload(
    asset_id: str,
    payload: DeviceR2UploadInitRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Create or resume a private R2 multipart upload for one device asset."""
    _guard_legacy_media_submit()
    if not r2_storage_service.r2_enabled():
        raise HTTPException(status_code=503, detail={"code": "R2_UPLOAD_UNAVAILABLE", "message": "直传服务暂时不可用"})
    normalized_asset_id = _device_identifier(asset_id, "录音资产标识", 160)
    asset = await find_asset(db, user_id=context.principal_id, asset_id=normalized_asset_id)
    if asset is None or asset.data_epoch_id != context.epoch_id:
        raise HTTPException(status_code=404, detail={"code": "ASSET_NOT_FOUND", "message": "录音资产不存在"})
    await _device_meeting(db, context, asset.meeting_id)
    if asset.upload_state != "registered":
        if asset.upload_state in {"uploaded", "processed"}:
            existing = await _find_device_r2_upload(db, context, normalized_asset_id)
            if existing is not None:
                return _r2_upload_payload(existing)
        raise HTTPException(status_code=409, detail={"code": "ASSET_CONTENT_IMMUTABLE", "message": "录音内容已经提交"})
    if asset.byte_size is not None and int(asset.byte_size) != int(payload.total_bytes):
        raise HTTPException(status_code=409, detail={"code": "ASSET_SIZE_MISMATCH", "message": "录音文件大小与登记信息不一致"})
    try:
        part_size, total_parts = r2_storage_service.validate_part_layout(payload.total_bytes)
    except ValueError as error:
        raise HTTPException(status_code=422, detail={"code": str(error), "message": "录音分片布局无效"}) from error
    checksum = payload.checksum_sha256
    if checksum:
        from app.services.meeting_recording_asset_service import normalize_checksum

        try:
            checksum = normalize_checksum(checksum)
        except ValueError as error:
            raise HTTPException(status_code=422, detail={"code": "CHECKSUM_INVALID", "message": "录音校验值无效"}) from error
    request_key = _idempotency_key(idempotency_key or payload.client_upload_id, "录音直传请求标识")
    existing = await _find_device_r2_upload(db, context, normalized_asset_id)
    now = datetime.utcnow()
    if existing is not None and existing.status == "completed":
        if existing.total_bytes != payload.total_bytes or existing.checksum_sha256 not in {None, checksum}:
            raise HTTPException(status_code=409, detail={"code": "R2_UPLOAD_REUSED", "message": "录音直传请求标识已用于其他文件"})
        return _r2_upload_payload(existing)
    if existing is not None and existing.status in {"active", "completing"} and existing.expires_at > now:
        if existing.total_bytes != payload.total_bytes or existing.idempotency_key != request_key:
            raise HTTPException(status_code=409, detail={"code": "R2_UPLOAD_REUSED", "message": "录音直传请求标识已用于其他文件"})
        if existing.status == "completing":
            raise HTTPException(status_code=409, detail={"code": "R2_UPLOAD_IN_PROGRESS", "message": "录音正在完成上传，请稍后重试"})
        try:
            if _r2_is_single(existing):
                url = await asyncio.to_thread(
                    r2_storage_service.presign_put_object,
                    object_key=existing.object_key,
                    mime_type=None,
                )
                head = await asyncio.to_thread(
                    r2_storage_service.object_head,
                    object_key=existing.object_key,
                )
                uploaded_parts = (
                    [r2_storage_service.R2Part(1, str(head.get("etag") or ""))]
                    if head and int(head.get("content_length") or 0) == int(existing.total_bytes)
                    and str(head.get("etag") or "").strip()
                    else []
                )
                urls = [{"part_number": 1, "url": url}]
            else:
                urls = await asyncio.to_thread(
                    r2_storage_service.presign_upload_parts,
                    object_key=existing.object_key,
                    upload_id=existing.multipart_upload_id,
                    total_parts=existing.total_parts,
                )
                uploaded_parts = await asyncio.to_thread(
                    r2_storage_service.list_uploaded_parts,
                    object_key=existing.object_key,
                    upload_id=existing.multipart_upload_id,
                )
            return _r2_upload_payload(existing, parts=uploaded_parts, urls=urls)
        except r2_storage_service.R2StorageUnavailable as error:
            raise HTTPException(status_code=503, detail={"code": "R2_UPLOAD_UNAVAILABLE", "message": "直传服务暂时不可用"}) from error
    if existing is not None and existing.status in {"active", "completing", "failed", "expired", "aborted"}:
        try:
            if _r2_is_single(existing):
                await asyncio.to_thread(
                    r2_storage_service.delete_object,
                    object_key=existing.object_key,
                )
            else:
                await asyncio.to_thread(
                    r2_storage_service.abort_multipart_upload,
                    object_key=existing.object_key,
                    upload_id=existing.multipart_upload_id,
                )
        except Exception:
            pass
        try:
            await asyncio.to_thread(
                r2_storage_service.delete_object,
                object_key=existing.object_key,
            )
        except Exception:
            pass
        await db.delete(existing)
        await db.flush()
    try:
        object_key = _r2_object_key(context, normalized_asset_id)
        if payload.total_bytes <= 16 * 1024 * 1024:
            # One PUT avoids a multipart create/list/complete cycle for the
            # short recordings that dominate phone imports.
            multipart_upload_id = f"single:{uuid.uuid4().hex}"
            # A single PUT is represented by one logical part even when the
            # generic layout (which is based on the 8 MiB multipart size)
            # would otherwise report several parts.  Returning the generic
            # count here makes the client look for presigned URLs that are
            # intentionally not generated by the single-object path.
            total_parts = 1
        else:
            multipart_upload_id = await asyncio.to_thread(
                r2_storage_service.create_multipart_upload,
                object_key=object_key,
                mime_type=asset.mime_type or "application/octet-stream",
            )
        upload = MeetingRecordingR2UploadV1(
            user_id=context.principal_id,
            meeting_id=asset.meeting_id,
            asset_id=asset.id,
            data_epoch_id=context.epoch_id,
            bucket=settings.R2_BUCKET.strip(),
            object_key=object_key,
            multipart_upload_id=multipart_upload_id,
            idempotency_key=request_key,
            part_size=part_size,
            total_bytes=payload.total_bytes,
            total_parts=total_parts,
            checksum_sha256=checksum,
            status="active",
            created_at=now,
            updated_at=now,
            expires_at=now + timedelta(hours=settings.R2_UPLOAD_SESSION_TTL_HOURS),
        )
        db.add(upload)
        await db.flush()
        if str(multipart_upload_id).startswith("single:"):
            urls = [{
                "part_number": 1,
                "url": await asyncio.to_thread(
                    r2_storage_service.presign_put_object,
                    object_key=object_key,
                    mime_type=None,
                ),
            }]
        else:
            urls = await asyncio.to_thread(
                r2_storage_service.presign_upload_parts,
                object_key=object_key,
                upload_id=multipart_upload_id,
                total_parts=total_parts,
            )
        return _r2_upload_payload(upload, urls=urls)
    except r2_storage_service.R2StorageUnavailable as error:
        raise HTTPException(status_code=503, detail={"code": "R2_UPLOAD_UNAVAILABLE", "message": "直传服务暂时不可用"}) from error
    except Exception:
        # If presigning or DB flush failed after multipart creation, aborting
        # is best effort. The 24-hour R2 lifecycle rule remains the final
        # safety net for a connector/network failure.
        try:
            if "multipart_upload_id" in locals() and "object_key" in locals():
                if str(multipart_upload_id).startswith("single:"):
                    await asyncio.to_thread(
                        r2_storage_service.delete_object,
                        object_key=object_key,
                    )
                else:
                    await asyncio.to_thread(
                        r2_storage_service.abort_multipart_upload,
                        object_key=object_key,
                        upload_id=multipart_upload_id,
                    )
        except Exception:
            pass
        raise


@router.get("/assets/{asset_id}/r2-upload")
async def get_device_r2_upload(
    asset_id: str,
    upload_id: str | None = Query(default=None, max_length=512),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    normalized_asset_id = _device_identifier(asset_id, "录音资产标识", 160)
    upload = await _find_device_r2_upload(db, context, normalized_asset_id, upload_id)
    if upload is None:
        raise HTTPException(status_code=404, detail={"code": "R2_UPLOAD_NOT_FOUND", "message": "直传任务不存在"})
    if upload.status == "active" and upload.expires_at <= datetime.utcnow():
        raise HTTPException(status_code=410, detail={"code": "R2_UPLOAD_EXPIRED", "message": "直传任务已过期，请重新上传"})
    parts: list[r2_storage_service.R2Part] = []
    urls: list[dict[str, Any]] = []
    if upload.status == "active" and r2_storage_service.r2_enabled():
        if _r2_is_single(upload):
            head = await asyncio.to_thread(
                r2_storage_service.object_head,
                object_key=upload.object_key,
            )
            if head and int(head.get("content_length") or 0) == int(upload.total_bytes) and str(head.get("etag") or "").strip():
                parts = [r2_storage_service.R2Part(1, str(head["etag"]).strip())]
            urls = [{
                "part_number": 1,
                "url": await asyncio.to_thread(
                    r2_storage_service.presign_put_object,
                    object_key=upload.object_key,
                    mime_type=None,
                ),
            }]
        else:
            parts = await asyncio.to_thread(
                r2_storage_service.list_uploaded_parts,
                object_key=upload.object_key,
                upload_id=upload.multipart_upload_id,
            )
            urls = await asyncio.to_thread(
                r2_storage_service.presign_upload_parts,
                object_key=upload.object_key,
                upload_id=upload.multipart_upload_id,
                total_parts=upload.total_parts,
            )
    return _r2_upload_payload(upload, parts=parts, urls=urls)


@router.post("/assets/{asset_id}/r2-upload/complete")
async def complete_device_r2_upload(
    asset_id: str,
    payload: DeviceR2UploadCompleteRequest,
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _guard_legacy_media_submit()
    normalized_asset_id = _device_identifier(asset_id, "录音资产标识", 160)
    upload = await _find_device_r2_upload(db, context, normalized_asset_id, payload.upload_id)
    if upload is None:
        raise HTTPException(status_code=404, detail={"code": "R2_UPLOAD_NOT_FOUND", "message": "直传任务不存在"})
    asset = await find_asset(db, user_id=context.principal_id, asset_id=normalized_asset_id)
    if asset is None or asset.data_epoch_id != context.epoch_id or asset.id != upload.asset_id:
        raise HTTPException(status_code=404, detail={"code": "ASSET_NOT_FOUND", "message": "录音资产不存在"})
    await _device_meeting(db, context, asset.meeting_id)
    if upload.status == "completed":
        return {**_device_asset_payload(asset), "uploaded": True, "r2": _r2_upload_payload(upload), "replayed": True}
    if upload.status == "completing":
        raise HTTPException(status_code=409, detail={"code": "R2_UPLOAD_IN_PROGRESS", "message": "录音正在完成上传，请稍后重试"})
    if upload.status != "active":
        raise HTTPException(status_code=409, detail={"code": "R2_UPLOAD_NOT_ACTIVE", "message": "直传任务已失效，请重新上传"})
    if upload.expires_at <= datetime.utcnow():
        upload.status = "expired"
        upload.updated_at = datetime.utcnow()
        await db.commit()
        raise HTTPException(status_code=410, detail={"code": "R2_UPLOAD_EXPIRED", "message": "直传任务已过期，请重新上传"})
    if int(payload.total_bytes) != int(upload.total_bytes):
        raise HTTPException(status_code=409, detail={"code": "R2_SIZE_MISMATCH", "message": "录音文件大小与直传任务不一致"})
    parts = _r2_part_map(payload.parts, upload.total_parts)
    if payload.checksum_sha256:
        from app.services.meeting_recording_asset_service import normalize_checksum

        try:
            expected_checksum = normalize_checksum(payload.checksum_sha256)
        except ValueError as error:
            raise HTTPException(status_code=422, detail={"code": "CHECKSUM_INVALID", "message": "录音校验值无效"}) from error
        if upload.checksum_sha256 and upload.checksum_sha256 != expected_checksum:
            raise HTTPException(status_code=409, detail={"code": "CHECKSUM_MISMATCH", "message": "录音校验值与直传任务不一致"})
    if asset.upload_state in {"uploaded", "processed"}:
        upload.status = "completed"
        upload.completed_at = datetime.utcnow()
        upload.updated_at = datetime.utcnow()
        await db.commit()
        return {**_device_asset_payload(asset), "uploaded": True, "r2": _r2_upload_payload(upload), "replayed": True}
    upload.status = "completing"
    upload.updated_at = datetime.utcnow()
    await db.commit()
    temporary: Path | None = None
    target: Path | None = None
    multipart_completed = False
    try:
        if _r2_is_single(upload):
            head = await asyncio.to_thread(
                r2_storage_service.object_head,
                object_key=upload.object_key,
            )
            if head is None:
                raise HTTPException(status_code=409, detail={"code": "R2_PARTS_INCOMPLETE", "message": "录音尚未上传完成"})
            if int(head.get("content_length") or 0) != int(upload.total_bytes):
                raise HTTPException(status_code=422, detail={"code": "R2_SIZE_MISMATCH", "message": "直传文件大小校验失败"})
            actual_etag = str(head.get("etag") or "").strip()
            if parts and actual_etag and parts[0].etag.strip('"').lower() != actual_etag.strip('"').lower():
                raise HTTPException(status_code=409, detail={"code": "R2_PARTS_MISMATCH", "message": "录音校验标识不一致，请重试"})
            multipart_completed = True
        else:
            # Verify the server-side part listing before completing. This
            # prevents a client from submitting a guessed ETag list and gives
            # resume a deterministic missing-part error.
            uploaded_parts = await asyncio.to_thread(
                r2_storage_service.list_uploaded_parts,
                object_key=upload.object_key,
                upload_id=upload.multipart_upload_id,
            )
            # A process can die after R2 accepted CompleteMultipartUpload but
            # before SQLite marked the session completed. In that narrow
            # window list_parts returns no upload; an existing final object is
            # the durable proof that completion already happened.
            if not uploaded_parts:
                multipart_completed = await asyncio.to_thread(
                    r2_storage_service.object_exists,
                    object_key=upload.object_key,
                )
            actual_by_number = {item.part_number: item.etag for item in uploaded_parts}
            if not multipart_completed:
                for part in parts:
                    actual = actual_by_number.get(part.part_number)
                    if actual is None or actual.strip('"').lower() != part.etag.strip('"').lower():
                        raise HTTPException(status_code=409, detail={"code": "R2_PARTS_MISMATCH", "message": "录音分片校验不一致，请重试缺失分片"})
                verified_parts = [
                    r2_storage_service.R2Part(part.part_number, actual_by_number[part.part_number])
                    for part in parts
                ]
                await asyncio.to_thread(
                    r2_storage_service.complete_multipart_upload,
                    object_key=upload.object_key,
                    upload_id=upload.multipart_upload_id,
                    parts=verified_parts,
                )
                multipart_completed = True
        target = recording_asset_storage_path(
            user_id=context.principal_id,
            meeting_id=asset.meeting_id,
            asset_id=asset.id,
            suffix=_upload_suffix(asset.mime_type),
        )
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.r2")
        await asyncio.to_thread(
            r2_storage_service.download_object,
            object_key=upload.object_key,
            target=temporary,
        )
        if not temporary.is_file() or temporary.stat().st_size != upload.total_bytes:
            raise HTTPException(status_code=422, detail={"code": "R2_SIZE_MISMATCH", "message": "直传文件大小校验失败"})
        checksum = await asyncio.to_thread(_sha256_file, temporary)
        expected_checksum = upload.checksum_sha256 or asset.checksum_sha256
        if expected_checksum and expected_checksum != checksum:
            raise HTTPException(status_code=422, detail={"code": "CHECKSUM_MISMATCH", "message": "录音校验失败"})
        temporary.replace(target)
        request_hash = recording_request_hash(
            "device-content-r2",
            f"{context.epoch_id}:{asset.id}",
            {"revision": int(asset.revision), "size": int(upload.total_bytes), "checksum": checksum},
        )
        result = await complete_content_upload(
            db,
            user_id=context.principal_id,
            asset_id=asset.id,
            expected_revision=int(asset.revision),
            idempotency_key=f"r2-content:{upload.id}",
            request_hash=request_hash,
            storage_path=str(target),
            actual_byte_size=int(upload.total_bytes),
            actual_checksum=checksum,
            duration_ms=asset.duration_ms,
            data_epoch_id=context.epoch_id,
        )
        upload.status = "completed"
        upload.completed_at = datetime.utcnow()
        upload.updated_at = datetime.utcnow()
        await db.commit()
        # The object is only a transfer buffer. A lifecycle rule is still
        # required as a safety net, but a successful request should remove it
        # immediately and not wait for the next cleanup cycle.
        try:
            await asyncio.to_thread(r2_storage_service.delete_object, object_key=upload.object_key)
        except Exception:
            pass
        return {**_device_asset_payload(asset), "uploaded": True, "server_result": result.payload, "r2": _r2_upload_payload(upload)}
    except HTTPException as error:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        if target is not None and asset.upload_state == "registered":
            target.unlink(missing_ok=True)
        detail = error.detail if isinstance(error.detail, dict) else {}
        # A stale/missing ETag is a resumable client-side condition. Keep the
        # multipart session active so the phone can query the missing parts;
        # checksum and object-size failures are terminal for this session.
        upload.status = "active" if detail.get("code") == "R2_PARTS_MISMATCH" else "failed"
        upload.updated_at = datetime.utcnow()
        await db.commit()
        raise
    except Exception as error:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        if target is not None and asset.upload_state == "registered":
            target.unlink(missing_ok=True)
        upload.status = "failed" if multipart_completed else "active"
        upload.updated_at = datetime.utcnow()
        await db.commit()
        raise HTTPException(status_code=502, detail={"code": "R2_COMPLETE_FAILED", "message": "直传文件暂时无法接收，请重试"}) from error


@router.delete("/assets/{asset_id}/r2-upload")
async def cancel_device_r2_upload(
    asset_id: str,
    upload_id: str | None = Query(default=None, max_length=512),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    normalized_asset_id = _device_identifier(asset_id, "录音资产标识", 160)
    upload = await _find_device_r2_upload(db, context, normalized_asset_id, upload_id)
    if upload is None:
        return {"schema_version": 1, "cancelled": True, "already_missing": True}
    if upload.status in {"active", "completing"}:
        try:
            if _r2_is_single(upload):
                await asyncio.to_thread(
                    r2_storage_service.delete_object,
                    object_key=upload.object_key,
                )
            else:
                await asyncio.to_thread(
                    r2_storage_service.abort_multipart_upload,
                    object_key=upload.object_key,
                    upload_id=upload.multipart_upload_id,
                )
        except Exception:
            pass
        upload.status = "aborted"
        upload.updated_at = datetime.utcnow()
        await db.commit()
    return {"schema_version": 1, "cancelled": True, "upload_id": upload.id, "status": upload.status}


class _DeviceChunkMergeError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(code)
        self.code = code
        self.message = message


def _write_device_chunk(body: bytes, temporary: Path, part: Path) -> None:
    """Perform chunk filesystem work off the uvicorn event loop."""
    temporary.write_bytes(body)
    temporary.replace(part)


def _merge_device_chunks(
    parts: list[Path],
    target: Path,
    temporary: Path,
    total_bytes: int,
) -> tuple[int, str]:
    """Merge and hash upload parts without blocking realtime WebSockets."""
    total = 0
    digest = hashlib.sha256()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with temporary.open("xb") as output:
            for part in parts:
                with part.open("rb") as source:
                    while True:
                        block = source.read(settings.MEETING_AUDIO_CHUNK_BYTES)
                        if not block:
                            break
                        total += len(block)
                        if total > total_bytes:
                            raise _DeviceChunkMergeError("CHUNK_TOTAL_INVALID", "录音分片总大小不匹配")
                        digest.update(block)
                        output.write(block)
        if total != total_bytes:
            raise _DeviceChunkMergeError("CHUNK_TOTAL_INVALID", "录音分片总大小不匹配")
        return total, f"sha256:{digest.hexdigest()}"
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


@router.put("/assets/{asset_id}/chunks/{chunk_index}")
async def upload_device_asset_chunk(
    asset_id: str,
    chunk_index: int,
    request: Request,
    expected_revision: int = Query(default=1, ge=1),
    upload_id: str | None = Header(default=None, alias="X-Laoji-Upload-Id"),
    chunk_offset: int | None = Header(default=None, alias="X-Laoji-Chunk-Offset"),
    total_bytes: int | None = Header(default=None, alias="X-Laoji-Total-Bytes"),
    total_chunks: int | None = Header(default=None, alias="X-Laoji-Total-Chunks"),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _guard_legacy_media_submit()
    normalized_asset_id = _device_identifier(asset_id, "录音资产标识", 160)
    if chunk_index < 0 or chunk_index > 4095:
        raise HTTPException(status_code=422, detail={"code": "CHUNK_INDEX_INVALID", "message": "录音分片序号无效"})
    if not upload_id or chunk_offset is None or total_bytes is None or total_chunks is None:
        raise HTTPException(status_code=428, detail={"code": "CHUNK_HEADERS_REQUIRED", "message": "录音分片信息不完整"})
    upload_key = _device_identifier(upload_id, "录音上传标识", 512)
    if total_bytes < 1 or total_bytes > settings.MEETING_AUDIO_MAX_BYTES:
        raise HTTPException(status_code=413, detail={"code": "AUDIO_TOO_LARGE", "message": "录音文件过大"})
    if total_chunks < 1 or total_chunks > 4096 or chunk_index >= total_chunks:
        raise HTTPException(status_code=422, detail={"code": "CHUNK_LAYOUT_INVALID", "message": "录音分片布局无效"})
    if chunk_offset < 0 or chunk_offset >= total_bytes:
        raise HTTPException(status_code=422, detail={"code": "CHUNK_OFFSET_INVALID", "message": "录音分片位置无效"})
    asset = await find_asset(db, user_id=context.principal_id, asset_id=normalized_asset_id)
    if asset is None or asset.data_epoch_id != context.epoch_id:
        raise HTTPException(status_code=404, detail={"code": "ASSET_NOT_FOUND", "message": "录音资产不存在"})
    await _device_meeting(db, context, asset.meeting_id)
    body = await request.body()
    if not body:
        raise HTTPException(status_code=422, detail={"code": "CHUNK_EMPTY", "message": "录音分片为空"})
    if chunk_offset + len(body) > total_bytes:
        raise HTTPException(status_code=422, detail={"code": "CHUNK_RANGE_INVALID", "message": "录音分片超出文件范围"})
    staging = _device_chunk_staging_dir(context, normalized_asset_id, upload_key)
    staging.mkdir(parents=True, exist_ok=True)
    part = staging / f"{chunk_index}.part"
    temporary = staging / f".{chunk_index}.{uuid.uuid4().hex}.part"
    try:
        # Replays of an already accepted chunk are idempotent and do not
        # append duplicate bytes to the eventual source file.
        if part.exists() and part.stat().st_size == len(body):
            return {"schema_version": 1, "accepted": True, "chunk_index": chunk_index, "replayed": True}
        await asyncio.to_thread(_write_device_chunk, body, temporary, part)
    finally:
        temporary.unlink(missing_ok=True)
    return {"schema_version": 1, "accepted": True, "chunk_index": chunk_index, "replayed": False}


@router.post("/assets/{asset_id}/chunks/complete")
async def complete_device_asset_chunk_upload(
    asset_id: str,
    payload: DeviceChunkCompleteRequest,
    expected_revision: int = Query(default=1, ge=1),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _guard_legacy_media_submit()
    key = _idempotency_key(idempotency_key, "录音上传完成请求标识")
    normalized_asset_id = _device_identifier(asset_id, "录音资产标识", 160)
    upload_key = _device_identifier(payload.upload_id, "录音上传标识", 512)
    asset = await find_asset(db, user_id=context.principal_id, asset_id=normalized_asset_id)
    if asset is None or asset.data_epoch_id != context.epoch_id:
        raise HTTPException(status_code=404, detail={"code": "ASSET_NOT_FOUND", "message": "录音资产不存在"})
    await _device_meeting(db, context, asset.meeting_id)
    # The response to ``complete`` may be lost after the database commit. In
    # that case the client retries with the same expected revision after the
    # staging directory has already been removed; return the committed asset
    # instead of turning an already successful upload into CHUNK_MISSING.
    if str(asset.upload_state or "").lower() in {"processed", "uploaded"} and int(asset.revision or 0) > expected_revision:
        return {**_device_asset_payload(asset), "uploaded": True, "replayed": True}
    staging = _device_chunk_staging_dir(context, normalized_asset_id, upload_key)
    parts = [staging / f"{index}.part" for index in range(payload.total_chunks)]
    if any(not part.is_file() for part in parts):
        raise HTTPException(status_code=409, detail={"code": "CHUNK_MISSING", "message": "录音仍有分片未上传"})
    target = recording_asset_storage_path(
        user_id=context.principal_id,
        meeting_id=asset.meeting_id,
        asset_id=asset.id,
        suffix=_upload_suffix(asset.mime_type),
    )
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")
    try:
        total, checksum = await asyncio.to_thread(
            _merge_device_chunks,
            parts,
            target,
            temporary,
            payload.total_bytes,
        )
        if payload.checksum_sha256:
            from app.services.meeting_recording_asset_service import normalize_checksum

            try:
                expected_checksum = normalize_checksum(payload.checksum_sha256)
            except ValueError as error:
                raise HTTPException(status_code=422, detail={"code": "CHECKSUM_INVALID", "message": "录音校验值无效"}) from error
            if expected_checksum != checksum:
                raise HTTPException(status_code=422, detail={"code": "CHECKSUM_MISMATCH", "message": "录音校验失败"})
        temporary.replace(target)
        request_hash = recording_request_hash(
            "device-content-chunked",
            f"{context.epoch_id}:{asset.id}",
            {"revision": expected_revision, "size": total, "checksum": checksum},
        )
        result = await complete_content_upload(
            db,
            user_id=context.principal_id,
            asset_id=asset.id,
            expected_revision=expected_revision,
            idempotency_key=key,
            request_hash=request_hash,
            storage_path=str(target),
            actual_byte_size=total,
            actual_checksum=checksum,
            duration_ms=asset.duration_ms,
            data_epoch_id=context.epoch_id,
        )
        await db.commit()
        return {**_device_asset_payload(asset), "uploaded": True, "server_result": result.payload}
    except _DeviceChunkMergeError as error:
        raise HTTPException(status_code=422, detail={"code": error.code, "message": error.message}) from error
    except RecordingAssetConflict as error:
        target.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
        return JSONResponse(status_code=error.status_code, content={"error": {"code": error.code, "message": "录音上传状态冲突"}, "current": error.current})
    except Exception:
        target.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
        raise
    finally:
        _cleanup_device_chunk_dir(staging)


@router.put("/assets/{asset_id}/content")
async def upload_device_asset(
    asset_id: str,
    audio: UploadFile = File(...),
    expected_revision: int = Query(default=1, ge=1),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _guard_legacy_media_submit()
    key = _idempotency_key(idempotency_key, "录音上传请求标识")
    asset = await find_asset(db, user_id=context.principal_id, asset_id=_device_identifier(asset_id, "录音资产标识", 160))
    if asset is None or asset.data_epoch_id != context.epoch_id:
        raise HTTPException(status_code=404, detail={"code": "ASSET_NOT_FOUND", "message": "录音资产不存在"})
    await _device_meeting(db, context, asset.meeting_id)
    suffix = _upload_suffix(asset.mime_type)
    target = recording_asset_storage_path(
        user_id=context.principal_id,
        meeting_id=asset.meeting_id,
        asset_id=asset.id,
        suffix=suffix,
    )
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")
    total = 0
    digest = hashlib.sha256()
    try:
        with temporary.open("xb") as output:
            while True:
                chunk = await audio.read(settings.MEETING_AUDIO_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > settings.MEETING_AUDIO_MAX_BYTES:
                    raise HTTPException(status_code=413, detail={"code": "AUDIO_TOO_LARGE", "message": "录音文件过大"})
                digest.update(chunk)
                output.write(chunk)
        if total <= 0:
            raise HTTPException(status_code=422, detail={"code": "AUDIO_EMPTY", "message": "录音文件为空"})
        temporary.replace(target)
        checksum = f"sha256:{digest.hexdigest()}"
        request_hash = recording_request_hash(
            "device-content",
            f"{context.epoch_id}:{asset.id}",
            {"revision": expected_revision, "size": total, "checksum": checksum},
        )
        result = await complete_content_upload(
            db,
            user_id=context.principal_id,
            asset_id=asset.id,
            expected_revision=expected_revision,
            idempotency_key=key,
            request_hash=request_hash,
            storage_path=str(target),
            actual_byte_size=total,
            actual_checksum=checksum,
            duration_ms=asset.duration_ms,
            data_epoch_id=context.epoch_id,
        )
        await db.commit()
        return {**_device_asset_payload(asset), "uploaded": True, "server_result": result.payload}
    except RecordingAssetConflict as error:
        target.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
        return JSONResponse(status_code=error.status_code, content={"error": {"code": error.code, "message": "录音上传状态冲突"}, "current": error.current})
    except Exception:
        target.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
        raise


@router.post("/assets/{asset_id}/transcription", status_code=202)
async def create_device_transcription(
    asset_id: str,
    payload: DeviceTranscriptionRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    _guard_legacy_media_submit()
    key = _idempotency_key(idempotency_key, "转写请求标识")
    normalized_asset_id = _device_identifier(asset_id, "录音资产标识", 160)
    asset = await find_asset(db, user_id=context.principal_id, asset_id=normalized_asset_id)
    if asset is None or asset.data_epoch_id != context.epoch_id:
        raise HTTPException(status_code=404, detail={"code": "ASSET_NOT_FOUND", "message": "录音资产不存在"})
    await _device_meeting(db, context, asset.meeting_id)
    try:
        result = await create_transcription_job(
            db,
            user_id=context.principal_id,
            asset_id=asset.id,
            client_request_id=_device_identifier(payload.client_request_id, "本机转写请求标识"),
            idempotency_key=key,
            language=payload.language,
            data_epoch_id=context.epoch_id,
        )
    except LookupError as error:
        raise HTTPException(status_code=409, detail={"code": "ASSET_NOT_UPLOADED", "message": "录音尚未上传完成"}) from error
    except RecordingAssetConflict as error:
        return JSONResponse(status_code=error.status_code, content={"error": {"code": error.code, "message": "转写请求冲突"}, "current": error.current})
    job = await db.get(MeetingRecordingTranscriptionJobV2, result.payload["job_id"])
    if job is None:
        raise HTTPException(status_code=500, detail={"code": "TASK_CREATE_FAILED", "message": "转写任务创建失败"})
    job.data_epoch_id = context.epoch_id
    await db.flush()
    await db.commit()
    if job.status == "queued":
        submit_transcription_job(job.id)
    return _device_job_payload(job)


@router.get("/tasks/{task_id}")
async def get_device_task(
    task_id: str,
    wait_ms: int = Query(default=0, ge=0, le=5_000),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    normalized = _device_identifier(task_id, "任务标识", 160)
    job = await find_job(db, user_id=context.principal_id, job_id=normalized, data_epoch_id=context.epoch_id)
    if job is not None:
        deadline = asyncio.get_running_loop().time() + wait_ms / 1000
        while job.status in {"queued", "running"} and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.15)
            await db.refresh(job)
        return _device_job_payload(job)
    status_payload = await wait_for_submitted_summary_status(
        normalized,
        timeout_seconds=wait_ms / 1000,
        expected_scope=f"device:{context.principal_id}:{context.epoch_id}",
    )
    if status_payload is None:
        raise HTTPException(status_code=404, detail={"code": "TASK_NOT_FOUND", "message": "任务不存在"})
    return {"schema_version": 1, **status_payload}


@router.get("/meetings/{binding_id}/transcript")
async def get_device_transcript(
    binding_id: str,
    limit: int = Query(default=5000, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    meeting = await _device_meeting(db, context, binding_id)
    rows = list(
        (
            await db.execute(
                select(TranscriptLine)
                .where(TranscriptLine.meeting_id == meeting.id)
                .order_by(TranscriptLine.start_time, TranscriptLine.id)
                .offset(offset)
                .limit(limit)
            )
        ).scalars().all()
    )
    total = int((await db.execute(select(func.count(TranscriptLine.id)).where(TranscriptLine.meeting_id == meeting.id))).scalar_one() or 0)
    latest_job = (
        await db.execute(
            select(MeetingRecordingTranscriptionJobV2)
            .where(
                MeetingRecordingTranscriptionJobV2.meeting_id == meeting.id,
                MeetingRecordingTranscriptionJobV2.user_id == context.principal_id,
                MeetingRecordingTranscriptionJobV2.data_epoch_id == context.epoch_id,
            )
            .order_by(
                MeetingRecordingTranscriptionJobV2.created_at.desc(),
                MeetingRecordingTranscriptionJobV2.id.desc(),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    draft_rows: list[MeetingRecordingTranscriptDraftV1] = []
    draft_total = 0
    if latest_job is not None and latest_job.status in {"queued", "running", "failed"}:
        draft_total = int(
            (
                await db.execute(
                    select(func.count(MeetingRecordingTranscriptDraftV1.id)).where(
                        MeetingRecordingTranscriptDraftV1.job_id == latest_job.id,
                        MeetingRecordingTranscriptDraftV1.meeting_id == meeting.id,
                        MeetingRecordingTranscriptDraftV1.user_id == context.principal_id,
                        MeetingRecordingTranscriptDraftV1.data_epoch_id == context.epoch_id,
                    )
                )
            ).scalar_one()
            or 0
        )
        if draft_total:
            draft_rows = list(
                (
                    await db.execute(
                        select(MeetingRecordingTranscriptDraftV1)
                        .where(
                            MeetingRecordingTranscriptDraftV1.job_id == latest_job.id,
                            MeetingRecordingTranscriptDraftV1.meeting_id == meeting.id,
                            MeetingRecordingTranscriptDraftV1.user_id == context.principal_id,
                            MeetingRecordingTranscriptDraftV1.data_epoch_id == context.epoch_id,
                        )
                        .order_by(
                            MeetingRecordingTranscriptDraftV1.start_ms,
                            MeetingRecordingTranscriptDraftV1.ordinal,
                            MeetingRecordingTranscriptDraftV1.segment_id,
                        )
                        .offset(offset)
                        .limit(limit)
                    )
                ).scalars().all()
            )

    # A new transcription may run for one asset while the meeting already has
    # usable text from realtime capture or another imported file. Always expose
    # the latest job's draft and retain final rows from the other assets. The
    # old total==0 gate made every partial batch invisible until the final
    # transaction, which looked like the whole transcript arrived at once.
    use_drafts = draft_total > 0
    visible_rows = rows
    if use_drafts and latest_job is not None:
        visible_rows = [
            line
            for line in rows
            if line.recording_asset_id != latest_job.asset_id
        ]
    items = [
        {
            "id": line.id,
            "recording_asset_id": line.recording_asset_id,
            "transcription_job_id": line.transcription_job_id,
            "speaker_id": line.speaker_id,
            "speaker_label": line.speaker_label,
            "text": line.text,
            "start_ms": round(line.start_time * 1000),
            "end_ms": round(line.end_time * 1000),
            "confidence": line.confidence,
        }
        for line in visible_rows
    ]
    if use_drafts:
        items.extend([
            {
                "id": f"draft:{draft.job_id}:{draft.segment_id}",
                "recording_asset_id": draft.asset_id,
                "transcription_job_id": draft.job_id,
                "speaker_id": draft.speaker_id,
                "speaker_label": draft.speaker_label,
                "text": draft.text,
                "start_ms": draft.start_ms,
                "end_ms": draft.end_ms,
                "confidence": draft.confidence,
            }
            for draft in draft_rows
        ])
        items.sort(key=lambda item: (int(item["start_ms"]), str(item["id"])))
    complete = not use_drafts and (
        latest_job is None or latest_job.status == "completed"
    )
    if latest_job is not None and latest_job.status == "failed" and total == 0:
        status = "failed"
    elif complete:
        status = "ready" if total else "empty"
    else:
        status = "processing"
    updated_marker = (
        max((draft.updated_at for draft in draft_rows), default=None)
        if use_drafts
        else meeting.updated_at
    )
    revision_marker = (
        updated_marker.isoformat() if updated_marker is not None else "0"
    )
    return {
        "schema_version": 2,
        "meeting_id": meeting.id,
        "status": status,
        "complete": complete,
        "source_kind": "provisional" if use_drafts else "final",
        "revision_id": (
            f"device-transcript-draft:{latest_job.id}:{revision_marker}:{draft_total}"
            if use_drafts and latest_job is not None
            else f"device-transcript:{meeting.updated_at.isoformat() if meeting.updated_at else '0'}:{total}"
        ),
        "total": len(items),
        "items": items,
        "processed_duration_ms": max(
            [int(line.end_time * 1000) for line in rows]
            + [int(draft.end_ms) for draft in draft_rows]
            + [0]
        ),
        "source_duration_ms": None,
        "job": job_payload(latest_job) if latest_job is not None else None,
    }


@router.post("/meetings/{binding_id}/summary", status_code=202)
async def create_device_summary(
    binding_id: str,
    payload: DeviceSummaryRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    meeting = await _device_meeting(db, context, binding_id)
    key = _idempotency_key(idempotency_key, "整理请求标识")
    try:
        template = get_summary_template(payload.template_id, payload.template_revision)
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "SUMMARY_TEMPLATE_INVALID", "message": str(error)},
        ) from error
    lines = list(
        (
            await db.execute(
                select(TranscriptLine).where(TranscriptLine.meeting_id == meeting.id).order_by(TranscriptLine.start_time)
            )
        ).scalars().all()
    )
    if not lines:
        raise HTTPException(status_code=400, detail={"code": "TRANSCRIPT_EMPTY", "message": "会议暂无文字记录"})
    _guard_legacy_generation(
        vnext_capability_cutover.SOURCE_STREAM_CAPABILITY,
        vnext_capability_cutover.SOURCE_STREAM_CONTRACT_REVISION,
    )
    transcript = [
        {
            "id": line.id,
            "speaker": line.speaker_label,
            "speaker_id": line.speaker_id,
            "text": line.text,
            "start": line.start_time,
            "end": line.end_time,
            "confidence": line.confidence,
        }
        for line in lines
    ]
    fingerprint = hashlib.sha256(json.dumps(transcript, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    task = submit_device_final_summary(
        meeting.id,
        task_scope=f"device:{context.principal_id}:{context.epoch_id}",
        dedupe_key=f"device:{context.epoch_id}:{meeting.id}:{template['id']}:{template['revision']}:{fingerprint}:retain-{int(payload.retain_generated_result)}",
        force=payload.force,
        template_id=template["id"],
        template_revision=template["revision"],
        retain_generated_result=payload.retain_generated_result,
    )
    return {
        "schema_version": 1,
        "task_id": task.id,
        "meeting_id": meeting.id,
        "template_id": template["id"],
        "template_revision": template["revision"],
        "retain_generated_result": payload.retain_generated_result,
        "request_id": key,
        "reused": task.reused,
    }


@router.get("/meetings/{binding_id}/summary")
async def get_device_summary(
    binding_id: str,
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    meeting = await _device_meeting(db, context, binding_id)
    result = latest_device_summary_result(
        task_scope=f"device:{context.principal_id}:{context.epoch_id}",
        meeting_id=meeting.id,
    )
    if result is None:
        raise HTTPException(status_code=404, detail={"code": "SUMMARY_NOT_FOUND", "message": "整理结果尚未生成"})
    raw_summary = result.get("structured_document") if isinstance(result, dict) else None
    structured_document = (
        raw_summary
        if isinstance(raw_summary, dict)
        else None
    )
    return {
        "schema_version": 1,
        "meeting_id": meeting.id,
        "summary_id": result.get("summary_id"),
        "overview": result.get("overview") or "",
        "key_decisions": result.get("key_decisions") or [],
        "action_items": result.get("action_items") or [],
        "markdown": result.get("markdown") or result.get("full_text") or "",
        "generated_at": result.get("generated_at"),
        "template_id": structured_document.get("template_id") if structured_document else result.get("template_id"),
        "template_revision": structured_document.get("template_revision") if structured_document else result.get("template_revision"),
        "structured_document": structured_document,
    }


def _summary_v3_response(record: dict[str, Any]) -> dict[str, Any]:
    document = record.get("document") if isinstance(record.get("document"), dict) else {}
    return {
        "schema_version": 3,
        "document_id": record.get("id"),
        "meeting_id": record.get("meeting_id"),
        "facts_document": document,
        "action_candidates": document.get("action_candidates") or [],
        "source_fingerprint": record.get("source_fingerprint"),
        "transcript_revision": record.get("transcript_revision"),
        "model_revision": record.get("model_revision"),
        "prompt_revision": record.get("prompt_revision"),
        "generated_at": record.get("generated_at"),
        "coverage": record.get("coverage") or {},
    }


@router.post("/meetings/{binding_id}/summary-v3", status_code=202)
async def create_device_summary_v3(
    binding_id: str,
    payload: DeviceSummaryV3Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    meeting = await _device_meeting(db, context, binding_id)
    header_key = idempotency_key.strip() if idempotency_key else ""
    body_key = payload.idempotency_key.strip() if payload.idempotency_key else ""
    if header_key and body_key and header_key != body_key:
        raise HTTPException(
            status_code=422,
            detail={"code": "IDEMPOTENCY_KEY_MISMATCH", "message": "整理请求标识不一致"},
        )
    request_key = _idempotency_key(header_key or body_key or None, "整理请求标识")
    if not source_hash_matches(payload.manual_note.content, payload.manual_note.content_sha256):
        raise HTTPException(
            status_code=422,
            detail={"code": "MANUAL_NOTE_HASH_MISMATCH", "message": "我的笔记内容已变化，请重试"},
        )
    attachments = [item.model_dump(mode="json") for item in payload.attachments]
    for item in attachments:
        if not source_hash_matches(str(item["content"]), str(item["content_sha256"])):
            raise HTTPException(
                status_code=422,
                detail={"code": "ATTACHMENT_HASH_MISMATCH", "message": "所选附件内容已变化，请重新选择"},
            )
    source_bytes = len(payload.manual_note.content.encode("utf-8")) + sum(
        len(str(item["content"]).encode("utf-8")) for item in attachments
    )
    if source_bytes > 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail={"code": "SUMMARY_SOURCES_TOO_LARGE", "message": "所选笔记和附件内容过长"},
        )

    lines = list(
        (
            await db.execute(
                select(TranscriptLine)
                .where(TranscriptLine.meeting_id == meeting.id)
                .order_by(TranscriptLine.start_time, TranscriptLine.id)
            )
        ).scalars().all()
    )
    if not lines:
        raise HTTPException(
            status_code=400,
            detail={"code": "TRANSCRIPT_EMPTY", "message": "会议暂无文字记录"},
        )
    _guard_legacy_generation(
        vnext_capability_cutover.SOURCE_STREAM_CAPABILITY,
        vnext_capability_cutover.SOURCE_STREAM_CONTRACT_REVISION,
    )
    transcript = [
        {
            "id": line.id,
            "speaker": line.speaker_label,
            "speaker_id": line.speaker_id,
            "text": line.text,
            "start": line.start_time,
            "end": line.end_time,
            "confidence": line.confidence,
        }
        for line in lines
    ]
    manual_note = payload.manual_note.model_dump(mode="json")
    _sources, fingerprint, _transcript_revision = normalize_sources(
        transcript,
        manual_note,
        attachments,
    )
    task_scope = f"device:{context.principal_id}:{context.epoch_id}"
    active_model_revision = summary_v3_model_revision()
    existing = find_document_by_identity(
        task_scope=task_scope,
        meeting_id=meeting.id,
        source_fingerprint=fingerprint,
        model_revision=active_model_revision,
        prompt_revision=PROMPT_REVISION,
    )
    if existing is not None:
        return {
            "schema_version": 3,
            "task_id": existing["task_id"],
            "meeting_id": meeting.id,
            "request_id": request_key,
            "source_fingerprint": fingerprint,
            "prompt_revision": PROMPT_REVISION,
            "model_revision": active_model_revision,
            "reused": True,
            "already_current": True,
        }

    private_payload = {
        "schema_version": 3,
        "declared_transcript_revision": payload.transcript_revision,
        "manual_note": manual_note,
        "attachments": attachments,
    }
    try:
        payload_id = save_source_payload(
            task_scope=task_scope,
            meeting_id=meeting.id,
            payload=private_payload,
        )
    except SummaryV3StoreError as error:
        raise HTTPException(
            status_code=503,
            detail={"code": "SUMMARY_PRIVATE_PAYLOAD_UNAVAILABLE", "message": "整理服务暂时不可用"},
        ) from error
    try:
        task = submit_device_summary_v3(
            meeting.id,
            task_scope=task_scope,
            payload_id=payload_id,
            dedupe_key=f"summary-v3:{fingerprint}:{active_model_revision}:{PROMPT_REVISION}",
            expected_source_fingerprint=fingerprint,
            model_revision=active_model_revision,
            # A completed identity is immutable and was returned above. For a
            # queued/running or failed task, preserve the caller's explicit
            # retry intent at the persistent task layer without creating a
            # second document for an unchanged source fingerprint.
            force=payload.force,
        )
    except Exception:
        delete_source_payload(payload_id)
        raise
    if task.reused:
        delete_source_payload(payload_id)
    return {
        "schema_version": 3,
        "task_id": task.id,
        "meeting_id": meeting.id,
        "request_id": request_key,
        "source_fingerprint": fingerprint,
        "prompt_revision": PROMPT_REVISION,
        "model_revision": active_model_revision,
        "reused": task.reused,
        "already_current": False,
    }


@router.get("/meetings/{binding_id}/summary-v3")
async def get_device_summary_v3(
    binding_id: str,
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    meeting = await _device_meeting(db, context, binding_id)
    record = latest_summary_v3_document(
        task_scope=f"device:{context.principal_id}:{context.epoch_id}",
        meeting_id=meeting.id,
    )
    if record is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "SUMMARY_V3_NOT_FOUND", "message": "新版整理结果尚未生成"},
        )
    return _summary_v3_response(record)


@router.post("/meetings/{binding_id}/questions")
async def ask_device_question(
    binding_id: str,
    request: DeviceQuestionRequest,
    context: DeviceContext = Depends(require_device),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    meeting = await _device_meeting(db, context, binding_id)
    lines = list(
        (
            await db.execute(
                select(TranscriptLine).where(TranscriptLine.meeting_id == meeting.id).order_by(TranscriptLine.start_time)
            )
        ).scalars().all()
    )
    if not lines:
        raise HTTPException(status_code=400, detail={"code": "TRANSCRIPT_EMPTY", "message": "会议暂无文字记录"})
    _guard_legacy_generation(
        vnext_capability_cutover.QUESTION_READER_CAPABILITY,
        vnext_capability_cutover.QUESTION_READER_CONTRACT_REVISION,
    )
    client_thread_id = _device_identifier(request.client_thread_id, "问答记录标识")
    client_request_id = _device_identifier(request.client_request_id, "问答请求标识")
    manual_note: MeetingQuestionManualNoteSource | None = None
    if request.include_manual_note:
        if (
            request.manual_note is None
            or not request.manual_note.content.strip()
            or not source_hash_matches(
                request.manual_note.content,
                request.manual_note.content_sha256,
            )
        ):
            raise HTTPException(
                status_code=422,
                detail={"code": "MANUAL_NOTE_INVALID", "message": "我的笔记内容校验失败"},
            )
        manual_note = MeetingQuestionManualNoteSource(
            revision=request.manual_note.revision,
            content=request.manual_note.content,
        )
    elif request.manual_note is not None:
        raise HTTPException(
            status_code=422,
            detail={"code": "MANUAL_NOTE_NOT_SELECTED", "message": "我的笔记来源状态不一致"},
        )
    manual_note_revision = manual_note.revision if manual_note is not None else None
    transcript_revision_id = f"device-transcript:{meeting.updated_at.isoformat() if meeting.updated_at else '0'}:{len(lines)}"
    source_segments = [
        MeetingQuestionTranscriptSource(
            segment_id=line.id,
            source_segment_id=None,
            start_ms=max(0, round(line.start_time * 1000)),
            end_ms=max(0, round(line.end_time * 1000)),
            speaker=line.speaker_label,
            text=line.text,
        )
        for line in lines
    ]
    model_payload = MeetingQuestionRequest(
        schema_version=1,
        client_meeting_id=meeting.id,
        client_thread_id=client_thread_id,
        client_request_id=client_request_id,
        expected_ordinal=request.expected_ordinal,
        input_fingerprint="sha256:" + "0" * 64,
        transcript_revision_id=transcript_revision_id,
        summary_version_id=request.summary_version_id,
        manual_note_revision=manual_note_revision,
        include_manual_note=manual_note is not None,
        question=request.question.strip(),
        transcript_segments=source_segments,
        summary_sections=request.summary_sections,
        manual_note=manual_note,
        context=request.context,
    )
    payload = model_payload.model_dump(mode="json")
    payload["input_fingerprint"] = meeting_question_input_fingerprint(payload)
    model_payload = MeetingQuestionRequest(**payload)
    payload = model_payload.model_dump(mode="json")
    request_hash = meeting_question_request_hash(payload)
    allowed_source_ids = {
        str(source["segment_id"]).strip()
        for source in payload["transcript_segments"]
    }
    allowed_summary_source_ids = {
        str(source["section_id"]).strip()
        for source in payload["summary_sections"]
    }
    # A device question is transient by default.  Only the explicit quality
    # switch creates an anonymous retained candidate; the main meeting
    # question tables are account/sync compatibility tables and must not be
    # used for device-primary data.
    request_hash_key = "sha256:" + hashlib.sha256(request_hash.encode("utf-8")).hexdigest()
    if request.retain_generated_result:
        existing = device_identity.find_quality_candidate(
            context,
            kind="question",
            meeting_id=meeting.id,
            request_hash=request_hash_key,
        )
        if existing is not None and _device_question_candidate_is_current(
            existing,
            meeting_id=meeting.id,
            client_thread_id=client_thread_id,
            client_request_id=client_request_id,
            expected_ordinal=request.expected_ordinal,
            input_fingerprint=payload["input_fingerprint"],
            transcript_revision_id=transcript_revision_id,
            allowed_source_ids=allowed_source_ids,
            summary_version_id=request.summary_version_id,
            allowed_summary_source_ids=allowed_summary_source_ids,
            manual_note_revision=manual_note_revision,
        ):
            return {**existing, "reused": True}
        # A retained result can be malformed or belong to an older transcript
        # projection.  Do not replay it and do not turn it into a visible
        # failure; regenerate against the current server-side lines below.
    answer = await asyncio.to_thread(generate_meeting_question_answer, payload)
    # The generator contract is a mapping, but a provider/parser failure must
    # still become a source-free insufficient result rather than an uncaught
    # AttributeError that leaves the request ambiguous.
    if not isinstance(answer, dict):
        answer = {}
    now_ms = round(datetime.now(timezone.utc).timestamp() * 1000)

    # The device endpoint owns a server-side transcript projection.  Validate
    # every returned citation against that exact projection before it leaves
    # the service; a stale model/cache result must never be handed to the
    # mobile client for it to interpret as a current source. Device Q&A can
    # additionally use only the exact manual-note revision supplied here.
    citations: list[dict[str, str]] = []
    citation_invalid = False
    seen_citations: set[tuple[str, str]] = set()
    for item in (answer.get("citations") or []):
        if not isinstance(item, dict):
            citation_invalid = True
            continue
        kind = str(item.get("kind") or "").strip()
        source_id = str(item.get("source_id") or "").strip()
        identity = (kind, source_id)
        allowed = (
            kind == "transcript" and source_id in allowed_source_ids
        ) or (
            kind == "summary" and source_id in allowed_summary_source_ids
        ) or (
            kind == "manual_note"
            and manual_note_revision is not None
            and source_id == f"manual-note:{manual_note_revision}"
        )
        if not allowed or identity in seen_citations:
            citation_invalid = True
            continue
        seen_citations.add(identity)
        citations.append({"kind": kind, "source_id": source_id})

    answer_scope = str(answer.get("answer_scope") or "meeting")
    answer_kind = str(answer.get("answer_kind") or "insufficient")
    if answer_scope not in {"meeting", "general"} or answer_kind not in {"answer", "insufficient"}:
        answer_scope = "meeting"
        answer_kind = "insufficient"
        answer = {
            **answer,
            "answer_scope": answer_scope,
            "answer_kind": answer_kind,
            "answer": "当前会议记录中没有足够信息",
        }
    if answer_scope == "general":
        # General answers are deliberately source-free.
        citations = []
    elif answer_kind == "insufficient":
        citations = []
    elif citation_invalid or not citations:
        # Fail closed instead of returning an answer whose visible claims no
        # longer have a source in this meeting's transcript.
        answer_scope = "meeting"
        answer_kind = "insufficient"
        answer = {
            **answer,
            "answer_scope": answer_scope,
            "answer_kind": answer_kind,
            "answer": "当前会议记录中没有足够信息",
        }
    result = {
        "schema_version": 1,
        "client_meeting_id": meeting.id,
        "client_thread_id": client_thread_id,
        "client_request_id": client_request_id,
        "remote_thread_id": f"device-thread:{context.epoch_id}:{client_thread_id}",
        "remote_turn_id": f"device-turn:{request_hash_key[7:23]}",
        "ordinal": request.expected_ordinal,
        "input_fingerprint": payload["input_fingerprint"],
        "transcript_revision_id": transcript_revision_id,
        "summary_version_id": request.summary_version_id,
        "manual_note_revision": manual_note_revision,
        "answer_scope": answer_scope,
        "answer_kind": answer_kind,
        "answer": str(answer.get("answer") or "当前会议记录中没有足够信息"),
        "citations": citations,
        "created_at_ms": now_ms,
        "completed_at_ms": now_ms,
        "transient": not request.retain_generated_result,
        "reused": False,
    }
    if request.retain_generated_result:
        device_identity.store_quality_candidate(
            context,
            kind="question",
            meeting_id=meeting.id,
            request_hash=request_hash_key,
            payload=result,
            ttl_seconds=30 * 24 * 60 * 60,
        )
    return result


@router.get("/speakers")
async def list_device_speakers(
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    from app.services.speaker_db_service import get_speaker_db

    profiles = get_speaker_db().load_for_owner_epoch(context.principal_id, context.epoch_id)
    return {
        "schema_version": 1,
        "items": [
            {
                "speaker_id": item.get("speaker_id"),
                "name": f"讲话人 {str(item.get('speaker_id') or '')[-4:] or '未命名'}",
                "quality": item.get("quality"),
                "sample_count": item.get("sample_count"),
                "profile_revision": item.get("profile_revision"),
                "model_version": item.get("model_version"),
                "consent_version": item.get("consent_version"),
            }
            for item in profiles
        ],
    }


def _device_speaker_payload(profile: dict[str, Any]) -> dict[str, Any]:
    speaker_id = str(profile.get("speaker_id") or "")
    return {
        "speaker_id": speaker_id,
        # Never project a user-provided display name through the device API.
        "name": f"讲话人 {speaker_id[-4:] or '未命名'}",
        "quality": profile.get("quality"),
        "sample_count": profile.get("sample_count"),
        "profile_revision": profile.get("profile_revision"),
        "model_version": profile.get("model_version"),
        "consent_state": profile.get("consent_state"),
        "consent_version": profile.get("consent_version"),
        "available_in_realtime": bool(profile.get("is_active", True))
        and str(profile.get("consent_state") or "granted") == "granted",
    }


async def _read_device_speaker_audio(audio: UploadFile) -> tuple[Any, Any, float, str, str, list, list]:
    """Use the existing CAM++ quality/extraction path without account auth."""
    from app.api.app_speakers import _read_audio, _voiceprint_features

    samples = await _read_audio(audio)
    embedding, quality, level, description, issues, suggestions = await _voiceprint_features(samples)
    return samples, embedding, quality, level, description, issues, suggestions


@router.post("/speakers/audio", status_code=201)
async def register_device_speaker_audio(
    name: str | None = Form(default=None),
    audio: UploadFile = File(...),
    capture_profile: str = Form("android-voice-communication-v1"),
    voiceprint_consent_accepted: bool = Form(False),
    voiceprint_consent_version: str = Form(""),
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    if not voiceprint_consent_accepted or voiceprint_consent_version.strip() != "voiceprint-v1":
        raise HTTPException(status_code=428, detail={
            "code": "VOICEPRINT_CONSENT_REQUIRED",
            "message": "需要明确同意声纹用途后才能上传录音",
        })
    del name
    if capture_profile not in {"legacy", "android-voice-communication-v1"}:
        raise HTTPException(status_code=422, detail={"code": "CAPTURE_PROFILE_INVALID", "message": "录音采集版本不受支持"})
    samples, embedding, quality, level, description, issues, suggestions = await _read_device_speaker_audio(audio)
    from app.services.speaker_db_service import get_speaker_db

    speaker_id = f"device-{context.epoch_id[:8]}-{uuid.uuid4().hex[:16]}"
    db = get_speaker_db()
    saved = db.save_speaker(
        speaker_id=speaker_id,
        embedding=embedding,
        embedding_mean=embedding,
        name=f"device-{speaker_id[-8:]}",
        quality=quality,
        sample_count=1,
        overwrite=False,
        owner_user_id=context.principal_id,
        capture_profile=capture_profile,
        consent_version="voiceprint-v1",
    )
    if not saved or not db.set_profile_epoch(context.principal_id, speaker_id, context.epoch_id):
        raise HTTPException(status_code=409, detail={"code": "SPEAKER_CONFLICT", "message": "讲话人标识冲突，请重试"})
    profile = db.load_speaker_for_owner_epoch(context.principal_id, context.epoch_id, speaker_id) or {
        "speaker_id": speaker_id,
        "name": f"device-{speaker_id[-8:]}",
        "quality": quality,
        "sample_count": 1,
        "profile_revision": 1,
        "model_version": "campplus-v1",
        "consent_state": "granted",
        "consent_version": "voiceprint-v1",
        "is_active": True,
    }
    return {
        "schema_version": 1,
        "success": True,
        "speaker": _device_speaker_payload(profile),
        "quality_level": level,
        "quality_description": description,
        "quality_issues": issues,
        "suggestions": suggestions,
        "duration_sec": round(len(samples) / 16000.0, 2),
    }


@router.post("/speakers/{speaker_id}/samples", status_code=200)
async def supplement_device_speaker_audio(
    speaker_id: str,
    audio: UploadFile = File(...),
    capture_profile: str = Form("android-voice-communication-v1"),
    voiceprint_consent_accepted: bool = Form(False),
    voiceprint_consent_version: str = Form(""),
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    if not voiceprint_consent_accepted or voiceprint_consent_version.strip() != "voiceprint-v1":
        raise HTTPException(status_code=428, detail={
            "code": "VOICEPRINT_CONSENT_REQUIRED",
            "message": "需要明确同意声纹用途后才能上传录音",
        })
    from app.services.speaker_db_service import get_speaker_db
    from app.api.app_speakers import _embedding_cosine

    db = get_speaker_db()
    existing = db.load_speaker_for_owner_epoch(context.principal_id, context.epoch_id, speaker_id)
    if existing is None:
        raise HTTPException(status_code=404, detail={"code": "SPEAKER_NOT_FOUND", "message": "讲话人不存在"})
    if capture_profile not in {"legacy", "android-voice-communication-v1"}:
        raise HTTPException(status_code=422, detail={"code": "CAPTURE_PROFILE_INVALID", "message": "录音采集版本不受支持"})
    samples, embedding, quality, level, description, issues, suggestions = await _read_device_speaker_audio(audio)
    existing_embedding = existing.get("embedding")
    if existing_embedding is not None and _embedding_cosine(existing_embedding, embedding) < 0.45:
        raise HTTPException(status_code=422, detail={"code": "SPEAKER_MISMATCH", "message": "这段录音与已有讲话人音色差异较大，请确认由同一人录制"})
    if not db.supplement_audio_for_owner(context.principal_id, speaker_id, embedding, quality=quality):
        raise HTTPException(status_code=409, detail={"code": "SPEAKER_CONFLICT", "message": "讲话人资料已变化，请刷新后重试"})
    profile = db.load_speaker_for_owner_epoch(context.principal_id, context.epoch_id, speaker_id) or existing
    return {
        "schema_version": 1,
        "success": True,
        "speaker": _device_speaker_payload(profile),
        "quality_level": level,
        "quality_description": description,
        "quality_issues": issues,
        "suggestions": suggestions,
        "duration_sec": round(len(samples) / 16000.0, 2),
    }


@router.patch("/speakers/{speaker_id}")
async def rename_device_speaker(
    speaker_id: str,
    payload: DeviceSpeakerNameRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    from app.services.speaker_db_service import get_speaker_db

    # Display-name edits are intentionally local-only.  Retain the endpoint
    # as a compatibility no-op so an older client cannot mutate server-side
    # user data; the response contains an anonymous label.
    del payload
    db = get_speaker_db()
    if db.load_speaker_for_owner_epoch(context.principal_id, context.epoch_id, speaker_id) is None:
        raise HTTPException(status_code=404, detail={"code": "SPEAKER_NOT_FOUND", "message": "讲话人不存在"})
    profile = db.load_speaker_for_owner_epoch(context.principal_id, context.epoch_id, speaker_id)
    return {"schema_version": 1, "success": True, "speaker": _device_speaker_payload(profile or {"speaker_id": speaker_id})}


@router.post("/speakers", status_code=201)
async def register_device_speaker(
    payload: DeviceSpeakerRegisterRequest,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    if payload.consent_version != "voiceprint-v1":
        raise HTTPException(status_code=428, detail={"code": "VOICEPRINT_CONSENT_REQUIRED", "message": "需要明确同意声纹用途"})
    import numpy as np

    values = np.asarray(payload.embedding, dtype=np.float32)
    if values.size < 8 or not np.isfinite(values).all() or float(np.linalg.norm(values)) < 1e-7:
        raise HTTPException(status_code=422, detail={"code": "VOICEPRINT_INVALID", "message": "声纹数据无效"})
    from app.services.speaker_db_service import get_speaker_db

    speaker_id = payload.speaker_id or f"device-{context.epoch_id[:8]}-{uuid.uuid4().hex[:16]}"
    if not speaker_id.startswith(f"device-{context.epoch_id[:8]}-"):
        raise HTTPException(status_code=422, detail={"code": "SPEAKER_INVALID", "message": "讲话人标识无效"})
    db = get_speaker_db()
    saved = db.save_speaker(
        speaker_id=speaker_id,
        embedding=values,
        embedding_mean=values,
        name=f"device-{speaker_id[-8:]}",
        owner_user_id=context.principal_id,
        consent_version=payload.consent_version,
    )
    if not saved or not db.set_profile_epoch(context.principal_id, speaker_id, context.epoch_id):
        raise HTTPException(status_code=409, detail={"code": "SPEAKER_CONFLICT", "message": "讲话人资料已存在"})
    return {
        "schema_version": 1,
        "speaker_id": speaker_id,
        "name": f"讲话人 {speaker_id[-4:] or '未命名'}",
        "data_epoch_id": context.epoch_id,
    }


@router.delete("/speakers/{speaker_id}")
async def delete_device_speaker(
    speaker_id: str,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    from app.services.speaker_db_service import get_speaker_db

    db = get_speaker_db()
    if db.load_speaker_for_owner_epoch(context.principal_id, context.epoch_id, speaker_id) is None:
        raise HTTPException(status_code=404, detail={"code": "SPEAKER_NOT_FOUND", "message": "讲话人不存在"})
    if not db.deactivate_speaker_for_owner(context.principal_id, speaker_id):
        raise HTTPException(status_code=404, detail={"code": "SPEAKER_NOT_FOUND", "message": "讲话人不存在"})
    return {"schema_version": 1, "speaker_id": speaker_id, "deleted": True}


def _transient_key_stream(length: int, nonce: bytes) -> bytes:
    secret = settings.SECRET_KEY.encode("utf-8")
    chunks: list[bytes] = []
    counter = 0
    while sum(len(item) for item in chunks) < length:
        chunks.append(hashlib.sha256(secret + nonce + counter.to_bytes(8, "big")).digest())
        counter += 1
    return b"".join(chunks)[:length]


def _seal_transient(payload: bytes) -> bytes:
    nonce = os.urandom(16)
    stream = _transient_key_stream(len(payload), nonce)
    cipher = bytes(left ^ right for left, right in zip(payload, stream))
    mac = hashlib.sha256(settings.SECRET_KEY.encode("utf-8") + nonce + cipher).digest()
    return nonce + mac + cipher


def _open_transient(payload: bytes) -> bytes:
    if len(payload) < 48:
        raise ValueError("transient_payload_invalid")
    nonce, mac, cipher = payload[:16], payload[16:48], payload[48:]
    expected = hashlib.sha256(settings.SECRET_KEY.encode("utf-8") + nonce + cipher).digest()
    if not __import__("hmac").compare_digest(mac, expected):
        raise ValueError("transient_payload_invalid")
    stream = _transient_key_stream(len(cipher), nonce)
    return bytes(left ^ right for left, right in zip(cipher, stream))


@router.post("/transient-inputs", status_code=201)
async def create_device_transient_input(
    purpose: str = Query(min_length=1, max_length=80),
    ttl_seconds: int = Query(default=900, ge=30, le=86_400),
    payload: str = "",
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    text = payload.encode("utf-8")
    if len(text) > 16 * 1024 * 1024:
        raise HTTPException(status_code=413, detail={"code": "TRANSIENT_TOO_LARGE", "message": "临时输入过大"})
    identifier = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    expires = now.timestamp() + ttl_seconds
    connection = device_identity.control_connection()
    try:
        connection.execute(
            "INSERT INTO device_transient_inputs "
            "(id, principal_id, epoch_id, purpose, payload_ciphertext, expires_at, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (identifier, context.principal_id, context.epoch_id, purpose.strip(), _seal_transient(text), datetime.fromtimestamp(expires, timezone.utc).isoformat(), now.isoformat()),
        )
        connection.commit()
    finally:
        connection.close()
    return {"schema_version": 1, "input_id": identifier, "expires_at": datetime.fromtimestamp(expires, timezone.utc).isoformat()}


@router.get("/transient-inputs/{input_id}")
async def get_device_transient_input(
    input_id: str,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    connection = device_identity.control_connection()
    try:
        row = connection.execute(
            "SELECT purpose, payload_ciphertext, expires_at FROM device_transient_inputs "
            "WHERE id = ? AND principal_id = ? AND epoch_id = ? AND consumed_at IS NULL",
            (_device_identifier(input_id, "临时输入标识", 80), context.principal_id, context.epoch_id),
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "TRANSIENT_NOT_FOUND", "message": "临时输入不存在或已过期"})
    if row["expires_at"] < device_identity.utc_now():
        raise HTTPException(status_code=410, detail={"code": "TRANSIENT_EXPIRED", "message": "临时输入已过期"})
    try:
        raw = _open_transient(bytes(row["payload_ciphertext"]))
    except ValueError as error:
        raise HTTPException(status_code=500, detail={"code": "TRANSIENT_INVALID", "message": "临时输入已损坏"}) from error
    return {"schema_version": 1, "input_id": input_id, "purpose": row["purpose"], "payload": raw.decode("utf-8"), "expires_at": row["expires_at"]}


@router.delete("/transient-inputs/{input_id}")
async def delete_device_transient_input(
    input_id: str,
    context: DeviceContext = Depends(require_device),
) -> dict[str, Any]:
    connection = device_identity.control_connection()
    try:
        cursor = connection.execute(
            "DELETE FROM device_transient_inputs WHERE id = ? AND principal_id = ? AND epoch_id = ?",
            (_device_identifier(input_id, "临时输入标识", 80), context.principal_id, context.epoch_id),
        )
        connection.commit()
        deleted = cursor.rowcount > 0
    finally:
        connection.close()
    return {"schema_version": 1, "input_id": input_id, "deleted": deleted}
