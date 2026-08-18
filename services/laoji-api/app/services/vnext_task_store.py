"""Durable vNext task/attempt owner.

This store is deliberately separate from ``summary_tasks_v2`` while Stage 1
is behind its capability barrier. It owns only task execution identity,
leases, cancellation and terminal replay; domain payloads remain in their
domain services and are referenced by an opaque result locator/body.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import socket
import time
from typing import Any, Literal, Protocol
import uuid

from app.services.device_identity import control_connection, ensure_device_schema, utc_now
from app.services import vnext_purge_store


TaskState = Literal["active", "success", "failure", "cancelled"]
AttemptState = Literal[
    "queued", "running", "succeeded", "retryable_failure",
    "terminal_failure", "cancelled", "lease_expired",
]
AttemptPhase = Literal["queued", "admitted", "running", "committing"]
DeviceOperationReason = Literal["original", "retry", "regenerate"]

MAX_ATTEMPTS = 3
LEASE_SECONDS = 180


class TaskOwnerContext(Protocol):
    device_id: str
    epoch_id: str


class VNextTaskError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now_epoch() -> float:
    return time.time()


def _safe(value: str, field: str, maximum: int = 512) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > maximum or any(ord(char) < 32 or ord(char) == 127 for char in normalized):
        raise VNextTaskError("IDENTIFIER_INVALID", f"{field}无效", 422)
    return normalized


def _sha256(value: str, field: str = "input_sha256") -> str:
    normalized = _safe(value, field, 71)
    if len(normalized) != 71 or not normalized.startswith("sha256:"):
        raise VNextTaskError("HASH_INVALID", f"{field}无效", 422)
    try:
        int(normalized[7:], 16)
    except ValueError as error:
        raise VNextTaskError("HASH_INVALID", f"{field}无效", 422) from error
    return normalized


def _table_columns(connection: Any, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}


def _upgrade_legacy_owner_schema(connection: Any) -> None:
    """Rebuild the early probe tables from principal_id to canonical device_id."""
    columns = _table_columns(connection, "vnext_bindings")
    if not columns or "device_id" in columns:
        return
    if "principal_id" not in columns:
        raise RuntimeError("vnext_binding_owner_schema_unknown")
    connection.execute("PRAGMA foreign_keys=OFF")
    try:
        connection.executescript(
            """
            BEGIN IMMEDIATE;
            CREATE TABLE vnext_bindings_owner_upgrade (
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                binding_epoch_seq INTEGER NOT NULL CHECK(binding_epoch_seq >= 1),
                binding_revision INTEGER NOT NULL DEFAULT 1,
                cancel_revision INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','purging','purged')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                purged_at INTEGER,
                PRIMARY KEY(device_id, epoch_id, binding_id),
                UNIQUE(device_id, epoch_id, binding_generation),
                UNIQUE(device_id, epoch_id, binding_epoch_seq)
            );
            INSERT INTO vnext_bindings_owner_upgrade(
                device_id, epoch_id, binding_id, binding_generation,
                binding_epoch_seq, binding_revision, cancel_revision, state,
                created_at, updated_at
            )
            SELECT principal.device_id, binding.epoch_id, binding.binding_id,
                   binding.binding_generation,
                   ROW_NUMBER() OVER (
                       PARTITION BY binding.principal_id, binding.epoch_id
                       ORDER BY binding.created_at, binding.binding_id
                   ),
                   binding.binding_revision, binding.cancel_revision, binding.state,
                   binding.created_at, binding.updated_at
              FROM vnext_bindings binding
              JOIN device_principals principal ON principal.id = binding.principal_id;

            CREATE TABLE vnext_tasks_owner_upgrade (
                task_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                capability TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
                input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 71),
                generation_id TEXT NOT NULL,
                predecessor_task_id TEXT,
                creation_reason TEXT NOT NULL CHECK(creation_reason IN ('original','retry','regenerate')),
                state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','success','failure','cancelled')),
                cancel_revision INTEGER NOT NULL DEFAULT 0,
                current_attempt_id TEXT,
                result_kind TEXT CHECK(result_kind IS NULL OR result_kind IN ('artifact','content_outcome')),
                result_json TEXT,
                error_code TEXT,
                retry_not_before_epoch REAL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                terminal_at TEXT,
                UNIQUE(device_id, epoch_id, capability, entity_id, entity_revision, input_sha256, generation_id)
            );
            INSERT INTO vnext_tasks_owner_upgrade
            SELECT task.task_id, principal.device_id, task.epoch_id, task.binding_id,
                   task.binding_generation, task.capability, task.entity_id,
                   task.entity_revision, task.input_sha256, task.generation_id,
                   task.predecessor_task_id, task.creation_reason, task.state,
                   task.cancel_revision, task.current_attempt_id, task.result_kind,
                   task.result_json, task.error_code, NULL, task.created_at, task.updated_at,
                   task.terminal_at
              FROM vnext_tasks task
              JOIN device_principals principal ON principal.id = task.principal_id;

            CREATE TABLE vnext_task_attempts_owner_upgrade (
                attempt_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES vnext_tasks_owner_upgrade(task_id) ON DELETE CASCADE,
                attempt_number INTEGER NOT NULL CHECK(attempt_number >= 1 AND attempt_number <= 3),
                state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','retryable_failure','terminal_failure','cancelled','lease_expired')),
                phase TEXT NOT NULL CHECK(phase IN ('queued','admitted','running','committing')),
                lease_owner TEXT,
                lease_expires_at_epoch REAL,
                error_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                terminal_at TEXT,
                UNIQUE(task_id, attempt_number)
            );
            INSERT INTO vnext_task_attempts_owner_upgrade
            SELECT attempt.* FROM vnext_task_attempts attempt
             WHERE EXISTS (
                 SELECT 1 FROM vnext_tasks_owner_upgrade task
                  WHERE task.task_id = attempt.task_id
             );

            DROP TABLE vnext_task_attempts;
            DROP TABLE vnext_tasks;
            DROP TABLE vnext_bindings;
            ALTER TABLE vnext_bindings_owner_upgrade RENAME TO vnext_bindings;
            ALTER TABLE vnext_tasks_owner_upgrade RENAME TO vnext_tasks;
            ALTER TABLE vnext_task_attempts_owner_upgrade RENAME TO vnext_task_attempts;
            COMMIT;
            """
        )
    except Exception:
        if connection.in_transaction:
            connection.rollback()
        raise
    finally:
        connection.execute("PRAGMA foreign_keys=ON")


def ensure_vnext_task_schema() -> None:
    ensure_device_schema()
    with control_connection() as connection:
        _upgrade_legacy_owner_schema(connection)
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS vnext_bindings (
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                binding_epoch_seq INTEGER NOT NULL CHECK(binding_epoch_seq >= 1),
                binding_revision INTEGER NOT NULL DEFAULT 1,
                cancel_revision INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL DEFAULT 'active'
                    CHECK(state IN ('active','purging','purged')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                purged_at INTEGER,
                PRIMARY KEY(device_id, epoch_id, binding_id),
                UNIQUE(device_id, epoch_id, binding_generation),
                UNIQUE(device_id, epoch_id, binding_epoch_seq)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_bindings_state
                ON vnext_bindings(device_id, epoch_id, state, updated_at);
            CREATE TABLE IF NOT EXISTS vnext_tasks (
                task_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                capability TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                entity_revision INTEGER NOT NULL CHECK(entity_revision >= 1),
                input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 71),
                generation_id TEXT NOT NULL,
                predecessor_task_id TEXT,
                creation_reason TEXT NOT NULL
                    CHECK(creation_reason IN ('original','retry','regenerate')),
                state TEXT NOT NULL DEFAULT 'active'
                    CHECK(state IN ('active','success','failure','cancelled')),
                cancel_revision INTEGER NOT NULL DEFAULT 0,
                current_attempt_id TEXT,
                result_kind TEXT CHECK(result_kind IS NULL OR result_kind IN ('artifact','content_outcome')),
                result_json TEXT,
                error_code TEXT,
                retry_not_before_epoch REAL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                terminal_at TEXT,
                UNIQUE(device_id, epoch_id, capability, entity_id, entity_revision, input_sha256, generation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_tasks_recovery
                ON vnext_tasks(device_id, epoch_id, state, updated_at, task_id);
            CREATE TABLE IF NOT EXISTS vnext_task_attempts (
                attempt_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES vnext_tasks(task_id) ON DELETE CASCADE,
                attempt_number INTEGER NOT NULL CHECK(attempt_number >= 1 AND attempt_number <= 3),
                state TEXT NOT NULL
                    CHECK(state IN ('queued','running','succeeded','retryable_failure','terminal_failure','cancelled','lease_expired')),
                phase TEXT NOT NULL CHECK(phase IN ('queued','admitted','running','committing')),
                lease_owner TEXT,
                lease_expires_at_epoch REAL,
                error_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                terminal_at TEXT,
                UNIQUE(task_id, attempt_number)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_attempts_recovery
                ON vnext_task_attempts(state, lease_expires_at_epoch, created_at, attempt_id);
            """
        )
        task_columns = _table_columns(connection, "vnext_tasks")
        if "retry_not_before_epoch" not in task_columns:
            connection.execute(
                "ALTER TABLE vnext_tasks ADD COLUMN retry_not_before_epoch REAL"
            )
        additive_columns = {
            "source_stream_id": "TEXT",
            "source_manifest_sha256": "TEXT",
            "current_checkpoint_slot": "INTEGER",
            "checkpoint_through_chapter": "INTEGER",
            "checkpoint_reservation_id": "TEXT",
            "result_artifact_id": "TEXT",
        }
        task_columns = _table_columns(connection, "vnext_tasks")
        for column, declaration in additive_columns.items():
            if column not in task_columns:
                connection.execute(
                    f"ALTER TABLE vnext_tasks ADD COLUMN {column} {declaration}"
                )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_vnext_tasks_retry_ready "
            "ON vnext_tasks(state, retry_not_before_epoch, created_at, task_id)"
        )
        # A process can die after the task row is made terminal but before an
        # attempt projection is normalized.  Repair only this impossible
        # combination; active retryable attempts remain untouched and can be
        # claimed normally.
        now = utc_now()
        connection.execute(
            """UPDATE vnext_task_attempts
                  SET state = 'terminal_failure', phase = 'committing',
                      updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
                WHERE state = 'retryable_failure'
                  AND EXISTS (
                      SELECT 1 FROM vnext_tasks task
                       WHERE task.task_id = vnext_task_attempts.task_id
                         AND task.state IN ('failure', 'success', 'cancelled')
                  )""",
            (now, now),
        )
        connection.commit()
    vnext_purge_store.ensure_purge_schema()


