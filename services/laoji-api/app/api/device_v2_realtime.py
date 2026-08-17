"""Isolated device-v2 realtime ingress with durable audio and event cursors."""

from __future__ import annotations

import asyncio
import hashlib
import json
import struct
from typing import Literal

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.schemas.vnext_contracts import RealtimeChunkHeaderV2
from app.services import (
    device_v2_identity,
    vnext_realtime_crypto,
    vnext_realtime_pipeline,
    vnext_realtime_store,
)


router = APIRouter(prefix="/device/v2", tags=["device-v2-realtime"])

FRAME_MAGIC = b"LJPC"
FRAME_VERSION = 2
FRAME_PREFIX = struct.Struct(">4sBH")
MAX_HEADER_BYTES = 2048
MAX_PCM_BYTES = 1024 * 1024


class RealtimeOpenV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2]
    type: Literal["session.open"]
    task_id: str = Field(min_length=8, max_length=180)
    client_operation_id: str = Field(min_length=8, max_length=180)
    binding_id: str = Field(min_length=8, max_length=180)
    binding_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    binding_revision: int = Field(ge=1)
    cancel_revision: int = Field(ge=0)
    asset_id: str = Field(min_length=1, max_length=180)
    asset_generation: str = Field(pattern=r"^[0-9a-f]{32}$")
    codec_revision: Literal["pcm16-16000-mono-v1"]
    expires_at_epoch: int = Field(ge=1)
    after_event_seq: int = Field(default=0, ge=0)


class RealtimeControlV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[2]
    type: Literal["events.ack", "session.finalize"]
    through_event_seq: int | None = Field(default=None, ge=0)


def _decode_chunk_frame(frame: bytes) -> tuple[RealtimeChunkHeaderV2, bytes]:
    if len(frame) < FRAME_PREFIX.size:
        raise ValueError("realtime_frame_too_short")
    magic, version, header_size = FRAME_PREFIX.unpack_from(frame)
    if magic != FRAME_MAGIC or version != FRAME_VERSION:
        raise ValueError("realtime_frame_version_invalid")
    if not 1 <= header_size <= MAX_HEADER_BYTES:
        raise ValueError("realtime_frame_header_invalid")
    payload_offset = FRAME_PREFIX.size + header_size
    if payload_offset > len(frame):
        raise ValueError("realtime_frame_header_invalid")
    pcm = frame[payload_offset:]
    if not 1 <= len(pcm) <= MAX_PCM_BYTES or len(pcm) % 2:
        raise ValueError("realtime_pcm_invalid")
    try:
        header = RealtimeChunkHeaderV2.model_validate_json(
            frame[FRAME_PREFIX.size:payload_offset]
        )
    except ValidationError as error:
        raise ValueError("realtime_frame_header_invalid") from error
    actual_sha256 = "sha256:" + hashlib.sha256(pcm).hexdigest()
    if header.content_sha256 != actual_sha256:
        raise ValueError("realtime_pcm_hash_mismatch")
    return header, pcm


def _bearer(websocket: WebSocket) -> tuple[str, str, str]:
    authorization = str(websocket.headers.get("authorization") or "").strip()
    scheme, separator, token = authorization.partition(" ")
    device_id = str(websocket.headers.get("x-laoji-device-id") or "").strip()
    epoch_id = str(websocket.headers.get("x-laoji-epoch-id") or "").strip()
    if scheme.lower() != "bearer" or not separator or not token or not device_id or not epoch_id:
        raise device_v2_identity.DeviceV2IdentityError(
            "V2_AUTH_REQUIRED", "需要设备认证", 401,
        )
    return device_id, epoch_id, token


async def _authenticate(websocket: WebSocket) -> tuple[device_v2_identity.DeviceV2Context, tuple[str, str, str]]:
    bearer = _bearer(websocket)
    context = await asyncio.to_thread(device_v2_identity.authenticate_bearer, *bearer)
    return context, bearer


async def _send_store_error(websocket: WebSocket, error: Exception) -> None:
    if isinstance(error, vnext_realtime_store.VNextRealtimeError):
        code, message = error.code, error.message
    elif isinstance(error, device_v2_identity.DeviceV2IdentityError):
        code, message = error.code, error.message
    else:
        code, message = "REALTIME_PROTOCOL_INVALID", "实时转写协议无效"
    await websocket.send_json({"schema_version": 2, "type": "error", "code": code, "message": message})


async def _replay_events(
    websocket: WebSocket,
    snapshot: dict,
) -> None:
    session_id = str(snapshot["session"]["session_id"])
    for event in snapshot["events"]:
        event_seq = int(event["event_seq"])
        identity = f"{session_id}:event:{event_seq}"
        payload = vnext_realtime_crypto.open_event(identity, bytes(event["encrypted_payload"]))
        await websocket.send_json(json.loads(payload.decode("utf-8")))


