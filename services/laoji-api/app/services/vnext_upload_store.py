"""Device-owned R2 upload, verified asset and cleanup ledger."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from typing import Any, Iterable, Literal, Protocol

from app.config import settings
from app.services import r2_storage_service, vnext_task_store
from app.services.device_identity import control_connection, utc_now


MAX_OBJECT_BYTES = 1024 * 1024 * 1024
MAX_DEVICE_ACTIVE_UPLOADS = 2
MAX_GLOBAL_ACTIVE_UPLOADS = 4
MAX_DEVICE_RESERVED_BYTES = 2 * 1024 * 1024 * 1024
MAX_GLOBAL_RESERVED_BYTES = 4 * 1024 * 1024 * 1024
MAX_DEVICE_CLEANUP_ROWS = 4096
MAX_GLOBAL_CLEANUP_ROWS = 16384
SINGLE_UPLOAD_THRESHOLD = 32 * 1024 * 1024

class UploadOwnerContext(Protocol):
    device_id: str
    epoch_id: str


class VNextUploadError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _safe(value: str, field: str, maximum: int = 512) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > maximum or any(ord(char) < 32 or ord(char) == 127 for char in normalized):
        raise VNextUploadError("IDENTIFIER_INVALID", f"{field}无效", 422)
    return normalized


def _generation(value: str, field: str) -> str:
    normalized = _safe(value, field, 32).lower()
    if len(normalized) != 32:
        raise VNextUploadError("GENERATION_INVALID", f"{field}无效", 422)
    try:
        int(normalized, 16)
    except ValueError as error:
        raise VNextUploadError("GENERATION_INVALID", f"{field}无效", 422) from error
    return normalized


def _sha256(value: str, field: str = "expected_sha256") -> str:
    normalized = _safe(value, field, 71).lower()
    if not normalized.startswith("sha256:") or len(normalized) != 71:
        raise VNextUploadError("HASH_INVALID", f"{field}无效", 422)
    try:
        int(normalized[7:], 16)
    except ValueError as error:
        raise VNextUploadError("HASH_INVALID", f"{field}无效", 422) from error
    return normalized


def _positive(value: int, field: str, maximum: int = 9_007_199_254_740_991) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > maximum:
        raise VNextUploadError("VALUE_INVALID", f"{field}无效", 422)
    return value


def _nonnegative(value: int, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise VNextUploadError("VALUE_INVALID", f"{field}无效", 422)
    return value


def _request_sha256(value: dict[str, Any]) -> str:
    canonical = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _object_digest(context: UploadOwnerContext, binding_id: str, session_id: str) -> str:
    key = settings.SECRET_KEY.encode("utf-8")
    body = f"vnext-upload\0{context.device_id}\0{context.epoch_id}\0{binding_id}\0{session_id}".encode("utf-8")
    return hmac.new(key, body, hashlib.sha256).hexdigest()


def _object_key(object_digest: str) -> str:
    prefix = str(getattr(settings, "R2_OBJECT_PREFIX", "vnext-staging") or "").strip().strip("/")
    if (
        not prefix
        or len(prefix) > 120
        or ".." in prefix.split("/")
        or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", part) for part in prefix.split("/"))
    ):
        raise VNextUploadError("R2_PREFIX_INVALID", "R2 对象前缀无效", 500)
    return f"{prefix}/{object_digest[:2]}/{object_digest}"


def _decode_session(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "session_id": row["session_id"],
        "binding_id": row["binding_id"],
        "binding_generation": row["binding_generation"],
        "binding_revision": int(row["binding_revision"]),
        "cancel_revision": int(row["cancel_revision"]),
        "client_operation_id": row["client_operation_id"],
        "asset_id": row["asset_id"],
        "asset_generation": row["asset_generation"],
        "expected_size": int(row["expected_size"]),
        "expected_sha256": row["expected_sha256"],
        "mime_type": row["mime_type"],
        "mode": row["mode"],
        "part_size": int(row["part_size"]),
        "total_parts": int(row["total_parts"]),
        "state": "consumed" if row["consumed_at"] is not None else row["state"],
        "expires_at": int(row["expires_at"]),
        "verified_asset_id": row["verified_asset_id"],
        "transcription_task_id": row["transcription_task_id"],
    }


def ensure_vnext_upload_schema() -> None:
    vnext_task_store.ensure_vnext_task_schema()
    with control_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS vnext_capacity_reservations (
                reservation_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                resource_kind TEXT NOT NULL CHECK(resource_kind = 'r2_staging'),
                owner_kind TEXT NOT NULL CHECK(owner_kind = 'upload_session'),
                owner_id TEXT NOT NULL,
                reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes >= 1),
                state TEXT NOT NULL CHECK(state IN ('active','releasing','released')),
                created_at_epoch INTEGER NOT NULL,
                released_at_epoch INTEGER,
                UNIQUE(resource_kind, owner_kind, owner_id)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_capacity_active
                ON vnext_capacity_reservations(state, device_id, epoch_id);

            CREATE TABLE IF NOT EXISTS vnext_upload_sessions (
                session_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
                cancel_revision INTEGER NOT NULL CHECK(cancel_revision >= 0),
                client_operation_id TEXT NOT NULL,
                asset_id TEXT NOT NULL,
                asset_generation TEXT NOT NULL,
                expected_size INTEGER NOT NULL CHECK(expected_size >= 1 AND expected_size <= 1073741824),
                expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256) = 71),
                mime_type TEXT NOT NULL,
                mode TEXT NOT NULL CHECK(mode IN ('single','multipart')),
                object_key_hmac TEXT NOT NULL,
                multipart_upload_id TEXT,
                part_size INTEGER NOT NULL,
                total_parts INTEGER NOT NULL,
                last_presign_expires_at_epoch INTEGER,
                request_sha256 TEXT NOT NULL,
                reservation_id TEXT NOT NULL REFERENCES vnext_capacity_reservations(reservation_id),
                verified_asset_id TEXT,
                transcription_task_id TEXT,
                state TEXT NOT NULL CHECK(state IN (
                    'provisioning','active','completing','verified',
                    'cleanup_pending','cancelled','expired'
                )),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                created_at_epoch INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                completed_at TEXT,
                consumed_at TEXT,
                UNIQUE(device_id, epoch_id, client_operation_id),
                UNIQUE(device_id, epoch_id, asset_id, asset_generation)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_upload_recovery
                ON vnext_upload_sessions(state, expires_at, session_id);

            CREATE TABLE IF NOT EXISTS vnext_upload_parts (
                session_id TEXT NOT NULL REFERENCES vnext_upload_sessions(session_id) ON DELETE CASCADE,
                part_number INTEGER NOT NULL CHECK(part_number >= 1),
                last_presigned_at_epoch INTEGER NOT NULL,
                PRIMARY KEY(session_id, part_number)
            );

            CREATE TABLE IF NOT EXISTS vnext_verified_assets (
                asset_revision_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                binding_revision INTEGER NOT NULL,
                cancel_revision INTEGER NOT NULL,
                asset_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                byte_size INTEGER NOT NULL,
                source_sha256 TEXT NOT NULL,
                sealed_locator TEXT NOT NULL,
                object_revision INTEGER NOT NULL DEFAULT 1 CHECK(object_revision >= 1),
                reservation_id TEXT NOT NULL REFERENCES vnext_capacity_reservations(reservation_id),
                state TEXT NOT NULL CHECK(state IN ('sealed','consumed','cleanup_pending')),
                activated_at TEXT NOT NULL,
                UNIQUE(device_id, epoch_id, binding_id, asset_id, generation)
            );

            CREATE TABLE IF NOT EXISTS vnext_object_cleanup_obligations (
                obligation_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                binding_revision INTEGER NOT NULL,
                cancel_revision INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                opaque_object_ref TEXT NOT NULL,
                multipart_upload_id TEXT,
                reservation_id TEXT NOT NULL,
                terminal_session_state TEXT NOT NULL CHECK(terminal_session_state IN ('cancelled','expired')),
                not_before_epoch INTEGER NOT NULL,
                claim_until_epoch INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL CHECK(state IN ('pending','running','confirmed')),
                last_error_code TEXT,
                created_at TEXT NOT NULL,
                confirmed_at TEXT,
                cleanup_reason TEXT NOT NULL DEFAULT 'cancelled'
                    CHECK(cleanup_reason IN ('cancelled','expired','consumed')),
                UNIQUE(session_id)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_cleanup_ready
                ON vnext_object_cleanup_obligations(state, not_before_epoch, obligation_id);
            """
        )
        verified_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(vnext_verified_assets)").fetchall()
        }
        if "object_revision" not in verified_columns:
            connection.execute(
                "ALTER TABLE vnext_verified_assets ADD COLUMN object_revision INTEGER NOT NULL DEFAULT 1"
            )
        upload_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(vnext_upload_sessions)").fetchall()
        }
        if "consumed_at" not in upload_columns:
            connection.execute("ALTER TABLE vnext_upload_sessions ADD COLUMN consumed_at TEXT")
        cleanup_columns = {
            str(row[1])
            for row in connection.execute(
                "PRAGMA table_info(vnext_object_cleanup_obligations)"
            ).fetchall()
        }
        if "cleanup_reason" not in cleanup_columns:
            connection.execute(
                "ALTER TABLE vnext_object_cleanup_obligations "
                "ADD COLUMN cleanup_reason TEXT NOT NULL DEFAULT 'cancelled'"
            )
        connection.commit()


