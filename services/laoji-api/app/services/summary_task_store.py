"""SQLite-backed identity and recovery state for authenticated summary jobs."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import os
import sqlite3
import socket
import threading
import time
from typing import Any

from sqlalchemy.engine import make_url

from app.config import settings


SCHEMA_VERSION = 1
REPLAY_SECONDS = 5 * 60
DEFAULT_LEASE_SECONDS = 180
_SCHEMA_LOCK = threading.Lock()
_INITIALIZED_PATHS: set[Path] = set()


def _database_path() -> Path:
    url = make_url(settings.DATABASE_URL)
    if not url.drivername.startswith("sqlite") or not url.database:
        raise RuntimeError("summary_task_store_requires_sqlite")
    return Path(url.database).expanduser().resolve()


def _connect() -> sqlite3.Connection:
    path = _database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=10000")
    with _SCHEMA_LOCK:
        if path not in _INITIALIZED_PATHS:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS summary_tasks_v2 (
                    id TEXT PRIMARY KEY,
                    schema_version INTEGER NOT NULL,
                    task_kind TEXT NOT NULL,
                    task_scope TEXT,
                    meeting_id TEXT NOT NULL,
                    dedupe_key TEXT,
                    request_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    stage TEXT NOT NULL DEFAULT 'queued',
                    attempt INTEGER NOT NULL DEFAULT 0,
                    result_json TEXT,
                    error_code TEXT,
                    lease_owner TEXT,
                    lease_expires_at_epoch REAL,
                    heartbeat_at_epoch REAL,
                    checkpoint_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    retain_generated_result INTEGER NOT NULL DEFAULT 0,
                    result_expires_at TEXT,
                    CHECK (schema_version = 1),
                    CHECK (status IN ('queued','running','success','failure')),
                    CHECK (attempt >= 0)
                );
                CREATE INDEX IF NOT EXISTS idx_summary_tasks_v2_recovery
                    ON summary_tasks_v2(status, created_at, id);
                CREATE INDEX IF NOT EXISTS idx_summary_tasks_v2_dedupe
                    ON summary_tasks_v2(task_scope, meeting_id, task_kind, dedupe_key, created_at);
                """
            )
            columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(summary_tasks_v2)")
            }
            for column, ddl in {
                "lease_owner": "TEXT",
                "lease_expires_at_epoch": "REAL",
                "heartbeat_at_epoch": "REAL",
                "checkpoint_json": "TEXT",
                "retain_generated_result": "INTEGER NOT NULL DEFAULT 0",
                "result_expires_at": "TEXT",
                "stage": "TEXT NOT NULL DEFAULT 'queued'",
            }.items():
                if column not in columns:
                    connection.execute(
                        f"ALTER TABLE summary_tasks_v2 ADD COLUMN {column} {ddl}"
                    )
            connection.commit()
            _INITIALIZED_PATHS.add(path)
    return connection


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _decode_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    payload = dict(row)
    try:
        payload["request"] = json.loads(payload.pop("request_json"))
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("summary_task_request_invalid") from exc
    raw_result = payload.pop("result_json")
    if raw_result is not None:
        try:
            payload["result"] = json.loads(raw_result)
        except (TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError("summary_task_result_invalid") from exc
    else:
        payload["result"] = None
    raw_checkpoint = payload.pop("checkpoint_json", None)
    if raw_checkpoint is not None:
        try:
            payload["checkpoint"] = json.loads(raw_checkpoint)
        except (TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError("summary_task_checkpoint_invalid") from exc
    else:
        payload["checkpoint"] = None
    payload["retain_generated_result"] = bool(payload.get("retain_generated_result"))
    return payload


def create_task(
    *,
    task_id: str,
    task_kind: str,
    task_scope: str | None,
    meeting_id: str,
    dedupe_key: str | None,
    request: dict[str, Any],
    force: bool,
    retain_generated_result: bool = False,
    result_ttl_seconds: int | None = None,
) -> tuple[dict[str, Any], bool]:
    now = _now()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=REPLAY_SECONDS)).isoformat()
    encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    result_expires_at = None
    if not retain_generated_result and result_ttl_seconds is not None:
        ttl = max(1, int(result_ttl_seconds))
        result_expires_at = (
            datetime.now(timezone.utc) + timedelta(seconds=ttl)
        ).isoformat()
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if dedupe_key and not force:
            existing = connection.execute(
                """
                SELECT * FROM summary_tasks_v2
                WHERE task_scope IS ? AND meeting_id = ? AND task_kind = ? AND dedupe_key = ?
                  AND (status IN ('queued','running') OR (status = 'success' AND completed_at >= ?))
                ORDER BY created_at DESC, id DESC LIMIT 1
                """,
                (task_scope, meeting_id, task_kind, dedupe_key, cutoff),
            ).fetchone()
            if existing is not None:
                connection.commit()
                decoded = _decode_row(existing)
                assert decoded is not None
                return decoded, True
        connection.execute(
            """
            INSERT INTO summary_tasks_v2 (
                id, schema_version, task_kind, task_scope, meeting_id, dedupe_key,
                request_json, status, stage, attempt, created_at, updated_at
                , retain_generated_result, result_expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?)
            """,
            (
                task_id,
                SCHEMA_VERSION,
                task_kind,
                task_scope,
                meeting_id,
                dedupe_key,
                encoded,
                now,
                now,
                1 if retain_generated_result else 0,
                result_expires_at,
            ),
        )
        row = connection.execute(
            "SELECT * FROM summary_tasks_v2 WHERE id = ?",
            (task_id,),
        ).fetchone()
        connection.commit()
    decoded = _decode_row(row)
    assert decoded is not None
    return decoded, False