def _decode_task(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    result = dict(row)
    # Owner IDs are authorization inputs and are never echoed in task bodies.
    result.pop("device_id", None)
    raw = result.pop("result_json", None)
    if raw is None:
        result["result"] = None
    else:
        try:
            result["result"] = json.loads(raw)
        except json.JSONDecodeError as error:
            raise VNextTaskError("RESULT_INVALID", "任务结果损坏", 500) from error
    return result


def decode_task_row(row: Any) -> dict[str, Any] | None:
    """Decode a task selected inside another canonical-store transaction."""
    return _decode_task(row)


def _binding_row(connection: Any, context: TaskOwnerContext, binding_id: str) -> Any:
    return connection.execute(
        """SELECT * FROM vnext_bindings
           WHERE device_id = ? AND epoch_id = ? AND binding_id = ?""",
        (context.device_id, context.epoch_id, binding_id),
    ).fetchone()


def register_binding(
    context: TaskOwnerContext,
    *,
    binding_id: str,
    binding_generation: str,
    binding_epoch_seq: int | None = None,
    binding_revision: int = 1,
    cancel_revision: int = 0,
    purge_capability: dict[str, str] | None = None,
) -> dict[str, Any]:
    ensure_vnext_task_schema()
    binding_id = _safe(binding_id, "binding_id")
    binding_generation = _safe(binding_generation, "binding_generation", 256)
    if not isinstance(binding_revision, int) or binding_revision < 1:
        raise VNextTaskError("REVISION_INVALID", "binding revision 无效", 422)
    if not isinstance(cancel_revision, int) or cancel_revision < 0:
        raise VNextTaskError("REVISION_INVALID", "cancel revision 无效", 422)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = _binding_row(connection, context, binding_id)
        if existing is not None:
            if binding_epoch_seq is None:
                binding_epoch_seq = int(existing["binding_epoch_seq"])
        else:
            sequence_row = connection.execute(
                "SELECT COALESCE(MAX(binding_epoch_seq), 0) + 1 AS next_seq FROM vnext_bindings WHERE device_id = ? AND epoch_id = ?",
                (context.device_id, context.epoch_id),
            ).fetchone()
            next_sequence = int(sequence_row["next_seq"])
            if binding_epoch_seq is None:
                # v1 probe compatibility only. Device-v2 callers provide the
                # client-owned monotonic sequence explicitly.
                binding_epoch_seq = int(sequence_row["next_seq"])
            elif binding_epoch_seq != next_sequence:
                connection.rollback()
                raise VNextTaskError("BINDING_SEQUENCE_GAP", "binding sequence 必须连续登记", 409)
        if not isinstance(binding_epoch_seq, int) or binding_epoch_seq < 1:
            connection.rollback()
            raise VNextTaskError("BINDING_SEQUENCE_INVALID", "binding sequence 无效", 422)
        if existing is not None:
            if (
                str(existing["binding_generation"]) != binding_generation
                or int(existing["binding_epoch_seq"]) != binding_epoch_seq
                or int(existing["binding_revision"]) != binding_revision
                or int(existing["cancel_revision"]) != cancel_revision
            ):
                connection.rollback()
                raise VNextTaskError("BINDING_CONFLICT", "会议服务标识已绑定其他 generation", 409)
            if existing["state"] != "active":
                connection.rollback()
                raise VNextTaskError("BINDING_PURGING", "会议服务连接正在清理", 409)
            if purge_capability is not None:
                try:
                    vnext_purge_store.register_capability(
                        connection,
                        scope_kind="binding",
                        capability_id=purge_capability["capability_id"],
                        device_id=context.device_id,
                        epoch_id=context.epoch_id,
                        binding_id=binding_id,
                        binding_generation=binding_generation,
                        secret_sha256=purge_capability["secret_sha256"],
                        registration_request_id=purge_capability["registration_request_id"],
                    )
                except vnext_purge_store.VNextPurgeError as error:
                    connection.rollback()
                    raise VNextTaskError(error.code, error.message, error.status_code) from error
            connection.commit()
            return {
                **{key: value for key, value in dict(existing).items() if key != "device_id"},
                "created": False,
            }
        try:
            connection.execute(
                """INSERT INTO vnext_bindings(
                     device_id, epoch_id, binding_id, binding_generation,
                     binding_epoch_seq, binding_revision, cancel_revision,
                     created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    context.device_id, context.epoch_id, binding_id, binding_generation,
                    binding_epoch_seq, binding_revision, cancel_revision, now, now,
                ),
            )
            if purge_capability is not None:
                vnext_purge_store.register_capability(
                    connection,
                    scope_kind="binding",
                    capability_id=purge_capability["capability_id"],
                    device_id=context.device_id,
                    epoch_id=context.epoch_id,
                    binding_id=binding_id,
                    binding_generation=binding_generation,
                    secret_sha256=purge_capability["secret_sha256"],
                    registration_request_id=purge_capability["registration_request_id"],
                )
        except Exception as error:
            connection.rollback()
            if isinstance(error, VNextTaskError):
                raise
            if isinstance(error, vnext_purge_store.VNextPurgeError):
                raise VNextTaskError(error.code, error.message, error.status_code) from error
            raise VNextTaskError("BINDING_CONFLICT", "会议服务 generation 已被占用", 409) from error
        row = _binding_row(connection, context, binding_id)
        connection.commit()
    assert row is not None
    return {
        **{key: value for key, value in dict(row).items() if key != "device_id"},
        "created": True,
    }


def get_binding(context: TaskOwnerContext, binding_id: str) -> dict[str, Any] | None:
    ensure_vnext_task_schema()
    binding_id = _safe(binding_id, "binding_id")
    with control_connection() as connection:
        row = _binding_row(connection, context, binding_id)
    if row is None:
        return None
    return {key: value for key, value in dict(row).items() if key != "device_id"}


def create_task(
    context: TaskOwnerContext,
    *,
    task_id: str,
    binding_id: str,
    binding_generation: str,
    capability: str,
    entity_id: str,
    entity_revision: int,
    input_sha256: str,
    generation_id: str,
    predecessor_task_id: str | None = None,
    creation_reason: DeviceOperationReason = "original",
) -> tuple[dict[str, Any], bool]:
    ensure_vnext_task_schema()
    task_id = _safe(task_id, "task_id")
    binding_id = _safe(binding_id, "binding_id")
    binding_generation = _safe(binding_generation, "binding_generation", 256)
    capability = _safe(capability, "capability", 120)
    entity_id = _safe(entity_id, "entity_id")
    generation_id = _safe(generation_id, "generation_id")
    input_sha256 = _sha256(input_sha256)
    if not isinstance(entity_revision, int) or entity_revision < 1:
        raise VNextTaskError("REVISION_INVALID", "实体 revision 无效", 422)
    if creation_reason not in {"original", "retry", "regenerate"}:
        raise VNextTaskError("CREATION_REASON_INVALID", "任务生成原因无效", 422)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row, reused = create_task_in_transaction(
            connection,
            context,
            task_id=task_id,
            binding_id=binding_id,
            binding_generation=binding_generation,
            capability=capability,
            entity_id=entity_id,
            entity_revision=entity_revision,
            input_sha256=input_sha256,
            generation_id=generation_id,
            predecessor_task_id=predecessor_task_id,
            creation_reason=creation_reason,
        )
        connection.commit()
    decoded = _decode_task(row)
    assert decoded is not None
    return decoded, reused


def create_task_in_transaction(
    connection: Any,
    context: TaskOwnerContext,
    *,
    task_id: str,
    binding_id: str,
    binding_generation: str,
    capability: str,
    entity_id: str,
    entity_revision: int,
    input_sha256: str,
    generation_id: str,
    predecessor_task_id: str | None = None,
    creation_reason: DeviceOperationReason = "original",
) -> tuple[Any, bool]:
    """Create or replay a Task inside a domain owner's existing transaction."""
    task_id = _safe(task_id, "task_id")
    binding_id = _safe(binding_id, "binding_id")
    binding_generation = _safe(binding_generation, "binding_generation", 256)
    capability = _safe(capability, "capability", 120)
    entity_id = _safe(entity_id, "entity_id")
    generation_id = _safe(generation_id, "generation_id")
    input_sha256 = _sha256(input_sha256)
    if not isinstance(entity_revision, int) or entity_revision < 1:
        raise VNextTaskError("REVISION_INVALID", "实体 revision 无效", 422)
    if creation_reason not in {"original", "retry", "regenerate"}:
        raise VNextTaskError("CREATION_REASON_INVALID", "任务生成原因无效", 422)
    binding = _binding_row(connection, context, binding_id)
    if binding is None or str(binding["binding_generation"]) != binding_generation:
        raise VNextTaskError("BINDING_REQUIRED", "会议服务连接未登记", 428)
    if binding["state"] != "active":
        raise VNextTaskError("BINDING_PURGING", "会议服务连接正在清理", 409)
    existing = connection.execute(
        "SELECT * FROM vnext_tasks WHERE task_id = ?",
        (task_id,),
    ).fetchone()
    if existing is not None:
        same = (
            existing["device_id"] == context.device_id
            and existing["epoch_id"] == context.epoch_id
            and existing["binding_id"] == binding_id
            and existing["binding_generation"] == binding_generation
            and existing["capability"] == capability
            and existing["entity_id"] == entity_id
            and int(existing["entity_revision"]) == entity_revision
            and existing["input_sha256"] == input_sha256
            and existing["generation_id"] == generation_id
        )
        if not same:
            raise VNextTaskError("TASK_ID_CONFLICT", "任务 ID 已绑定其他输入", 409)
        return existing, True
    now = utc_now()
    connection.execute(
        """INSERT INTO vnext_tasks(
             task_id, device_id, epoch_id, binding_id, binding_generation,
             capability, entity_id, entity_revision, input_sha256, generation_id,
             predecessor_task_id, creation_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            task_id, context.device_id, context.epoch_id, binding_id,
            binding_generation, capability, entity_id, entity_revision,
            input_sha256, generation_id, predecessor_task_id, creation_reason,
            now, now,
        ),
    )
    row = connection.execute(
        "SELECT * FROM vnext_tasks WHERE task_id = ?", (task_id,),
    ).fetchone()
    assert row is not None
    return row, False


def get_task(context: TaskOwnerContext, task_id: str) -> dict[str, Any] | None:
    ensure_vnext_task_schema()
    task_id = _safe(task_id, "task_id")
    with control_connection() as connection:
        return _decode_task(connection.execute(
            "SELECT * FROM vnext_tasks WHERE task_id = ? AND device_id = ? AND epoch_id = ?",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone())


def claim_attempt(
    context: TaskOwnerContext,
    task_id: str,
    *,
    lease_owner: str | None = None,
    lease_seconds: int = LEASE_SECONDS,
) -> dict[str, Any] | None:
    ensure_vnext_task_schema()
    task_id = _safe(task_id, "task_id")
    owner = _safe(lease_owner or f"{socket.gethostname()}:{os.getpid()}", "lease_owner", 200)
    now_epoch = _now_epoch()
    expires = now_epoch + max(30, min(1800, int(lease_seconds)))
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        task = connection.execute(
            "SELECT * FROM vnext_tasks WHERE task_id = ? AND device_id = ? AND epoch_id = ?",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
        if task is None or task["state"] != "active":
            connection.rollback()
            return None
        if (
            task["retry_not_before_epoch"] is not None
            and float(task["retry_not_before_epoch"]) > now_epoch
        ):
            connection.rollback()
            return None
        current = connection.execute(
            """SELECT * FROM vnext_task_attempts
               WHERE task_id = ? AND state IN ('queued','running','retryable_failure','lease_expired')
               ORDER BY attempt_number DESC LIMIT 1""",
            (task_id,),
        ).fetchone()
        if current is not None and current["state"] == "queued":
            connection.execute(
                "UPDATE vnext_task_attempts SET state = 'running', phase = 'admitted', lease_owner = ?, lease_expires_at_epoch = ?, updated_at = ? WHERE attempt_id = ?",
                (owner, expires, now, current["attempt_id"]),
            )
            connection.execute(
                "UPDATE vnext_tasks SET current_attempt_id = ?, retry_not_before_epoch = NULL, "
                "updated_at = ? WHERE task_id = ?",
                (current["attempt_id"], now, task_id),
            )
            row = connection.execute("SELECT * FROM vnext_task_attempts WHERE attempt_id = ?", (current["attempt_id"],)).fetchone()
            connection.commit()
            assert row is not None
            return dict(row)
        if (
            current is not None
            and current["state"] == "running"
            and current["lease_owner"] == owner
        ):
            connection.execute(
                """UPDATE vnext_task_attempts
                      SET lease_expires_at_epoch = ?, updated_at = ?
                    WHERE attempt_id = ?""",
                (expires, now, current["attempt_id"]),
            )
            row = connection.execute(
                "SELECT * FROM vnext_task_attempts WHERE attempt_id = ?",
                (current["attempt_id"],),
            ).fetchone()
            connection.commit()
            assert row is not None
            return dict(row)
        if current is not None and current["state"] == "running" and current["lease_expires_at_epoch"] > now_epoch:
            connection.rollback()
            return None
        if current is not None and current["state"] == "running":
            connection.execute(
                "UPDATE vnext_task_attempts SET state = 'lease_expired', updated_at = ?, terminal_at = ? WHERE attempt_id = ?",
                (now, now, current["attempt_id"]),
            )
        attempt_number = int(current["attempt_number"]) + 1 if current is not None else 1
        if attempt_number > MAX_ATTEMPTS:
            connection.execute(
                "UPDATE vnext_tasks SET state = 'failure', error_code = 'ATTEMPT_LIMIT', updated_at = ?, terminal_at = ? WHERE task_id = ?",
                (now, now, task_id),
            )
            connection.commit()
            return None
        attempt_id = f"{task_id}:attempt:{attempt_number}:{uuid.uuid4().hex[:12]}"
        connection.execute(
            """INSERT INTO vnext_task_attempts(
                 attempt_id, task_id, attempt_number, state, phase,
                 lease_owner, lease_expires_at_epoch, created_at, updated_at
               ) VALUES (?, ?, ?, 'running', 'admitted', ?, ?, ?, ?)""",
            (attempt_id, task_id, attempt_number, owner, expires, now, now),
        )
        connection.execute(
            "UPDATE vnext_tasks SET current_attempt_id = ?, retry_not_before_epoch = NULL, "
            "updated_at = ? WHERE task_id = ?",
            (attempt_id, now, task_id),
        )
        row = connection.execute("SELECT * FROM vnext_task_attempts WHERE attempt_id = ?", (attempt_id,)).fetchone()
        connection.commit()
    assert row is not None
    return dict(row)


def mark_success(
    context: TaskOwnerContext,
    task_id: str,
    attempt_id: str,
    result: Any,
    *,
    result_kind: Literal["artifact", "content_outcome"] = "artifact",
    lease_owner: str | None = None,
) -> bool:
    ensure_vnext_task_schema()
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    owner = _safe(lease_owner or f"{socket.gethostname()}:{os.getpid()}", "lease_owner", 200)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        completed = mark_success_in_transaction(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            result=result,
            result_kind=result_kind,
            lease_owner=owner,
        )
        if completed:
            connection.commit()
        else:
            connection.rollback()
        return completed


def mark_success_in_transaction(
    connection: Any,
    context: TaskOwnerContext,
    *,
    task_id: str,
    attempt_id: str,
    result: Any,
    result_kind: Literal["artifact", "content_outcome"] = "artifact",
    lease_owner: str,
) -> bool:
    """Commit an attempt terminal inside the domain artifact transaction."""
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    owner = _safe(lease_owner, "lease_owner", 200)
    if result_kind not in {"artifact", "content_outcome"}:
        raise VNextTaskError("RESULT_KIND_INVALID", "任务结果类型无效", 422)
    now = utc_now()
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    attempt = connection.execute(
        """SELECT a.* FROM vnext_task_attempts a JOIN vnext_tasks t ON t.task_id = a.task_id
           WHERE a.attempt_id = ? AND a.task_id = ? AND t.device_id = ? AND t.epoch_id = ?""",
        (attempt_id, task_id, context.device_id, context.epoch_id),
    ).fetchone()
    if attempt is None or attempt["state"] != "running" or attempt["lease_owner"] != owner:
        return False
    connection.execute(
        """UPDATE vnext_task_attempts
              SET state = 'succeeded', phase = 'committing', updated_at = ?, terminal_at = ?
            WHERE attempt_id = ?""",
        (now, now, attempt_id),
    )
    cursor = connection.execute(
        """UPDATE vnext_tasks
              SET state = 'success', result_kind = ?, result_json = ?, error_code = NULL,
                  retry_not_before_epoch = NULL, updated_at = ?, terminal_at = ?
            WHERE task_id = ? AND state = 'active' AND current_attempt_id = ?""",
        (result_kind, encoded, now, now, task_id, attempt_id),
    )
    return cursor.rowcount == 1


def mark_failure(
    context: TaskOwnerContext,
    task_id: str,
    attempt_id: str,
    error_code: str,
    *,
    retryable: bool,
    retry_after_seconds: float = 0,
    lease_owner: str | None = None,
) -> bool:
    ensure_vnext_task_schema()
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    owner = _safe(lease_owner or f"{socket.gethostname()}:{os.getpid()}", "lease_owner", 200)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        marked = mark_failure_in_transaction(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            error_code=error_code,
            retryable=retryable,
            retry_after_seconds=retry_after_seconds,
            lease_owner=owner,
        )
        if marked:
            connection.commit()
        else:
            connection.rollback()
        return marked


def mark_failure_in_transaction(
    connection: Any,
    context: TaskOwnerContext,
    *,
    task_id: str,
    attempt_id: str,
    error_code: str,
    retryable: bool,
    retry_after_seconds: float = 0,
    lease_owner: str,
) -> bool:
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    owner = _safe(lease_owner, "lease_owner", 200)
    code = _safe(error_code, "error_code", 160)
    now = utc_now()
    attempt = connection.execute(
        """SELECT a.* FROM vnext_task_attempts a JOIN vnext_tasks t ON t.task_id = a.task_id
           WHERE a.attempt_id = ? AND a.task_id = ? AND t.device_id = ? AND t.epoch_id = ?""",
        (attempt_id, task_id, context.device_id, context.epoch_id),
    ).fetchone()
    if attempt is None or attempt["state"] != "running" or attempt["lease_owner"] != owner:
        return False
    task_state: TaskState = (
        "active" if retryable and int(attempt["attempt_number"]) < MAX_ATTEMPTS else "failure"
    )
    # The attempt cannot remain retryable after the task reaches a terminal
    # state.  Keeping the two rows monotonic prevents stale workers and the
    # deletion gate from treating a finished task as runnable work.
    next_state: AttemptState = "retryable_failure" if task_state == "active" else "terminal_failure"
    connection.execute(
        """UPDATE vnext_task_attempts
              SET state = ?, phase = 'committing', error_code = ?, updated_at = ?, terminal_at = ?
            WHERE attempt_id = ?""",
        (next_state, code, now, now, attempt_id),
    )
    bounded_retry_seconds = max(0.0, min(3600.0, float(retry_after_seconds)))
    retry_not_before_epoch = (
        _now_epoch() + bounded_retry_seconds
        if task_state == "active" and bounded_retry_seconds > 0
        else None
    )
    cursor = connection.execute(
        """UPDATE vnext_tasks SET state = ?, error_code = ?, retry_not_before_epoch = ?, updated_at = ?,
                  terminal_at = CASE WHEN ? = 'failure' THEN ? ELSE NULL END
           WHERE task_id = ? AND state = 'active' AND current_attempt_id = ?""",
        (
            task_state, code, retry_not_before_epoch, now,
            task_state, now, task_id, attempt_id,
        ),
    )
    return cursor.rowcount == 1


def cancel_task(context: TaskOwnerContext, task_id: str) -> bool:
    ensure_vnext_task_schema()
    task_id = _safe(task_id, "task_id")
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        cancelled = cancel_task_in_transaction(
            connection,
            context,
            task_id=task_id,
            now=now,
        )
        connection.commit()
        return cancelled


def cancel_task_in_transaction(
    connection: Any,
    context: TaskOwnerContext,
    *,
    task_id: str,
    now: str | None = None,
) -> bool:
    """Fence a Task from a domain owner's existing cancellation transaction."""
    task_id = _safe(task_id, "task_id")
    cancelled_at = now or utc_now()
    cursor = connection.execute(
        """UPDATE vnext_tasks SET state = 'cancelled', cancel_revision = cancel_revision + 1,
                  updated_at = ?, terminal_at = ?
           WHERE task_id = ? AND device_id = ? AND epoch_id = ? AND state = 'active'""",
        (cancelled_at, cancelled_at, task_id, context.device_id, context.epoch_id),
    )
    connection.execute(
        """UPDATE vnext_task_attempts SET state = 'cancelled', updated_at = ?, terminal_at = ?
           WHERE task_id = ? AND state IN ('queued','running')""",
        (cancelled_at, cancelled_at, task_id),
    )
    return cursor.rowcount == 1


def cancel_binding_tasks(context: TaskOwnerContext, binding_id: str) -> int:
    """Cancel every non-terminal task fenced by a purging binding.

    Binding deletion is a domain-level operation; it must also advance the
    generic task owner or a late worker could still commit an artifact after
    the mobile binding has been purged.
    """
    ensure_vnext_task_schema()
    binding_id = _safe(binding_id, "binding_id")
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            """SELECT task_id FROM vnext_tasks
               WHERE device_id = ? AND epoch_id = ? AND binding_id = ? AND state = 'active'""",
            (context.device_id, context.epoch_id, binding_id),
        ).fetchall()
        if not rows:
            connection.commit()
            return 0
        task_ids = [str(row["task_id"]) for row in rows]
        connection.executemany(
            """UPDATE vnext_tasks
                  SET state = 'cancelled', cancel_revision = cancel_revision + 1,
                      updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
                WHERE task_id = ? AND state = 'active'""",
            [(now, now, task_id) for task_id in task_ids],
        )
        connection.executemany(
            """UPDATE vnext_task_attempts
                  SET state = 'cancelled', updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
                WHERE task_id = ? AND state IN ('queued','running')""",
            [(now, now, task_id) for task_id in task_ids],
        )
        connection.commit()
        return len(task_ids)


def cancel_epoch_tasks(context: TaskOwnerContext) -> int:
    """Cancel all active generic tasks before an epoch is physically closed."""
    ensure_vnext_task_schema()
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            """SELECT task_id FROM vnext_tasks
               WHERE device_id = ? AND epoch_id = ? AND state = 'active'""",
            (context.device_id, context.epoch_id),
        ).fetchall()
        task_ids = [str(row["task_id"]) for row in rows]
        if task_ids:
            connection.executemany(
                """UPDATE vnext_tasks
                      SET state = 'cancelled', cancel_revision = cancel_revision + 1,
                          updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
                    WHERE task_id = ? AND state = 'active'""",
                [(now, now, task_id) for task_id in task_ids],
            )
            connection.executemany(
                """UPDATE vnext_task_attempts
                      SET state = 'cancelled', updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
                    WHERE task_id = ? AND state IN ('queued','running')""",
                [(now, now, task_id) for task_id in task_ids],
            )
        connection.commit()
        return len(task_ids)


def recoverable_tasks(context: TaskOwnerContext) -> list[dict[str, Any]]:
    ensure_vnext_task_schema()
    now = _now_epoch()
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT * FROM vnext_tasks
               WHERE device_id = ? AND epoch_id = ? AND state = 'active'
               ORDER BY created_at, task_id""",
            (context.device_id, context.epoch_id),
        ).fetchall()
        for row in connection.execute(
            """SELECT attempt_id FROM vnext_task_attempts
               WHERE state = 'running' AND lease_expires_at_epoch <= ?""",
            (now,),
        ).fetchall():
            connection.execute(
                "UPDATE vnext_task_attempts SET state = 'lease_expired', updated_at = ?, terminal_at = ? WHERE attempt_id = ? AND state = 'running'",
                (utc_now(), utc_now(), row["attempt_id"]),
            )
        connection.commit()
    return [decoded for row in rows if (decoded := _decode_task(row)) is not None]


def pending_source_stream_tasks(limit: int = 32) -> list[dict[str, str]]:
    """Return active source-stream tasks for the generic vNext workers.

    The query intentionally returns only opaque owner identity.  Domain
    payloads remain in their stores and the worker must reconstruct a fresh
    owner context before claiming a lease.  This also makes the scan safe to
    run after a process restart without retaining an in-memory queue.
    """
    ensure_vnext_task_schema()
    bounded = max(1, min(256, int(limit)))
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT device_id, epoch_id, task_id
                 FROM vnext_tasks
                WHERE state = 'active'
                  AND source_stream_id IS NOT NULL
                  AND capability = 'summary'
                ORDER BY created_at, task_id
                LIMIT ?""",
            (bounded,),
        ).fetchall()
    return [
        {
            "device_id": str(row["device_id"]),
            "epoch_id": str(row["epoch_id"]),
            "task_id": str(row["task_id"]),
        }
        for row in rows
    ]


def reset_store_for_tests() -> None:
    """Clear only the vNext tables in the configured control database."""
    ensure_vnext_task_schema()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM vnext_task_attempts")
        connection.execute("DELETE FROM vnext_tasks")
        connection.execute("DELETE FROM vnext_bindings")
        connection.commit()