def _binding(connection: Any, context: UploadOwnerContext, binding_id: str) -> Any:
    return connection.execute(
        """SELECT * FROM vnext_bindings
           WHERE device_id = ? AND epoch_id = ? AND binding_id = ?""",
        (context.device_id, context.epoch_id, binding_id),
    ).fetchone()


def _assert_binding(
    connection: Any,
    context: UploadOwnerContext,
    *,
    binding_id: str,
    binding_generation: str,
    binding_revision: int,
    cancel_revision: int,
) -> Any:
    binding = _binding(connection, context, binding_id)
    if binding is None or str(binding["binding_generation"]) != binding_generation:
        raise VNextUploadError("BINDING_REQUIRED", "会议服务连接未登记", 428)
    if str(binding["state"]) != "active":
        raise VNextUploadError("BINDING_PURGING", "会议服务连接正在清理", 409)
    if int(binding["binding_revision"]) != binding_revision or int(binding["cancel_revision"]) != cancel_revision:
        raise VNextUploadError("BINDING_REVISION_CHANGED", "会议服务连接版本已变化", 409)
    return binding


def _session_row(connection: Any, context: UploadOwnerContext, session_id: str) -> Any:
    return connection.execute(
        """SELECT * FROM vnext_upload_sessions
           WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
        (session_id, context.device_id, context.epoch_id),
    ).fetchone()


def _session_payload(
    row: Any,
    *,
    put_url: str | None = None,
    object_completed: bool = False,
    uploaded_parts: Iterable[r2_storage_service.R2Part] = (),
) -> dict[str, Any]:
    decoded = _decode_session(row)
    assert decoded is not None
    decoded["schema_version"] = 2
    decoded["put_url"] = put_url
    decoded["object_completed"] = object_completed
    decoded["uploaded_parts"] = [
        {"part_number": part.part_number, "etag": part.etag}
        for part in uploaded_parts
    ]
    return decoded


def upload_enabled() -> bool:
    return r2_storage_service.r2_enabled()


def create_upload_session(
    context: UploadOwnerContext,
    *,
    session_id: str,
    binding_id: str,
    binding_generation: str,
    binding_revision: int,
    cancel_revision: int,
    client_operation_id: str,
    asset_id: str,
    asset_generation: str,
    expected_size: int,
    expected_sha256: str,
    mime_type: str,
    now_epoch: int | None = None,
) -> tuple[dict[str, Any], bool]:
    ensure_vnext_upload_schema()
    if not r2_storage_service.r2_enabled():
        raise VNextUploadError("UPLOAD_STORAGE_UNAVAILABLE", "录音上传服务暂不可用", 503)
    session_id = _safe(session_id, "session_id", 180)
    binding_id = _safe(binding_id, "binding_id", 180)
    binding_generation = _generation(binding_generation, "binding_generation")
    binding_revision = _positive(binding_revision, "binding_revision")
    cancel_revision = _nonnegative(cancel_revision, "cancel_revision")
    client_operation_id = _safe(client_operation_id, "client_operation_id", 180)
    asset_id = _safe(asset_id, "asset_id", 180)
    asset_generation = _generation(asset_generation, "asset_generation")
    if not isinstance(expected_size, int) or isinstance(expected_size, bool) or expected_size < 1:
        raise VNextUploadError("VALUE_INVALID", "expected_size无效", 422)
    if expected_size > MAX_OBJECT_BYTES:
        raise VNextUploadError("UPLOAD_TOO_LARGE", "录音文件不能超过 1 GiB", 413)
    expected_sha256 = _sha256(expected_sha256)
    mime_type = _safe(mime_type, "mime_type", 160).lower()
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    request_sha256 = _request_sha256({
        "session_id": session_id,
        "binding_id": binding_id,
        "binding_generation": binding_generation,
        "binding_revision": binding_revision,
        "cancel_revision": cancel_revision,
        "client_operation_id": client_operation_id,
        "asset_id": asset_id,
        "asset_generation": asset_generation,
        "expected_size": expected_size,
        "expected_sha256": expected_sha256,
        "mime_type": mime_type,
    })
    mode = "single" if expected_size < SINGLE_UPLOAD_THRESHOLD else "multipart"
    part_size = max(5 * 1024 * 1024, int(settings.R2_PART_SIZE))
    total_parts = 1 if mode == "single" else (expected_size + part_size - 1) // part_size
    reservation_id = f"upload:{session_id}"
    object_digest = _object_digest(context, binding_id, session_id)
    expires_at = now_epoch + int(settings.R2_UPLOAD_SESSION_TTL_HOURS) * 3600
    now = utc_now()

    created = False
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _assert_binding(
            connection, context,
            binding_id=binding_id,
            binding_generation=binding_generation,
            binding_revision=binding_revision,
            cancel_revision=cancel_revision,
        )
        existing = _session_row(connection, context, session_id)
        if existing is None:
            existing = connection.execute(
                """SELECT * FROM vnext_upload_sessions
                   WHERE device_id = ? AND epoch_id = ? AND client_operation_id = ?""",
                (context.device_id, context.epoch_id, client_operation_id),
            ).fetchone()
        if existing is not None:
            if str(existing["request_sha256"]) != request_sha256:
                connection.rollback()
                raise VNextUploadError("UPLOAD_SESSION_CONFLICT", "上传请求标识已用于其他录音", 409)
            connection.commit()
            row = existing
        else:
            active_device = int(connection.execute(
                """SELECT COUNT(*) FROM vnext_upload_sessions
                   WHERE device_id = ? AND epoch_id = ?
                     AND state IN ('provisioning','active','completing')""",
                (context.device_id, context.epoch_id),
            ).fetchone()[0])
            active_global = int(connection.execute(
                """SELECT COUNT(*) FROM vnext_upload_sessions
                   WHERE state IN ('provisioning','active','completing')"""
            ).fetchone()[0])
            reserved_device = int(connection.execute(
                """SELECT COALESCE(SUM(reserved_bytes), 0) FROM vnext_capacity_reservations
                   WHERE device_id = ? AND epoch_id = ? AND state IN ('active','releasing')""",
                (context.device_id, context.epoch_id),
            ).fetchone()[0])
            reserved_global = int(connection.execute(
                """SELECT COALESCE(SUM(reserved_bytes), 0) FROM vnext_capacity_reservations
                   WHERE state IN ('active','releasing')"""
            ).fetchone()[0])
            cleanup_device = int(connection.execute(
                """SELECT COUNT(*) FROM vnext_object_cleanup_obligations
                   WHERE device_id = ? AND epoch_id = ? AND state <> 'confirmed'""",
                (context.device_id, context.epoch_id),
            ).fetchone()[0]) + active_device
            cleanup_global = int(connection.execute(
                "SELECT COUNT(*) FROM vnext_object_cleanup_obligations WHERE state <> 'confirmed'"
            ).fetchone()[0]) + active_global
            if active_device >= MAX_DEVICE_ACTIVE_UPLOADS or active_global >= MAX_GLOBAL_ACTIVE_UPLOADS:
                connection.rollback()
                raise VNextUploadError("UPLOAD_CAPACITY_BUSY", "上传任务较多，请稍后重试", 429)
            if reserved_device + expected_size > MAX_DEVICE_RESERVED_BYTES or reserved_global + expected_size > MAX_GLOBAL_RESERVED_BYTES:
                connection.rollback()
                raise VNextUploadError("UPLOAD_CAPACITY_BYTES", "云端暂存空间不足，请稍后重试", 429)
            if cleanup_device >= MAX_DEVICE_CLEANUP_ROWS or cleanup_global >= MAX_GLOBAL_CLEANUP_ROWS:
                connection.rollback()
                raise VNextUploadError("CLEANUP_CAPACITY_BUSY", "云端清理队列繁忙，请稍后重试", 429)
            connection.execute(
                """INSERT INTO vnext_capacity_reservations(
                     reservation_id, device_id, epoch_id, resource_kind, owner_kind,
                     owner_id, reserved_bytes, state, created_at_epoch
                   ) VALUES (?, ?, ?, 'r2_staging', 'upload_session', ?, ?, 'active', ?)""",
                (reservation_id, context.device_id, context.epoch_id, session_id, expected_size, now_epoch),
            )
            connection.execute(
                """INSERT INTO vnext_upload_sessions(
                     session_id, device_id, epoch_id, binding_id, binding_generation,
                     binding_revision, cancel_revision, client_operation_id,
                     asset_id, asset_generation, expected_size, expected_sha256,
                     mime_type, mode, object_key_hmac, multipart_upload_id,
                     part_size, total_parts, request_sha256, reservation_id,
                     state, created_at, updated_at, created_at_epoch, expires_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
                             ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?)""",
                (
                    session_id, context.device_id, context.epoch_id, binding_id,
                    binding_generation, binding_revision, cancel_revision,
                    client_operation_id, asset_id, asset_generation, expected_size,
                    expected_sha256, mime_type, mode, object_digest, part_size,
                    total_parts, request_sha256, reservation_id, now, now,
                    now_epoch, expires_at,
                ),
            )
            row = _session_row(connection, context, session_id)
            connection.commit()
            created = True

    assert row is not None
    object_key = _object_key(str(row["object_key_hmac"]))
    put_url: str | None = None
    try:
        if str(row["state"]) == "provisioning":
            if str(row["mode"]) == "single":
                upload_id = f"single:{session_id}"
                put_url = r2_storage_service.presign_put_object(object_key=object_key)
            else:
                upload_id = str(row["multipart_upload_id"] or "")
                if not upload_id:
                    candidates = r2_storage_service.find_multipart_uploads(object_key=object_key)
                    upload_id = candidates[0] if candidates else r2_storage_service.create_multipart_upload(
                        object_key=object_key,
                        mime_type=mime_type,
                    )
            presign_expiry = now_epoch + int(settings.R2_PRESIGN_TTL_SECONDS) if put_url else None
            with control_connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """UPDATE vnext_upload_sessions
                       SET multipart_upload_id = ?, state = 'active',
                           last_presign_expires_at_epoch = COALESCE(?, last_presign_expires_at_epoch),
                           updated_at = ?
                       WHERE session_id = ? AND state = 'provisioning'""",
                    (upload_id, presign_expiry, utc_now(), session_id),
                )
                row = _session_row(connection, context, session_id)
                connection.commit()
        elif str(row["mode"]) == "single" and str(row["state"]) == "active":
            put_url = r2_storage_service.presign_put_object(object_key=object_key)
            with control_connection() as connection:
                connection.execute(
                    """UPDATE vnext_upload_sessions
                       SET last_presign_expires_at_epoch = MAX(COALESCE(last_presign_expires_at_epoch, 0), ?),
                           updated_at = ? WHERE session_id = ?""",
                    (now_epoch + int(settings.R2_PRESIGN_TTL_SECONDS), utc_now(), session_id),
                )
                connection.commit()
                row = _session_row(connection, context, session_id)
    except Exception as error:
        raise VNextUploadError("UPLOAD_STORAGE_UNAVAILABLE", "录音上传服务暂不可用", 503) from error
    assert row is not None
    return _session_payload(row, put_url=put_url), not created


def get_upload_session(context: UploadOwnerContext, session_id: str, *, probe: bool = True) -> dict[str, Any] | None:
    ensure_vnext_upload_schema()
    session_id = _safe(session_id, "session_id", 180)
    with control_connection() as connection:
        row = _session_row(connection, context, session_id)
    if row is None:
        return None
    uploaded_parts: list[r2_storage_service.R2Part] = []
    object_completed = False
    if probe and row["state"] in {"active", "completing"}:
        object_key = _object_key(str(row["object_key_hmac"]))
        try:
            object_completed = r2_storage_service.object_head(object_key=object_key) is not None
            if not object_completed and row["mode"] == "multipart" and row["multipart_upload_id"]:
                uploaded_parts = r2_storage_service.list_uploaded_parts(
                    object_key=object_key,
                    upload_id=str(row["multipart_upload_id"]),
                )
        except Exception as error:
            raise VNextUploadError(
                "UPLOAD_STORAGE_UNAVAILABLE", "录音上传状态暂时无法查询", 503,
            ) from error
    return _session_payload(
        row,
        object_completed=object_completed,
        uploaded_parts=uploaded_parts,
    )


def presign_upload_parts(
    context: UploadOwnerContext,
    session_id: str,
    *,
    binding_generation: str,
    binding_revision: int,
    cancel_revision: int,
    part_numbers: list[int],
    now_epoch: int | None = None,
) -> dict[str, Any]:
    ensure_vnext_upload_schema()
    session_id = _safe(session_id, "session_id", 180)
    binding_generation = _generation(binding_generation, "binding_generation")
    binding_revision = _positive(binding_revision, "binding_revision")
    cancel_revision = _nonnegative(cancel_revision, "cancel_revision")
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    if not part_numbers or len(part_numbers) > 256 or len(set(part_numbers)) != len(part_numbers):
        raise VNextUploadError("UPLOAD_PARTS_INVALID", "上传分片请求无效", 422)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _session_row(connection, context, session_id)
        if row is None:
            connection.rollback()
            raise VNextUploadError("UPLOAD_SESSION_NOT_FOUND", "上传任务不存在", 404)
        _assert_binding(
            connection, context,
            binding_id=str(row["binding_id"]),
            binding_generation=binding_generation,
            binding_revision=binding_revision,
            cancel_revision=cancel_revision,
        )
        if str(row["binding_generation"]) != binding_generation or row["mode"] != "multipart" or row["state"] != "active":
            connection.rollback()
            raise VNextUploadError("UPLOAD_SESSION_NOT_ACTIVE", "上传任务当前不能签发分片", 409)
        total_parts = int(row["total_parts"])
        if any(not isinstance(number, int) or isinstance(number, bool) or number < 1 or number > total_parts for number in part_numbers):
            connection.rollback()
            raise VNextUploadError("UPLOAD_PARTS_INVALID", "上传分片序号无效", 422)
        connection.commit()
    object_key = _object_key(str(row["object_key_hmac"]))
    try:
        all_urls = r2_storage_service.presign_upload_parts(
            object_key=object_key,
            upload_id=str(row["multipart_upload_id"]),
            total_parts=total_parts,
        )
    except Exception as error:
        raise VNextUploadError(
            "UPLOAD_STORAGE_UNAVAILABLE", "录音上传分片暂时无法签发", 503,
        ) from error
    selected = [item for item in all_urls if int(item["part_number"]) in set(part_numbers)]
    expires_at = now_epoch + int(settings.R2_PRESIGN_TTL_SECONDS)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = _session_row(connection, context, session_id)
        if current is None or current["state"] != "active" or int(current["cancel_revision"]) != cancel_revision:
            connection.rollback()
            raise VNextUploadError("UPLOAD_SESSION_NOT_ACTIVE", "上传任务状态已变化", 409)
        for number in part_numbers:
            connection.execute(
                """INSERT INTO vnext_upload_parts(session_id, part_number, last_presigned_at_epoch)
                   VALUES (?, ?, ?)
                   ON CONFLICT(session_id, part_number) DO UPDATE SET
                     last_presigned_at_epoch = excluded.last_presigned_at_epoch""",
                (session_id, number, now_epoch),
            )
        connection.execute(
            """UPDATE vnext_upload_sessions
               SET last_presign_expires_at_epoch = MAX(COALESCE(last_presign_expires_at_epoch, 0), ?),
                   updated_at = ? WHERE session_id = ?""",
            (expires_at, utc_now(), session_id),
        )
        connection.commit()
    return {"schema_version": 2, "session_id": session_id, "expires_at": expires_at, "parts": selected}


def _verified_and_task(connection: Any, context: UploadOwnerContext, session: Any) -> tuple[Any, Any]:
    asset = connection.execute(
        "SELECT * FROM vnext_verified_assets WHERE asset_revision_id = ?",
        (session["verified_asset_id"],),
    ).fetchone()
    task = connection.execute(
        "SELECT * FROM vnext_tasks WHERE task_id = ? AND device_id = ? AND epoch_id = ?",
        (session["transcription_task_id"], context.device_id, context.epoch_id),
    ).fetchone()
    return asset, task


def complete_upload_session(
    context: UploadOwnerContext,
    session_id: str,
    *,
    binding_generation: str,
    binding_revision: int,
    cancel_revision: int,
    parts: list[dict[str, Any]],
    transcription_task_id: str,
    transcription_generation_id: str,
    transcription_input_sha256: str,
) -> dict[str, Any]:
    ensure_vnext_upload_schema()
    session_id = _safe(session_id, "session_id", 180)
    binding_generation = _generation(binding_generation, "binding_generation")
    binding_revision = _positive(binding_revision, "binding_revision")
    cancel_revision = _nonnegative(cancel_revision, "cancel_revision")
    transcription_task_id = _safe(transcription_task_id, "transcription_task_id", 180)
    transcription_generation_id = _safe(transcription_generation_id, "transcription_generation_id", 180)
    transcription_input_sha256 = _sha256(transcription_input_sha256, "transcription_input_sha256")
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _session_row(connection, context, session_id)
        if row is None:
            connection.rollback()
            raise VNextUploadError("UPLOAD_SESSION_NOT_FOUND", "上传任务不存在", 404)
        _assert_binding(
            connection, context,
            binding_id=str(row["binding_id"]), binding_generation=binding_generation,
            binding_revision=binding_revision, cancel_revision=cancel_revision,
        )
        if str(row["binding_generation"]) != binding_generation:
            connection.rollback()
            raise VNextUploadError("BINDING_REVISION_CHANGED", "上传任务所属连接已变化", 409)
        if row["state"] == "verified":
            asset, task = _verified_and_task(connection, context, row)
            connection.commit()
            if asset is None or task is None:
                raise VNextUploadError("UPLOAD_COMMIT_DAMAGED", "已完成上传记录不完整", 500)
            return {"schema_version": 2, "reused": True, "verified_asset": dict(asset), "task": vnext_task_store.decode_task_row(task)}
        if row["state"] not in {"active", "completing"}:
            connection.rollback()
            raise VNextUploadError("UPLOAD_SESSION_NOT_ACTIVE", "上传任务当前不能完成", 409)
        connection.execute(
            "UPDATE vnext_upload_sessions SET state = 'completing', updated_at = ? WHERE session_id = ?",
            (utc_now(), session_id),
        )
        connection.commit()

    object_key = _object_key(str(row["object_key_hmac"]))
    normalized_parts: list[r2_storage_service.R2Part] = []
    if row["mode"] == "multipart":
        try:
            already_completed = r2_storage_service.object_head(object_key=object_key) is not None
            if not already_completed:
                if len(parts) != int(row["total_parts"]):
                    raise VNextUploadError("UPLOAD_PARTS_INCOMPLETE", "上传分片尚未完成", 409)
                seen: set[int] = set()
                for item in parts:
                    number = item.get("part_number")
                    etag = str(item.get("etag") or "").strip()
                    if not isinstance(number, int) or isinstance(number, bool) or number < 1 or number > int(row["total_parts"]) or not etag or number in seen:
                        raise VNextUploadError("UPLOAD_PARTS_INVALID", "上传分片结果无效", 422)
                    seen.add(number)
                    normalized_parts.append(r2_storage_service.R2Part(number, etag))
                r2_storage_service.complete_multipart_upload(
                    object_key=object_key,
                    upload_id=str(row["multipart_upload_id"]),
                    parts=normalized_parts,
                )
        except VNextUploadError:
            raise
        except Exception as error:
            try:
                recovered = r2_storage_service.object_head(object_key=object_key) is not None
            except Exception:
                recovered = False
            if not recovered:
                raise VNextUploadError("UPLOAD_COMPLETE_FAILED", "录音分片合并失败，可重试", 503) from error
    elif parts:
        raise VNextUploadError("UPLOAD_PARTS_INVALID", "单文件上传不接受分片结果", 422)

    try:
        head = r2_storage_service.object_head(object_key=object_key)
    except Exception as error:
        raise VNextUploadError(
            "UPLOAD_STORAGE_UNAVAILABLE", "录音文件暂时无法校验，可重试", 503,
        ) from error
    if head is None:
        raise VNextUploadError("UPLOAD_OBJECT_MISSING", "尚未收到完整录音文件", 409)
    if int(head["content_length"]) != int(row["expected_size"]):
        _queue_cleanup(context, row, terminal_state="cancelled", not_before_epoch=int(time.time()))
        raise VNextUploadError("UPLOAD_SIZE_MISMATCH", "录音文件大小校验失败", 422)
    try:
        actual_sha256 = r2_storage_service.stream_object_sha256(object_key=object_key)
    except Exception as error:
        raise VNextUploadError(
            "UPLOAD_STORAGE_UNAVAILABLE", "录音文件暂时无法校验，可重试", 503,
        ) from error
    if actual_sha256 != str(row["expected_sha256"]):
        _queue_cleanup(context, row, terminal_state="cancelled", not_before_epoch=int(time.time()))
        raise VNextUploadError("UPLOAD_HASH_MISMATCH", "录音文件校验失败", 422)
    if transcription_input_sha256 != actual_sha256:
        raise VNextUploadError("TRANSCRIPTION_INPUT_MISMATCH", "转写输入与录音文件不一致", 422)

    asset_revision_id = f"asset-revision:{session_id}"
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = _session_row(connection, context, session_id)
        if current is None:
            connection.rollback()
            raise VNextUploadError("UPLOAD_SESSION_NOT_FOUND", "上传任务不存在", 404)
        try:
            _assert_binding(
                connection, context,
                binding_id=str(current["binding_id"]), binding_generation=binding_generation,
                binding_revision=binding_revision, cancel_revision=cancel_revision,
            )
        except VNextUploadError:
            connection.rollback()
            _queue_cleanup(context, current, terminal_state="cancelled", not_before_epoch=int(time.time()))
            raise
        if current["state"] == "verified":
            asset, task = _verified_and_task(connection, context, current)
            connection.commit()
            if asset is None or task is None:
                raise VNextUploadError("UPLOAD_COMMIT_DAMAGED", "已完成上传记录不完整", 500)
            return {"schema_version": 2, "reused": True, "verified_asset": dict(asset), "task": vnext_task_store.decode_task_row(task)}
        if current["state"] != "completing":
            connection.rollback()
            raise VNextUploadError("UPLOAD_SESSION_NOT_ACTIVE", "上传任务状态已变化", 409)
        connection.execute(
            """INSERT INTO vnext_verified_assets(
                 asset_revision_id, device_id, epoch_id, binding_id, binding_generation,
                 binding_revision, cancel_revision, asset_id, generation, byte_size,
                 source_sha256, sealed_locator, reservation_id, state, activated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sealed', ?)""",
            (
                asset_revision_id, context.device_id, context.epoch_id, current["binding_id"],
                binding_generation, binding_revision, cancel_revision, current["asset_id"],
                current["asset_generation"], current["expected_size"], actual_sha256,
                current["object_key_hmac"], current["reservation_id"], now,
            ),
        )
        existing_task = connection.execute(
            "SELECT * FROM vnext_tasks WHERE task_id = ?",
            (transcription_task_id,),
        ).fetchone()
        logical_task = connection.execute(
            """SELECT * FROM vnext_tasks
               WHERE device_id = ? AND epoch_id = ? AND capability = 'transcript'
                 AND entity_id = ? AND entity_revision = 1
                 AND input_sha256 = ? AND generation_id = ?""",
            (
                context.device_id, context.epoch_id, current["asset_id"],
                actual_sha256, transcription_generation_id,
            ),
        ).fetchone()
        if existing_task is None and logical_task is not None:
            existing_task = logical_task
            transcription_task_id = str(logical_task["task_id"])
        if existing_task is not None:
            same_task = (
                existing_task["device_id"] == context.device_id
                and existing_task["epoch_id"] == context.epoch_id
                and existing_task["binding_id"] == current["binding_id"]
                and existing_task["binding_generation"] == binding_generation
                and existing_task["capability"] == "transcript"
                and existing_task["entity_id"] == current["asset_id"]
                and int(existing_task["entity_revision"]) == 1
                and existing_task["input_sha256"] == actual_sha256
                and existing_task["generation_id"] == transcription_generation_id
            )
            if not same_task:
                connection.rollback()
                raise VNextUploadError("TASK_ID_CONFLICT", "转写任务标识已用于其他输入", 409)
        else:
            connection.execute(
                """INSERT INTO vnext_tasks(
                     task_id, device_id, epoch_id, binding_id, binding_generation,
                     capability, entity_id, entity_revision, input_sha256, generation_id,
                     creation_reason, cancel_revision, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 'transcript', ?, 1, ?, ?, 'original', ?, ?, ?)""",
                (
                    transcription_task_id, context.device_id, context.epoch_id,
                    current["binding_id"], binding_generation, current["asset_id"],
                    actual_sha256, transcription_generation_id, cancel_revision, now, now,
                ),
            )
        connection.execute(
            """UPDATE vnext_upload_sessions
               SET state = 'verified', verified_asset_id = ?, transcription_task_id = ?,
                   completed_at = ?, updated_at = ? WHERE session_id = ? AND state = 'completing'""",
            (asset_revision_id, transcription_task_id, now, now, session_id),
        )
        current = _session_row(connection, context, session_id)
        asset, task = _verified_and_task(connection, context, current)
        connection.commit()
    assert asset is not None and task is not None
    return {"schema_version": 2, "reused": False, "verified_asset": dict(asset), "task": vnext_task_store.decode_task_row(task)}


def _queue_cleanup(
    context: UploadOwnerContext,
    session: Any,
    *,
    terminal_state: Literal["cancelled", "expired"],
    not_before_epoch: int,
) -> str:
    obligation_id = f"cleanup:{session['session_id']}"
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = _session_row(connection, context, str(session["session_id"]))
        if current is None:
            connection.rollback()
            raise VNextUploadError("UPLOAD_SESSION_NOT_FOUND", "上传任务不存在", 404)
        if current["state"] == "verified":
            connection.rollback()
            raise VNextUploadError("VERIFIED_ASSET_IN_USE", "录音已进入转写，不能取消上传", 409)
        effective_not_before = max(
            int(not_before_epoch),
            int(current["last_presign_expires_at_epoch"] or 0) if current["mode"] == "single" else 0,
        )
        connection.execute(
            """INSERT OR IGNORE INTO vnext_object_cleanup_obligations(
                 obligation_id, device_id, epoch_id, binding_id, binding_generation,
                 binding_revision, cancel_revision, session_id, opaque_object_ref,
                 multipart_upload_id, reservation_id, terminal_session_state,
                 not_before_epoch, state, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
            (
                obligation_id, context.device_id, context.epoch_id, current["binding_id"],
                current["binding_generation"], current["binding_revision"],
                current["cancel_revision"], current["session_id"], current["object_key_hmac"],
                current["multipart_upload_id"], current["reservation_id"], terminal_state,
                effective_not_before, now,
            ),
        )
        connection.execute(
            """UPDATE vnext_capacity_reservations SET state = 'releasing'
               WHERE reservation_id = ? AND state = 'active'""",
            (current["reservation_id"],),
        )
        connection.execute(
            """UPDATE vnext_upload_sessions SET state = 'cleanup_pending', updated_at = ?
               WHERE session_id = ? AND state <> 'cleanup_pending'""",
            (now, current["session_id"]),
        )
        connection.commit()
    return obligation_id


def queue_verified_asset_cleanup_in_transaction(
    connection: Any,
    *,
    task_id: str,
    not_before_epoch: int,
) -> str:
    """Queue one verified object after its transcript is durable on the phone.

    The existing cleanup table predates the logical ``consumed`` upload state.
    Keep its physical terminal state compatible while recording the reason in a
    separate column; the public session projection reports ``consumed`` only
    after HEAD confirms that the staging object is absent.
    """
    task_id = _safe(task_id, "task_id", 512)
    not_before_epoch = _nonnegative(not_before_epoch, "not_before_epoch")
    session = connection.execute(
        """SELECT * FROM vnext_upload_sessions
             WHERE transcription_task_id = ? AND state IN ('verified','cleanup_pending')""",
        (task_id,),
    ).fetchone()
    if session is None:
        raise VNextUploadError("VERIFIED_ASSET_NOT_FOUND", "已校验录音不存在", 404)
    effective_not_before = max(
        not_before_epoch,
        int(session["last_presign_expires_at_epoch"] or 0)
        if session["mode"] == "single" else 0,
    )
    obligation_id = f"cleanup:{session['session_id']}"
    now = utc_now()
    existing = connection.execute(
        "SELECT * FROM vnext_object_cleanup_obligations WHERE obligation_id = ?",
        (obligation_id,),
    ).fetchone()
    if existing is None:
        connection.execute(
            """INSERT INTO vnext_object_cleanup_obligations(
                 obligation_id, device_id, epoch_id, binding_id, binding_generation,
                 binding_revision, cancel_revision, session_id, opaque_object_ref,
                 multipart_upload_id, reservation_id, terminal_session_state,
                 not_before_epoch, state, created_at, cleanup_reason
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'expired', ?, 'pending', ?, 'consumed')""",
            (
                obligation_id,
                session["device_id"],
                session["epoch_id"],
                session["binding_id"],
                session["binding_generation"],
                session["binding_revision"],
                session["cancel_revision"],
                session["session_id"],
                session["object_key_hmac"],
                session["multipart_upload_id"],
                session["reservation_id"],
                effective_not_before,
                now,
            ),
        )
    elif existing["state"] != "confirmed" and existing["cleanup_reason"] == "consumed":
        connection.execute(
            """UPDATE vnext_object_cleanup_obligations
                  SET not_before_epoch = MIN(not_before_epoch, ?), state = 'pending',
                      claim_until_epoch = NULL, last_error_code = NULL
                WHERE obligation_id = ?""",
            (effective_not_before, obligation_id),
        )
    connection.execute(
        """UPDATE vnext_verified_assets SET state = 'cleanup_pending'
             WHERE asset_revision_id = ? AND state = 'sealed'""",
        (session["verified_asset_id"],),
    )
    connection.execute(
        """UPDATE vnext_capacity_reservations SET state = 'releasing'
             WHERE reservation_id = ? AND state = 'active'""",
        (session["reservation_id"],),
    )
    connection.execute(
        """UPDATE vnext_upload_sessions SET state = 'cleanup_pending', updated_at = ?
             WHERE session_id = ? AND state = 'verified'""",
        (now, session["session_id"]),
    )
    return obligation_id


def queue_terminal_task_source_cleanup(*, limit: int = 32) -> int:
    """Recover cleanup for tasks terminalized outside the domain handler."""
    ensure_vnext_upload_schema()
    bounded = max(1, min(128, int(limit)))
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT task.task_id
                 FROM vnext_tasks task
                 JOIN vnext_upload_sessions session
                   ON session.transcription_task_id = task.task_id
                 JOIN vnext_verified_assets asset
                   ON asset.asset_revision_id = session.verified_asset_id
                WHERE task.capability = 'transcript'
                  AND task.state IN ('failure','cancelled')
                  AND session.state = 'verified' AND session.consumed_at IS NULL
                  AND asset.state = 'sealed'
                ORDER BY task.updated_at, task.task_id LIMIT ?""",
            (bounded,),
        ).fetchall()
    queued = 0
    for row in rows:
        with control_connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                queue_verified_asset_cleanup_in_transaction(
                    connection,
                    task_id=str(row["task_id"]),
                    not_before_epoch=int(time.time()),
                )
            except VNextUploadError as error:
                connection.rollback()
                if error.code != "VERIFIED_ASSET_NOT_FOUND":
                    raise
            else:
                connection.commit()
                queued += 1
    return queued


def cancel_upload_session(
    context: UploadOwnerContext,
    session_id: str,
    *,
    binding_generation: str,
    binding_revision: int,
    cancel_revision: int,
    now_epoch: int | None = None,
) -> dict[str, Any]:
    ensure_vnext_upload_schema()
    session_id = _safe(session_id, "session_id", 180)
    binding_generation = _generation(binding_generation, "binding_generation")
    binding_revision = _positive(binding_revision, "binding_revision")
    cancel_revision = _nonnegative(cancel_revision, "cancel_revision")
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    with control_connection() as connection:
        row = _session_row(connection, context, session_id)
        if row is None:
            raise VNextUploadError("UPLOAD_SESSION_NOT_FOUND", "上传任务不存在", 404)
        _assert_binding(
            connection, context,
            binding_id=str(row["binding_id"]), binding_generation=binding_generation,
            binding_revision=binding_revision, cancel_revision=cancel_revision,
        )
        if row["binding_generation"] != binding_generation:
            raise VNextUploadError("BINDING_REVISION_CHANGED", "上传任务所属连接已变化", 409)
        if row["state"] in {"cancelled", "expired"}:
            return {"schema_version": 2, "session_id": session_id, "state": row["state"]}
    obligation_id = _queue_cleanup(context, row, terminal_state="cancelled", not_before_epoch=now_epoch)
    return {"schema_version": 2, "session_id": session_id, "state": "cleanup_pending", "cleanup_id": obligation_id}


def process_cleanup_obligations(*, limit: int = 32, now_epoch: int | None = None) -> int:
    ensure_vnext_upload_schema()
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        candidates = connection.execute(
            """SELECT obligation_id FROM vnext_object_cleanup_obligations
               WHERE not_before_epoch <= ?
                 AND (state = 'pending' OR (state = 'running' AND claim_until_epoch <= ?))
               ORDER BY not_before_epoch, obligation_id LIMIT ?""",
            (now_epoch, now_epoch, max(1, min(128, int(limit)))),
        ).fetchall()
        claimed_ids = [str(row["obligation_id"]) for row in candidates]
        for obligation_id in claimed_ids:
            connection.execute(
                """UPDATE vnext_object_cleanup_obligations
                   SET state = 'running', claim_until_epoch = ?
                   WHERE obligation_id = ?""",
                (now_epoch + 180, obligation_id),
            )
        rows = [
            connection.execute(
                "SELECT * FROM vnext_object_cleanup_obligations WHERE obligation_id = ?",
                (obligation_id,),
            ).fetchone()
            for obligation_id in claimed_ids
        ]
        connection.commit()
    confirmed = 0
    for row in rows:
        object_key = _object_key(str(row["opaque_object_ref"]))
        upload_id = str(row["multipart_upload_id"] or "")
        try:
            if upload_id and not upload_id.startswith("single:"):
                r2_storage_service.abort_multipart_upload(object_key=object_key, upload_id=upload_id)
            r2_storage_service.delete_object(object_key=object_key)
            if r2_storage_service.object_head(object_key=object_key) is not None:
                raise RuntimeError("object_still_present")
            now = utc_now()
            with control_connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """UPDATE vnext_object_cleanup_obligations
                       SET state = 'confirmed', attempts = attempts + 1,
                           claim_until_epoch = NULL, last_error_code = NULL, confirmed_at = ?
                       WHERE obligation_id = ? AND state = 'running'""",
                    (now, row["obligation_id"]),
                )
                connection.execute(
                    """UPDATE vnext_capacity_reservations
                       SET state = 'released', released_at_epoch = ?
                       WHERE reservation_id = ? AND state <> 'released'""",
                    (now_epoch, row["reservation_id"]),
                )
                if row["cleanup_reason"] == "consumed":
                    connection.execute(
                        """UPDATE vnext_verified_assets SET state = 'consumed'
                             WHERE reservation_id = ? AND state = 'cleanup_pending'""",
                        (row["reservation_id"],),
                    )
                    connection.execute(
                        """UPDATE vnext_upload_sessions
                              SET state = 'verified', consumed_at = ?, updated_at = ?
                            WHERE session_id = ? AND state = 'cleanup_pending'""",
                        (now, now, row["session_id"]),
                    )
                else:
                    connection.execute(
                        """UPDATE vnext_upload_sessions SET state = ?, updated_at = ?
                           WHERE session_id = ? AND state = 'cleanup_pending'""",
                        (row["terminal_session_state"], now, row["session_id"]),
                    )
                connection.commit()
            confirmed += 1
        except Exception as error:
            with control_connection() as connection:
                connection.execute(
                    """UPDATE vnext_object_cleanup_obligations
                       SET state = 'pending', attempts = attempts + 1,
                           claim_until_epoch = NULL, not_before_epoch = ?, last_error_code = ?
                       WHERE obligation_id = ? AND state = 'running'""",
                    (
                        now_epoch + min(3600, 30 * (2 ** min(6, int(row["attempts"])))),
                        type(error).__name__[:160], row["obligation_id"],
                    ),
                )
                connection.commit()
    return confirmed


