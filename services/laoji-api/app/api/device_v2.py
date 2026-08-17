"""Device v2 authentication surface.

Only the identity contract is exposed here initially.  Domain routers remain
on v1 until the mobile Keystore client and the v2 capability gate are ready.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field

from app.services import device_v2_identity


router = APIRouter(prefix="/device/v2", tags=["device-v2"])
security = HTTPBearer(auto_error=False)


class BootstrapChallengeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    device_id: str = Field(min_length=36, max_length=36)
    epoch_id: str = Field(min_length=36, max_length=36)
    public_key: str = Field(min_length=1, max_length=1_400)
    request_id: str = Field(min_length=8, max_length=160)


class BootstrapCompleteRequest(BootstrapChallengeRequest):
    challenge_id: str = Field(min_length=8, max_length=180)
    nonce: str = Field(min_length=1, max_length=100)
    signature: str = Field(min_length=1, max_length=400)
    proof_nonce: int = Field(ge=0, le=9_223_372_036_854_775_807)


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


def _error(error: device_v2_identity.DeviceV2IdentityError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


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
        "domain_routes": False,
    }


@router.get("/ready")
async def ready(context: device_v2_identity.DeviceV2Context = Depends(require_device_v2)) -> dict[str, Any]:
    return {"schema_version": 2, "ready": True, "device_id": context.device_id, "epoch_id": context.epoch_id}
