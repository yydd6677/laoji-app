"""Purge-only capabilities for the isolated device-v2 contract.

The secret is created and retained by the Android native journal.  This
module stores only its SHA-256 digest and can only erase the registered epoch
or binding generation.  It deliberately exposes no listing or content read
surface.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
import time
from typing import Any, Literal
import uuid

from app.services.device_identity import control_connection, ensure_device_schema, valid_uuid


ScopeKind = Literal["epoch", "binding"]
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class VNextPurgeError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> int:
    return int(time.time())


def _identifier(value: str, field: str, maximum: int = 180) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized or len(normalized) > maximum or any(ord(char) < 32 or ord(char) == 127 for char in normalized):
        raise VNextPurgeError("PURGE_INPUT_INVALID", f"{field}无效", 422)
    return normalized


def _secret_hash(value: str) -> str:
    normalized = _identifier(value, "secret_sha256", 64)
    if not _HASH_RE.fullmatch(normalized):
        raise VNextPurgeError("PURGE_INPUT_INVALID", "清理凭据摘要无效", 422)
    return normalized


def ensure_purge_schema(connection: sqlite3.Connection | None = None) -> None:
    ensure_device_schema()
    owns_connection = connection is None
    current = connection or control_connection()
    try:
        current.executescript(
            """
            CREATE TABLE IF NOT EXISTS v2_purge_capabilities (
                capability_id TEXT PRIMARY KEY,
                scope_kind TEXT NOT NULL CHECK(scope_kind IN ('epoch','binding')),
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT,
                binding_generation TEXT,
                secret_sha256 TEXT NOT NULL CHECK(length(secret_sha256) = 64),
                state TEXT NOT NULL DEFAULT 'active'
                    CHECK(state IN ('active','consumed','revoked')),
                registration_request_id TEXT NOT NULL,
                registration_sha256 TEXT NOT NULL CHECK(length(registration_sha256) = 64),
                created_at INTEGER NOT NULL,
                consumed_at INTEGER,
                revoked_at INTEGER,
                UNIQUE(registration_request_id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_purge_epoch_scope
                ON v2_purge_capabilities(device_id, epoch_id)
                WHERE scope_kind = 'epoch';
            CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_purge_binding_scope
                ON v2_purge_capabilities(device_id, epoch_id, binding_id, binding_generation)
                WHERE scope_kind = 'binding';
            CREATE TABLE IF NOT EXISTS v2_purges (
                purge_id TEXT PRIMARY KEY,
                capability_id TEXT NOT NULL UNIQUE REFERENCES v2_purge_capabilities(capability_id),
                request_id TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('pending','running','confirmed')),
                last_error_code TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                confirmed_at INTEGER,
                UNIQUE(capability_id, request_id)
            );
            CREATE INDEX IF NOT EXISTS idx_v2_purges_state
                ON v2_purges(state, updated_at, purge_id);
            """
        )
        if owns_connection:
            current.commit()
    finally:
        if owns_connection:
            current.close()


def _registration_hash(
    *, scope_kind: ScopeKind, device_id: str, epoch_id: str,
    binding_id: str | None, binding_generation: str | None, secret_sha256: str,
) -> str:
    canonical = "\n".join([
        "laoji-purge-capability-v1", scope_kind, device_id, epoch_id,
        binding_id or "", binding_generation or "", secret_sha256,
    ])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def register_capability(
    connection: sqlite3.Connection,
    *,
    scope_kind: ScopeKind,
    capability_id: str,
    device_id: str,
    epoch_id: str,
    secret_sha256: str,
    registration_request_id: str,
    binding_id: str | None = None,
    binding_generation: str | None = None,
) -> dict[str, Any]:
    """Register a client-generated capability inside its owner transaction."""
    capability_id = _identifier(capability_id, "capability_id")
    device_id = _identifier(device_id, "device_id")
    epoch_id = _identifier(epoch_id, "epoch_id")
    registration_request_id = _identifier(registration_request_id, "registration_request_id")
    secret_sha256 = _secret_hash(secret_sha256)
    if not valid_uuid(capability_id) or not valid_uuid(device_id) or not valid_uuid(epoch_id):
        raise VNextPurgeError("PURGE_INPUT_INVALID", "清理范围标识无效", 422)
    if scope_kind == "binding":
        binding_id = _identifier(binding_id or "", "binding_id")
        binding_generation = _identifier(binding_generation or "", "binding_generation", 256)
        if not valid_uuid(binding_id):
            raise VNextPurgeError("PURGE_INPUT_INVALID", "清理 binding 标识无效", 422)
    elif scope_kind == "epoch":
        if binding_id is not None or binding_generation is not None:
            raise VNextPurgeError("PURGE_INPUT_INVALID", "epoch 清理不能携带 binding", 422)
    else:
        raise VNextPurgeError("PURGE_INPUT_INVALID", "清理范围无效", 422)
    registration_sha256 = _registration_hash(
        scope_kind=scope_kind,
        device_id=device_id,
        epoch_id=epoch_id,
        binding_id=binding_id,
        binding_generation=binding_generation,
        secret_sha256=secret_sha256,
    )
    existing = connection.execute(
        "SELECT * FROM v2_purge_capabilities WHERE capability_id = ? OR registration_request_id = ?",
        (capability_id, registration_request_id),
    ).fetchone()
    if existing is not None:
        if (
            str(existing["capability_id"]) != capability_id
            or str(existing["registration_sha256"]) != registration_sha256
        ):
            raise VNextPurgeError("PURGE_CAPABILITY_CONFLICT", "清理凭据登记冲突", 409)
        return _public_capability(existing)
    now = _now()
    try:
        connection.execute(
            """INSERT INTO v2_purge_capabilities(
                 capability_id, scope_kind, device_id, epoch_id, binding_id,
                 binding_generation, secret_sha256, registration_request_id,
                 registration_sha256, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                capability_id, scope_kind, device_id, epoch_id, binding_id,
                binding_generation, secret_sha256, registration_request_id,
                registration_sha256, now,
            ),
        )
    except sqlite3.IntegrityError as error:
        raise VNextPurgeError("PURGE_SCOPE_CONFLICT", "该清理范围已登记其他凭据", 409) from error
    row = connection.execute(
        "SELECT * FROM v2_purge_capabilities WHERE capability_id = ?",
        (capability_id,),
    ).fetchone()
    assert row is not None
    return _public_capability(row)