def expire_upload_sessions(*, now_epoch: int | None = None, limit: int = 64) -> int:
    ensure_vnext_upload_schema()
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT * FROM vnext_upload_sessions
               WHERE state IN ('provisioning','active','completing') AND expires_at <= ?
               ORDER BY expires_at, session_id LIMIT ?""",
            (now_epoch, max(1, min(256, int(limit)))),
        ).fetchall()
    queued = 0
    for row in rows:
        context = _StoredContext(str(row["device_id"]), str(row["epoch_id"]))
        _queue_cleanup(context, row, terminal_state="expired", not_before_epoch=now_epoch)
        queued += 1
    return queued


def queue_scope_cleanup_in_transaction(
    connection: Any,
    *,
    device_id: str,
    epoch_id: str,
    binding_id: str | None = None,
    binding_generation: str | None = None,
    now_epoch: int | None = None,
) -> int:
    """Fence every upload in a purge scope without opening a second transaction."""
    now_epoch = int(time.time()) if now_epoch is None else _nonnegative(now_epoch, "now_epoch")
    where = "device_id = ? AND epoch_id = ?"
    parameters: list[Any] = [device_id, epoch_id]
    if binding_id is not None or binding_generation is not None:
        if binding_id is None or binding_generation is None:
            raise VNextUploadError("PURGE_SCOPE_INVALID", "上传清理范围无效", 500)
        where += " AND binding_id = ? AND binding_generation = ?"
        parameters.extend([binding_id, binding_generation])
    sessions = connection.execute(
        f"SELECT * FROM vnext_upload_sessions WHERE {where}",
        tuple(parameters),
    ).fetchall()
    queued = 0
    now = utc_now()
    for session in sessions:
        if session["state"] in {"cancelled", "expired"}:
            continue
        obligation_id = f"cleanup:{session['session_id']}"
        effective_not_before = max(
            now_epoch,
            int(session["last_presign_expires_at_epoch"] or 0)
            if session["mode"] == "single" else 0,
        )
        before = connection.execute(
            "SELECT state, cleanup_reason FROM vnext_object_cleanup_obligations WHERE obligation_id = ?",
            (obligation_id,),
        ).fetchone()
        connection.execute(
            """INSERT OR IGNORE INTO vnext_object_cleanup_obligations(
                 obligation_id, device_id, epoch_id, binding_id, binding_generation,
                 binding_revision, cancel_revision, session_id, opaque_object_ref,
                 multipart_upload_id, reservation_id, terminal_session_state,
                 not_before_epoch, state, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cancelled', ?, 'pending', ?)""",
            (
                obligation_id, device_id, epoch_id, session["binding_id"],
                session["binding_generation"], session["binding_revision"],
                session["cancel_revision"], session["session_id"],
                session["object_key_hmac"], session["multipart_upload_id"],
                session["reservation_id"], effective_not_before, now,
            ),
        )
        if before is not None and before["state"] == "pending":
            connection.execute(
                """UPDATE vnext_object_cleanup_obligations
                      SET terminal_session_state = 'cancelled', cleanup_reason = 'cancelled',
                          not_before_epoch = MIN(not_before_epoch, ?), last_error_code = NULL
                    WHERE obligation_id = ? AND state = 'pending'""",
                (effective_not_before, obligation_id),
            )
        connection.execute(
            """UPDATE vnext_capacity_reservations SET state = 'releasing'
               WHERE reservation_id = ? AND state = 'active'""",
            (session["reservation_id"],),
        )
        connection.execute(
            """UPDATE vnext_verified_assets SET state = 'cleanup_pending'
               WHERE asset_revision_id = ? AND state <> 'cleanup_pending'""",
            (session["verified_asset_id"],),
        )
        connection.execute(
            """UPDATE vnext_upload_sessions SET state = 'cleanup_pending', updated_at = ?
               WHERE session_id = ? AND state NOT IN ('cancelled','expired')""",
            (now, session["session_id"]),
        )
        if before is None or before["state"] != "confirmed":
            queued += 1
    return queued


