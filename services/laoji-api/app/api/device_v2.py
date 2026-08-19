"""Device v2 authentication surface.

Only the identity contract is exposed here initially.  Domain routers remain
on v1 until the mobile Keystore client and the v2 capability gate are ready.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field

from app.services import (
    device_v2_identity,
    schedule_graph_service,
    vnext_capability_cutover,
    vnext_purge_store,
    vnext_import_transcript_store,
    vnext_import_transcription_pipeline,
    vnext_source_stream_store,
    vnext_task_store,
    vnext_upload_store,
    vnext_question_reader,
)
from app.services.schedule_parser_service import ScheduleParserUnavailable, parse_schedule_text
from app.schemas.vnext_contracts import (
    ScheduleGraphClarificationRequestV1,
    ScheduleGraphRequestV1,
    ScheduleMentionGraph,
    SourceBundleItemV2,
    SourceManifestDescriptorV2,
    SourceStreamSnapshotV2,
)


router = APIRouter(prefix="/device/v2", tags=["device-v2"])
security = HTTPBearer(auto_error=False)
_logger = logging.getLogger(__name__)


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


class Q2ReaderSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_type: Literal["transcript", "manual_note", "attachment"]
    # Android transcript identities include the meeting owner, stable segment
    # identity and revision material.  They are opaque source handles, not the
    # short aliases exposed to the model, so keep the shared 512-character owner
    # boundary instead of rejecting valid mobile snapshots at the HTTP edge.
    source_id: str = Field(min_length=1, max_length=512)
    source_revision_id: str = Field(min_length=1, max_length=512)
    content_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    text: str = Field(min_length=1, max_length=8_000)


class Q2ReaderRequest(BaseModel):
    """Typed wire boundary for the candidate reader.

    Keeping binding fences in the same request prevents a caller from
    validating an immutable source snapshot against one binding and then
    executing it against another revision.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    contract_revision: str = Field(min_length=1, max_length=80)
    provider_revision: str = Field(min_length=1, max_length=80)
    snapshot_id: str = Field(min_length=1, max_length=180)
    source_fingerprint: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    question: str = Field(min_length=1, max_length=2_000)
    binding_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    binding_revision: int = Field(ge=1, le=9_223_372_036_854_775_807)
    cancel_revision: int = Field(ge=0, le=9_223_372_036_854_775_807)
    task_id: str | None = Field(default=None, min_length=8, max_length=512)
    source_stream_id: str | None = Field(default=None, min_length=8, max_length=180)
    source_stream_verified: bool = False
    sources: list[Q2ReaderSource] = Field(default_factory=list, max_length=1_024)


class V2UploadFence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    binding_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    binding_revision: int = Field(ge=1, le=9_007_199_254_740_991)
    cancel_revision: int = Field(ge=0, le=9_007_199_254_740_991)


class V2UploadCreate(V2UploadFence):
    session_id: str = Field(min_length=8, max_length=180)
    binding_id: str = Field(min_length=8, max_length=180)
    client_operation_id: str = Field(min_length=8, max_length=180)
    asset_id: str = Field(min_length=1, max_length=180)
    asset_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected_size: int = Field(ge=1, le=1024 * 1024 * 1024)
    expected_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    mime_type: str = Field(min_length=1, max_length=160)


class V2UploadParts(V2UploadFence):
    part_numbers: list[int] = Field(min_length=1, max_length=256)


class V2UploadedPart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    part_number: int = Field(ge=1, le=10_000)
    etag: str = Field(min_length=1, max_length=512)


