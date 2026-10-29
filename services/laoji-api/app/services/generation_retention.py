"""Opt-in quality copies, deliberately independent of task recovery payloads."""
from __future__ import annotations

import hashlib
import json
import logging
import secrets
from typing import Any, Callable, Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import settings
from app.services.device_identity import control_connection, control_schema_once, utc_now


class Owner(Protocol):
    device_id: str
    epoch_id: str


_logger = logging.getLogger(__name__)


@control_schema_once
def ensure_schema() -> None:
    with control_connection() as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS vnext_generation_preferences (
                device_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
                enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
                revision INTEGER NOT NULL CHECK(revision >= 1), updated_at TEXT NOT NULL,
                PRIMARY KEY(device_id, epoch_id)
            );
            CREATE TABLE IF NOT EXISTS vnext_quality_task_grants (
                task_id TEXT PRIMARY KEY REFERENCES vnext_tasks(task_id) ON DELETE CASCADE,
                consent_revision INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS vnext_quality_results (
                task_id TEXT NOT NULL REFERENCES vnext_tasks(task_id) ON DELETE CASCADE,
                result_key TEXT NOT NULL, kind TEXT NOT NULL
                    CHECK(kind IN ('transcript','summary','question_answer')),
                nonce BLOB NOT NULL, encrypted_output BLOB NOT NULL,
                created_at TEXT NOT NULL, PRIMARY KEY(task_id, result_key)
            );
        """)


def get_preference(context: Owner) -> dict[str, Any]:
    ensure_schema()
    with control_connection() as connection:
        row = connection.execute(
            "SELECT enabled, revision FROM vnext_generation_preferences WHERE device_id=? AND epoch_id=?",
            (context.device_id, context.epoch_id),
        ).fetchone()
    return {"schema_version": 2, "enabled": bool(row and row["enabled"]),
            "revision": int(row["revision"]) if row else 0}


def set_preference(context: Owner, enabled: bool) -> dict[str, Any]:
    if type(enabled) is not bool:
        raise ValueError("generation_retention_requires_boolean")
    ensure_schema()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT enabled, revision FROM vnext_generation_preferences WHERE device_id=? AND epoch_id=?",
            (context.device_id, context.epoch_id),
        ).fetchone()
        revision = int(row["revision"]) if row else 0
        if row is None or bool(row["enabled"]) != enabled:
            revision += 1
            connection.execute("""INSERT INTO vnext_generation_preferences
                (device_id,epoch_id,enabled,revision,updated_at) VALUES (?,?,?,?,?)
                ON CONFLICT(device_id,epoch_id) DO UPDATE SET enabled=excluded.enabled,
                    revision=excluded.revision,updated_at=excluded.updated_at""",
                (context.device_id, context.epoch_id, int(enabled), revision, utc_now()))
        if not enabled:
            # Same transaction as revocation: a concurrent publisher either
            # precedes this delete or observes the revoked grant, never both.
            for table in ("vnext_quality_results", "vnext_quality_task_grants"):
                connection.execute(f"DELETE FROM {table} WHERE task_id IN "
                    "(SELECT task_id FROM vnext_tasks WHERE device_id=? AND epoch_id=?)",
                    (context.device_id, context.epoch_id))
        connection.commit()
    return {"schema_version": 2, "enabled": enabled, "revision": revision}


def grant_task_in_transaction(connection: Any, context: Owner, task_id: str) -> None:
    """Snapshot consent only at original task creation, never on replay."""
    connection.execute("""INSERT INTO vnext_quality_task_grants(task_id,consent_revision)
        SELECT ?, revision FROM vnext_generation_preferences
        WHERE device_id=? AND epoch_id=? AND enabled=1""",
        (task_id, context.device_id, context.epoch_id))


def _authorized(connection: Any, context: Owner, task_id: str) -> bool:
    return connection.execute("""SELECT 1 FROM vnext_quality_task_grants grant_row
        JOIN vnext_tasks task ON task.task_id=grant_row.task_id
        JOIN vnext_generation_preferences preference
            ON preference.device_id=task.device_id AND preference.epoch_id=task.epoch_id
        WHERE task.task_id=? AND task.device_id=? AND task.epoch_id=?
            AND preference.enabled=1 AND preference.revision=grant_row.consent_revision""",
        (task_id, context.device_id, context.epoch_id)).fetchone() is not None


def _cipher() -> AESGCM:
    key = hashlib.sha256(b"laoji-quality-results-v1\0" + settings.SECRET_KEY.encode()).digest()
    return AESGCM(key)


def retain_in_transaction(connection: Any, context: Owner, *, task_id: str,
                          result_key: str, kind: str,
                          payload: dict[str, Any] | Callable[[], dict[str, Any]]) -> bool:
    """Store generated output only. Failure must not fail the user's task.

    Callers pass output, not request/evidence/audio. Lazy producers are never
    evaluated without a current grant. Recovery writers do not read this flag.
    """
    connection.execute("SAVEPOINT quality_copy")
    try:
        if not _authorized(connection, context, task_id):
            connection.execute("RELEASE quality_copy")
            return False
        value = payload() if callable(payload) else payload
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        nonce = secrets.token_bytes(12)
        aad = json.dumps([task_id, result_key, kind], separators=(",", ":")).encode()
        ciphertext = _cipher().encrypt(nonce, encoded, aad)
        connection.execute("""INSERT INTO vnext_quality_results
            (task_id,result_key,kind,nonce,encrypted_output,created_at) VALUES (?,?,?,?,?,?)
            ON CONFLICT(task_id,result_key) DO UPDATE SET kind=excluded.kind,
                nonce=excluded.nonce,encrypted_output=excluded.encrypted_output""",
            (task_id, result_key, kind, nonce, ciphertext, utc_now()))
        connection.execute("RELEASE quality_copy")
        return True
    except Exception as error:
        connection.execute("ROLLBACK TO quality_copy")
        connection.execute("RELEASE quality_copy")
        _logger.warning("quality_copy_skipped error_type=%s", type(error).__name__)
        return False


def read_retained_results(context: Owner, *, limit: int = 100) -> list[dict[str, Any]]:
    """Internal quality consumer; consent is rechecked, not just stored as UI state."""
    ensure_schema()
    with control_connection() as connection:
        connection.execute("BEGIN")
        rows = connection.execute("""SELECT result.* FROM vnext_quality_results result
            JOIN vnext_tasks task ON task.task_id=result.task_id
            JOIN vnext_quality_task_grants grant_row ON grant_row.task_id=task.task_id
            JOIN vnext_generation_preferences preference
                ON preference.device_id=task.device_id AND preference.epoch_id=task.epoch_id
            WHERE task.device_id=? AND task.epoch_id=? AND preference.enabled=1
                AND preference.revision=grant_row.consent_revision
            ORDER BY result.created_at,result.task_id,result.result_key LIMIT ?""",
            (context.device_id, context.epoch_id, max(1, min(1000, limit)))).fetchall()
        output = []
        for row in rows:
            aad = json.dumps([row["task_id"], row["result_key"], row["kind"]], separators=(",", ":")).encode()
            decoded = _cipher().decrypt(bytes(row["nonce"]), bytes(row["encrypted_output"]), aad)
            output.append({"kind": row["kind"], "output": json.loads(decoded)})
    return output
