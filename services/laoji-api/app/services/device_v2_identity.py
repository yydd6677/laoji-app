"""Device-v2 identity and short-lived bearer implementation.

This module owns challenge, key, epoch and token state; it never stores
meeting content. Device-v1 ownership projection remains an explicit
compatibility boundary until its current mobile callers move to v2 tokens.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import sqlite3
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.exceptions import InvalidSignature

from app.services.device_identity import control_connection, ensure_device_schema, valid_uuid


BOOTSTRAP_DIFFICULTY_BITS = 18
CHALLENGE_TTL_SECONDS = 60
TOKEN_TTL_SECONDS = 15 * 60
MAX_PUBLIC_KEY_BYTES = 512
MAX_SIGNATURE_BYTES = 256


class DeviceV2IdentityError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 401):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class DeviceV2Context:
    device_id: str
    epoch_id: str
    key_version: int
    token_revision: int


def _now() -> int:
    return int(time.time())


def _b64decode(value: str, field: str, maximum: int) -> bytes:
    raw = str(value or "").strip()
    if not raw or len(raw) > maximum * 2:
        raise DeviceV2IdentityError("V2_INPUT_INVALID", f"{field}无效", 422)
    try:
        decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except (ValueError, TypeError) as error:
        raise DeviceV2IdentityError("V2_INPUT_INVALID", f"{field}无效", 422) from error
    if not decoded or len(decoded) > maximum:
        raise DeviceV2IdentityError("V2_INPUT_INVALID", f"{field}无效", 422)
    return decoded


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _identifier(value: str, field: str, maximum: int = 180) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized or len(normalized) > maximum or any(ord(char) < 32 or ord(char) == 127 for char in normalized):
        raise DeviceV2IdentityError("V2_INPUT_INVALID", f"{field}无效", 422)
    return normalized


def _public_key(value: str) -> tuple[bytes, str]:
    der = _b64decode(value, "public_key", MAX_PUBLIC_KEY_BYTES)
    try:
        key = serialization.load_der_public_key(der)
    except ValueError as error:
        raise DeviceV2IdentityError("PUBLIC_KEY_INVALID", "设备公钥无效", 422) from error
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
        raise DeviceV2IdentityError("PUBLIC_KEY_INVALID", "仅支持 P-256 设备公钥", 422)
    canonical = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return canonical, hashlib.sha256(canonical).hexdigest()


def _signature(value: str) -> bytes:
    return _b64decode(value, "signature", MAX_SIGNATURE_BYTES)


def _nonce(value: str) -> bytes:
    return _b64decode(value, "nonce", 64)


def _message(kind: str, nonce: bytes, device_id: str, epoch_id: str, request_id: str, proof_nonce: int | None = None) -> bytes:
    suffix = "" if proof_nonce is None else f"\nproof:{proof_nonce}"
    return f"laoji-device-v2\n{kind}\n{_b64encode(nonce)}\n{device_id}\n{epoch_id}\n{request_id}{suffix}".encode("utf-8")


def _verify_signature(public_key_der: bytes, signature: bytes, message: bytes) -> None:
    try:
        key = serialization.load_der_public_key(public_key_der)
        if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
            raise ValueError("curve")
        key.verify(signature, message, ec.ECDSA(hashes.SHA256()))
    except (InvalidSignature, ValueError, TypeError) as error:
        raise DeviceV2IdentityError("SIGNATURE_INVALID", "设备签名校验失败", 401) from error


def _pow_valid(nonce: bytes, proof_nonce: int, difficulty_bits: int) -> bool:
    if not isinstance(proof_nonce, int) or proof_nonce < 0 or proof_nonce > 2**63 - 1:
        return False
    digest = hashlib.sha256(nonce + proof_nonce.to_bytes(8, "big", signed=False)).digest()
    return int.from_bytes(digest, "big") >> (256 - difficulty_bits) == 0


def _challenge_id() -> str:
    return f"ch_{uuid.uuid4().hex}"


def ensure_v2_schema() -> None:
    ensure_device_schema()
    with control_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS v2_devices (
                device_id TEXT PRIMARY KEY,
                current_epoch_id TEXT,
                current_key_version INTEGER NOT NULL DEFAULT 1,
                token_revision INTEGER NOT NULL DEFAULT 1,
                revoked_at INTEGER,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS v2_device_keys (
                device_id TEXT NOT NULL,
                key_version INTEGER NOT NULL,
                public_key_der BLOB NOT NULL,
                public_key_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                retired_at INTEGER,
                PRIMARY KEY(device_id, key_version),
                UNIQUE(device_id, public_key_hash)
            );
            CREATE TABLE IF NOT EXISTS v2_device_epochs (
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active','closed')),
                last_authenticated_at INTEGER,
                created_at INTEGER NOT NULL,
                closed_at INTEGER,
                PRIMARY KEY(device_id, epoch_id)
            );
            CREATE TABLE IF NOT EXISTS v2_auth_challenges (
                challenge_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK(kind IN ('bootstrap','auth')),
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                key_version INTEGER,
                public_key_hash TEXT NOT NULL,
                nonce_hash TEXT NOT NULL,
                nonce_b64 TEXT,
                proof_difficulty_bits INTEGER NOT NULL DEFAULT 0,
                request_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                consumed_at INTEGER,
                UNIQUE(kind, request_id)
            );
            CREATE TABLE IF NOT EXISTS v2_tokens (
                token_hash TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                key_version INTEGER NOT NULL,
                token_revision INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                revoked_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS v2_rate_buckets (
                bucket_key TEXT PRIMARY KEY,
                window_started_at INTEGER NOT NULL,
                request_count INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS v2_bootstrap_receipts (
                request_id TEXT PRIMARY KEY,
                request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
                response_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            """
        )
        challenge_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(v2_auth_challenges)").fetchall()
        }
        if "nonce_b64" not in challenge_columns:
            connection.execute("ALTER TABLE v2_auth_challenges ADD COLUMN nonce_b64 TEXT")
        connection.commit()
    from app.services.vnext_purge_store import ensure_purge_schema

    ensure_purge_schema()


