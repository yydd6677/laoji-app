from __future__ import annotations

import hashlib
import json
import struct
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.api import device_v2_realtime
from app.services.device_v2_identity import DeviceV2Context


def frame(chunk_seq: int, pcm: bytes, *, digest: str | None = None) -> bytes:
    header = json.dumps(
        {
            "schema_version": 2,
            "contract_revision": "realtime.chunk.v2",
            "type": "audio.chunk",
            "chunk_seq": chunk_seq,
            "start_ms": chunk_seq * 100,
            "end_ms": (chunk_seq + 1) * 100,
            "content_sha256": digest or "sha256:" + hashlib.sha256(pcm).hexdigest(),
        },
        separators=(",", ":"),
    ).encode()
    return struct.pack(">4sBH", b"LJPC", 2, len(header)) + header + pcm


def test_chunk_frame_requires_exact_pcm_hash() -> None:
    pcm = b"\x01\x00" * 1600
    header, decoded = device_v2_realtime._decode_chunk_frame(frame(0, pcm))
    assert header.chunk_seq == 0
    assert decoded == pcm

    try:
        device_v2_realtime._decode_chunk_frame(frame(0, pcm, digest="sha256:" + "0" * 64))
    except ValueError as error:
        assert str(error) == "realtime_pcm_hash_mismatch"
    else:
        raise AssertionError("mismatched realtime PCM hash was accepted")

    malformed = bytearray(frame(0, pcm))
    prefix_size = struct.calcsize(">4sBH")
    _, _, header_size = struct.unpack_from(">4sBH", malformed)
    header_payload = json.loads(
        bytes(malformed[prefix_size:prefix_size + header_size]).decode()
    )
    header_payload["end_ms"] = 200
    encoded = json.dumps(header_payload, separators=(",", ":")).encode()
    malformed = bytearray(struct.pack(">4sBH", b"LJPC", 2, len(encoded)) + encoded + pcm)
    try:
        device_v2_realtime._decode_chunk_frame(bytes(malformed))
    except ValueError as error:
        assert str(error) == "realtime_pcm_timeline_mismatch"
    else:
        raise AssertionError("PCM duration mismatch was accepted")


def test_realtime_websocket_is_fail_closed_without_capability(monkeypatch) -> None:
    monkeypatch.delenv("LAOJI_VNEXT_REALTIME_V2_ENABLED", raising=False)
    app = FastAPI()
    app.include_router(device_v2_realtime.router, prefix="/api")
    client = TestClient(app)
    with client.websocket_connect("/api/device/v2/realtime/disabled-session") as websocket:
        assert websocket.receive_json() == {
            "schema_version": 2,
            "type": "error",
            "code": "REALTIME_V2_DISABLED",
            "message": "实时转写候选链路尚未启用",
        }


@pytest.mark.asyncio
async def test_realtime_replay_pages_to_fixed_durable_cursor(monkeypatch) -> None:
    context = DeviceV2Context("device-1", "epoch-1", 1, 1)
    events = [
        {"event_seq": index, "encrypted_payload": str(index).encode()}
        for index in range(1, 301)
    ]

    def snapshot(_context, _session_id, *, after_event_seq, limit):
        page = [event for event in events if event["event_seq"] > after_event_seq][:limit]
        return {"session": {"session_id": "session-1"}, "events": page}

    monkeypatch.setattr(
        device_v2_realtime.vnext_realtime_store, "get_realtime_snapshot", snapshot,
    )
    monkeypatch.setattr(
        device_v2_realtime.vnext_realtime_crypto,
        "open_event",
        lambda _identity, payload: json.dumps({"event_seq": int(payload)}).encode(),
    )

    class Socket:
        def __init__(self):
            self.events = []

        async def send_json(self, payload):
            self.events.append(payload)

    socket = Socket()
    await device_v2_realtime._replay_events(
        socket,
        context,
        "session-1",
        after_event_seq=0,
        through_event_seq=300,
    )
    assert [event["event_seq"] for event in socket.events] == list(range(1, 301))