class V2UploadComplete(V2UploadFence):
    parts: list[V2UploadedPart] = Field(default_factory=list, max_length=10_000)
    transcription_task_id: str = Field(min_length=8, max_length=180)
    transcription_generation_id: str = Field(min_length=8, max_length=180)
    transcription_input_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class V2TranscriptEventAck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    through_event_seq: int = Field(ge=1, le=9_007_199_254_740_991)
    projection_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class V2SourceStreamCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    contract_revision: Literal["source.stream.v2"] = "source.stream.v2"
    stream_id: str = Field(min_length=8, max_length=180)
    task_id: str = Field(min_length=8, max_length=512)
    binding_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    binding_revision: int = Field(ge=1, le=9_007_199_254_740_991)
    cancel_revision: int = Field(ge=0, le=9_007_199_254_740_991)
    client_operation_id: str = Field(min_length=8, max_length=180)
    generation_id: str = Field(min_length=8, max_length=512)
    request_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    capability: Literal["summary", "question"]
    entity_id: str = Field(min_length=1, max_length=512)
    entity_revision: int = Field(ge=1, le=9_007_199_254_740_991)
    task_input_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class V2SourceManifestPage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    contract_revision: Literal["source.stream.v2"] = "source.stream.v2"
    page_seq: int = Field(ge=0, le=9_007_199_254_740_991)
    first_chapter_ordinal: int = Field(ge=0, le=9_007_199_254_740_991)
    descriptors: list[SourceManifestDescriptorV2] = Field(min_length=1, max_length=10_000)
    page_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    final_page: bool = False


class V2SourceBundleGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    contract_revision: Literal["source.stream.v2"] = "source.stream.v2"
    group_id: str = Field(min_length=8, max_length=180)
    chapter_ordinal: int = Field(ge=0, le=9_007_199_254_740_991)
    declared_bundle_count: int = Field(ge=1, le=8)
    declared_item_count: int = Field(ge=1, le=50_000)
    declared_uncompressed_bytes: int = Field(ge=1, le=128 * 1024 * 1024)
    chapter_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    request_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class V2SourceBundleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2] = 2
    contract_revision: Literal["source.stream.v2"] = "source.stream.v2"
    bundle_id: str = Field(min_length=8, max_length=180)
    ordinal: int = Field(ge=0, le=7)
    bundle_sha256: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    items: list[SourceBundleItemV2] = Field(min_length=1, max_length=50_000)


def _error(error: device_v2_identity.DeviceV2IdentityError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


def _task_error(error: vnext_task_store.VNextTaskError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail={"code": error.code, "message": error.message})


def _purge_error(error: vnext_purge_store.VNextPurgeError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail={"code": error.code, "message": error.message})


def _upload_error(error: vnext_upload_store.VNextUploadError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail={"code": error.code, "message": error.message})


def _transcript_error(error: vnext_import_transcript_store.VNextImportTranscriptError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail={"code": error.code, "message": error.message})


def _source_error(error: vnext_source_stream_store.VNextSourceStreamError) -> HTTPException:
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
    media_upload_v2 = vnext_capability_cutover.media_upload_cutover_enabled(
        prerequisites_ready=(
            vnext_upload_store.upload_enabled()
            and vnext_import_transcription_pipeline.import_transcription_enabled()
        ),
    )
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
        "upload_sessions_v2": media_upload_v2,
        "import_transcript_events_v2": media_upload_v2,
        "realtime_asr_v2": vnext_capability_cutover.realtime_asr_v2_enabled(),
        "schedule_graph_v2": vnext_capability_cutover.schedule_graph_v2_enabled(),
        "source_stream_v2": vnext_capability_cutover.source_stream_v2_enabled(),
        "question_reader_v2": vnext_capability_cutover.question_reader_v2_enabled(),
    }


@router.get("/ready")
async def ready(context: device_v2_identity.DeviceV2Context = Depends(require_device_v2)) -> dict[str, Any]:
    return {"schema_version": 2, "ready": True, "device_id": context.device_id, "epoch_id": context.epoch_id}


def _require_schedule_graph_v2() -> None:
    if not vnext_capability_cutover.schedule_graph_v2_enabled():
        raise HTTPException(status_code=404, detail={
            "code": "SCHEDULE_GRAPH_V2_DISABLED",
            "message": "日程图候选接口尚未启用",
        })


def _require_source_stream_v2() -> None:
    if not vnext_capability_cutover.source_stream_v2_enabled():
        raise HTTPException(status_code=404, detail={
            "code": "SOURCE_STREAM_V2_DISABLED",
            "message": "会议来源流候选接口尚未启用",
        })