def _lease_seconds(value: int | None = None) -> int:
    raw = value if value is not None else os.getenv(
        "LAOJI_SUMMARY_TASK_LEASE_SECONDS",
        str(DEFAULT_LEASE_SECONDS),
    )
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        parsed = DEFAULT_LEASE_SECONDS
    return min(30 * 60, max(30, parsed))


def claim_task(task_id: str, lease_owner: str, *, lease_seconds: int | None = None) -> bool:
    owner = lease_owner.strip()
    if not owner or len(owner) > 200:
        raise ValueError("summary_task_lease_owner_invalid")
    now_epoch = time.time()
    expires_epoch = now_epoch + _lease_seconds(lease_seconds)
    now = _now()
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        cursor = connection.execute(
            """
            UPDATE summary_tasks_v2
            SET status = 'running', stage = 'preparing',
                attempt = attempt + 1, error_code = NULL,
                lease_owner = ?, lease_expires_at_epoch = ?, heartbeat_at_epoch = ?,
                updated_at = ?, completed_at = NULL
            WHERE id = ? AND (
                status = 'queued'
                OR (
                    status = 'running'
                    AND (lease_expires_at_epoch IS NULL OR lease_expires_at_epoch <= ?)
                )
            )
            """,
            (owner, expires_epoch, now_epoch, now, task_id, now_epoch),
        )
        connection.commit()
        return cursor.rowcount == 1


def renew_lease(
    task_id: str,
    lease_owner: str,
    *,
    lease_seconds: int | None = None,
) -> bool:
    now_epoch = time.time()
    expires_epoch = now_epoch + _lease_seconds(lease_seconds)
    now = _now()
    with _connect() as connection:
        cursor = connection.execute(
            """
            UPDATE summary_tasks_v2
            SET lease_expires_at_epoch = ?, heartbeat_at_epoch = ?, updated_at = ?
            WHERE id = ? AND status = 'running' AND lease_owner = ?
              AND lease_expires_at_epoch > ?
            """,
            (expires_epoch, now_epoch, now, task_id, lease_owner, now_epoch),
        )
        connection.commit()
        return cursor.rowcount == 1


