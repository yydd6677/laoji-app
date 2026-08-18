from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
import re

from anyio import open_file, to_thread
from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.app_meetings import _probe_duration_sec
from app.config import settings
from app.database import get_db
from app.laoji.auth_router import get_current_user
from app.services.account_deletion_service import is_user_meeting_tombstoned
from app.services.meeting_recording_asset_service import (
    RecordingAssetConflict,
    asset_payload,
    complete_content_upload,
    create_media_clip_job,
    create_transcription_job,
    delete_media_clip_files,
    delete_media_clip_job,
    find_asset,
    find_media_clip_job,
    find_job,
    job_payload,
    list_assets,
    media_clip_job_payload,
    normalize_checksum,
    prepare_content_upload,
    queue_job_retry,
    queue_media_clip_retry,
    recover_stale_media_clip_job,
    recording_asset_storage_path,
    recording_request_hash,
    register_asset,
    submit_transcription_job,
    submit_media_clip_job,
)
from app.services.storage_admission import ensure_audio_upload_allowed


router = APIRouter()

_IDENTIFIER_RE = re.compile(r"^[^\x00-\x1f\x7f]+$")
_CHECKSUM_RE = re.compile(r"^(?:sha256:)?[0-9a-fA-F]{64}$")
_ALLOWED_MEDIA_EXTENSIONS = {
    ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".webm", ".flac",
    ".mp4", ".mov", ".mkv",
}


class RecordingAssetV2Register(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(ge=2, le=2)
    client_asset_id: str = Field(min_length=1, max_length=512)
    role: str = Field(pattern=r"^(primary|secondary)$")
    origin: str = Field(pattern=r"^(captured|imported|recovered)$")
    mime_type: str = Field(min_length=1, max_length=160)
    file_name: str = Field(min_length=1, max_length=255)
    byte_size: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991)
    duration_ms: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991)
    checksum_sha256: str | None = Field(default=None, pattern=_CHECKSUM_RE.pattern)


