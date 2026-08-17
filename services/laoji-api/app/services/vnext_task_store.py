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
from typing import Any, Literal
import uuid

from app.services.device_identity import DeviceContext, control_connection, ensure_device_schema, utc_now


TaskState = Literal["active", "success", "failure", "cancelled"]
AttemptState = Literal[
    "queued", "running", "succeeded", "retryable_failure",
    "terminal_failure", "cancelled", "lease_expired",
]
AttemptPhase = Literal["queued", "admitted", "running", "committing"]
DeviceOperationReason = Literal["original", "retry", "regenerate"]

MAX_ATTEMPTS = 3
LEASE_SECONDS = 180


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


def ensure_vnext_task_schema() -> None:
    ensure_device_schema()
    with control_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS vnext_bindings (
                principal_id INTEGER NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                binding_revision INTEGER NOT NULL DEFAULT 1,
                cancel_revision INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL DEFAULT 'active'
                    CHECK(state IN ('active','purging','purged')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(principal_id, epoch_id, binding_id),
                UNIQUE(principal_id, epoch_id, binding_generation)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_bindings_state
                ON vnext_bindings(principal_id, epoch_id, state, updated_at);
            CREATE TABLE IF NOT EXISTS vnext_tasks (
                task_id TEXT PRIMARY KEY,
                principal_id INTEGER NOT NULL,
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
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                terminal_at TEXT,
                UNIQUE(principal_id, epoch_id, capability, entity_id, entity_revision, input_sha256, generation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_tasks_recovery
                ON vnext_tasks(principal_id, epoch_id, state, updated_at, task_id);
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
        connection.commit()


def _decode_task(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    result = dict(row)
    # Principal IDs are internal control-store keys and are never part of the
    # device contract. Epoch/binding identifiers remain opaque client values.
    result.pop("principal_id", None)
    raw = result.pop("result_json", None)
    if raw is None:
        result["result"] = None
    else:
        try:
            result["result"] = json.loads(raw)
        except json.JSONDecodeError as error:
            raise VNextTaskError("RESULT_INVALID", "任务结果损坏", 500) from error
    return result


def _binding_row(connection: Any, context: DeviceContext, binding_id: str) -> Any:
    return connection.execute(
        """SELECT * FROM vnext_bindings
           WHERE principal_id = ? AND epoch_id = ? AND binding_id = ?""",
        (context.principal_id, context.epoch_id, binding_id),
    ).fetchone()


def register_binding(
    context: DeviceContext,
    *,
    binding_id: str,
    binding_generation: str,
) -> dict[str, Any]:
    ensure_vnext_task_schema()
    binding_id = _safe(binding_id, "binding_id")
    binding_generation = _safe(binding_generation, "binding_generation", 256)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = _binding_row(connection, context, binding_id)
        if existing is not None:
            if str(existing["binding_generation"]) != binding_generation:
                raise VNextTaskError("BINDING_CONFLICT", "会议服务标识已绑定其他 generation", 409)
            if existing["state"] != "active":
                raise VNextTaskError("BINDING_PURGING", "会议服务连接正在清理", 409)
            connection.commit()
            return {key: value for key, value in dict(existing).items() if key != "principal_id"}
        try:
            connection.execute(
                """INSERT INTO vnext_bindings(
                     principal_id, epoch_id, binding_id, binding_generation,
                     created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?)""",
                (context.principal_id, context.epoch_id, binding_id, binding_generation, now, now),
            )
        except Exception as error:
            connection.rollback()
            raise VNextTaskError("BINDING_CONFLICT", "会议服务 generation 已被占用", 409) from error
        row = _binding_row(connection, context, binding_id)
        connection.commit()
    assert row is not None
    return {key: value for key, value in dict(row).items() if key != "principal_id"}


def create_task(
    context: DeviceContext,
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
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        binding = _binding_row(connection, context, binding_id)
        if binding is None or str(binding["binding_generation"]) != binding_generation:
            connection.rollback()
            raise VNextTaskError("BINDING_REQUIRED", "会议服务连接未登记", 428)
        if binding["state"] != "active":
            connection.rollback()
            raise VNextTaskError("BINDING_PURGING", "会议服务连接正在清理", 409)
        existing = connection.execute(
            "SELECT * FROM vnext_tasks WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        if existing is not None:
            same = (
                existing["principal_id"] == context.principal_id
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
                connection.rollback()
                raise VNextTaskError("TASK_ID_CONFLICT", "任务 ID 已绑定其他输入", 409)
            connection.commit()
            decoded = _decode_task(existing)
            assert decoded is not None
            return decoded, True
        connection.execute(
            """INSERT INTO vnext_tasks(
                 task_id, principal_id, epoch_id, binding_id, binding_generation,
                 capability, entity_id, entity_revision, input_sha256, generation_id,
                 predecessor_task_id, creation_reason, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                task_id, context.principal_id, context.epoch_id, binding_id,
                binding_generation, capability, entity_id, entity_revision,
                input_sha256, generation_id, predecessor_task_id, creation_reason,
                now, now,
            ),
        )
        row = connection.execute("SELECT * FROM vnext_tasks WHERE task_id = ?", (task_id,)).fetchone()
        connection.commit()
    assert row is not None
    decoded = _decode_task(row)
    assert decoded is not None
    return decoded, False


def get_task(context: DeviceContext, task_id: str) -> dict[str, Any] | None:
    ensure_vnext_task_schema()
    task_id = _safe(task_id, "task_id")
    with control_connection() as connection:
        return _decode_task(connection.execute(
            "SELECT * FROM vnext_tasks WHERE task_id = ? AND principal_id = ? AND epoch_id = ?",
            (task_id, context.principal_id, context.epoch_id),
        ).fetchone())


def claim_attempt(
    context: DeviceContext,
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
            "SELECT * FROM vnext_tasks WHERE task_id = ? AND principal_id = ? AND epoch_id = ?",
            (task_id, context.principal_id, context.epoch_id),
        ).fetchone()
        if task is None or task["state"] != "active":
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
                "UPDATE vnext_tasks SET current_attempt_id = ?, updated_at = ? WHERE task_id = ?",
                (current["attempt_id"], now, task_id),
            )
            row = connection.execute("SELECT * FROM vnext_task_attempts WHERE attempt_id = ?", (current["attempt_id"],)).fetchone()
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
            "UPDATE vnext_tasks SET current_attempt_id = ?, updated_at = ? WHERE task_id = ?",
            (attempt_id, now, task_id),
        )
        row = connection.execute("SELECT * FROM vnext_task_attempts WHERE attempt_id = ?", (attempt_id,)).fetchone()
        connection.commit()
    assert row is not None
    return dict(row)


def mark_success(
    context: DeviceContext,
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
    now = utc_now()
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        attempt = connection.execute(
            """SELECT a.* FROM vnext_task_attempts a JOIN vnext_tasks t ON t.task_id = a.task_id
               WHERE a.attempt_id = ? AND a.task_id = ? AND t.principal_id = ? AND t.epoch_id = ?""",
            (attempt_id, task_id, context.principal_id, context.epoch_id),
        ).fetchone()
        if attempt is None or attempt["state"] != "running" or attempt["lease_owner"] != owner:
            connection.rollback()
            return False
        connection.execute(
            "UPDATE vnext_task_attempts SET state = 'succeeded', phase = 'committing', updated_at = ?, terminal_at = ? WHERE attempt_id = ?",
            (now, now, attempt_id),
        )
        cursor = connection.execute(
            """UPDATE vnext_tasks
                  SET state = 'success', result_kind = ?, result_json = ?, error_code = NULL,
                      updated_at = ?, terminal_at = ?
                WHERE task_id = ? AND state = 'active' AND current_attempt_id = ?""",
            (result_kind, encoded, now, now, task_id, attempt_id),
        )
        connection.commit()
        return cursor.rowcount == 1


def mark_failure(
    context: DeviceContext,
    task_id: str,
    attempt_id: str,
    error_code: str,
    *,
    retryable: bool,
    lease_owner: str | None = None,
) -> bool:
    ensure_vnext_task_schema()
    task_id = _safe(task_id, "task_id")
    attempt_id = _safe(attempt_id, "attempt_id")
    owner = _safe(lease_owner or f"{socket.gethostname()}:{os.getpid()}", "lease_owner", 200)
    code = _safe(error_code, "error_code", 160)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        attempt = connection.execute(
            """SELECT a.* FROM vnext_task_attempts a JOIN vnext_tasks t ON t.task_id = a.task_id
               WHERE a.attempt_id = ? AND a.task_id = ? AND t.principal_id = ? AND t.epoch_id = ?""",
            (attempt_id, task_id, context.principal_id, context.epoch_id),
        ).fetchone()
        if attempt is None or attempt["state"] != "running" or attempt["lease_owner"] != owner:
            connection.rollback()
            return False
        next_state: AttemptState = "retryable_failure" if retryable else "terminal_failure"
        connection.execute(
            "UPDATE vnext_task_attempts SET state = ?, phase = 'committing', error_code = ?, updated_at = ?, terminal_at = ? WHERE attempt_id = ?",
            (next_state, code, now, now, attempt_id),
        )
        task_state: TaskState = "active" if retryable and int(attempt["attempt_number"]) < MAX_ATTEMPTS else "failure"
        cursor = connection.execute(
            """UPDATE vnext_tasks SET state = ?, error_code = ?, updated_at = ?,
                      terminal_at = CASE WHEN ? = 'failure' THEN ? ELSE NULL END
               WHERE task_id = ? AND state = 'active' AND current_attempt_id = ?""",
            (task_state, code, now, task_state, now, task_id, attempt_id),
        )
        connection.commit()
        return cursor.rowcount == 1


def cancel_task(context: DeviceContext, task_id: str) -> bool:
    ensure_vnext_task_schema()
    task_id = _safe(task_id, "task_id")
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        cursor = connection.execute(
            """UPDATE vnext_tasks SET state = 'cancelled', cancel_revision = cancel_revision + 1,
                      updated_at = ?, terminal_at = ?
               WHERE task_id = ? AND principal_id = ? AND epoch_id = ? AND state = 'active'""",
            (now, now, task_id, context.principal_id, context.epoch_id),
        )
        connection.execute(
            """UPDATE vnext_task_attempts SET state = 'cancelled', updated_at = ?, terminal_at = ?
               WHERE task_id = ? AND state IN ('queued','running')""",
            (now, now, task_id),
        )
        connection.commit()
        return cursor.rowcount == 1


def cancel_binding_tasks(context: DeviceContext, binding_id: str) -> int:
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
               WHERE principal_id = ? AND epoch_id = ? AND binding_id = ? AND state = 'active'""",
            (context.principal_id, context.epoch_id, binding_id),
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


def cancel_epoch_tasks(context: DeviceContext) -> int:
    """Cancel all active generic tasks before an epoch is physically closed."""
    ensure_vnext_task_schema()
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            """SELECT task_id FROM vnext_tasks
               WHERE principal_id = ? AND epoch_id = ? AND state = 'active'""",
            (context.principal_id, context.epoch_id),
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


def recoverable_tasks(context: DeviceContext) -> list[dict[str, Any]]:
    ensure_vnext_task_schema()
    now = _now_epoch()
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT * FROM vnext_tasks
               WHERE principal_id = ? AND epoch_id = ? AND state = 'active'
               ORDER BY created_at, task_id""",
            (context.principal_id, context.epoch_id),
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


def reset_store_for_tests() -> None:
    """Clear only the vNext tables in the configured control database."""
    ensure_vnext_task_schema()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM vnext_task_attempts")
        connection.execute("DELETE FROM vnext_tasks")
        connection.execute("DELETE FROM vnext_bindings")
        connection.commit()
