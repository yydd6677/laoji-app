"""Device-v2 voiceprint registration and independent speaker overlay API."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from app.api.device_v2 import require_device_v2
from app.schemas.vnext_contracts import SpeakerOverlaySnapshotV2
from app.services import (
    device_v2_identity,
    vnext_speaker_pipeline,
    vnext_speaker_store,
)


router = APIRouter(prefix="/device/v2", tags=["device-v2-speakers"])


class CreateSpeakerProfileV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(default=2, ge=2, le=2)
    speaker_id: str = Field(min_length=8, max_length=180)
    display_name: str = Field(min_length=1, max_length=120)


class AddSpeakerSampleV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(default=2, ge=2, le=2)
    sample_rate: int = Field(default=16_000, ge=16_000, le=16_000)
    pcm_base64: str = Field(min_length=1, max_length=3_000_000)
    content_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


def _error(error: vnext_speaker_store.VNextSpeakerError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


def _decode_pcm(payload: AddSpeakerSampleV2) -> bytes:
    try:
        pcm = base64.b64decode(payload.pcm_base64, validate=True)
    except (ValueError, TypeError) as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "SPEAKER_SAMPLE_INVALID", "message": "声纹样本无效"},
        ) from error
    if len(pcm) % 2 or not 38_400 <= len(pcm) <= 1_920_000:
        raise HTTPException(
            status_code=422,
            detail={"code": "SPEAKER_SAMPLE_DURATION_INVALID", "message": "请提供 1.2 至 60 秒的声纹样本"},
        )
    digest = "sha256:" + hashlib.sha256(pcm).hexdigest()
    if digest != payload.content_sha256:
        raise HTTPException(
            status_code=422,
            detail={"code": "SPEAKER_SAMPLE_CHECKSUM_INVALID", "message": "声纹样本校验失败"},
        )
    return pcm


@router.get("/speakers")
async def list_speaker_profiles(
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    profiles = await asyncio.to_thread(vnext_speaker_store.list_profiles, context)
    return {"schema_version": 2, "profiles": profiles}


@router.post("/speakers", status_code=status.HTTP_201_CREATED)
async def create_speaker_profile(
    payload: CreateSpeakerProfileV2,
    response: Response,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        profile, reused = await asyncio.to_thread(
            vnext_speaker_store.create_profile,
            context,
            speaker_id=payload.speaker_id,
            display_name=payload.display_name,
        )
    except vnext_speaker_store.VNextSpeakerError as error:
        raise _error(error) from error
    if reused:
        response.status_code = status.HTTP_200_OK
    return {"schema_version": 2, "reused": reused, "profile": profile}


@router.post("/speakers/{speaker_id}/samples")
async def add_speaker_sample(
    speaker_id: str,
    payload: AddSpeakerSampleV2,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    pcm = _decode_pcm(payload)
    try:
        embedding, model_revision = await vnext_speaker_pipeline.extract_embedding_from_pcm(pcm)
        profile = await asyncio.to_thread(
            vnext_speaker_store.save_profile_embedding,
            context,
            speaker_id=speaker_id,
            embedding=embedding,
            model_revision=model_revision,
        )
    except vnext_speaker_store.VNextSpeakerError as error:
        raise _error(error) from error
    except Exception as error:
        raise HTTPException(
            status_code=503,
            detail={"code": "SPEAKER_MODEL_UNAVAILABLE", "message": "讲话人识别暂不可用"},
        ) from error
    finally:
        # The PCM sample is request-local and is never written to disk or logs.
        del pcm
    return {"schema_version": 2, "profile": profile}


@router.delete("/speakers/{speaker_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_speaker_profile(
    speaker_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> Response:
    try:
        deleted = await asyncio.to_thread(
            vnext_speaker_store.revoke_profile,
            context,
            speaker_id,
        )
    except vnext_speaker_store.VNextSpeakerError as error:
        raise _error(error) from error
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail={"code": "SPEAKER_PROFILE_NOT_FOUND", "message": "讲话人档案不存在"},
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/realtime/{session_id}/speaker-overlay")
async def get_realtime_speaker_overlay(
    session_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        snapshot = await asyncio.to_thread(
            vnext_speaker_store.get_overlay_snapshot,
            context,
            session_id,
        )
    except vnext_speaker_store.VNextSpeakerError as error:
        raise _error(error) from error
    if snapshot is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "SPEAKER_RUN_NOT_FOUND", "message": "讲话人处理不存在"},
        )
    return SpeakerOverlaySnapshotV2.model_validate(snapshot).model_dump()


@router.get("/tasks/{task_id}/speaker-overlay")
async def get_import_speaker_overlay(
    task_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        snapshot = await asyncio.to_thread(
            vnext_speaker_store.get_overlay_snapshot,
            context,
            vnext_speaker_store.import_speaker_run_id(task_id),
        )
    except vnext_speaker_store.VNextSpeakerError as error:
        raise _error(error) from error
    if snapshot is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "SPEAKER_RUN_NOT_FOUND", "message": "讲话人处理尚未开始"},
        )
    return SpeakerOverlaySnapshotV2.model_validate(snapshot).model_dump()