def _consume_rate(connection: sqlite3.Connection, bucket_key: str, *, limit: int, window_seconds: int, now: int) -> None:
    row = connection.execute(
        "SELECT window_started_at, request_count FROM v2_rate_buckets WHERE bucket_key = ?",
        (bucket_key,),
    ).fetchone()
    if row is None or now - int(row["window_started_at"]) >= window_seconds:
        connection.execute(
            "INSERT INTO v2_rate_buckets(bucket_key, window_started_at, request_count) VALUES (?, ?, 1) "
            "ON CONFLICT(bucket_key) DO UPDATE SET window_started_at = excluded.window_started_at, request_count = 1",
            (bucket_key, now),
        )
        return
    count = int(row["request_count"])
    if count >= limit:
        raise DeviceV2IdentityError("RATE_LIMITED", "设备认证请求过于频繁，请稍后重试", 429)
    connection.execute(
        "UPDATE v2_rate_buckets SET request_count = request_count + 1 WHERE bucket_key = ?",
        (bucket_key,),
    )


def create_bootstrap_challenge(
    *, device_id: str, epoch_id: str, public_key_der: str, request_id: str, rate_key: str = "direct",
) -> dict[str, Any]:
    ensure_v2_schema()
    device_id = _identifier(device_id, "device_id")
    epoch_id = _identifier(epoch_id, "epoch_id")
    if not valid_uuid(device_id) or not valid_uuid(epoch_id):
        raise DeviceV2IdentityError("V2_INPUT_INVALID", "设备或 epoch 标识无效", 422)
    key_der, key_hash = _public_key(public_key_der)
    request_id = _identifier(request_id, "request_id", 160)
    now = _now()
    nonce = secrets.token_bytes(32)
    challenge_id = _challenge_id()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT * FROM v2_auth_challenges WHERE kind = 'bootstrap' AND request_id = ?",
            (request_id,),
        ).fetchone()
        if existing is not None:
            if (
                existing["device_id"] != device_id
                or existing["epoch_id"] != epoch_id
                or existing["public_key_hash"] != key_hash
            ):
                connection.rollback()
                raise DeviceV2IdentityError("REQUEST_ID_CONFLICT", "注册请求标识已绑定其他内容", 409)
            if int(existing["expires_at"]) <= now or not existing["nonce_b64"]:
                connection.rollback()
                raise DeviceV2IdentityError("CHALLENGE_EXPIRED", "注册挑战已过期，请使用新的请求标识", 410)
            connection.commit()
            return {
                "schema_version": 2,
                "challenge_id": str(existing["challenge_id"]),
                "nonce": str(existing["nonce_b64"]),
                "expires_at": int(existing["expires_at"]),
                "proof_difficulty_bits": int(existing["proof_difficulty_bits"]),
                "public_key_hash": key_hash,
            }
        _consume_rate(connection, f"bootstrap:ip:{_identifier(rate_key, 'rate_key', 160)}", limit=3, window_seconds=86_400, now=now)
        _consume_rate(connection, "bootstrap:global", limit=20, window_seconds=86_400, now=now)
        connection.execute(
            """INSERT INTO v2_auth_challenges(
               challenge_id, kind, device_id, epoch_id, key_version,
               public_key_hash, nonce_hash, nonce_b64, proof_difficulty_bits, request_id,
               created_at, expires_at
            ) VALUES (?, 'bootstrap', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)""",
            (
                challenge_id, device_id, epoch_id, key_hash,
                hashlib.sha256(nonce).hexdigest(), _b64encode(nonce), BOOTSTRAP_DIFFICULTY_BITS,
                request_id, now, now + CHALLENGE_TTL_SECONDS,
            ),
        )
        connection.commit()
    return {
        "schema_version": 2,
        "challenge_id": challenge_id,
        "nonce": _b64encode(nonce),
        "expires_at": now + CHALLENGE_TTL_SECONDS,
        "proof_difficulty_bits": BOOTSTRAP_DIFFICULTY_BITS,
        "public_key_hash": key_hash,
    }