def _public_capability(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "capability_id": str(row["capability_id"]),
        "scope_kind": str(row["scope_kind"]),
        "registered": True,
    }


def _authorized_capability(connection: sqlite3.Connection, capability_id: str, secret: str) -> sqlite3.Row:
    capability_id = _identifier(capability_id, "capability_id")
    if not valid_uuid(capability_id):
        raise VNextPurgeError("CAPABILITY_NOT_REGISTERED", "清理凭据不存在", 404)
    row = connection.execute(
        "SELECT * FROM v2_purge_capabilities WHERE capability_id = ?",
        (capability_id,),
    ).fetchone()
    if row is None:
        raise VNextPurgeError("CAPABILITY_NOT_REGISTERED", "清理凭据不存在", 404)
    presented = hashlib.sha256(str(secret or "").strip().encode("ascii", "ignore")).hexdigest()
    if not secrets.compare_digest(str(row["secret_sha256"]), presented):
        raise VNextPurgeError("PURGE_AUTH_INVALID", "清理凭据无效", 401)
    if row["state"] == "revoked":
        raise VNextPurgeError("PURGE_CAPABILITY_REVOKED", "清理凭据已撤销", 410)
    return row


def _public_status(connection: sqlite3.Connection, capability: sqlite3.Row) -> dict[str, Any]:
    purge = connection.execute(
        "SELECT purge_id, state, last_error_code FROM v2_purges WHERE capability_id = ?",
        (capability["capability_id"],),
    ).fetchone()
    if purge is None:
        return {"schema_version": 2, "state": "pending", "purge_id": None, "error_code": None}
    return {
        "schema_version": 2,
        "state": str(purge["state"]),
        "purge_id": str(purge["purge_id"]),
        "error_code": str(purge["last_error_code"]) if purge["last_error_code"] else None,
    }


def get_purge_status(*, capability_id: str, secret: str) -> dict[str, Any]:
    ensure_purge_schema()
    with control_connection() as connection:
        capability = _authorized_capability(connection, capability_id, secret)
        return _public_status(connection, capability)