def update_stage(task_id: str, stage: str, *, lease_owner: str) -> bool:
    normalized = stage.strip().lower()
    if normalized not in {"preparing", "generating", "verifying", "persisting"}:
        raise ValueError("summary_task_stage_invalid")
    now_epoch = time.time()
    with _connect() as connection:
        cursor = connection.execute(
            """
            UPDATE summary_tasks_v2
            SET stage = ?, updated_at = ?
            WHERE id = ? AND status = 'running' AND lease_owner = ?
              AND lease_expires_at_epoch > ?
            """,
            (normalized, _now(), task_id, lease_owner, now_epoch),
        )
        connection.commit()
        return cursor.rowcount == 1


def mark_success(task_id: str, result: Any, *, lease_owner: str) -> bool:
    now = _now()
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    with _connect() as connection:
        cursor = connection.execute(
            """
            UPDATE summary_tasks_v2
            SET status = 'success', stage = 'success', result_json = ?, error_code = NULL,
                lease_owner = NULL, lease_expires_at_epoch = NULL,
                heartbeat_at_epoch = NULL, checkpoint_json = NULL,
                updated_at = ?, completed_at = ?
            WHERE id = ? AND status = 'running' AND lease_owner = ?
            """,
            (encoded, now, now, task_id, lease_owner),
        )
        connection.commit()
        return cursor.rowcount == 1


def mark_failure(
    task_id: str,
    error_code: str,
    *,
    lease_owner: str | None = None,
) -> bool:
    now = _now()
    with _connect() as connection:
        if lease_owner is None:
            where = (
                "id = ? AND (status = 'queued' OR (status = 'running' AND "
                "(lease_expires_at_epoch IS NULL OR lease_expires_at_epoch <= ?)))"
            )
            values: tuple[Any, ...] = (
                error_code[:160],
                now,
                now,
                task_id,
                time.time(),
            )
        else:
            where = "id = ? AND status = 'running' AND lease_owner = ?"
            values = (error_code[:160], now, now, task_id, lease_owner)
        cursor = connection.execute(
            """
            UPDATE summary_tasks_v2
            SET status = 'failure', stage = 'failure', error_code = ?, updated_at = ?, completed_at = ?,
                lease_owner = NULL, lease_expires_at_epoch = NULL,
                heartbeat_at_epoch = NULL
            WHERE """ + where,
            values,
        )
        connection.commit()
        return cursor.rowcount == 1


