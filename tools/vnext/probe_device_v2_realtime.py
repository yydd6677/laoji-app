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
import hashlib
import json
from pathlib import Path
import struct
import time
import uuid
from urllib import request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from probe_device_v2_upload import (
    b64url,
    decode_b64url,
    json_request,
    proof_nonce,
    require_success,
    signed_message,
)


FRAME_PREFIX = struct.Struct(">4sBH")


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("pcm", type=Path)
    parser.add_argument("--api", default="http://127.0.0.1:18021/api/device/v2")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chunk-ms", type=int, default=1000)
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


def bootstrap(api: str) -> tuple[dict[str, str], dict[str, str], str, str]:
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
    return auth, {"purge_id": purge_id, "purge_secret": purge_secret}, device_id, epoch_id


async def receive_until(ws, *, required: str, events: list[dict], timeout: float = 90.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = json.loads(await asyncio.wait_for(ws.recv(), max(0.1, deadline - time.monotonic())))
        if value.get("contract_revision") == "transcript.stream.v2":
            events.append(value)
        if value.get("type") == required:
            return value
        if value.get("type") == "error":
            raise RuntimeError(
                f"candidate realtime error: {value.get('code')} {value.get('message')}"
            )
    raise TimeoutError(f"timed out waiting for {required}")


async def run_probe(pcm: bytes, api: str, chunk_ms: int) -> dict:
    import websockets

    auth, purge, device_id, epoch_id = bootstrap(api)
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
            "binding_epoch_seq": 1,
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
    async with websockets.connect(ws_url, extra_headers=headers, open_timeout=20, close_timeout=10) as ws:
        await ws.send(json.dumps(opened, separators=(",", ":")))
        await receive_until(ws, required="session.ready", events=events)
        for seq, chunk in enumerate(chunks[:interrupted_after]):
            await ws.send(encode_chunk(seq, chunk, seq * chunk_ms))
            await receive_until(ws, required="audio.ack", events=events)
    await asyncio.sleep(0.25)
    opened["after_event_seq"] = max(
        (int(event.get("event_sequence", 0)) for event in events),
        default=0,
    )
    async with websockets.connect(ws_url, extra_headers=headers, open_timeout=20, close_timeout=10) as ws:
        await ws.send(json.dumps(opened, separators=(",", ":")))
        resumed = await receive_until(ws, required="session.ready", events=events)
        resume_seq = max(0, int(resumed.get("last_contiguous_chunk_seq", -1)) + 1)
        for seq in range(resume_seq, len(chunks)):
            chunk = chunks[seq]
            await ws.send(encode_chunk(seq, chunk, seq * chunk_ms))
            await receive_until(ws, required="audio.ack", events=events)
        await ws.send(json.dumps({"schema_version": 2, "type": "session.finalize"}, separators=(",", ":")))
        await receive_until(ws, required="session.complete", events=events, timeout=180)
        terminal = events[-1] if events else {}
        final_seq = max((int(event.get("event_sequence", 0)) for event in events), default=0)
        await ws.send(json.dumps({"schema_version": 2, "type": "events.ack", "through_event_seq": final_seq}))
        if final_seq:
            await receive_until(ws, required="events.acked", events=events)
    status, purged = json_request(
        f"{api}/purge-capabilities/{binding_purge_id}/execute",
        method="POST",
        headers={
            "Authorization": "LaojiPurge " + binding_purge_secret,
            "X-Laoji-Purge-Request-Id": "purge-" + uuid.uuid4().hex,
        },
    )
    require_success(status, purged, "binding purge")
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
        "model_revision": terminal.get("model_revision"),
        "purge_state": purged.get("state"),
        "wall_ms": round((time.perf_counter() - started) * 1000),
        "device_id_sha256": hashlib.sha256(device_id.encode()).hexdigest()[:12],
        "epoch_id_sha256": hashlib.sha256(epoch_id.encode()).hexdigest()[:12],
    }


def main() -> int:
    parsed = args()
    pcm = parsed.pcm.read_bytes()
    if not pcm or len(pcm) % 2:
        raise SystemExit("PCM file must be non-empty signed-int16 mono 16k")
    # The wire timeline is millisecond based (32 bytes per millisecond).  A
    # media decoder may leave a sub-millisecond tail; it cannot form a valid
    # realtime chunk and must not be sent as a zero-duration frame.
    pcm = pcm[: len(pcm) - (len(pcm) % 32)]
    if not pcm:
        raise SystemExit("PCM file is shorter than one millisecond")
    report = asyncio.run(run_probe(pcm, parsed.api, parsed.chunk_ms))
    parsed.output.parent.mkdir(parents=True, exist_ok=True)
    parsed.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