def _require_question_reader_v2() -> None:
    if not vnext_capability_cutover.question_reader_v2_enabled():
        raise HTTPException(status_code=404, detail={
            "code": "QUESTION_READER_V2_DISABLED",
            "message": "新版会议问答候选接口尚未启用",
        })


@router.post("/schedule/graph", response_model=ScheduleMentionGraph)
async def create_schedule_graph(
    payload: ScheduleGraphRequestV1,
    _context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> ScheduleMentionGraph:
    _require_schedule_graph_v2()
    try:
        if payload.client_intent in {"query", "delete", "reject"}:
            parsed = {"intent": payload.client_intent, "parse_source": "recognizers"}
        else:
            parsed = await parse_schedule_text(
                payload.text,
                reference_datetime=payload.reference_datetime.isoformat(),
                timezone_name=payload.timezone,
                # v2 Graph owns one structured model producer. The legacy
                # quick parser remains behind the compatibility route and
                # must not run as a second server-side decision owner here.
                model_only=True,
            )
            if not parsed:
                raise ScheduleParserUnavailable("模型未返回日程观察")
        return schedule_graph_service.produce_schedule_graph(
            payload.text,
            payload.reference_datetime,
            payload.timezone,
            source_id=payload.source_id,
            parsed=parsed,
            intent=payload.client_intent,
        )
    except ScheduleParserUnavailable as error:
        raise HTTPException(status_code=503, detail={
            "code": "SCHEDULE_GRAPH_PROVIDER_UNAVAILABLE",
            "message": "日程图生成服务暂时不可用",
        }) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail={
            "code": "SCHEDULE_GRAPH_INVALID",
            "message": "日程图内容无效",
        }) from error


@router.post("/schedule/graph/clarify", response_model=ScheduleMentionGraph)
async def clarify_schedule_graph(
    payload: ScheduleGraphClarificationRequestV1,
    _context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> ScheduleMentionGraph:
    _require_schedule_graph_v2()
    try:
        combined_text = f"{payload.graph.source.text}；补充：{payload.answer.strip()}"
        parsed = await parse_schedule_text(
            combined_text,
            reference_datetime=payload.graph.source.reference_datetime.isoformat(),
            timezone_name=payload.graph.source.timezone,
            model_only=True,
        )
        if not parsed:
            raise ScheduleParserUnavailable("模型未返回澄清观察")
        return schedule_graph_service.merge_schedule_clarification(
            payload.graph,
            payload.answer,
            parsed=parsed,
        )
    except ScheduleParserUnavailable as error:
        raise HTTPException(status_code=503, detail={
            "code": "SCHEDULE_GRAPH_PROVIDER_UNAVAILABLE",
            "message": "日程图补充服务暂时不可用",
        }) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail={
            "code": "SCHEDULE_GRAPH_CLARIFICATION_INVALID",
            "message": "没有理解这次日程补充",
        }) from error


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