def complete_bootstrap(
    *, challenge_id: str, nonce: str, device_id: str, epoch_id: str,
    public_key_der: str, signature: str, proof_nonce: int, request_id: str,
    purge_capability_id: str, purge_secret_sha256: str,
    purge_registration_request_id: str,
) -> dict[str, Any]:
    ensure_v2_schema()
    challenge_id = _identifier(challenge_id, "challenge_id")
    device_id = _identifier(device_id, "device_id")
    epoch_id = _identifier(epoch_id, "epoch_id")
    request_id = _identifier(request_id, "request_id", 160)
    nonce_bytes = _nonce(nonce)
    key_der, key_hash = _public_key(public_key_der)
    signature_bytes = _signature(signature)
    now = _now()
    request_sha256 = hashlib.sha256("\n".join([
        "laoji-bootstrap-complete-v2", challenge_id, device_id, epoch_id,
        key_hash, request_id, nonce, signature, str(proof_nonce), purge_capability_id,
        purge_secret_sha256, purge_registration_request_id,
    ]).encode("utf-8")).hexdigest()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        receipt = connection.execute(
            "SELECT request_sha256, response_json FROM v2_bootstrap_receipts WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        if receipt is not None:
            if not secrets.compare_digest(str(receipt["request_sha256"]), request_sha256):
                connection.rollback()
                raise DeviceV2IdentityError("REQUEST_ID_CONFLICT", "注册完成请求标识已绑定其他内容", 409)
            connection.commit()
            return json.loads(str(receipt["response_json"]))
        row = connection.execute(
            "SELECT * FROM v2_auth_challenges WHERE challenge_id = ? AND kind = 'bootstrap'",
            (challenge_id,),
        ).fetchone()
        if row is None or row["consumed_at"] is not None or int(row["expires_at"]) <= now:
            connection.rollback()
            raise DeviceV2IdentityError("CHALLENGE_EXPIRED", "注册挑战已过期", 410)
        if (
            row["device_id"] != device_id or row["epoch_id"] != epoch_id
            or row["public_key_hash"] != key_hash
            or row["request_id"] != request_id
            or not secrets.compare_digest(str(row["nonce_hash"]), hashlib.sha256(nonce_bytes).hexdigest())
        ):
            connection.rollback()
            raise DeviceV2IdentityError("CHALLENGE_MISMATCH", "注册挑战与设备身份不匹配", 409)
        if not _pow_valid(nonce_bytes, proof_nonce, int(row["proof_difficulty_bits"])):
            connection.rollback()
            raise DeviceV2IdentityError("PROOF_OF_WORK_INVALID", "注册工作量证明无效", 429)
        _verify_signature(key_der, signature_bytes, _message("bootstrap", nonce_bytes, device_id, epoch_id, request_id, proof_nonce))
        existing = connection.execute("SELECT * FROM v2_devices WHERE device_id = ?", (device_id,)).fetchone()
        if existing is not None:
            current = connection.execute(
                "SELECT public_key_hash FROM v2_device_keys WHERE device_id = ? AND key_version = ?",
                (device_id, int(existing["current_key_version"])),
            ).fetchone()
            if current is not None and current["public_key_hash"] != key_hash:
                connection.rollback()
                raise DeviceV2IdentityError("DEVICE_ALREADY_REGISTERED", "设备已登记其他密钥", 409)
            current_epoch_id = str(existing["current_epoch_id"] or "")
            if current_epoch_id and current_epoch_id != epoch_id:
                current_epoch = connection.execute(
                    "SELECT status FROM v2_device_epochs WHERE device_id = ? AND epoch_id = ?",
                    (device_id, current_epoch_id),
                ).fetchone()
                if current_epoch is not None and current_epoch["status"] == "active":
                    connection.rollback()
                    raise DeviceV2IdentityError("EPOCH_ROTATION_REQUIRED", "请先清理当前数据域再创建新数据域", 409)
        else:
            connection.execute(
                "INSERT INTO v2_devices(device_id, current_epoch_id, created_at) VALUES (?, ?, ?)",
                (device_id, epoch_id, now),
            )
            connection.execute(
                "INSERT INTO v2_device_keys(device_id, key_version, public_key_der, public_key_hash, created_at) VALUES (?, 1, ?, ?, ?)",
                (device_id, key_der, key_hash, now),
            )
        epoch = connection.execute(
            "SELECT status FROM v2_device_epochs WHERE device_id = ? AND epoch_id = ?",
            (device_id, epoch_id),
        ).fetchone()
        if epoch is not None and epoch["status"] != "active":
            connection.rollback()
            raise DeviceV2IdentityError("EPOCH_CLOSED", "数据域已清理且不能复用", 410)
        if epoch is None:
            connection.execute(
                "INSERT INTO v2_device_epochs(device_id, epoch_id, status, created_at) VALUES (?, ?, 'active', ?)",
                (device_id, epoch_id, now),
            )
        from app.services import vnext_purge_store

        try:
            purge_capability = vnext_purge_store.register_capability(
                connection,
                scope_kind="epoch",
                capability_id=purge_capability_id,
                device_id=device_id,
                epoch_id=epoch_id,
                secret_sha256=purge_secret_sha256,
                registration_request_id=purge_registration_request_id,
            )
        except vnext_purge_store.VNextPurgeError as error:
            connection.rollback()
            raise DeviceV2IdentityError(error.code, error.message, error.status_code) from error
        connection.execute(
            "UPDATE v2_devices SET current_epoch_id = ?, current_key_version = 1, token_revision = 1 WHERE device_id = ?",
            (epoch_id, device_id),
        )
        connection.execute(
            "UPDATE v2_auth_challenges SET consumed_at = ?, nonce_b64 = NULL WHERE challenge_id = ?",
            (now, challenge_id),
        )
        response = {
            "schema_version": 2,
            "device_id": device_id,
            "epoch_id": epoch_id,
            "key_version": 1,
            "token_revision": 1,
            "registered": True,
            "purge_capability": purge_capability,
        }
        connection.execute(
            "INSERT INTO v2_bootstrap_receipts(request_id, request_sha256, response_json, created_at) VALUES (?, ?, ?, ?)",
            (request_id, request_sha256, json.dumps(response, sort_keys=True, separators=(",", ":")), now),
        )
        connection.commit()
    return response


def create_auth_challenge(*, device_id: str, epoch_id: str, key_version: int, public_key_hash: str, request_id: str) -> dict[str, Any]:
    ensure_v2_schema()
    device_id = _identifier(device_id, "device_id")
    epoch_id = _identifier(epoch_id, "epoch_id")
    request_id = _identifier(request_id, "request_id", 160)
    if not valid_uuid(device_id) or not valid_uuid(epoch_id) or not isinstance(key_version, int) or key_version < 1:
        raise DeviceV2IdentityError("V2_INPUT_INVALID", "设备身份参数无效", 422)
    public_key_hash = _identifier(public_key_hash, "public_key_hash", 128)
    now = _now()
    nonce = secrets.token_bytes(32)
    challenge_id = _challenge_id()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT * FROM v2_auth_challenges WHERE kind = 'auth' AND request_id = ?",
            (request_id,),
        ).fetchone()
        if existing is not None:
            if (
                existing["device_id"] != device_id
                or existing["epoch_id"] != epoch_id
                or int(existing["key_version"]) != key_version
                or existing["public_key_hash"] != public_key_hash
            ):
                connection.rollback()
                raise DeviceV2IdentityError("REQUEST_ID_CONFLICT", "认证请求标识已绑定其他内容", 409)
            if int(existing["expires_at"]) <= now or not existing["nonce_b64"]:
                connection.rollback()
                raise DeviceV2IdentityError("CHALLENGE_EXPIRED", "认证挑战已过期，请使用新的请求标识", 410)
            connection.commit()
            return {
                "schema_version": 2,
                "challenge_id": str(existing["challenge_id"]),
                "nonce": str(existing["nonce_b64"]),
                "expires_at": int(existing["expires_at"]),
                "key_version": key_version,
            }
        _consume_rate(connection, f"auth:{device_id}:{epoch_id}", limit=30, window_seconds=60, now=now)
        device = connection.execute("SELECT * FROM v2_devices WHERE device_id = ? AND revoked_at IS NULL", (device_id,)).fetchone()
        key = connection.execute(
            "SELECT public_key_hash FROM v2_device_keys WHERE device_id = ? AND key_version = ? AND retired_at IS NULL",
            (device_id, key_version),
        ).fetchone()
        epoch = connection.execute(
            "SELECT status FROM v2_device_epochs WHERE device_id = ? AND epoch_id = ?",
            (device_id, epoch_id),
        ).fetchone()
        if device is None or key is None or key["public_key_hash"] != public_key_hash or epoch is None or epoch["status"] != "active":
            connection.rollback()
            raise DeviceV2IdentityError("DEVICE_NOT_REGISTERED", "设备密钥或数据域不可用", 401)
        connection.execute(
            """INSERT INTO v2_auth_challenges(
               challenge_id, kind, device_id, epoch_id, key_version,
               public_key_hash, nonce_hash, nonce_b64, proof_difficulty_bits, request_id,
               created_at, expires_at
            ) VALUES (?, 'auth', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)""",
            (
                challenge_id, device_id, epoch_id, key_version, public_key_hash,
                hashlib.sha256(nonce).hexdigest(), _b64encode(nonce), request_id, now, now + CHALLENGE_TTL_SECONDS,
            ),
        )
        connection.commit()
    return {
        "schema_version": 2,
        "challenge_id": challenge_id,
        "nonce": _b64encode(nonce),
        "expires_at": now + CHALLENGE_TTL_SECONDS,
        "key_version": key_version,
    }