def _cancel_task_rows(connection: sqlite3.Connection, where_sql: str, parameters: tuple[Any, ...]) -> None:
    task_rows = connection.execute(
        f"SELECT task_id FROM vnext_tasks WHERE {where_sql}",
        parameters,
    ).fetchall()
    task_ids = [str(row["task_id"]) for row in task_rows]
    if not task_ids:
        return
    connection.executemany(
        "UPDATE vnext_task_attempts SET state = 'cancelled', terminal_at = COALESCE(terminal_at, updated_at) "
        "WHERE task_id = ? AND state IN ('queued','running')",
        [(task_id,) for task_id in task_ids],
    )
    connection.executemany("DELETE FROM vnext_task_attempts WHERE task_id = ?", [(task_id,) for task_id in task_ids])
    connection.executemany("DELETE FROM vnext_tasks WHERE task_id = ?", [(task_id,) for task_id in task_ids])


def _begin_purge_binding(connection: sqlite3.Connection, capability: sqlite3.Row) -> None:
    from app.services import vnext_speaker_store, vnext_upload_store

    where = "device_id = ? AND epoch_id = ? AND binding_id = ? AND binding_generation = ?"
    parameters = (
        capability["device_id"], capability["epoch_id"],
        capability["binding_id"], capability["binding_generation"],
    )
    connection.execute(
        f"UPDATE vnext_bindings SET state = 'purging', cancel_revision = cancel_revision + 1 WHERE {where} AND state = 'active'",
        parameters,
    )
    vnext_speaker_store.purge_scope_in_transaction(
        connection,
        device_id=str(capability["device_id"]),
        epoch_id=str(capability["epoch_id"]),
        binding_id=str(capability["binding_id"]),
        binding_generation=str(capability["binding_generation"]),
    )
    _cancel_task_rows(connection, where, parameters)
    vnext_upload_store.queue_scope_cleanup_in_transaction(
        connection,
        device_id=str(capability["device_id"]),
        epoch_id=str(capability["epoch_id"]),
        binding_id=str(capability["binding_id"]),
        binding_generation=str(capability["binding_generation"]),
    )


def _begin_purge_epoch(connection: sqlite3.Connection, capability: sqlite3.Row) -> None:
    from app.services import vnext_speaker_store, vnext_upload_store

    device_id = str(capability["device_id"])
    epoch_id = str(capability["epoch_id"])
    now = _now()
    connection.execute(
        "UPDATE v2_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ? AND epoch_id = ?",
        (now, device_id, epoch_id),
    )
    connection.execute(
        "UPDATE v2_auth_challenges SET consumed_at = COALESCE(consumed_at, ?) WHERE device_id = ? AND epoch_id = ?",
        (now, device_id, epoch_id),
    )
    connection.execute(
        "UPDATE v2_device_epochs SET status = 'closed', closed_at = COALESCE(closed_at, ?) WHERE device_id = ? AND epoch_id = ?",
        (now, device_id, epoch_id),
    )
    connection.execute(
        "UPDATE vnext_bindings SET state = 'purging', cancel_revision = cancel_revision + 1 "
        "WHERE device_id = ? AND epoch_id = ? AND state = 'active'",
        (device_id, epoch_id),
    )
    vnext_speaker_store.purge_scope_in_transaction(
        connection,
        device_id=device_id,
        epoch_id=epoch_id,
    )
    _cancel_task_rows(connection, "device_id = ? AND epoch_id = ?", (device_id, epoch_id))
    vnext_upload_store.queue_scope_cleanup_in_transaction(
        connection,
        device_id=device_id,
        epoch_id=epoch_id,
    )


def _finish_purge_scope(connection: sqlite3.Connection, capability: sqlite3.Row) -> bool:
    from app.services import vnext_upload_store

    device_id = str(capability["device_id"])
    epoch_id = str(capability["epoch_id"])
    binding_id = str(capability["binding_id"]) if capability["scope_kind"] == "binding" else None
    binding_generation = (
        str(capability["binding_generation"])
        if capability["scope_kind"] == "binding"
        else None
    )
    if vnext_upload_store.scope_cleanup_pending(
        connection,
        device_id=device_id,
        epoch_id=epoch_id,
        binding_id=binding_id,
        binding_generation=binding_generation,
    ):
        return False
    vnext_upload_store.finalize_scope_cleanup_in_transaction(
        connection,
        device_id=device_id,
        epoch_id=epoch_id,
        binding_id=binding_id,
        binding_generation=binding_generation,
    )
    now = _now()
    if capability["scope_kind"] == "binding":
        connection.execute(
            """UPDATE vnext_bindings SET state = 'purged', purged_at = ?, updated_at = ?
               WHERE device_id = ? AND epoch_id = ?
                 AND binding_id = ? AND binding_generation = ?""",
            (now, now, device_id, epoch_id, binding_id, binding_generation),
        )
    else:
        connection.execute(
            """UPDATE vnext_bindings SET state = 'purged', purged_at = ?, updated_at = ?
               WHERE device_id = ? AND epoch_id = ?""",
            (now, now, device_id, epoch_id),
        )
    return True