def save_checkpoint(task_id: str, lease_owner: str, checkpoint: Any) -> bool:
    encoded = json.dumps(checkpoint, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    now = _now()
    now_epoch = time.time()
    with _connect() as connection:
        cursor = connection.execute(
            """
            UPDATE summary_tasks_v2
            SET checkpoint_json = ?, updated_at = ?
            WHERE id = ? AND status = 'running' AND lease_owner = ?
              AND lease_expires_at_epoch > ?
            """,
            (encoded, now, task_id, lease_owner, now_epoch),
        )
        connection.commit()
        return cursor.rowcount == 1


def get_task(task_id: str) -> dict[str, Any] | None:
    with _connect() as connection:
        return _decode_row(
            connection.execute(
                "SELECT * FROM summary_tasks_v2 WHERE id = ?",
                (task_id,),
            ).fetchone()
        )


def recoverable_tasks() -> list[dict[str, Any]]:
    now_epoch = time.time()
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT * FROM summary_tasks_v2
            WHERE status = 'queued'
               OR (
                   status = 'running'
                   AND (lease_expires_at_epoch IS NULL OR lease_expires_at_epoch <= ?)
               )
            ORDER BY created_at, id
            """,
            (now_epoch,),
        ).fetchall()
    return [task for row in rows if (task := _decode_row(row)) is not None]


def _pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def requeue_orphaned_local_tasks(hostname: str | None = None) -> int:
    """Release running leases whose owning process no longer exists locally.

    A live process or a lease from another host is never reclaimed here. Those
    records remain protected by their normal expiry time, which keeps rolling
    deployments and a future multi-host topology safe.
    """
    local_hostname = (hostname or socket.gethostname()).strip()
    if not local_hostname:
        return 0
    now = _now()
    recovered = 0
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            """
            SELECT id, lease_owner FROM summary_tasks_v2
            WHERE status = 'running' AND lease_owner IS NOT NULL
            """
        ).fetchall()
        for row in rows:
            owner = str(row["lease_owner"] or "")
            parts = owner.split(":", 2)
            if len(parts) != 3 or parts[0] != local_hostname:
                continue
            try:
                owner_pid = int(parts[1])
            except ValueError:
                continue
            if _pid_is_alive(owner_pid):
                continue
            cursor = connection.execute(
                """
                UPDATE summary_tasks_v2
                SET status = 'queued', stage = 'queued', lease_owner = NULL,
                    lease_expires_at_epoch = NULL, heartbeat_at_epoch = NULL,
                    updated_at = ?, completed_at = NULL
                WHERE id = ? AND status = 'running' AND lease_owner = ?
                """,
                (now, row["id"], owner),
            )
            recovered += cursor.rowcount
        connection.commit()
    return recovered


def task_counts() -> dict[str, int]:
    counts = {"queued": 0, "running": 0, "success": 0, "failure": 0}
    with _connect() as connection:
        rows = connection.execute(
            "SELECT status, COUNT(*) AS count FROM summary_tasks_v2 GROUP BY status"
        ).fetchall()
    for row in rows:
        if row["status"] in counts:
            counts[str(row["status"])] = int(row["count"])
    return counts


def purge_expired_results(now: str | None = None) -> int:
    """Clear transient generated bodies after their retention window.

    The task row remains as a small recovery/audit record, but the generated
    summary body is no longer available after the device privacy TTL.  Retained
    quality candidates use a separate table and are not touched here.
    """
    cutoff = now or _now()
    with _connect() as connection:
        cursor = connection.execute(
            """
            UPDATE summary_tasks_v2
            SET result_json = NULL,
                checkpoint_json = NULL,
                updated_at = ?
            WHERE result_expires_at IS NOT NULL
              AND result_expires_at < ?
              AND result_json IS NOT NULL
            """,
            (cutoff, cutoff),
        )
        connection.commit()
        return int(cursor.rowcount)


def latest_device_summary_result(
    *,
    task_scope: str,
    meeting_id: str,
) -> dict[str, Any] | None:
    """Return the newest unexpired device summary result, if any."""
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT * FROM summary_tasks_v2
            WHERE task_kind = 'device-final'
              AND task_scope = ?
              AND meeting_id = ?
              AND status = 'success'
              AND result_json IS NOT NULL
            ORDER BY completed_at DESC, id DESC
            LIMIT 1
            """,
            (task_scope, meeting_id),
        ).fetchone()
    decoded = _decode_row(row)
    return decoded.get("result") if decoded else None


def task_worker_state() -> dict[str, Any]:
    now_epoch = time.time()
    with _connect() as connection:
        active = int(
            connection.execute(
                """
                SELECT COUNT(*) FROM summary_tasks_v2
                WHERE status = 'running' AND lease_expires_at_epoch > ?
                """,
                (now_epoch,),
            ).fetchone()[0]
        )
        expired = int(
            connection.execute(
                """
                SELECT COUNT(*) FROM summary_tasks_v2
                WHERE status = 'running'
                  AND (lease_expires_at_epoch IS NULL OR lease_expires_at_epoch <= ?)
                """,
                (now_epoch,),
            ).fetchone()[0]
        )
        last_heartbeat = connection.execute(
            "SELECT MAX(heartbeat_at_epoch) FROM summary_tasks_v2"
        ).fetchone()[0]
    return {
        "active_leases": active,
        "expired_leases": expired,
        "last_heartbeat_at_epoch": last_heartbeat,
    }


def reset_store_for_tests() -> None:
    with _SCHEMA_LOCK:
        _INITIALIZED_PATHS.clear()