def rotate_key(
    *, context: DeviceV2Context, request_id: str, new_public_key_der: str,
    old_signature: str, new_signature: str,
) -> dict[str, Any]:
    """Atomically add a new P-256 key and revoke all prior bearer tokens."""
    ensure_v2_schema()
    request_id = _identifier(request_id, "request_id", 160)
    new_der, new_hash = _public_key(new_public_key_der)
    old_sig = _signature(old_signature)
    new_sig = _signature(new_signature)
    now = _now()
    message = _message(
        "rotate",
        hashlib.sha256(f"{context.device_id}\n{context.epoch_id}\n{request_id}\n{new_hash}".encode()).digest(),
        context.device_id,
        context.epoch_id,
        request_id,
        context.key_version,
    )
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        device = connection.execute(
            "SELECT current_key_version, token_revision, revoked_at FROM v2_devices WHERE device_id = ?",
            (context.device_id,),
        ).fetchone()
        old = connection.execute(
            "SELECT public_key_der FROM v2_device_keys WHERE device_id = ? AND key_version = ? AND retired_at IS NULL",
            (context.device_id, context.key_version),
        ).fetchone()
        if device is None or device["revoked_at"] is not None or old is None or int(device["current_key_version"]) != context.key_version:
            connection.rollback()
            raise DeviceV2IdentityError("KEY_ROTATION_STALE", "设备密钥版本已变化", 409)
        _verify_signature(bytes(old["public_key_der"]), old_sig, message)
        _verify_signature(new_der, new_sig, message)
        next_version = int(device["current_key_version"]) + 1
        connection.execute(
            "UPDATE v2_device_keys SET retired_at = ? WHERE device_id = ? AND key_version = ?",
            (now, context.device_id, context.key_version),
        )
        connection.execute(
            "INSERT INTO v2_device_keys(device_id, key_version, public_key_der, public_key_hash, created_at) VALUES (?, ?, ?, ?, ?)",
            (context.device_id, next_version, new_der, new_hash, now),
        )
        next_revision = int(device["token_revision"]) + 1
        connection.execute(
            "UPDATE v2_devices SET current_key_version = ?, token_revision = ? WHERE device_id = ?",
            (next_version, next_revision, context.device_id),
        )
        connection.execute(
            "UPDATE v2_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
            (now, context.device_id),
        )
        connection.commit()
    return {
        "schema_version": 2,
        "device_id": context.device_id,
        "epoch_id": context.epoch_id,
        "key_version": next_version,
        "token_revision": next_revision,
    }