@router.websocket("/realtime/{session_id}")
async def realtime_websocket(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    pipeline = None
    try:
        context, bearer = await _authenticate(websocket)
        raw_open = await websocket.receive_text()
        opened = RealtimeOpenV2.model_validate_json(raw_open)
        session, reused = await asyncio.to_thread(
            vnext_realtime_store.open_realtime_session,
            context,
            session_id=session_id,
            task_id=opened.task_id,
            client_operation_id=opened.client_operation_id,
            binding_id=opened.binding_id,
            binding_generation=opened.binding_generation,
            binding_revision=opened.binding_revision,
            cancel_revision=opened.cancel_revision,
            asset_id=opened.asset_id,
            asset_generation=opened.asset_generation,
            codec_revision=opened.codec_revision,
            expires_at_epoch=opened.expires_at_epoch,
        )
        snapshot = await asyncio.to_thread(
            vnext_realtime_store.get_realtime_snapshot,
            context,
            session_id,
            after_event_seq=opened.after_event_seq,
        )
        if snapshot is None:
            raise vnext_realtime_store.VNextRealtimeError(
                "REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404,
            )
        await websocket.send_json({
            "schema_version": 2,
            "type": "session.ready",
            "reused": reused,
            "last_contiguous_chunk_seq": int(session["last_contiguous_chunk_seq"]),
            "last_durable_event_seq": int(session["last_durable_event_seq"]),
            "state": session["state"],
        })
        await _replay_events(websocket, snapshot)
        pipeline = vnext_realtime_pipeline.VNextRealtimeTextPipeline(
            context,
            session_id,
            opened.asset_generation,
            websocket.send_json,
        )
        pipeline.start()

        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            # Re-check the short bearer on every durable mutation. A client
            # reconnects with a refreshed token and resumes from both cursors.
            await asyncio.to_thread(device_v2_identity.authenticate_bearer, *bearer)
            frame = message.get("bytes")
            if frame is not None:
                header, pcm = _decode_chunk_frame(frame)
                content_sha256 = "sha256:" + hashlib.sha256(pcm).hexdigest()
                locator = await asyncio.to_thread(
                    vnext_realtime_crypto.seal_chunk,
                    device_id=context.device_id,
                    epoch_id=context.epoch_id,
                    session_id=session_id,
                    chunk_seq=header.chunk_seq,
                    content_sha256=content_sha256,
                    pcm_bytes=pcm,
                )
                ack = await asyncio.to_thread(
                    vnext_realtime_store.append_chunk_checkpoint,
                    context,
                    session_id,
                    chunk_seq=header.chunk_seq,
                    start_ms=header.start_ms,
                    end_ms=header.end_ms,
                    byte_size=len(pcm),
                    content_sha256=content_sha256,
                    encrypted_spool_locator=locator,
                )
                await websocket.send_json({
                    "schema_version": 2,
                    "type": "audio.ack",
                    "chunk_seq": header.chunk_seq,
                    "last_contiguous_chunk_seq": ack["last_contiguous_chunk_seq"],
                    "reused": ack["reused"],
                })
                pipeline.notify_chunk()
                continue
            raw_control = message.get("text")
            if raw_control is None:
                raise ValueError("realtime_message_invalid")
            control = RealtimeControlV2.model_validate_json(raw_control)
            if control.type == "events.ack":
                if control.through_event_seq is None:
                    raise ValueError("realtime_event_ack_invalid")
                ack = await asyncio.to_thread(
                    vnext_realtime_store.acknowledge_events,
                    context,
                    session_id,
                    control.through_event_seq,
                )
                await websocket.send_json({
                    "schema_version": 2,
                    "type": "events.acked",
                    **{key: value for key, value in ack.items() if key != "schema_version"},
                })
            else:
                finalizing = await asyncio.to_thread(
                    vnext_realtime_store.mark_session_finalizing,
                    context,
                    session_id,
                )
                await websocket.send_json({
                    "schema_version": 2,
                    "type": "session.finalizing",
                    "last_contiguous_chunk_seq": finalizing["last_contiguous_chunk_seq"],
                    "last_durable_event_seq": finalizing["last_durable_event_seq"],
                })
                await pipeline.finalize()
                await websocket.send_json({
                    "schema_version": 2,
                    "type": "session.complete",
                })
                return
    except WebSocketDisconnect:
        return
    except device_v2_identity.DeviceV2IdentityError as error:
        await _send_store_error(websocket, error)
        await websocket.close(code=4401)
    except (ValidationError, ValueError, vnext_realtime_store.VNextRealtimeError) as error:
        await _send_store_error(websocket, error)
        await websocket.close(code=4400)
    except Exception:
        await websocket.send_json({
            "schema_version": 2,
            "type": "error",
            "code": "REALTIME_PIPELINE_UNAVAILABLE",
            "message": "实时转写暂时不可用，音频已安全保存",
        })
        await websocket.close(code=1011)
    finally:
        if pipeline is not None:
            await pipeline.close()
