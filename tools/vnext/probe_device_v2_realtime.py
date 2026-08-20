#!/usr/bin/env python3
"""Real candidate-only device-v2 realtime WebSocket probe.

The probe creates an ephemeral device/epoch and binding, streams PCM chunks
through the candidate realtime contract, reconnects from the durable cursor,
acks the terminal event, and purges the binding.  Reports contain hashes and
counts only; audio text, bearer tokens and raw identifiers are never written.
Requires the server/runtime ``websockets`` dependency (12.x).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import functools
import hashlib
import json
from pathlib import Path
import socket
import struct
import statistics
import time
import uuid
from urllib import request
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from probe_device_v2_upload import (
    b64url,
    decode_b64url,
    execute_purge_and_wait,
    json_request,
    proof_nonce,
    require_success,
    signed_message,
)


FRAME_PREFIX = struct.Struct(">4sBH")
_PROBE_SOURCE_IP: str | None = None


def configure_source_ip(source_ip: str | None) -> None:
    """Use a loopback alias for isolated repeated probes when IP quotas are full."""
    global _PROBE_SOURCE_IP
    _PROBE_SOURCE_IP = str(source_ip).strip() if source_ip else None
    if _PROBE_SOURCE_IP is None:
        return
    original = socket.create_connection

    @functools.wraps(original)
    def create_connection(address, timeout=None, source_address=None, *, all_errors=False):
        host = str(address[0]).strip().lower()
        if source_address is None and (host == "localhost" or host.startswith("127.")):
            source_address = (_PROBE_SOURCE_IP, 0)
        return original(
            address,
            timeout=timeout,
            source_address=source_address,
            all_errors=all_errors,
        )

    socket.create_connection = create_connection


@dataclass(frozen=True)
class BootstrapState:
    auth: dict[str, str]
    purge: dict[str, str]
    device_id: str
    epoch_id: str
    private_key: ec.EllipticCurvePrivateKey
    public_key_hash: str
    key_version: int


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("pcm", type=Path)
    parser.add_argument("--api", default="http://127.0.0.1:18021/api/device/v2")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chunk-ms", type=int, default=1000)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--source-ip", default=None)
    parser.add_argument("--traffic-class", default="isolated-evaluation")
    parser.add_argument(
        "--pace-realtime",
        action="store_true",
        help="send PCM against its source clock instead of saturating the socket",
    )
    return parser.parse_args()


def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def encode_chunk(seq: int, pcm: bytes, start_ms: int) -> bytes:
    if len(pcm) % 2 or not pcm:
        raise ValueError("pcm must contain an even number of bytes")
    end_ms = start_ms + len(pcm) // 32
    header = json.dumps({
        "schema_version": 2,
        "contract_revision": "realtime.chunk.v2",
        "type": "audio.chunk",
        "chunk_seq": seq,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "content_sha256": sha256_bytes(pcm),
    }, separators=(",", ":")).encode("utf-8")
    return FRAME_PREFIX.pack(b"LJPC", 2, len(header)) + header + pcm


def pacing_delay_seconds(
    *,
    audio_started_monotonic: float,
    source_end_ms: int,
    now_monotonic: float,
) -> float:
    target = audio_started_monotonic + max(0, int(source_end_ms)) / 1000.0
    return max(0.0, target - now_monotonic)


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    low = int(position)
    high = min(len(ordered) - 1, low + 1)
    fraction = position - low
    return ordered[low] + (ordered[high] - ordered[low]) * fraction


def bootstrap(api: str) -> BootstrapState:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_der = private_key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    public_wire = b64url(public_der)
    device_id, epoch_id = str(uuid.uuid4()), str(uuid.uuid4())
    bootstrap_request_id = "bootstrap-" + uuid.uuid4().hex
    purge_secret = uuid.uuid4().hex + uuid.uuid4().hex
    status, challenge = json_request(
        f"{api}/bootstrap/challenges",
        method="POST",
        payload={
            "schema_version": 2,
            "device_id": device_id,
            "epoch_id": epoch_id,
            "public_key": public_wire,
            "request_id": bootstrap_request_id,
        },
    )
    challenge = require_success(status, challenge, "bootstrap challenge")
    proof = proof_nonce(decode_b64url(challenge["nonce"]), int(challenge["proof_difficulty_bits"]))
    signature = private_key.sign(
        signed_message("bootstrap", challenge["nonce"], device_id, epoch_id, bootstrap_request_id, proof),
        ec.ECDSA(hashes.SHA256()),
    )
    purge_id = str(uuid.uuid4())
    status, completed = json_request(
        f"{api}/bootstrap/complete",
        method="POST",
        payload={
            "schema_version": 2,
            "device_id": device_id,
            "epoch_id": epoch_id,
            "public_key": public_wire,
            "request_id": bootstrap_request_id,
            "challenge_id": challenge["challenge_id"],
            "nonce": challenge["nonce"],
            "signature": b64url(signature),
            "proof_nonce": proof,
            "purge_capability": {
                "capability_id": purge_id,
                "secret_sha256": hashlib.sha256(purge_secret.encode()).hexdigest(),
                "registration_request_id": "epoch-purge-" + uuid.uuid4().hex,
            },
        },
    )
    require_success(status, completed, "bootstrap complete")

    auth_request_id = "auth-" + uuid.uuid4().hex
    status, auth_challenge = json_request(
        f"{api}/auth/challenges",
        method="POST",
        payload={
            "schema_version": 2,
            "device_id": device_id,
            "epoch_id": epoch_id,
            "key_version": 1,
            "public_key_hash": challenge["public_key_hash"],
            "request_id": auth_request_id,
        },
    )
    auth_challenge = require_success(status, auth_challenge, "auth challenge")
    auth_signature = private_key.sign(
        signed_message("auth", auth_challenge["nonce"], device_id, epoch_id, auth_request_id),
        ec.ECDSA(hashes.SHA256()),
    )
    status, token = json_request(
        f"{api}/auth/tokens",
        method="POST",
        payload={
            "schema_version": 2,
            "challenge_id": auth_challenge["challenge_id"],
            "nonce": auth_challenge["nonce"],
            "signature": b64url(auth_signature),
            "request_id": auth_request_id,
        },
    )
    token = require_success(status, token, "auth token")
    auth = {
        "Authorization": "Bearer " + token["access_token"],
        "X-Laoji-Device-Id": device_id,
        "X-Laoji-Epoch-Id": epoch_id,
    }
    return BootstrapState(
        auth=auth,
        purge={"purge_id": purge_id, "purge_secret": purge_secret},
        device_id=device_id,
        epoch_id=epoch_id,
        private_key=private_key,
        public_key_hash=challenge["public_key_hash"],
        key_version=1,
    )


def refresh_auth(api: str, state: BootstrapState) -> dict[str, str]:
    """Issue a new short-lived bearer for the same device epoch and key."""
    request_id = "refresh-auth-" + uuid.uuid4().hex
    status, challenge = json_request(
        f"{api}/auth/challenges",
        method="POST",
        payload={
            "schema_version": 2,
            "device_id": state.device_id,
            "epoch_id": state.epoch_id,
            "key_version": state.key_version,
            "public_key_hash": state.public_key_hash,
            "request_id": request_id,
        },
    )
    challenge = require_success(status, challenge, "refresh auth challenge")
    signature = state.private_key.sign(
        signed_message("auth", challenge["nonce"], state.device_id, state.epoch_id, request_id),
        ec.ECDSA(hashes.SHA256()),
    )
    status, token = json_request(
        f"{api}/auth/tokens",
        method="POST",
        payload={
            "schema_version": 2,
            "challenge_id": challenge["challenge_id"],
            "nonce": challenge["nonce"],
            "signature": b64url(signature),
            "request_id": request_id,
        },
    )
    token = require_success(status, token, "refresh auth token")
    auth = {
        "Authorization": "Bearer " + token["access_token"],
        "X-Laoji-Device-Id": state.device_id,
        "X-Laoji-Epoch-Id": state.epoch_id,
    }
    traffic_class = state.auth.get("X-Laoji-Traffic-Class")
    if traffic_class:
        auth["X-Laoji-Traffic-Class"] = traffic_class
    return auth


def purge_epoch(api: str, state: BootstrapState) -> dict:
    return execute_purge_and_wait(
        api,
        state.purge["purge_id"],
        state.purge["purge_secret"],
        request_prefix="epoch-purge",
    )


async def receive_until(ws, *, required: str, events: list[dict], timeout: float = 90.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = json.loads(await asyncio.wait_for(ws.recv(), max(0.1, deadline - time.monotonic())))
        if value.get("contract_revision") == "transcript.stream.v2":
            value["_probe_received_monotonic_ms"] = round(time.monotonic() * 1000)
            events.append(value)
        if value.get("type") == required:
            return value
        if value.get("type") == "error":
            raise RuntimeError(
                f"candidate realtime error: {value.get('code')} {value.get('message')}"
            )
    raise TimeoutError(f"timed out waiting for {required}")


async def run_probe(
    pcm: bytes,
    api: str,
    chunk_ms: int,
    *,
    state: BootstrapState | None = None,
    refresh_before_reconnect: bool = True,
    binding_epoch_seq: int = 1,
    pace_realtime: bool = False,
) -> dict:
    import websockets

    state = state or bootstrap(api)
    auth, purge, device_id, epoch_id = state.auth, state.purge, state.device_id, state.epoch_id
    binding_id = str(uuid.uuid4())
    binding_generation = uuid.uuid4().hex
    binding_purge_id = str(uuid.uuid4())
    binding_purge_secret = uuid.uuid4().hex + uuid.uuid4().hex
    status, binding = json_request(
        f"{api}/meetings/{binding_id}",
        method="PUT",
        headers=auth,
        payload={
            "schema_version": 2,
            "binding_generation": binding_generation,
            "binding_epoch_seq": binding_epoch_seq,
            "binding_revision": 1,
            "cancel_revision": 0,
            "purge_capability": {
                "capability_id": binding_purge_id,
                "secret_sha256": hashlib.sha256(binding_purge_secret.encode()).hexdigest(),
                "registration_request_id": "binding-purge-" + uuid.uuid4().hex,
            },
        },
    )
    require_success(status, binding, "register binding")
    session_id = "realtime-" + uuid.uuid4().hex
    task_id = "transcript-" + uuid.uuid4().hex
    operation_id = "operation-" + uuid.uuid4().hex
    asset_id = "asset-" + uuid.uuid4().hex
    asset_generation = uuid.uuid4().hex
    ws_url = api.replace("http://", "ws://").replace("https://", "wss://") + f"/realtime/{session_id}"
    headers = [(key, value) for key, value in auth.items()]
    events: list[dict] = []
    opened = {
        "schema_version": 2,
        "type": "session.open",
        "task_id": task_id,
        "client_operation_id": operation_id,
        "binding_id": binding_id,
        "binding_generation": binding_generation,
        "binding_revision": 1,
        "cancel_revision": 0,
        "asset_id": asset_id,
        "asset_generation": asset_generation,
        "codec_revision": "pcm16-16000-mono-v1",
        "expires_at_epoch": int(time.time()) + 3600,
        "after_event_seq": 0,
    }
    chunk_bytes = max(32, int(chunk_ms) * 32)
    chunks = [pcm[offset:offset + chunk_bytes] for offset in range(0, len(pcm), chunk_bytes)]
    started = time.perf_counter()
    # Deliberately drop the first socket after a prefix of chunks.  The second
    # socket resumes from the server's durable chunk/event cursors, exercising
    # the same boundary used by Android after a network interruption.
    interrupted_after = max(1, len(chunks) // 2)
    socket_kwargs = {"local_addr": (_PROBE_SOURCE_IP, 0)} if _PROBE_SOURCE_IP else {}
    audio_started_monotonic: float | None = None
    async with websockets.connect(
        ws_url,
        extra_headers=headers,
        open_timeout=20,
        close_timeout=10,
        **socket_kwargs,
    ) as ws:
        await ws.send(json.dumps(opened, separators=(",", ":")))
        await receive_until(ws, required="session.ready", events=events)
        audio_started_monotonic = time.monotonic()
        for seq, chunk in enumerate(chunks[:interrupted_after]):
            await ws.send(encode_chunk(seq, chunk, seq * chunk_ms))
            await receive_until(ws, required="audio.ack", events=events)
            if pace_realtime:
                delay = pacing_delay_seconds(
                    audio_started_monotonic=audio_started_monotonic,
                    source_end_ms=(seq * chunk_ms) + len(chunk) // 32,
                    now_monotonic=time.monotonic(),
                )
                if delay:
                    await asyncio.sleep(delay)
        await asyncio.sleep(0.25)
    # Refresh the bearer before reconnecting. The session, binding and durable
    # cursors remain unchanged; only the in-memory authorization headers move
    # to the newly issued token.
    if refresh_before_reconnect:
        auth = refresh_auth(api, state)
    headers = [(key, value) for key, value in auth.items()]
    opened["after_event_seq"] = max(
        (int(event.get("event_sequence", 0)) for event in events),
        default=0,
    )
    async with websockets.connect(
        ws_url,
        extra_headers=headers,
        open_timeout=20,
        close_timeout=10,
        **socket_kwargs,
    ) as ws:
        await ws.send(json.dumps(opened, separators=(",", ":")))
        resumed = await receive_until(ws, required="session.ready", events=events)
        resume_seq = max(0, int(resumed.get("last_contiguous_chunk_seq", -1)) + 1)
        for seq in range(resume_seq, len(chunks)):
            chunk = chunks[seq]
            await ws.send(encode_chunk(seq, chunk, seq * chunk_ms))
            await receive_until(ws, required="audio.ack", events=events)
            if pace_realtime:
                assert audio_started_monotonic is not None
                delay = pacing_delay_seconds(
                    audio_started_monotonic=audio_started_monotonic,
                    source_end_ms=(seq * chunk_ms) + len(chunk) // 32,
                    now_monotonic=time.monotonic(),
                )
                if delay:
                    await asyncio.sleep(delay)
        await ws.send(json.dumps({"schema_version": 2, "type": "session.finalize"}, separators=(",", ":")))
        await receive_until(ws, required="session.complete", events=events, timeout=180)
        terminal = events[-1] if events else {}
        final_seq = max((int(event.get("event_sequence", 0)) for event in events), default=0)
        await ws.send(json.dumps({"schema_version": 2, "type": "events.ack", "through_event_seq": final_seq}))
        if final_seq:
            await receive_until(ws, required="events.acked", events=events)
    purged = execute_purge_and_wait(
        api,
        binding_purge_id,
        binding_purge_secret,
        request_prefix="purge",
    )
    stable_lag_ms = []
    if pace_realtime and audio_started_monotonic is not None:
        audio_started_ms = audio_started_monotonic * 1000
        stable_lag_ms = [
            max(
                0.0,
                float(event["_probe_received_monotonic_ms"])
                - audio_started_ms
                - float(event.get("source_end_ms") or 0),
            )
            for event in events
            if event.get("event_kind") == "stable"
            and isinstance(event.get("_probe_received_monotonic_ms"), int)
        ]
    return {
        "source_sha256": sha256_bytes(pcm),
        "source_bytes": len(pcm),
        "chunk_count": (len(pcm) + chunk_bytes - 1) // chunk_bytes,
        "interrupted_after_chunk": interrupted_after,
        "resumed_from_chunk": resume_seq,
        "event_count": len(events),
        "stable_event_count": sum(event.get("event_kind") == "stable" for event in events),
        "final_outcome": terminal.get("outcome"),
        "final_event_sequence": int(terminal.get("event_sequence", 0)),
        "token_refresh_before_reconnect": True,
        "paced_realtime": pace_realtime,
        "stable_lag_ms": {
            "count": len(stable_lag_ms),
            "p50": round(percentile(stable_lag_ms, 0.50) or 0, 1) if stable_lag_ms else None,
            "p95": round(percentile(stable_lag_ms, 0.95) or 0, 1) if stable_lag_ms else None,
            "max": round(max(stable_lag_ms), 1) if stable_lag_ms else None,
        },
        "model_revision": terminal.get("model_revision"),
        "purge_state": purged.get("state"),
        "wall_ms": round((time.perf_counter() - started) * 1000),
        "device_id_sha256": hashlib.sha256(device_id.encode()).hexdigest()[:12],
        "epoch_id_sha256": hashlib.sha256(epoch_id.encode()).hexdigest()[:12],
    }


async def run_repeated(
    pcm: bytes,
    api: str,
    chunk_ms: int,
    repeat: int,
    *,
    pace_realtime: bool = False,
    state: BootstrapState | None = None,
) -> dict:
    if repeat < 1:
        raise ValueError("repeat_must_be_positive")
    state = state or bootstrap(api)
    runs = [
        await run_probe(
            pcm,
            api,
            chunk_ms,
            state=state,
            refresh_before_reconnect=False,
            binding_epoch_seq=index + 1,
            pace_realtime=pace_realtime,
        )
        for index in range(repeat)
    ]
    wall = [int(item["wall_ms"]) for item in runs]
    return {
        "count": len(runs),
        "wall_ms": wall,
        "p50_ms": statistics.median(wall),
        "p95_ms": max(wall),
        "stable_event_count_min": min(int(item["stable_event_count"]) for item in runs),
        "final_outcomes": sorted({str(item["final_outcome"]) for item in runs}),
        "runs": runs,
    }


def main() -> int:
    parsed = args()
    configure_source_ip(getattr(parsed, "source_ip", None))
    pcm = parsed.pcm.read_bytes()
    if not pcm or len(pcm) % 2:
        raise SystemExit("PCM file must be non-empty signed-int16 mono 16k")
    # The wire timeline is millisecond based (32 bytes per millisecond).  A
    # media decoder may leave a sub-millisecond tail; it cannot form a valid
    # realtime chunk and must not be sent as a zero-duration frame.
    pcm = pcm[: len(pcm) - (len(pcm) % 32)]
    if not pcm:
        raise SystemExit("PCM file is shorter than one millisecond")
    state = bootstrap(parsed.api)
    state.auth["X-Laoji-Traffic-Class"] = parsed.traffic_class
    if parsed.repeat == 1:
        report = asyncio.run(run_probe(
            pcm,
            parsed.api,
            parsed.chunk_ms,
            state=state,
            pace_realtime=parsed.pace_realtime,
        ))
    else:
        report = asyncio.run(run_repeated(
            pcm,
            parsed.api,
            parsed.chunk_ms,
            parsed.repeat,
            pace_realtime=parsed.pace_realtime,
            state=state,
        ))
    report["epoch_purge_state"] = purge_epoch(parsed.api, state).get("state")
    parsed.output.parent.mkdir(parents=True, exist_ok=True)
    parsed.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