def _finish_purge_record(
    connection: sqlite3.Connection,
    capability: sqlite3.Row,
    purge: sqlite3.Row,
) -> bool:
    if not _finish_purge_scope(connection, capability):
        connection.execute(
            "UPDATE v2_purges SET state = 'running', updated_at = ? WHERE purge_id = ?",
            (_now(), purge["purge_id"]),
        )
        return False
    now = _now()
    connection.execute(
        """UPDATE v2_purges SET state = 'confirmed', last_error_code = NULL,
                  updated_at = ?, confirmed_at = ? WHERE purge_id = ?""",
        (now, now, purge["purge_id"]),
    )
    connection.execute(
        "UPDATE v2_purge_capabilities SET state = 'consumed', consumed_at = ? WHERE capability_id = ?",
        (now, capability["capability_id"]),
    )
    return True


def execute_purge(*, capability_id: str, secret: str, request_id: str) -> dict[str, Any]:
    ensure_purge_schema()
    from app.services import vnext_speaker_store, vnext_upload_store

    vnext_upload_store.ensure_vnext_upload_schema()
    vnext_speaker_store.ensure_vnext_speaker_schema()
    request_id = _identifier(request_id, "purge_request_id", 180)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        capability = _authorized_capability(connection, capability_id, secret)
        existing = connection.execute(
            "SELECT * FROM v2_purges WHERE capability_id = ?",
            (capability["capability_id"],),
        ).fetchone()
        if existing is None:
            now = _now()
            purge_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO v2_purges(purge_id, capability_id, request_id, state, created_at, updated_at) "
                "VALUES (?, ?, ?, 'pending', ?, ?)",
                (purge_id, capability["capability_id"], request_id, now, now),
            )
        connection.commit()

    try:
        with control_connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            capability = _authorized_capability(connection, capability_id, secret)
            purge = connection.execute(
                "SELECT * FROM v2_purges WHERE capability_id = ?",
                (capability["capability_id"],),
            ).fetchone()
            assert purge is not None
            if purge["state"] == "confirmed":
                connection.commit()
                return _public_status(connection, capability)
            connection.execute(
                "UPDATE v2_purges SET state = 'running', last_error_code = NULL, updated_at = ? WHERE purge_id = ?",
                (_now(), purge["purge_id"]),
            )
            if capability["scope_kind"] == "epoch":
                _begin_purge_epoch(connection, capability)
            else:
                _begin_purge_binding(connection, capability)
            connection.commit()

        vnext_upload_store.process_cleanup_obligations(limit=128)
        vnext_speaker_store.cleanup_orphaned_after_purge()
        with control_connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            capability = _authorized_capability(connection, capability_id, secret)
            purge = connection.execute(
                "SELECT * FROM v2_purges WHERE capability_id = ?",
                (capability["capability_id"],),
            ).fetchone()
            assert purge is not None
            _finish_purge_record(connection, capability, purge)
            connection.commit()
            return _public_status(connection, capability)
    except VNextPurgeError:
        raise
    except Exception as error:
        with control_connection() as connection:
            connection.execute(
                "UPDATE v2_purges SET state = 'pending', last_error_code = 'PURGE_INTERNAL_RETRY', updated_at = ? WHERE capability_id = ?",
                (_now(), capability_id),
            )
            connection.commit()
        raise VNextPurgeError("PURGE_INTERNAL_RETRY", "远端清理暂未完成，请稍后重试", 503) from error


def reset_store_for_tests() -> None:
    ensure_purge_schema()
    with control_connection() as connection:
        connection.execute("DELETE FROM v2_purges")
        connection.execute("DELETE FROM v2_purge_capabilities")
        connection.commit()
