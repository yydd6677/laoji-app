"""Read-only task-kernel observability shared by readiness and maintenance.

Disconnected realtime input is durable work waiting for its client, not an
inference queue and not a live execution. Keep it visible as a separate count.
"""

from __future__ import annotations

import time
from typing import Any


def read_task_runtime(connection: Any, *, now_epoch: float | None = None) -> dict:
    now = time.time() if now_epoch is None else float(now_epoch)
    counts = dict.fromkeys(("queued", "running", "waiting_for_client", "success", "failure", "cancelled"), 0)
    active = []
    # Schema is initialized by startup, never mutated from a health request.
    rows = connection.execute(
        """SELECT task.task_id, task.device_id, task.epoch_id, task.capability,
                  task.state, task.updated_at, attempt.state AS attempt_state,
                  attempt.phase, attempt.lease_owner, attempt.lease_expires_at_epoch,
                  session.state AS realtime_state, session.worker_admission_expires,
                  session.expires_at_epoch AS realtime_expires_at_epoch
             FROM vnext_tasks task
             LEFT JOIN vnext_task_attempts attempt ON attempt.attempt_id = task.current_attempt_id
             LEFT JOIN vnext_realtime_asr_sessions session ON session.task_id = task.task_id"""
    ).fetchall()
    for row in rows:
        state = row["state"]
        if state != "active":
            if state in counts:
                counts[state] += 1
            continue
        waiting = (
            row["realtime_state"] in {"open", "reconnecting", "finalizing"}
            and float(row["realtime_expires_at_epoch"] or 0) > now
            and row["worker_admission_expires"] is None
            and row["attempt_state"] == "queued"
            and row["lease_owner"] is None and row["lease_expires_at_epoch"] is None
        )
        status = "waiting_for_client" if waiting else "running" if row["attempt_state"] == "running" else "queued"
        counts[status] += 1
        active.append({**dict(row), "runtime_state": status})
    leases = connection.execute(
        """SELECT
               SUM(CASE WHEN lease_expires_at_epoch > ? THEN 1 ELSE 0 END) AS active_leases,
               SUM(CASE WHEN lease_expires_at_epoch <= ? OR lease_expires_at_epoch IS NULL
                        THEN 1 ELSE 0 END) AS expired_leases,
               MIN(CASE WHEN lease_expires_at_epoch <= ? THEN lease_expires_at_epoch END) AS oldest_lease_expiry
             FROM vnext_task_attempts WHERE state = 'running'""", (now, now, now),
    ).fetchone()
    return {
        "counts": counts,
        "queue_depth": counts["queued"] + counts["running"],
        "active_leases": int(leases["active_leases"] or 0),
        "expired_leases": int(leases["expired_leases"] or 0),
        "oldest_lease_expiry": leases["oldest_lease_expiry"],
        "active_tasks": active,
    }


def task_runtime_snapshot() -> dict:
    from app.services.device_identity import control_connection

    with control_connection() as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        result = read_task_runtime(connection)
    result.pop("active_tasks")  # Public health never exposes device/meeting IDs.
    result["ready"] = result["expired_leases"] == 0
    return result