def test_realtime_websocket_persists_before_ack(monkeypatch) -> None:
    monkeypatch.setenv("LAOJI_VNEXT_REALTIME_V2_ENABLED", "1")
    context = DeviceV2Context("device-1", "epoch-1", 1, 1)
    calls: list[str] = []

    class Pipeline:
        def __init__(self, *_args, **_kwargs):
            pass

        def start(self):
            calls.append("pipeline-start")

        def notify_chunk(self):
            calls.append("pipeline-notify")

        def ensure_available(self):
            return None

        async def finalize(self):
            calls.append("pipeline-finalize")

        async def close(self):
            calls.append("pipeline-close")

    monkeypatch.setattr(
        device_v2_realtime.vnext_realtime_pipeline,
        "VNextRealtimeTextPipeline",
        Pipeline,
    )

    monkeypatch.setattr(
        device_v2_realtime.device_v2_identity,
        "authenticate_bearer",
        lambda *_args: context,
    )
    monkeypatch.setattr(
        device_v2_realtime.vnext_task_store,
        "claim_attempt",
        lambda *_args, **_kwargs: {"attempt_id": "transcription-attempt-1"},
    )

    def open_session(_context, **kwargs):
        calls.append("open")
        return {
            "session_id": kwargs["session_id"],
            "last_contiguous_chunk_seq": -1,
            "last_durable_event_seq": 0,
            "state": "open",
        }, False

    monkeypatch.setattr(device_v2_realtime.vnext_realtime_store, "open_realtime_session", open_session)
    monkeypatch.setattr(
        device_v2_realtime.vnext_realtime_store,
        "get_realtime_snapshot",
        lambda *_args, **_kwargs: {
            "session": {
                "session_id": "realtime-session-1",
                "last_durable_event_seq": 0,
            },
            "events": [],
        },
    )
    monkeypatch.setattr(
        device_v2_realtime.vnext_realtime_store,
        "claim_realtime_worker",
        lambda *_args, **_kwargs: {
            "session_id": "realtime-session-1",
            "task_id": "transcription-task-1",
            "last_contiguous_chunk_seq": -1,
            "last_durable_event_seq": 0,
            "state": "open",
        },
    )

    def seal_chunk(**_kwargs):
        calls.append("sealed")
        return "chunk:" + "a" * 64

    def append_chunk(_context, _session_id, **kwargs):
        assert calls[-1] == "sealed"
        calls.append("persisted")
        return {
            "last_contiguous_chunk_seq": kwargs["chunk_seq"],
            "reused": False,
        }

    monkeypatch.setattr(device_v2_realtime.vnext_realtime_crypto, "seal_chunk", seal_chunk)
    monkeypatch.setattr(device_v2_realtime.vnext_realtime_store, "append_chunk_checkpoint", append_chunk)
    monkeypatch.setattr(
        device_v2_realtime.vnext_realtime_store,
        "mark_session_finalizing",
        lambda *_args, **_kwargs: {
            "last_contiguous_chunk_seq": 0,
            "last_durable_event_seq": 0,
        },
    )
    monkeypatch.setattr(
        device_v2_realtime.vnext_realtime_store,
        "acknowledge_events",
        lambda *_args, **_kwargs: {
            "schema_version": 2,
            "session_id": "realtime-session-1",
            "acked_through": 0,
            "last_durable_event_seq": 0,
            "server_payload_released": True,
        },
    )

    app = FastAPI()
    app.include_router(device_v2_realtime.router, prefix="/api")
    client = TestClient(app)
    headers = {
        "Authorization": "Bearer dv2.test",
        "X-Laoji-Device-Id": context.device_id,
        "X-Laoji-Epoch-Id": context.epoch_id,
    }
    with client.websocket_connect(
        "/api/device/v2/realtime/realtime-session-1",
        headers=headers,
    ) as websocket:
        websocket.send_json({
            "schema_version": 2,
            "type": "session.open",
            "task_id": "transcription-task-1",
            "client_operation_id": "realtime-operation-1",
            "binding_id": "binding-1",
            "binding_generation": "a" * 32,
            "binding_revision": 1,
            "cancel_revision": 0,
            "asset_id": "asset-1",
            "asset_generation": "b" * 32,
            "codec_revision": "pcm16-16000-mono-v1",
            "expires_at_epoch": int(time.time()) + 900,
            "after_event_seq": 0,
        })
        assert websocket.receive_json()["type"] == "session.ready"
        pcm = b"\x01\x00" * 1600
        websocket.send_bytes(frame(0, pcm))
        ack = websocket.receive_json()
        assert calls[-1] == "pipeline-notify"
        assert ack == {
            "schema_version": 2,
            "type": "audio.ack",
            "chunk_seq": 0,
            "last_contiguous_chunk_seq": 0,
            "reused": False,
        }
        websocket.send_json({"schema_version": 2, "type": "session.finalize"})
        assert websocket.receive_json()["type"] == "session.finalizing"
        assert websocket.receive_json()["type"] == "session.complete"
        websocket.send_json({
            "schema_version": 2,
            "type": "events.ack",
            "through_event_seq": 0,
        })
        assert websocket.receive_json()["type"] == "events.acked"
