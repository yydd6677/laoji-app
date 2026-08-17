"""Device v2 authentication surface.

Only the identity contract is exposed here initially.  Domain routers remain
on v1 until the mobile Keystore client and the v2 capability gate are ready.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field

from app.services import device_v2_identity, vnext_purge_store, vnext_task_store


router = APIRouter(prefix="/device/v2", tags=["device-v2"])
security = HTTPBearer(auto_error=False)


class BootstrapChallengeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    device_id: str = Field(min_length=36, max_length=36)
    epoch_id: str = Field(min_length=36, max_length=36)
    public_key: str = Field(min_length=1, max_length=1_400)
    request_id: str = Field(min_length=8, max_length=160)


class PurgeCapabilityRegistration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    capability_id: str = Field(min_length=36, max_length=36)
    secret_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    registration_request_id: str = Field(min_length=8, max_length=180)


class BootstrapCompleteRequest(BootstrapChallengeRequest):
    challenge_id: str = Field(min_length=8, max_length=180)
    nonce: str = Field(min_length=1, max_length=100)
    signature: str = Field(min_length=1, max_length=400)
    proof_nonce: int = Field(ge=0, le=9_223_372_036_854_775_807)
    purge_capability: PurgeCapabilityRegistration


class AuthChallengeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    device_id: str = Field(min_length=36, max_length=36)
    epoch_id: str = Field(min_length=36, max_length=36)
    key_version: int = Field(ge=1, le=100)
    public_key_hash: str = Field(min_length=64, max_length=128)
    request_id: str = Field(min_length=8, max_length=160)


class AuthTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    challenge_id: str = Field(min_length=8, max_length=180)
    nonce: str = Field(min_length=1, max_length=100)
    signature: str = Field(min_length=1, max_length=400)
    request_id: str = Field(min_length=8, max_length=160)


class RotateKeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    request_id: str = Field(min_length=8, max_length=160)
    new_public_key: str = Field(min_length=1, max_length=1_400)
    old_signature: str = Field(min_length=1, max_length=400)
    new_signature: str = Field(min_length=1, max_length=400)


class V2BindingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    binding_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    binding_epoch_seq: int = Field(ge=1, le=9_223_372_036_854_775_807)
    binding_revision: int = Field(default=1, ge=1, le=9_223_372_036_854_775_807)
    cancel_revision: int = Field(default=0, ge=0, le=9_223_372_036_854_775_807)
    purge_capability: PurgeCapabilityRegistration


class V2TaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    task_id: str = Field(min_length=1, max_length=512)
    binding_id: str = Field(min_length=36, max_length=36)
    binding_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    capability: str = Field(min_length=1, max_length=120)
    entity_id: str = Field(min_length=1, max_length=512)
    entity_revision: int = Field(ge=1, le=9_007_199_254_740_991)
    input_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    generation_id: str = Field(min_length=1, max_length=512)
    predecessor_task_id: str | None = Field(default=None, max_length=512)
    creation_reason: Literal["original", "retry", "regenerate"] = "original"


def _error(error: device_v2_identity.DeviceV2IdentityError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


def _task_error(error: vnext_task_store.VNextTaskError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail={"code": error.code, "message": error.message})


def _purge_error(error: vnext_purge_store.VNextPurgeError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail={"code": error.code, "message": error.message})


def _purge_secret(authorization: str | None) -> str:
    parts = str(authorization or "").strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "laojipurge" or not parts[1].strip():
        raise HTTPException(status_code=401, detail={"code": "PURGE_AUTH_REQUIRED", "message": "需要清理凭据"})
    return parts[1].strip()


async def require_device_v2(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    device_id: str | None = Header(default=None, alias="X-Laoji-Device-Id"),
    epoch_id: str | None = Header(default=None, alias="X-Laoji-Epoch-Id"),
) -> device_v2_identity.DeviceV2Context:
    if not credentials or credentials.scheme.lower() != "bearer" or not device_id or not epoch_id:
        raise HTTPException(status_code=401, detail={"code": "BEARER_REQUIRED", "message": "需要设备令牌"})
    try:
        return device_v2_identity.authenticate_bearer(device_id, epoch_id, credentials.credentials)
    except device_v2_identity.DeviceV2IdentityError as error:
        raise _error(error) from error


@router.post("/bootstrap/challenges")
async def bootstrap_challenge(request: Request, payload: BootstrapChallengeRequest) -> dict[str, Any]:
    try:
        rate_key = request.client.host if request.client else "unknown"
        return device_v2_identity.create_bootstrap_challenge(
            device_id=payload.device_id,
            epoch_id=payload.epoch_id,
            public_key_der=payload.public_key,
            request_id=payload.request_id,
            rate_key=rate_key,
        )
    except device_v2_identity.DeviceV2IdentityError as error:
        raise _error(error) from error


@router.post("/bootstrap/complete")
async def bootstrap_complete(payload: BootstrapCompleteRequest) -> dict[str, Any]:
    try:
        return device_v2_identity.complete_bootstrap(
            challenge_id=payload.challenge_id,
            nonce=payload.nonce,
            device_id=payload.device_id,
            epoch_id=payload.epoch_id,
            public_key_der=payload.public_key,
            signature=payload.signature,
            proof_nonce=payload.proof_nonce,
            request_id=payload.request_id,
            purge_capability_id=payload.purge_capability.capability_id,
            purge_secret_sha256=payload.purge_capability.secret_sha256,
            purge_registration_request_id=payload.purge_capability.registration_request_id,
        )
    except device_v2_identity.DeviceV2IdentityError as error:
        raise _error(error) from error


@router.post("/auth/challenges")
async def auth_challenge(payload: AuthChallengeRequest) -> dict[str, Any]:
    try:
        return device_v2_identity.create_auth_challenge(
            device_id=payload.device_id,
            epoch_id=payload.epoch_id,
            key_version=payload.key_version,
            public_key_hash=payload.public_key_hash,
            request_id=payload.request_id,
        )
    except device_v2_identity.DeviceV2IdentityError as error:
        raise _error(error) from error


@router.post("/auth/tokens")
async def auth_token(payload: AuthTokenRequest) -> dict[str, Any]:
    try:
        return device_v2_identity.exchange_auth_token(
            challenge_id=payload.challenge_id,
            nonce=payload.nonce,
            signature=payload.signature,
            request_id=payload.request_id,
        )
    except device_v2_identity.DeviceV2IdentityError as error:
        raise _error(error) from error


@router.post("/auth/keys/rotate")
async def rotate_key(
    payload: RotateKeyRequest,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        return device_v2_identity.rotate_key(
            context=context,
            request_id=payload.request_id,
            new_public_key_der=payload.new_public_key,
            old_signature=payload.old_signature,
            new_signature=payload.new_signature,
        )
    except device_v2_identity.DeviceV2IdentityError as error:
        raise _error(error) from error


@router.get("/capabilities")
async def capabilities(context: device_v2_identity.DeviceV2Context = Depends(require_device_v2)) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "device_api": True,
        "device_id": context.device_id,
        "epoch_id": context.epoch_id,
        "key_version": context.key_version,
        "token_revision": context.token_revision,
        "auth": {"p256": True, "bearer_ttl_seconds": device_v2_identity.TOKEN_TTL_SECONDS},
        "domain_routes": True,
        "purge_only_capability": True,
    }


@router.get("/ready")
async def ready(context: device_v2_identity.DeviceV2Context = Depends(require_device_v2)) -> dict[str, Any]:
    return {"schema_version": 2, "ready": True, "device_id": context.device_id, "epoch_id": context.epoch_id}


@router.post("/purge-capabilities/{capability_id}/execute")
async def execute_purge_capability(
    capability_id: str,
    authorization: str | None = Header(default=None, alias="Authorization"),
    request_id: str | None = Header(default=None, alias="X-Laoji-Purge-Request-Id"),
) -> dict[str, Any]:
    if not request_id:
        raise HTTPException(status_code=428, detail={"code": "PURGE_REQUEST_ID_REQUIRED", "message": "缺少清理请求标识"})
    try:
        return await asyncio.to_thread(
            vnext_purge_store.execute_purge,
            capability_id=capability_id, secret=_purge_secret(authorization), request_id=request_id,
        )
    except vnext_purge_store.VNextPurgeError as error:
        raise _purge_error(error) from error


@router.get("/purge-capabilities/{capability_id}")
async def purge_capability_status(
    capability_id: str,
    authorization: str | None = Header(default=None, alias="Authorization"),
    request_id: str | None = Header(default=None, alias="X-Laoji-Purge-Request-Id"),
) -> dict[str, Any]:
    if not request_id:
        raise HTTPException(status_code=428, detail={"code": "PURGE_REQUEST_ID_REQUIRED", "message": "缺少清理请求标识"})
    try:
        return await asyncio.to_thread(
            vnext_purge_store.get_purge_status,
            capability_id=capability_id, secret=_purge_secret(authorization),
        )
    except vnext_purge_store.VNextPurgeError as error:
        raise _purge_error(error) from error


@router.put("/meetings/{binding_id}")
async def register_binding(
    binding_id: str,
    payload: V2BindingRequest,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        binding = await asyncio.to_thread(
            vnext_task_store.register_binding, context,
            binding_id=binding_id,
            binding_generation=payload.binding_generation,
            binding_epoch_seq=payload.binding_epoch_seq,
            binding_revision=payload.binding_revision,
            cancel_revision=payload.cancel_revision,
            purge_capability=payload.purge_capability.model_dump(),
        )
        return {"schema_version": 2, "binding": binding}
    except vnext_task_store.VNextTaskError as error:
        raise _task_error(error) from error


@router.get("/meetings/{binding_id}")
async def get_binding(
    binding_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        binding = await asyncio.to_thread(vnext_task_store.get_binding, context, binding_id)
    except vnext_task_store.VNextTaskError as error:
        raise _task_error(error) from error
    if binding is None:
        raise HTTPException(status_code=404, detail={"code": "BINDING_NOT_FOUND", "message": "会议服务连接不存在"})
    return {"schema_version": 2, "binding": binding}


@router.post("/tasks")
async def create_task(
    payload: V2TaskRequest,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        task, reused = await asyncio.to_thread(
            vnext_task_store.create_task, context,
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
        return {"schema_version": 2, "reused": reused, "task": task}
    except vnext_task_store.VNextTaskError as error:
        raise _task_error(error) from error


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        task = await asyncio.to_thread(vnext_task_store.get_task, context, task_id)
    except vnext_task_store.VNextTaskError as error:
        raise _task_error(error) from error
    if task is None:
        raise HTTPException(status_code=404, detail={"code": "TASK_NOT_FOUND", "message": "任务不存在"})
    return {"schema_version": 2, "task": task}


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(
    task_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        cancelled = await asyncio.to_thread(vnext_task_store.cancel_task, context, task_id)
    except vnext_task_store.VNextTaskError as error:
        raise _task_error(error) from error
    if not cancelled:
        raise HTTPException(status_code=409, detail={"code": "TASK_NOT_ACTIVE", "message": "任务已结束或不存在"})
    return {"schema_version": 2, "cancelled": True}