def exchange_auth_token(*, challenge_id: str, nonce: str, signature: str, request_id: str) -> dict[str, Any]:
    ensure_v2_schema()
    challenge_id = _identifier(challenge_id, "challenge_id")
    request_id = _identifier(request_id, "request_id", 160)
    nonce_bytes = _nonce(nonce)
    signature_bytes = _signature(signature)
    now = _now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM v2_auth_challenges WHERE challenge_id = ? AND kind = 'auth'",
            (challenge_id,),
        ).fetchone()
        if row is None or row["consumed_at"] is not None or int(row["expires_at"]) <= now:
            connection.rollback()
            raise DeviceV2IdentityError("CHALLENGE_EXPIRED", "认证挑战已过期", 410)
        if row["request_id"] != request_id or not secrets.compare_digest(str(row["nonce_hash"]), hashlib.sha256(nonce_bytes).hexdigest()):
            connection.rollback()
            raise DeviceV2IdentityError("CHALLENGE_MISMATCH", "认证挑战不匹配", 409)
        key = connection.execute(
            "SELECT public_key_der FROM v2_device_keys WHERE device_id = ? AND key_version = ? AND public_key_hash = ? AND retired_at IS NULL",
            (row["device_id"], int(row["key_version"]), row["public_key_hash"]),
        ).fetchone()
        device = connection.execute("SELECT token_revision FROM v2_devices WHERE device_id = ? AND revoked_at IS NULL", (row["device_id"],)).fetchone()
        epoch = connection.execute(
            "SELECT status FROM v2_device_epochs WHERE device_id = ? AND epoch_id = ?",
            (row["device_id"], row["epoch_id"]),
        ).fetchone()
        if key is None or device is None or epoch is None or epoch["status"] != "active":
            connection.rollback()
            raise DeviceV2IdentityError("DEVICE_NOT_REGISTERED", "设备密钥不可用", 401)
        _verify_signature(bytes(key["public_key_der"]), signature_bytes, _message("auth", nonce_bytes, row["device_id"], row["epoch_id"], request_id))
        token = f"dv2.{_b64encode(secrets.token_bytes(32))}"
        expires_at = now + TOKEN_TTL_SECONDS
        connection.execute(
            "INSERT INTO v2_tokens(token_hash, device_id, epoch_id, key_version, token_revision, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                hashlib.sha256(token.encode("ascii")).hexdigest(), row["device_id"], row["epoch_id"],
                int(row["key_version"]), int(device["token_revision"]), now, expires_at,
            ),
        )
        connection.execute(
            "UPDATE v2_auth_challenges SET consumed_at = ?, nonce_b64 = NULL WHERE challenge_id = ?",
            (now, challenge_id),
        )
        connection.execute(
            "UPDATE v2_device_epochs SET last_authenticated_at = ? WHERE device_id = ? AND epoch_id = ?",
            (now, row["device_id"], row["epoch_id"]),
        )
        connection.commit()
    return {
        "schema_version": 2,
        "access_token": token,
        "token_type": "Bearer",
        "expires_at": expires_at,
        "device_id": row["device_id"],
        "epoch_id": row["epoch_id"],
        "key_version": int(row["key_version"]),
        "token_revision": int(device["token_revision"]),
    }


