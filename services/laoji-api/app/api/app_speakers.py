"""User-isolated voiceprint management for the LaoJi mobile App."""

from __future__ import annotations

import asyncio
import secrets
import numpy as np
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.speakers import (
    MAX_SAMPLE_DURATION,
    MIN_QUALITY_SCORE,
    MIN_SAMPLE_DURATION,
    _assess_quality,
    _parse_audio_bytes,
    _safe_profile,
)
from app.laoji.auth_router import get_current_user
from app.database import get_db
from app.services.account_deletion_service import is_user_meeting_tombstoned
from app.services.meeting_speaker_service import (
    SpeakerContractConflict,
    create_reprocess_job,
    find_latest_reprocess_job,
    find_reprocess_job,
    reprocess_job_payload,
    retry_reprocess_job,
    schedule_reprocess_job,
    speaker_reprocess_request_hash,
)
from app.services.speaker_db_service import get_speaker_db


router = APIRouter()
MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_SPEAKER_NAME_LENGTH = 30
LEGACY_CAPTURE_PROFILE = "legacy"
CURRENT_CAPTURE_PROFILE = "android-voice-communication-v1"
SUPPORTED_CAPTURE_PROFILES = {LEGACY_CAPTURE_PROFILE, CURRENT_CAPTURE_PROFILE}
MIN_SUPPLEMENT_COSINE = 0.45
VOICEPRINT_CONSENT_VERSION = "voiceprint-v1"


class SpeakerNameUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_SPEAKER_NAME_LENGTH)


def _normalize_name(name: str) -> str:
    normalized = " ".join(name.strip().split())
    if not normalized:
        raise HTTPException(status_code=400, detail="讲话人名称不能为空")
    if len(normalized) > MAX_SPEAKER_NAME_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"讲话人名称不能超过 {MAX_SPEAKER_NAME_LENGTH} 个字符",
        )
    return normalized


def _normalize_capture_profile(value: str) -> str:
    normalized = str(value or LEGACY_CAPTURE_PROFILE).strip()
    if normalized not in SUPPORTED_CAPTURE_PROFILES:
        raise HTTPException(
            status_code=400,
            detail="录音采集版本不受支持，请更新老记后重试",
        )
    return normalized


def _assert_account_writable(user_id: int) -> None:
    if is_user_meeting_tombstoned(user_id):
        raise HTTPException(status_code=409, detail="账号正在删除，暂时不能修改讲话人")


async def _read_audio(audio: UploadFile) -> np.ndarray:
    content = await audio.read(MAX_AUDIO_BYTES + 1)
    await audio.close()
    if not content:
        raise HTTPException(status_code=400, detail="录音文件为空")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="录音文件过大")
    try:
        samples = await asyncio.to_thread(
            _parse_audio_bytes,
            content,
            audio.filename or "voice.wav",
            audio.content_type or "audio/wav",
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无法读取录音文件：{exc}") from exc
    duration = len(samples) / 16000.0
    if duration < MIN_SAMPLE_DURATION:
        raise HTTPException(
            status_code=400,
            detail=f"录音时间太短，请至少录制 {MIN_SAMPLE_DURATION} 秒",
        )
    if duration > MAX_SAMPLE_DURATION:
        raise HTTPException(
            status_code=400,
            detail=f"录音时间太长，请控制在 {MAX_SAMPLE_DURATION} 秒以内",
        )
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    if rms < 0.01:
        raise HTTPException(status_code=400, detail="没有检测到清晰人声，请靠近麦克风重新录制")
    clipped_ratio = float(np.mean(np.abs(samples) >= 0.99))
    if clipped_ratio > 0.08:
        raise HTTPException(status_code=400, detail="录音音量过大并出现失真，请稍远离麦克风重录")
    return samples


async def _extract_embedding_strict(audio_data: np.ndarray) -> np.ndarray:
    from app.asr.model_manager import SpeakerEmbeddingExtractor, get_model_manager

    manager = get_model_manager()
    if not manager.is_initialized():
        await manager.initialize()
    model = manager.get_camp_model()
    if model is None:
        raise RuntimeError("声纹模型尚未就绪")
    extractor = SpeakerEmbeddingExtractor(model, device=manager.device)
    embedding = await asyncio.to_thread(extractor.extract, audio_data)
    if embedding is None or np.linalg.norm(embedding) < 1e-7:
        raise RuntimeError("没有提取到有效声纹")
    return embedding.astype(np.float32)


def _embedding_cosine(left: np.ndarray, right: np.ndarray) -> float:
    return float(
        np.dot(left, right)
        / (np.linalg.norm(left) * np.linalg.norm(right) + 1e-8)
    )


async def _voiceprint_features(audio_data: np.ndarray) -> tuple[np.ndarray, float, str, str, list, list]:
    try:
        embedding = await _extract_embedding_strict(audio_data)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="声纹服务暂时不可用，请稍后重试",
        ) from exc
    quality, level, description, issues, suggestions = _assess_quality(
        audio_data,
        embedding,
        sample_count=1,
    )
    if quality < MIN_QUALITY_SCORE:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "这段录音暂时不能建立可靠声纹",
                "quality": round(float(quality), 3),
                "quality_level": level,
                "quality_issues": issues,
                "suggestions": suggestions or ["请在安静环境中靠近麦克风重新录制"],
            },
        )
    return embedding, float(quality), level, description, issues, suggestions