def scope_cleanup_pending(
    connection: Any,
    *,
    device_id: str,
    epoch_id: str,
    binding_id: str | None = None,
    binding_generation: str | None = None,
) -> int:
    where = "device_id = ? AND epoch_id = ? AND state <> 'confirmed'"
    parameters: list[Any] = [device_id, epoch_id]
    if binding_id is not None or binding_generation is not None:
        if binding_id is None or binding_generation is None:
            raise VNextUploadError("PURGE_SCOPE_INVALID", "上传清理范围无效", 500)
        where += " AND binding_id = ? AND binding_generation = ?"
        parameters.extend([binding_id, binding_generation])
    return int(connection.execute(
        f"SELECT COUNT(*) FROM vnext_object_cleanup_obligations WHERE {where}",
        tuple(parameters),
    ).fetchone()[0])


def finalize_scope_cleanup_in_transaction(
    connection: Any,
    *,
    device_id: str,
    epoch_id: str,
    binding_id: str | None = None,
    binding_generation: str | None = None,
) -> None:
    if scope_cleanup_pending(
        connection,
        device_id=device_id,
        epoch_id=epoch_id,
        binding_id=binding_id,
        binding_generation=binding_generation,
    ):
        raise VNextUploadError("PURGE_OBJECTS_PENDING", "录音对象仍在清理", 409)
    where = "device_id = ? AND epoch_id = ?"
    parameters: list[Any] = [device_id, epoch_id]
    if binding_id is not None or binding_generation is not None:
        if binding_id is None or binding_generation is None:
            raise VNextUploadError("PURGE_SCOPE_INVALID", "上传清理范围无效", 500)
        where += " AND binding_id = ? AND binding_generation = ?"
        parameters.extend([binding_id, binding_generation])
    connection.execute(f"DELETE FROM vnext_verified_assets WHERE {where}", tuple(parameters))
    connection.execute(f"DELETE FROM vnext_upload_sessions WHERE {where}", tuple(parameters))