@router.post(
    "/meetings/{binding_id}/source-streams",
    status_code=202,
    response_model=SourceStreamSnapshotV2,
)
async def create_source_stream(
    binding_id: str,
    payload: V2SourceStreamCreate,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    _require_source_stream_v2()
    try:
        await asyncio.to_thread(vnext_source_stream_store.purge_expired_source_streams, limit=32)
        stream, _reused = await asyncio.to_thread(
            vnext_source_stream_store.create_source_stream,
            context,
            stream_id=payload.stream_id,
            task_id=payload.task_id,
            binding_id=binding_id,
            binding_generation=payload.binding_generation,
            binding_revision=payload.binding_revision,
            cancel_revision=payload.cancel_revision,
            client_operation_id=payload.client_operation_id,
            generation_id=payload.generation_id,
            request_sha256=payload.request_sha256,
            capability=payload.capability,
            entity_id=payload.entity_id,
            entity_revision=payload.entity_revision,
            task_input_sha256=payload.task_input_sha256,
        )
        return stream
    except vnext_source_stream_store.VNextSourceStreamError as error:
        raise _source_error(error) from error


@router.get("/source-streams/{stream_id}", response_model=SourceStreamSnapshotV2)
async def get_source_stream(
    stream_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    _require_source_stream_v2()
    try:
        stream = await asyncio.to_thread(
            vnext_source_stream_store.get_source_stream,
            context,
            stream_id,
        )
    except vnext_source_stream_store.VNextSourceStreamError as error:
        raise _source_error(error) from error
    if stream is None:
        raise HTTPException(status_code=404, detail={
            "code": "SOURCE_STREAM_NOT_FOUND",
            "message": "来源流不存在",
        })
    return stream


@router.post(
    "/source-streams/{stream_id}/manifest-pages",
    status_code=202,
    response_model=SourceStreamSnapshotV2,
)
async def append_source_manifest_page(
    stream_id: str,
    payload: V2SourceManifestPage,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    _require_source_stream_v2()
    try:
        return await asyncio.to_thread(
            vnext_source_stream_store.append_manifest_page,
            context,
            stream_id,
            page_seq=payload.page_seq,
            first_chapter_ordinal=payload.first_chapter_ordinal,
            descriptors=[item.model_dump() for item in payload.descriptors],
            page_sha256=payload.page_sha256,
            final_page=payload.final_page,
        )
    except vnext_source_stream_store.VNextSourceStreamError as error:
        raise _source_error(error) from error


@router.post("/source-streams/{stream_id}/groups", status_code=202)
async def create_source_bundle_group(
    stream_id: str,
    payload: V2SourceBundleGroupCreate,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    _require_source_stream_v2()
    try:
        group, reused = await asyncio.to_thread(
            vnext_source_stream_store.create_bundle_group,
            context,
            stream_id,
            group_id=payload.group_id,
            chapter_ordinal=payload.chapter_ordinal,
            declared_bundle_count=payload.declared_bundle_count,
            declared_item_count=payload.declared_item_count,
            declared_uncompressed_bytes=payload.declared_uncompressed_bytes,
            chapter_hash=payload.chapter_sha256,
            request_sha256=payload.request_sha256,
        )
        return {"schema_version": 2, "reused": reused, "group": group}
    except vnext_source_stream_store.VNextSourceStreamError as error:
        raise _source_error(error) from error


@router.post("/source-bundle-groups/{group_id}/bundles", status_code=202)
async def append_source_bundle(
    group_id: str,
    payload: V2SourceBundleCreate,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    _require_source_stream_v2()
    try:
        group = await asyncio.to_thread(
            vnext_source_stream_store.append_bundle,
            context,
            group_id,
            bundle_id=payload.bundle_id,
            ordinal=payload.ordinal,
            items=[item.model_dump() for item in payload.items],
            supplied_bundle_sha256=payload.bundle_sha256,
        )
        return {"schema_version": 2, "group": group}
    except vnext_source_stream_store.VNextSourceStreamError as error:
        raise _source_error(error) from error


@router.post("/source-bundle-groups/{group_id}/commit", status_code=202)
async def commit_source_bundle_group(
    group_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    _require_source_stream_v2()
    try:
        group = await asyncio.to_thread(
            vnext_source_stream_store.commit_bundle_group,
            context,
            group_id,
        )
        return {"schema_version": 2, "group": group}
    except vnext_source_stream_store.VNextSourceStreamError as error:
        raise _source_error(error) from error


@router.delete("/source-streams/{stream_id}", status_code=202)
async def delete_source_stream(
    stream_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    _require_source_stream_v2()
    try:
        cancelled = await asyncio.to_thread(
            vnext_source_stream_store.cancel_source_stream,
            context,
            stream_id,
        )
    except vnext_source_stream_store.VNextSourceStreamError as error:
        raise _source_error(error) from error
    if not cancelled:
        raise HTTPException(status_code=409, detail={
            "code": "SOURCE_STREAM_NOT_CANCELLABLE",
            "message": "来源流已完成或不存在",
        })
    return {"schema_version": 2, "cancelled": True}


@router.post("/uploads")
async def create_upload(
    payload: V2UploadCreate,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> JSONResponse:
    try:
        session, reused = await asyncio.to_thread(
            vnext_upload_store.create_upload_session,
            context,
            session_id=payload.session_id,
            binding_id=payload.binding_id,
            binding_generation=payload.binding_generation,
            binding_revision=payload.binding_revision,
            cancel_revision=payload.cancel_revision,
            client_operation_id=payload.client_operation_id,
            asset_id=payload.asset_id,
            asset_generation=payload.asset_generation,
            expected_size=payload.expected_size,
            expected_sha256=payload.expected_sha256,
            mime_type=payload.mime_type,
        )
        return JSONResponse(
            status_code=200 if reused else 201,
            content={"schema_version": 2, "reused": reused, "session": session},
        )
    except vnext_upload_store.VNextUploadError as error:
        raise _upload_error(error) from error


@router.get("/uploads/{session_id}")
async def get_upload(
    session_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        session = await asyncio.to_thread(vnext_upload_store.get_upload_session, context, session_id)
    except vnext_upload_store.VNextUploadError as error:
        raise _upload_error(error) from error
    if session is None:
        raise HTTPException(status_code=404, detail={"code": "UPLOAD_SESSION_NOT_FOUND", "message": "上传任务不存在"})
    return {"schema_version": 2, "session": session}


@router.post("/uploads/{session_id}/parts")
async def upload_parts(
    session_id: str,
    payload: V2UploadParts,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            vnext_upload_store.presign_upload_parts,
            context,
            session_id,
            binding_generation=payload.binding_generation,
            binding_revision=payload.binding_revision,
            cancel_revision=payload.cancel_revision,
            part_numbers=payload.part_numbers,
        )
    except vnext_upload_store.VNextUploadError as error:
        raise _upload_error(error) from error


@router.post("/uploads/{session_id}/complete")
async def complete_upload(
    session_id: str,
    payload: V2UploadComplete,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        result = await asyncio.to_thread(
            vnext_upload_store.complete_upload_session,
            context,
            session_id,
            binding_generation=payload.binding_generation,
            binding_revision=payload.binding_revision,
            cancel_revision=payload.cancel_revision,
            parts=[part.model_dump() for part in payload.parts],
            transcription_task_id=payload.transcription_task_id,
            transcription_generation_id=payload.transcription_generation_id,
            transcription_input_sha256=payload.transcription_input_sha256,
        )
        # Materialize the durable import run before acknowledging completion.
        # The worker still owns execution, but the phone can immediately poll
        # a queued run instead of observing a transient 404 between the upload
        # commit and the worker's next maintenance scan.
        if vnext_import_transcription_pipeline.import_transcription_enabled():
            try:
                await asyncio.to_thread(
                    vnext_import_transcript_store.ensure_run_for_task,
                    context,
                    str(result["task"]["task_id"]),
                )
            except Exception as error:
                # Upload verification is already durable.  The GET path has
                # the same idempotent self-healing hook and the worker will
                # retry the handoff, so do not turn a committed upload into a
                # false upload failure.
                _logger.warning(
                    "vnext import run handoff deferred: %s",
                    type(error).__name__,
                )
        return result
    except vnext_upload_store.VNextUploadError as error:
        raise _upload_error(error) from error


@router.delete("/uploads/{session_id}")
async def delete_upload(
    session_id: str,
    payload: V2UploadFence,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> JSONResponse:
    try:
        result = await asyncio.to_thread(
            vnext_upload_store.cancel_upload_session,
            context,
            session_id,
            binding_generation=payload.binding_generation,
            binding_revision=payload.binding_revision,
            cancel_revision=payload.cancel_revision,
        )
        return JSONResponse(status_code=202 if result["state"] == "cleanup_pending" else 200, content=result)
    except vnext_upload_store.VNextUploadError as error:
        raise _upload_error(error) from error


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


@router.post("/meetings/{binding_id}/questions-v2")
async def read_question_v2(
    binding_id: str,
    payload: Q2ReaderRequest,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    """Run one source-attributed Q2 reader call behind the device fence."""
    _require_question_reader_v2()
    stream_id = payload.source_stream_id
    task_id: str | None = payload.task_id
    attempt_id: str | None = None
    lease_owner = f"q2-api:{uuid.uuid4().hex}"
    try:
        await asyncio.to_thread(vnext_source_stream_store.purge_expired_source_streams, limit=32)
        binding = await asyncio.to_thread(vnext_task_store.get_binding, context, binding_id)
        if binding is None or binding.get("state") != "active":
            raise vnext_question_reader.Q2ReaderError(
                "BINDING_REQUIRED",
                "会议服务连接未登记",
                428,
            )
        if (
            payload.binding_generation != binding.get("binding_generation")
            or payload.binding_revision != int(binding.get("binding_revision", -2))
            or payload.cancel_revision != int(binding.get("cancel_revision", -2))
        ):
            raise vnext_question_reader.Q2ReaderError(
                "BINDING_FENCE_INVALID",
                "会议服务连接版本已变化",
                409,
            )
        if stream_id is None:
            if payload.source_stream_verified:
                raise vnext_question_reader.Q2ReaderError(
                    "Q2_INPUT_INVALID",
                    "来源流校验标记只能由服务端设置",
                    422,
                )
            if not payload.sources:
                raise vnext_question_reader.Q2ReaderError(
                    "Q2_INPUT_INVALID",
                    "Q2 来源不能为空",
                    422,
                )
            return await asyncio.to_thread(vnext_question_reader.read_q2, payload.model_dump())

        source_snapshot = await asyncio.to_thread(
            vnext_source_stream_store.load_question_source_stream,
            context,
            stream_id,
        )
        if source_snapshot is None:
            # A successful request deletes the source stream.  The task ID makes
            # a replay idempotent without retaining plaintext or a tombstone.
            if task_id:
                existing = await asyncio.to_thread(vnext_task_store.get_task, context, task_id)
                if (
                    existing is not None
                    and existing.get("capability") == "question"
                    and existing.get("state") == "success"
                    and existing.get("input_sha256") == payload.source_fingerprint
                    and isinstance(existing.get("result"), dict)
                ):
                    return existing["result"]
            raise vnext_question_reader.Q2ReaderError(
                "SOURCE_STREAM_NOT_FOUND",
                "会议来源流不存在或已过期",
                404,
            )
        if source_snapshot["binding_id"] != binding_id:
            raise vnext_question_reader.Q2ReaderError(
                "SOURCE_STREAM_BINDING_INVALID",
                "来源流会议连接不匹配",
                409,
            )
        if (
            source_snapshot["binding_generation"] != payload.binding_generation
            or source_snapshot["binding_revision"] != payload.binding_revision
            or source_snapshot["cancel_revision"] != payload.cancel_revision
        ):
            raise vnext_question_reader.Q2ReaderError(
                "BINDING_FENCE_INVALID",
                "会议服务连接版本已变化",
                409,
            )
        if payload.source_fingerprint != source_snapshot["source_fingerprint"]:
            raise vnext_question_reader.Q2ReaderError(
                "Q2_SOURCE_FINGERPRINT_MISMATCH",
                "Q2 来源整体标识校验失败",
                409,
            )
        if task_id is not None and task_id != source_snapshot["task_id"]:
            raise vnext_question_reader.Q2ReaderError(
                "Q2_TASK_INVALID",
                "Q2 任务与来源流不匹配",
                409,
            )
        task_id = source_snapshot["task_id"]
        attempt = await asyncio.to_thread(
            vnext_task_store.claim_attempt,
            context,
            task_id,
            lease_owner=lease_owner,
            lease_seconds=180,
        )
        if attempt is None:
            existing = await asyncio.to_thread(vnext_task_store.get_task, context, task_id)
            if (
                existing is not None
                and existing.get("state") == "success"
                and isinstance(existing.get("result"), dict)
            ):
                return existing["result"]
            raise vnext_question_reader.Q2ReaderError(
                "Q2_TASK_BUSY",
                "上一条会议问答仍在处理中，请稍后重试",
                409,
            )
        attempt_id = str(attempt["attempt_id"])
        reader_payload = payload.model_dump()
        reader_payload["sources"] = source_snapshot["sources"]
        reader_payload["task_id"] = task_id
        reader_payload["source_stream_verified"] = True
        result = await asyncio.to_thread(vnext_question_reader.read_q2, reader_payload)
        return await asyncio.to_thread(
            vnext_source_stream_store.commit_question_result,
            context,
            task_id,
            attempt_id=attempt_id,
            lease_owner=lease_owner,
            source_stream_id=stream_id,
            source_fingerprint=payload.source_fingerprint,
            result=result,
        )
    except vnext_question_reader.Q2ReaderError as error:
        if attempt_id is not None and task_id is not None:
            retryable = error.status_code >= 500
            await asyncio.to_thread(
                vnext_task_store.mark_failure,
                context,
                task_id,
                attempt_id,
                error.code,
                retryable=retryable,
                retry_after_seconds=5 if retryable else 0,
                lease_owner=lease_owner,
            )
        raise HTTPException(status_code=error.status_code, detail={"code": error.code, "message": error.message}) from error
    except vnext_source_stream_store.VNextSourceStreamError as error:
        if attempt_id is not None and task_id is not None:
            await asyncio.to_thread(
                vnext_task_store.mark_failure,
                context,
                task_id,
                attempt_id,
                error.code,
                retryable=error.status_code >= 500,
                retry_after_seconds=5 if error.status_code >= 500 else 0,
                lease_owner=lease_owner,
            )
        raise _source_error(error) from error


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


@router.get("/tasks/{task_id}/artifact")
async def get_task_artifact(
    task_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    """Read a completed vNext artifact through the same device/epoch fence."""
    try:
        artifact = await asyncio.to_thread(
            vnext_source_stream_store.load_generated_artifact,
            context,
            task_id,
        )
    except vnext_source_stream_store.VNextSourceStreamError as error:
        raise _source_error(error) from error
    if artifact is None:
        raise HTTPException(status_code=404, detail={
            "code": "TASK_ARTIFACT_NOT_FOUND",
            "message": "任务结果尚未生成",
        })
    return {"schema_version": 2, "artifact": artifact}


@router.get("/tasks/{task_id}/transcript-events")
async def get_transcript_events(
    task_id: str,
    after_event_seq: int = Query(default=0, ge=0, le=9_007_199_254_740_991),
    limit: int = Query(default=256, ge=1, le=1024),
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        snapshot = await asyncio.to_thread(
            vnext_import_transcript_store.get_event_snapshot,
            context,
            task_id,
            after_event_seq=after_event_seq,
            limit=limit,
        )
    except vnext_import_transcript_store.VNextImportTranscriptError as error:
        raise _transcript_error(error) from error
    if snapshot is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "TRANSCRIPT_RUN_NOT_FOUND", "message": "转写任务尚未开始"},
        )
    return snapshot


@router.post("/tasks/{task_id}/transcript-events/ack")
async def ack_transcript_events(
    task_id: str,
    payload: V2TranscriptEventAck,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            vnext_import_transcript_store.ack_events,
            context,
            task_id,
            through_event_seq=payload.through_event_seq,
            projection_sha256=payload.projection_sha256,
        )
    except vnext_import_transcript_store.VNextImportTranscriptError as error:
        raise _transcript_error(error) from error


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(
    task_id: str,
    context: device_v2_identity.DeviceV2Context = Depends(require_device_v2),
) -> dict[str, Any]:
    try:
        task = await asyncio.to_thread(vnext_task_store.get_task, context, task_id)
        if task is not None and task.get("source_stream_id"):
            cancelled = await asyncio.to_thread(
                vnext_source_stream_store.cancel_source_stream,
                context,
                str(task["source_stream_id"]),
            )
        else:
            cancelled = await asyncio.to_thread(vnext_task_store.cancel_task, context, task_id)
    except vnext_task_store.VNextTaskError as error:
        raise _task_error(error) from error
    except vnext_source_stream_store.VNextSourceStreamError as error:
        raise _source_error(error) from error
    if not cancelled:
        raise HTTPException(status_code=409, detail={"code": "TASK_NOT_ACTIVE", "message": "任务已结束或不存在"})
    return {"schema_version": 2, "cancelled": True}