class RecordingAssetTranscriptionV2Create(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(ge=2, le=2)
    client_request_id: str = Field(min_length=8, max_length=512)
    language: str = Field(default="zh", pattern=r"^(zh|en|auto)$")


class RecordingAssetMediaClipV1Create(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(ge=1, le=1)
    client_clip_id: str = Field(min_length=1, max_length=512)
    start_ms: int = Field(ge=0, le=9_007_199_254_740_991)
    end_ms: int = Field(ge=1, le=9_007_199_254_740_991)


def _identifier(value: str | None, label: str, maximum: int = 512) -> str:
    normalized = (value or "").strip()
    if (
        not normalized
        or len(normalized) > maximum
        or not _IDENTIFIER_RE.fullmatch(normalized)
    ):
        raise HTTPException(status_code=422, detail=f"{label}无效")
    return normalized


def _revision(value: str | None) -> int:
    if value is None:
        raise HTTPException(status_code=428, detail="缺少录音资产版本条件")
    normalized = value.strip()
    if normalized.startswith("W/"):
        normalized = normalized[2:].strip()
    if len(normalized) >= 2 and normalized[0] == normalized[-1] == '"':
        normalized = normalized[1:-1]
    if not normalized.isdigit():
        raise HTTPException(status_code=400, detail="录音资产版本条件无效")
    revision = int(normalized)
    if revision < 1 or revision > 9_007_199_254_740_991:
        raise HTTPException(status_code=400, detail="录音资产版本条件无效")
    return revision


def _conflict_response(error: RecordingAssetConflict) -> JSONResponse:
    messages = {
        "idempotency_key_reused": "同一请求标识已用于其他录音资产操作",
        "asset_identity_mismatch": "录音资产身份与已登记内容不一致",
        "primary_asset_exists": "此会议已经有主录音",
        "revision_conflict": "录音资产云端版本已变化",
        "asset_content_immutable": "录音资产内容已经上传，不能直接覆盖",
        "asset_size_mismatch": "录音文件大小与登记信息不一致",
        "asset_checksum_mismatch": "录音文件校验失败，请重新选择文件",
        "transcription_request_reused": "同一请求标识已用于其他转写任务",
        "transcription_already_running": "此录音正在转写，请稍后再试",
        "job_not_retryable": "当前转写任务不能重试",
        "media_clip_identity_mismatch": "片段身份与已创建任务不一致",
        "media_clip_not_retryable": "当前片段任务不能重试",
    }
    revision = error.current.get("revision") if isinstance(error.current, dict) else None
    headers = {"ETag": f'"{revision}"'} if isinstance(revision, int) else None
    return JSONResponse(
        status_code=error.status_code,
        headers=headers,
        content={
            "error": {
                "code": error.code,
                "message": messages.get(error.code, "录音资产状态已变化，请刷新后重试"),
            },
            "current": error.current,
        },
    )


@router.post("/v2/meeting-notes/{meeting_id}/recording-assets")
async def post_recording_asset_v2(
    meeting_id: str,
    data: RecordingAssetV2Register,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能登记录音资产")
    meeting_id = _identifier(meeting_id, "会议标识", 160)
    idempotency_key = _identifier(idempotency_key, "录音资产请求标识")
    mutation = data.model_dump()
    mutation["client_asset_id"] = _identifier(data.client_asset_id, "本机录音资产标识")
    mutation["mime_type"] = _identifier(data.mime_type, "录音格式", 160).lower()
    mutation["file_name"] = _safe_file_name(data.file_name)
    try:
        mutation["checksum_sha256"] = normalize_checksum(data.checksum_sha256)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    request_hash = recording_request_hash("register", meeting_id, mutation)
    try:
        result = await register_asset(
            db,
            user_id=user_id,
            meeting_id=meeting_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            mutation=mutation,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问") from error
    except RecordingAssetConflict as error:
        return _conflict_response(error)
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )


@router.get("/v2/meeting-notes/{meeting_id}/recording-assets")
async def get_recording_assets_v2(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    meeting_id = _identifier(meeting_id, "会议标识", 160)
    try:
        assets = await list_assets(
            db,
            user_id=int(current_user["id"]),
            meeting_id=meeting_id,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="会议不存在或无权访问") from error
    return {
        "schema_version": 2,
        "meeting_id": meeting_id,
        "items": [asset_payload(asset) for asset in assets],
    }


@router.put("/v2/recording-assets/{asset_id}/content")
async def put_recording_asset_content_v2(
    asset_id: str,
    file: UploadFile = File(...),
    if_match: str | None = Header(default=None, alias="If-Match"),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能上传录音资产")
    asset_id = _identifier(asset_id, "录音资产标识", 160)
    expected_revision = _revision(if_match)
    idempotency_key = _identifier(idempotency_key, "录音资产请求标识")
    request_hash = recording_request_hash("content", asset_id, {})
    try:
        asset, replay = await prepare_content_upload(
            db,
            user_id=user_id,
            asset_id=asset_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
        )
    except LookupError as error:
        await file.close()
        raise HTTPException(status_code=404, detail="录音资产不存在或无权访问") from error
    except RecordingAssetConflict as error:
        await file.close()
        return _conflict_response(error)
    if replay is not None:
        await file.close()
        return JSONResponse(
            status_code=replay.status_code,
            headers={
                "ETag": f'"{replay.payload["revision"]}"',
                "X-Idempotent-Replay": "true",
            },
            content=replay.payload,
        )
    suffix = Path(asset.file_name).suffix.lower()
    if suffix not in _ALLOWED_MEDIA_EXTENSIONS:
        await file.close()
        raise HTTPException(status_code=415, detail="不支持的会议媒体格式")
    target = recording_asset_storage_path(
        user_id=user_id,
        meeting_id=asset.meeting_id,
        asset_id=asset.id,
        suffix=suffix,
    )
    # Check the mount that will actually receive this asset. This matters when
    # audio storage is split across volumes and keeps the admission decision
    # aligned with the canonical target rather than the process cwd.
    ensure_audio_upload_allowed(target.parent)
    operation_suffix = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:16]
    temporary = target.with_name(f".{target.name}.{operation_suffix}.part")
    total_bytes = 0
    digest = hashlib.sha256()
    try:
        async with await open_file(temporary, "xb") as output:
            while chunk := await file.read(settings.MEETING_AUDIO_CHUNK_BYTES):
                total_bytes += len(chunk)
                if total_bytes > settings.MEETING_AUDIO_MAX_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"录音文件不能超过 {settings.MEETING_AUDIO_MAX_BYTES // 1024 // 1024} MB",
                    )
                digest.update(chunk)
                await output.write(chunk)
            await output.flush()
        await file.close()
        if total_bytes == 0:
            raise HTTPException(status_code=400, detail="录音文件为空")
        actual_checksum = f"sha256:{digest.hexdigest()}"
        if asset.byte_size is not None and asset.byte_size != total_bytes:
            raise RecordingAssetConflict("asset_size_mismatch", asset_payload(asset))
        if asset.checksum_sha256 is not None and asset.checksum_sha256 != actual_checksum:
            raise RecordingAssetConflict("asset_checksum_mismatch", asset_payload(asset))
        await to_thread.run_sync(os.replace, temporary, target)
        duration_sec = await to_thread.run_sync(_probe_duration_sec, target)
        duration_ms = round(duration_sec * 1000) if duration_sec is not None else asset.duration_ms
        result = await complete_content_upload(
            db,
            user_id=user_id,
            asset_id=asset_id,
            expected_revision=expected_revision,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            storage_path=str(target),
            actual_byte_size=total_bytes,
            actual_checksum=actual_checksum,
            duration_ms=duration_ms,
        )
    except RecordingAssetConflict as error:
        temporary.unlink(missing_ok=True)
        if target.exists() and asset.upload_state != "uploaded":
            target.unlink(missing_ok=True)
        return _conflict_response(error)
    except BaseException:
        temporary.unlink(missing_ok=True)
        if target.exists() and asset.upload_state != "uploaded":
            target.unlink(missing_ok=True)
        raise
    return JSONResponse(
        status_code=result.status_code,
        headers={"ETag": f'"{result.payload["revision"]}"'},
        content=result.payload,
    )


@router.get("/v2/recording-assets/{asset_id}/content")
async def get_recording_asset_content_v2(
    asset_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    asset_id = _identifier(asset_id, "录音资产标识", 160)
    asset = await find_asset(db, user_id=int(current_user["id"]), asset_id=asset_id)
    if (
        asset is None
        or asset.upload_state != "uploaded"
        or not asset.storage_path
        or not Path(asset.storage_path).is_file()
    ):
        raise HTTPException(status_code=404, detail="录音文件不存在或无权访问")
    return FileResponse(
        asset.storage_path,
        media_type=asset.mime_type,
        filename=asset.file_name,
    )


@router.post("/v2/recording-assets/{asset_id}/media-clips")
async def post_recording_asset_media_clip_v1(
    asset_id: str,
    data: RecordingAssetMediaClipV1Create,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能创建音频片段")
    asset_id = _identifier(asset_id, "录音资产标识", 160)
    idempotency_key = _identifier(idempotency_key, "片段请求标识")
    client_clip_id = _identifier(data.client_clip_id, "本机片段标识")
    try:
        result = await create_media_clip_job(
            db,
            user_id=user_id,
            asset_id=asset_id,
            client_clip_id=client_clip_id,
            idempotency_key=idempotency_key,
            start_ms=data.start_ms,
            end_ms=data.end_ms,
        )
    except LookupError as error:
        raise HTTPException(status_code=409, detail="录音尚未上传完成，不能生成片段") from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RecordingAssetConflict as error:
        return _conflict_response(error)
    await db.commit()
    if result.payload.get("status") == "queued":
        submit_media_clip_job(result.payload["job_id"])
    return JSONResponse(status_code=result.status_code, content=result.payload)


@router.get("/v2/media-clip-jobs/{job_id}")
async def get_media_clip_job_v1(
    job_id: str,
    wait_ms: int = Query(default=0, ge=0, le=5_000),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job_id = _identifier(job_id, "片段任务标识", 160)
    user_id = int(current_user["id"])
    deadline = asyncio.get_running_loop().time() + wait_ms / 1000.0
    submitted = False
    while True:
        job, should_submit = await recover_stale_media_clip_job(
            db,
            user_id=user_id,
            job_id=job_id,
        )
        if job is None:
            raise HTTPException(status_code=404, detail="片段任务不存在或无权访问")
        if should_submit and not submitted:
            await db.commit()
            submit_media_clip_job(job.id)
            submitted = True
        if job.status not in ("queued", "running") or asyncio.get_running_loop().time() >= deadline:
            return media_clip_job_payload(job)
        await asyncio.sleep(min(0.25, max(0.01, deadline - asyncio.get_running_loop().time())))
        db.expire_all()


@router.post("/v2/media-clip-jobs/{job_id}/retry")
async def retry_media_clip_job_v1(
    job_id: str,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job_id = _identifier(job_id, "片段任务标识", 160)
    _identifier(idempotency_key, "片段重试标识")
    try:
        result = await queue_media_clip_retry(
            db,
            user_id=int(current_user["id"]),
            job_id=job_id,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="片段任务不存在或无权访问") from error
    except RecordingAssetConflict as error:
        return _conflict_response(error)
    await db.commit()
    if result.payload.get("status") == "queued":
        submit_media_clip_job(job_id)
    return JSONResponse(status_code=result.status_code, content=result.payload)


@router.get("/v2/media-clip-jobs/{job_id}/content")
async def get_media_clip_content_v1(
    job_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job_id = _identifier(job_id, "片段任务标识", 160)
    job = await find_media_clip_job(
        db,
        user_id=int(current_user["id"]),
        job_id=job_id,
    )
    if (
        job is None
        or job.status != "completed"
        or job.mime_type != "audio/wav"
        or not job.output_path
        or not Path(job.output_path).is_file()
    ):
        raise HTTPException(status_code=404, detail="音频片段尚未生成或无权访问")
    return FileResponse(job.output_path, media_type=job.mime_type, filename=job.file_name)


@router.delete("/v2/media-clip-jobs/{job_id}")
async def delete_media_clip_job_v1(
    job_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job_id = _identifier(job_id, "片段任务标识", 160)
    paths = await delete_media_clip_job(
        db,
        user_id=int(current_user["id"]),
        job_id=job_id,
    )
    await db.commit()
    await to_thread.run_sync(delete_media_clip_files, paths)
    return Response(status_code=204)


@router.post("/v2/recording-assets/{asset_id}/transcriptions")
async def post_recording_asset_transcription_v2(
    asset_id: str,
    data: RecordingAssetTranscriptionV2Create,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，不能创建转写任务")
    asset_id = _identifier(asset_id, "录音资产标识", 160)
    idempotency_key = _identifier(idempotency_key, "转写请求标识")
    client_request_id = _identifier(data.client_request_id, "本机转写请求标识")
    try:
        result = await create_transcription_job(
            db,
            user_id=user_id,
            asset_id=asset_id,
            client_request_id=client_request_id,
            idempotency_key=idempotency_key,
            language=data.language,
        )
    except LookupError as error:
        raise HTTPException(status_code=409, detail="录音尚未上传完成，不能开始转写") from error
    except RecordingAssetConflict as error:
        return _conflict_response(error)
    await db.commit()
    if result.status_code == 202:
        submit_transcription_job(result.payload["job_id"])
    return JSONResponse(status_code=result.status_code, content=result.payload)


@router.get("/v2/processing-jobs/{job_id}")
async def get_recording_processing_job_v2(
    job_id: str,
    wait_ms: int = Query(default=0, ge=0, le=5_000),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job_id = _identifier(job_id, "处理任务标识", 160)
    user_id = int(current_user["id"])
    deadline = asyncio.get_running_loop().time() + wait_ms / 1000.0
    while True:
        job = await find_job(db, user_id=user_id, job_id=job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="处理任务不存在或无权访问")
        if job.status not in ("queued", "running") or asyncio.get_running_loop().time() >= deadline:
            return job_payload(job)
        await asyncio.sleep(min(0.25, max(0.01, deadline - asyncio.get_running_loop().time())))
        db.expire_all()


@router.post("/v2/processing-jobs/{job_id}/retry")
async def retry_recording_processing_job_v2(
    job_id: str,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job_id = _identifier(job_id, "处理任务标识", 160)
    _identifier(idempotency_key, "处理任务重试标识")
    try:
        result = await queue_job_retry(
            db,
            user_id=int(current_user["id"]),
            job_id=job_id,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="处理任务不存在或无权访问") from error
    except RecordingAssetConflict as error:
        return _conflict_response(error)
    await db.commit()
    if result.status_code == 202:
        submit_transcription_job(job_id)
    return JSONResponse(status_code=result.status_code, content=result.payload)


def _safe_file_name(value: str) -> str:
    raw = value.replace("\\", "/").split("/")[-1].strip()
    suffix = Path(raw).suffix.lower()
    if suffix not in _ALLOWED_MEDIA_EXTENSIONS:
        raise HTTPException(status_code=415, detail="不支持的会议媒体格式")
    stem = Path(raw).stem[:120]
    safe_stem = "".join(
        character if character.isalnum() or character in {"-", "_"} else "_"
        for character in stem
    ).strip("_") or "recording"
    return f"{safe_stem}{suffix}"