def _app_profile(profile: dict) -> dict:
    safe = _safe_profile(profile)
    consent_state = str(profile.get("consent_state") or "granted")
    safe["available_in_realtime"] = bool(
        profile.get("is_active", True) and consent_state == "granted"
    )
    safe["profile_revision"] = max(1, int(profile.get("profile_revision") or 1))
    safe["consent_state"] = consent_state
    safe["consent_version"] = profile.get("consent_version")
    safe["model_version"] = str(profile.get("model_version") or "campplus-v1")
    return safe


def _assert_voiceprint_consent(accepted: bool, version: str) -> str:
    normalized = str(version or "").strip()
    if not accepted or normalized != VOICEPRINT_CONSENT_VERSION:
        raise HTTPException(status_code=428, detail="需要明确同意声纹用途后才能上传录音")
    return normalized


@router.get("")
async def list_app_speakers(current_user: dict = Depends(get_current_user)):
    user_id = int(current_user["id"])
    speakers = get_speaker_db().load_for_owner(user_id, active_only=True)
    return {
        "speakers": [_app_profile(item) for item in speakers],
        "total": len(speakers),
    }


@router.post("", status_code=201)
async def register_app_speaker(
    name: str = Form(...),
    audio: UploadFile = File(...),
    capture_profile: str = Form(LEGACY_CAPTURE_PROFILE),
    voiceprint_consent_accepted: bool = Form(False),
    voiceprint_consent_version: str = Form(""),
    current_user: dict = Depends(get_current_user),
):
    user_id = int(current_user["id"])
    _assert_account_writable(user_id)
    normalized_name = _normalize_name(name)
    normalized_capture_profile = _normalize_capture_profile(capture_profile)
    consent_version = _assert_voiceprint_consent(
        voiceprint_consent_accepted,
        voiceprint_consent_version,
    )
    audio_data = await _read_audio(audio)
    embedding, quality, level, description, issues, _suggestions = await _voiceprint_features(audio_data)
    speaker_id = f"u{user_id}_{secrets.token_hex(8)}"
    saved = get_speaker_db().save_speaker(
        speaker_id=speaker_id,
        embedding=embedding,
        embedding_mean=embedding,
        name=normalized_name,
        quality=quality,
        sample_count=1,
        overwrite=False,
        owner_user_id=user_id,
        capture_profile=normalized_capture_profile,
        consent_version=consent_version,
    )
    if not saved:
        raise HTTPException(status_code=409, detail="讲话人标识冲突，请重试")
    profile = get_speaker_db().load_speaker_for_owner(user_id, speaker_id)
    return {
        "success": True,
        "speaker": _app_profile(profile or {"speaker_id": speaker_id, "name": normalized_name}),
        "quality_level": level,
        "quality_description": description,
        "quality_issues": issues,
        "duration_sec": round(len(audio_data) / 16000.0, 2),
    }


@router.post("/{speaker_id}/samples")
async def supplement_app_speaker(
    speaker_id: str,
    audio: UploadFile = File(...),
    capture_profile: str = Form(LEGACY_CAPTURE_PROFILE),
    voiceprint_consent_accepted: bool = Form(False),
    voiceprint_consent_version: str = Form(""),
    current_user: dict = Depends(get_current_user),
):
    user_id = int(current_user["id"])
    _assert_account_writable(user_id)
    db = get_speaker_db()
    existing = db.load_speaker_for_owner(user_id, speaker_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="讲话人不存在")
    normalized_capture_profile = _normalize_capture_profile(capture_profile)
    _assert_voiceprint_consent(
        voiceprint_consent_accepted,
        voiceprint_consent_version,
    )
    audio_data = await _read_audio(audio)
    embedding, quality, level, description, issues, _suggestions = await _voiceprint_features(audio_data)
    existing_capture_profile = str(
        existing.get("capture_profile") or LEGACY_CAPTURE_PROFILE
    )
    profile_replaced = False
    if (
        existing_capture_profile == LEGACY_CAPTURE_PROFILE
        and normalized_capture_profile == CURRENT_CAPTURE_PROFILE
    ):
        if not db.replace_audio_for_owner(
            user_id,
            speaker_id,
            embedding,
            quality=quality,
            capture_profile=normalized_capture_profile,
        ):
            raise HTTPException(status_code=409, detail="讲话人已变化，请刷新后重试")
        profile_replaced = True
    elif existing_capture_profile != normalized_capture_profile:
        raise HTTPException(status_code=409, detail="讲话人采集版本不一致，请更新后重新录制")
    else:
        existing_embedding = existing.get("embedding")
        if existing_embedding is not None:
            similarity = _embedding_cosine(existing_embedding, embedding)
            if similarity < MIN_SUPPLEMENT_COSINE:
                raise HTTPException(
                    status_code=400,
                    detail="这段录音与已有讲话人音色差异较大，请确认由同一人录制",
                )
        if not db.supplement_audio_for_owner(user_id, speaker_id, embedding, quality=quality):
            raise HTTPException(status_code=409, detail="讲话人已变化，请刷新后重试")
    profile = db.load_speaker_for_owner(user_id, speaker_id)
    return {
        "success": True,
        "speaker": _app_profile(profile or existing),
        "quality_level": level,
        "quality_description": description,
        "quality_issues": issues,
        "duration_sec": round(len(audio_data) / 16000.0, 2),
        "profile_replaced": profile_replaced,
    }