class _StoredContext:
    def __init__(self, device_id: str, epoch_id: str):
        self.device_id = device_id
        self.epoch_id = epoch_id


def list_pending_transcription_sources(limit: int = 32) -> list[dict[str, Any]]:
    """Return opaque internal source descriptors for active generic transcript tasks."""
    ensure_vnext_upload_schema()
    bounded = max(1, min(128, int(limit)))
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT task.task_id, task.device_id, task.epoch_id,
                      session.session_id AS upload_session_id,
                      asset.asset_revision_id, asset.asset_id,
                      asset.generation AS asset_generation, asset.byte_size,
                      asset.source_sha256, asset.sealed_locator,
                      session.mime_type, task.created_at
                 FROM vnext_tasks task
                 JOIN vnext_upload_sessions session
                   ON session.transcription_task_id = task.task_id
                 JOIN vnext_verified_assets asset
                   ON asset.asset_revision_id = session.verified_asset_id
                WHERE task.capability = 'transcript' AND task.state = 'active'
                  AND COALESCE(task.retry_not_before_epoch, 0) <= ?
                  AND session.state = 'verified' AND asset.state = 'sealed'
                ORDER BY task.created_at, task.task_id LIMIT ?""",
            (time.time(), bounded),
        ).fetchall()
    return [dict(row) for row in rows]


def get_verified_transcription_source(
    context: UploadOwnerContext,
    task_id: str,
) -> dict[str, Any]:
    ensure_vnext_upload_schema()
    task_id = _safe(task_id, "task_id", 512)
    with control_connection() as connection:
        row = connection.execute(
            """SELECT task.task_id, task.binding_id, task.binding_generation,
                      session.session_id AS upload_session_id, session.mime_type,
                      asset.asset_revision_id, asset.asset_id,
                      asset.generation AS asset_generation, asset.byte_size,
                      asset.source_sha256, asset.sealed_locator, asset.state AS asset_state,
                      binding.binding_revision, binding.cancel_revision,
                      binding.state AS binding_state
                 FROM vnext_tasks task
                 JOIN vnext_upload_sessions session
                   ON session.transcription_task_id = task.task_id
                 JOIN vnext_verified_assets asset
                   ON asset.asset_revision_id = session.verified_asset_id
                 JOIN vnext_bindings binding
                   ON binding.device_id = task.device_id AND binding.epoch_id = task.epoch_id
                  AND binding.binding_id = task.binding_id
                WHERE task.task_id = ? AND task.device_id = ? AND task.epoch_id = ?""",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
    if row is None:
        raise VNextUploadError("VERIFIED_ASSET_NOT_FOUND", "已校验录音不存在", 404)
    if row["binding_state"] != "active" or row["asset_state"] != "sealed":
        raise VNextUploadError("VERIFIED_ASSET_UNAVAILABLE", "录音当前不能进入转写", 409)
    result = dict(row)
    result["object_key"] = _object_key(str(row["sealed_locator"]))
    result.pop("sealed_locator", None)
    return result