def authenticate_bearer(device_id: str, epoch_id: str, token: str) -> DeviceV2Context:
    ensure_v2_schema()
    device_id = _identifier(device_id, "device_id")
    epoch_id = _identifier(epoch_id, "epoch_id")
    token = str(token or "").strip()
    if not token.startswith("dv2.") or len(token) > 256:
        raise DeviceV2IdentityError("BEARER_INVALID", "设备令牌无效", 401)
    now = _now()
    with control_connection() as connection:
        row = connection.execute(
            """SELECT token.key_version, token.token_revision, token.expires_at,
                      device.token_revision AS current_token_revision,
                      epoch.status
                FROM v2_tokens token
                 INNER JOIN v2_devices device ON device.device_id = token.device_id
                 INNER JOIN v2_device_epochs epoch ON epoch.device_id = token.device_id AND epoch.epoch_id = token.epoch_id
                WHERE token.token_hash = ? AND token.device_id = ? AND token.epoch_id = ?
                  AND token.revoked_at IS NULL AND device.revoked_at IS NULL""",
            (hashlib.sha256(token.encode("ascii", "ignore")).hexdigest(), device_id, epoch_id),
        ).fetchone()
    if row is None or row["status"] != "active" or int(row["expires_at"]) <= now or int(row["token_revision"]) != int(row["current_token_revision"]):
        raise DeviceV2IdentityError("BEARER_INVALID", "设备令牌已失效", 401)
    return DeviceV2Context(device_id, epoch_id, int(row["key_version"]), int(row["token_revision"]))
