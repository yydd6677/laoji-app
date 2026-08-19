#!/usr/bin/env python3
"""Exercise the isolated device-v2 upload/transcript lifecycle over HTTP.

The probe creates an ephemeral P-256 device identity, uploads one real media
asset using the candidate's presigned R2 contract, waits for durable transcript
events, acknowledges the projection and finally executes the binding purge.
Tokens, private keys, purge secrets and presigned URLs are never written to the
output report.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
from pathlib import Path
import time
import uuid
from urllib import error, request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("media", type=Path)
    parser.add_argument("--api", default="http://127.0.0.1:18021/api/device/v2")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def decode_b64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def json_request(
    url: str,
    *,
    method: str = "GET",
    payload: dict | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict]:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    wire_headers = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        wire_headers["Content-Type"] = "application/json"
    req = request.Request(url, data=body, method=method, headers=wire_headers)
    try:
        with request.urlopen(req, timeout=120) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        raw = exc.read()
        try:
            detail = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            detail = {"error": raw[:200].decode("utf-8", "replace")}
        return exc.code, detail
    except (error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        return 0, {"error": type(reason).__name__}


def require_success(status: int, payload: dict, operation: str) -> dict:
    if not 200 <= status < 300:
        raise RuntimeError(f"{operation} failed: HTTP {status} {json.dumps(payload, ensure_ascii=False)}")
    return payload


def proof_nonce(nonce: bytes, difficulty: int) -> int:
    for value in range(2**32):
        digest = hashlib.sha256(nonce + value.to_bytes(8, "big")).digest()
        if int.from_bytes(digest, "big") >> (256 - difficulty) == 0:
            return value
    raise RuntimeError("proof search exhausted")


def signed_message(
    kind: str,
    nonce_wire: str,
    device_id: str,
    epoch_id: str,
    request_id: str,
    proof: int | None = None,
) -> bytes:
    suffix = "" if proof is None else f"\nproof:{proof}"
    return f"laoji-device-v2\n{kind}\n{nonce_wire}\n{device_id}\n{epoch_id}\n{request_id}{suffix}".encode()


def sha256_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    return size, "sha256:" + digest.hexdigest()


def put_bytes(url: str, payload: bytes) -> str:
    req = request.Request(
        url,
        data=payload,
        method="PUT",
        headers={"Content-Length": str(len(payload))},
    )
    with request.urlopen(req, timeout=300) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f"R2 PUT failed: HTTP {response.status}")
        return str(response.headers.get("ETag") or "").strip()


def upload_media(api: str, auth: dict[str, str], session: dict, media: Path) -> list[dict]:
    if session["mode"] == "single":
        put_bytes(str(session["put_url"]), media.read_bytes())
        return []
    part_size = int(session["part_size"])
    total_parts = int(session["total_parts"])
    status, payload = json_request(
        f"{api}/uploads/{session['session_id']}/parts",
        method="POST",
        headers=auth,
        payload={
            "schema_version": 2,
            "binding_generation": session["binding_generation"],
            "binding_revision": session["binding_revision"],
            "cancel_revision": session["cancel_revision"],
            "part_numbers": list(range(1, total_parts + 1)),
        },
    )
    parts = require_success(status, payload, "presign parts")["parts"]
    receipts = []
    with media.open("rb") as source:
        for item in sorted(parts, key=lambda value: int(value["part_number"])):
            number = int(item["part_number"])
            chunk = source.read(part_size)
            etag = put_bytes(str(item["url"]), chunk)
            if not etag:
                raise RuntimeError(f"R2 part {number} did not return ETag")
            receipts.append({"part_number": number, "etag": etag})
    return receipts


def main() -> int:
    args = parse_args()
    media = args.media.resolve()
    if not media.is_file():
        raise SystemExit(f"media not found: {media}")
    started = time.perf_counter()
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_der = private_key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    public_wire = b64url(public_der)
    device_id = str(uuid.uuid4())
    epoch_id = str(uuid.uuid4())
    bootstrap_request_id = "bootstrap-" + uuid.uuid4().hex
    purge_secret = uuid.uuid4().hex + uuid.uuid4().hex

    status, challenge = json_request(
        f"{args.api}/bootstrap/challenges",
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
        signed_message(
            "bootstrap", challenge["nonce"], device_id, epoch_id,
            bootstrap_request_id, proof,
        ),
        ec.ECDSA(hashes.SHA256()),
    )
    status, completed = json_request(
        f"{args.api}/bootstrap/complete",
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
                "capability_id": str(uuid.uuid4()),
                "secret_sha256": hashlib.sha256(purge_secret.encode()).hexdigest(),
                "registration_request_id": "epoch-purge-" + uuid.uuid4().hex,
            },
        },
    )
    require_success(status, completed, "bootstrap complete")

    auth_request_id = "auth-" + uuid.uuid4().hex
    status, auth_challenge = json_request(
        f"{args.api}/auth/challenges",
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
        f"{args.api}/auth/tokens",
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
    auth_headers = {
        "Authorization": "Bearer " + token["access_token"],
        "X-Laoji-Device-Id": device_id,
        "X-Laoji-Epoch-Id": epoch_id,
    }

    binding_id = str(uuid.uuid4())
    binding_generation = uuid.uuid4().hex
    binding_purge_id = str(uuid.uuid4())
    binding_purge_secret = uuid.uuid4().hex + uuid.uuid4().hex
    status, binding = json_request(
        f"{args.api}/meetings/{binding_id}",
        method="PUT",
        headers=auth_headers,
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

    size, source_sha256 = sha256_file(media)
    session_id = "upload-" + uuid.uuid4().hex
    asset_generation = uuid.uuid4().hex
    status, created = json_request(
        f"{args.api}/uploads",
        method="POST",
        headers=auth_headers,
        payload={
            "schema_version": 2,
            "session_id": session_id,
            "binding_id": binding_id,
            "binding_generation": binding_generation,
            "binding_revision": 1,
            "cancel_revision": 0,
            "client_operation_id": "operation-" + uuid.uuid4().hex,
            "asset_id": "asset-" + uuid.uuid4().hex,
            "asset_generation": asset_generation,
            "expected_size": size,
            "expected_sha256": source_sha256,
            "mime_type": mimetypes.guess_type(media.name)[0] or "application/octet-stream",
        },
    )
    session = require_success(status, created, "create upload")["session"]
    receipts = upload_media(args.api, auth_headers, session, media)
    task_id = "transcript-" + uuid.uuid4().hex
    status, committed = json_request(
        f"{args.api}/uploads/{session_id}/complete",
        method="POST",
        headers=auth_headers,
        payload={
            "schema_version": 2,
            "binding_generation": binding_generation,
            "binding_revision": 1,
            "cancel_revision": 0,
            "parts": receipts,
            "transcription_task_id": task_id,
            "transcription_generation_id": "generation-" + uuid.uuid4().hex,
            "transcription_input_sha256": source_sha256,
        },
    )
    require_success(status, committed, "complete upload")
    transcription_started = time.perf_counter()

    deadline = time.monotonic() + args.timeout_seconds
    snapshot = None
    first_stable_ms = None
    first_stable_source_end_ms = None
    transcription_wall_ms = None
    while time.monotonic() < deadline:
        status, candidate = json_request(
            f"{args.api}/tasks/{task_id}/transcript-events?after_event_seq=0&limit=1024",
            headers=auth_headers,
        )
        if status == 200:
            snapshot = candidate
            stable_events = [
                event
                for event in list(snapshot.get("events") or [])
                if event.get("event_kind") == "stable" and event.get("outcome") == "text"
            ]
            if stable_events and first_stable_ms is None:
                first_stable_ms = round((time.perf_counter() - transcription_started) * 1000)
                first_stable_source_end_ms = int(stable_events[0].get("source_end_ms") or 0)
            if snapshot.get("state") in {"succeeded", "no_content", "failed", "cancelled"}:
                transcription_wall_ms = round((time.perf_counter() - transcription_started) * 1000)
                break
        elif status not in {0, 404}:
            raise RuntimeError(f"event polling failed: HTTP {status} {candidate}")
        time.sleep(0.2)
    if snapshot is None or snapshot.get("state") not in {"succeeded", "no_content"}:
        raise RuntimeError(f"transcription did not succeed: {snapshot}")
    events = list(snapshot.get("events") or [])
    if not events or events[-1].get("event_kind") != "final":
        raise RuntimeError("terminal transcript event missing")
    projection = "sha256:" + hashlib.sha256(
        json.dumps(events, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    status, acknowledged = json_request(
        f"{args.api}/tasks/{task_id}/transcript-events/ack",
        method="POST",
        headers=auth_headers,
        payload={
            "schema_version": 2,
            "through_event_seq": int(snapshot["last_event_seq"]),
            "projection_sha256": projection,
        },
    )
    require_success(status, acknowledged, "ack transcript")

    purge_headers = {
        "Authorization": "LaojiPurge " + binding_purge_secret,
        "X-Laoji-Purge-Request-Id": "purge-" + uuid.uuid4().hex,
    }
    status, purged = json_request(
        f"{args.api}/purge-capabilities/{binding_purge_id}/execute",
        method="POST",
        headers=purge_headers,
    )
    purged = require_success(status, purged, "binding purge")
    report = {
        "media": str(media),
        "source_sha256": source_sha256,
        "source_bytes": size,
        "upload_mode": session["mode"],
        "upload_parts": len(receipts) if receipts else 1,
        "task_state": snapshot["state"],
        "event_count": len(events),
        "stable_event_count": sum(event.get("event_kind") == "stable" for event in events),
        "first_stable_ms": first_stable_ms,
        "first_stable_source_end_ms": first_stable_source_end_ms,
        "transcription_wall_ms": transcription_wall_ms,
        "source_duration_ms": int(events[-1].get("source_end_ms") or 0),
        "transcription_rtf": (
            round(transcription_wall_ms / int(events[-1].get("source_end_ms") or 1), 6)
            if transcription_wall_ms is not None and int(events[-1].get("source_end_ms") or 0) > 0
            else None
        ),
        "final_event_sequence": snapshot["last_event_seq"],
        "model_revision": snapshot.get("model_revision"),
        "acked": acknowledged.get("through_event_seq") == snapshot["last_event_seq"],
        "purge_state": purged.get("state"),
        "wall_ms": round((time.perf_counter() - started) * 1000),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