@router.patch("/{speaker_id}")
async def rename_app_speaker(
    speaker_id: str,
    request: SpeakerNameUpdate,
    current_user: dict = Depends(get_current_user),
):
    user_id = int(current_user["id"])
    _assert_account_writable(user_id)
    normalized_name = _normalize_name(request.name)
    db = get_speaker_db()
    if not db.update_speaker_for_owner(user_id, speaker_id, name=normalized_name):
        raise HTTPException(status_code=404, detail="讲话人不存在")
    profile = db.load_speaker_for_owner(user_id, speaker_id)
    return {"success": True, "speaker": _app_profile(profile or {})}


@router.delete("/{speaker_id}")
async def delete_app_speaker(
    speaker_id: str,
    current_user: dict = Depends(get_current_user),
):
    user_id = int(current_user["id"])
    _assert_account_writable(user_id)
    if not get_speaker_db().deactivate_speaker_for_owner(user_id, speaker_id):
        raise HTTPException(status_code=404, detail="讲话人不存在")
    return {"success": True, "speaker_id": speaker_id}


@router.post("/{speaker_id}/reprocess", status_code=202)
async def create_speaker_reprocess(
    speaker_id: str,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = int(current_user["id"])
    _assert_account_writable(user_id)
    if idempotency_key is None or not idempotency_key.strip() or len(idempotency_key.strip()) > 512:
        raise HTTPException(status_code=428, detail="缺少旧会议重新匹配请求标识")
    normalized_speaker_id = speaker_id.strip()
    if not normalized_speaker_id or len(normalized_speaker_id) > 160:
        raise HTTPException(status_code=422, detail="讲话人资料标识无效")
    request_hash = speaker_reprocess_request_hash(normalized_speaker_id)
    try:
        result = await create_reprocess_job(
            db,
            user_id=user_id,
            speaker_profile_id=normalized_speaker_id,
            idempotency_key=idempotency_key.strip(),
            request_hash=request_hash,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="讲话人不存在或已撤销") from error
    except SpeakerContractConflict as error:
        raise HTTPException(status_code=error.status_code, detail="请求标识已被其他操作使用") from error
    job_id = str(result.payload["job_id"])
    schedule_reprocess_job(job_id)
    return result.payload


@router.get("/{speaker_id}/reprocess")
async def get_latest_speaker_reprocess(
    speaker_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await find_latest_reprocess_job(
        db,
        user_id=int(current_user["id"]),
        speaker_profile_id=speaker_id.strip(),
    )
    return {"job": reprocess_job_payload(job) if job is not None else None}


@router.get("/{speaker_id}/reprocess/{job_id}")
async def get_speaker_reprocess(
    speaker_id: str,
    job_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await find_reprocess_job(
        db,
        user_id=int(current_user["id"]),
        speaker_profile_id=speaker_id.strip(),
        job_id=job_id.strip(),
    )
    if job is None:
        raise HTTPException(status_code=404, detail="重新匹配任务不存在或无权访问")
    return reprocess_job_payload(job)


@router.post("/{speaker_id}/reprocess/{job_id}/retry")
async def retry_speaker_reprocess(
    speaker_id: str,
    job_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        job = await retry_reprocess_job(
            db,
            user_id=int(current_user["id"]),
            speaker_profile_id=speaker_id.strip(),
            job_id=job_id.strip(),
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail="重新匹配任务不存在或无权访问") from error
    if job.status == "queued":
        schedule_reprocess_job(job.id)
    return reprocess_job_payload(job)
