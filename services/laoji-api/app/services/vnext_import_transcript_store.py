"""Durable stable/final event owner for imported vNext recordings."""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Protocol

from app.schemas.vnext_contracts import TranscriptStreamEventV2
from app.services.device_identity import control_connection, utc_now
from app.services import vnext_realtime_crypto, vnext_task_store


MAX_EVENT_BYTES = 256 * 1024
EVENT_PAYLOAD_TTL_SECONDS = 24 * 60 * 60


class ImportOwnerContext(Protocol):
    device_id: str
    epoch_id: str


class VNextImportTranscriptError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _safe(value: str, field: str, maximum: int = 512) -> str:
    normalized = str(value or "").strip()
    if (
        not normalized
        or len(normalized) > maximum
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        raise VNextImportTranscriptError("IDENTIFIER_INVALID", f"{field}无效", 422)
    return normalized


def _sha256(value: str, field: str = "source_sha256") -> str:
    normalized = _safe(value, field, 71).lower()
    if not normalized.startswith("sha256:") or len(normalized) != 71:
        raise VNextImportTranscriptError("HASH_INVALID", f"{field}无效", 422)
    try:
        int(normalized[7:], 16)
    except ValueError as error:
        raise VNextImportTranscriptError("HASH_INVALID", f"{field}无效", 422) from error
    return normalized


def ensure_vnext_import_transcript_schema() -> None:
    vnext_task_store.ensure_vnext_task_schema()
    with control_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS vnext_import_transcript_runs (
                task_id TEXT PRIMARY KEY REFERENCES vnext_tasks(task_id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                asset_revision_id TEXT NOT NULL UNIQUE,
                asset_id TEXT NOT NULL,
                asset_generation TEXT NOT NULL,
                source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 71),
                source_size INTEGER NOT NULL CHECK(source_size >= 1),
                mime_type TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN (
                    'queued','running','succeeded','no_content','failed','cancelled'
                )),
                last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_event_seq >= 0),
                last_acked_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_acked_event_seq >= 0),
                ack_projection_sha256 TEXT,
                device_acked_at TEXT,
                payload_purged_at TEXT,
                model_revision TEXT,
                source_duration_ms INTEGER,
                error_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                terminal_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_import_runs_ready
                ON vnext_import_transcript_runs(state, updated_at, task_id);

            CREATE TABLE IF NOT EXISTS vnext_import_transcript_events (
                task_id TEXT NOT NULL REFERENCES vnext_import_transcript_runs(task_id) ON DELETE CASCADE,
                event_seq INTEGER NOT NULL CHECK(event_seq >= 1),
                event_kind TEXT NOT NULL CHECK(event_kind IN ('stable','final')),
                stable_segment_key TEXT,
                segment_revision INTEGER NOT NULL CHECK(segment_revision >= 1),
                outcome TEXT NOT NULL CHECK(outcome IN ('text','no_speech')),
                source_start_ms INTEGER NOT NULL CHECK(source_start_ms >= 0),
                source_end_ms INTEGER NOT NULL CHECK(source_end_ms >= source_start_ms),
                payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 71),
                encrypted_payload BLOB NOT NULL,
                created_at TEXT NOT NULL,
                device_acked_at TEXT,
                PRIMARY KEY(task_id, event_seq),
                UNIQUE(task_id, stable_segment_key, segment_revision)
            );
            """
        )
        columns = {
            str(row[1])
            for row in connection.execute(
                "PRAGMA table_info(vnext_import_transcript_runs)"
            ).fetchall()
        }
        if "last_acked_event_seq" not in columns:
            connection.execute(
                "ALTER TABLE vnext_import_transcript_runs "
                "ADD COLUMN last_acked_event_seq INTEGER NOT NULL DEFAULT 0"
            )
        if "ack_projection_sha256" not in columns:
            connection.execute(
                "ALTER TABLE vnext_import_transcript_runs ADD COLUMN ack_projection_sha256 TEXT"
            )
        if "device_acked_at" not in columns:
            connection.execute(
                "ALTER TABLE vnext_import_transcript_runs ADD COLUMN device_acked_at TEXT"
            )
        if "payload_purged_at" not in columns:
            connection.execute(
                "ALTER TABLE vnext_import_transcript_runs ADD COLUMN payload_purged_at TEXT"
            )
        connection.commit()


def ensure_run(
    context: ImportOwnerContext,
    source: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    ensure_vnext_import_transcript_schema()
    task_id = _safe(str(source.get("task_id") or ""), "task_id", 512)
    source_sha256 = _sha256(str(source.get("source_sha256") or ""))
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        task = connection.execute(
            """SELECT * FROM vnext_tasks
                 WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
        if task is None or task["capability"] != "transcript":
            connection.rollback()
            raise VNextImportTranscriptError("TRANSCRIPT_TASK_NOT_FOUND", "转写任务不存在", 404)
        existing = connection.execute(
            "SELECT * FROM vnext_import_transcript_runs WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        identity = (
            str(source["asset_revision_id"]),
            str(source["asset_id"]),
            str(source["asset_generation"]),
            source_sha256,
            int(source["byte_size"]),
            str(source["mime_type"]),
        )
        if existing is not None:
            same = (
                existing["device_id"] == context.device_id
                and existing["epoch_id"] == context.epoch_id
                and existing["asset_revision_id"] == identity[0]
                and existing["asset_id"] == identity[1]
                and existing["asset_generation"] == identity[2]
                and existing["source_sha256"] == identity[3]
                and int(existing["source_size"]) == identity[4]
                and existing["mime_type"] == identity[5]
            )
            connection.commit()
            if not same:
                raise VNextImportTranscriptError("TRANSCRIPT_RUN_CONFLICT", "转写任务来源已变化", 409)
            return dict(existing), True
        connection.execute(
            """INSERT INTO vnext_import_transcript_runs(
                 task_id, device_id, epoch_id, binding_id, binding_generation,
                 asset_revision_id, asset_id, asset_generation, source_sha256,
                 source_size, mime_type, state, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)""",
            (
                task_id,
                context.device_id,
                context.epoch_id,
                task["binding_id"],
                task["binding_generation"],
                *identity,
                now,
                now,
            ),
        )
        row = connection.execute(
            "SELECT * FROM vnext_import_transcript_runs WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        connection.commit()
    assert row is not None
    return dict(row), False


def ensure_run_for_task(
    context: ImportOwnerContext,
    task_id: str,
) -> tuple[dict[str, Any], bool] | None:
    """Materialize the import run for a verified upload task.

    Upload completion and the import worker are intentionally separate
    transactions.  A device can therefore poll in the small interval after
    the task/asset commit but before the worker's next scan.  Resolve the
    verified source here and create the idempotent run immediately so that
    polling observes ``queued`` instead of a misleading 404.

    ``None`` means the task is not a verified upload (for example a realtime
    task or a terminal task whose source has already been cleaned up).
    """
    task_id = _safe(task_id, "task_id", 512)
    from app.services import vnext_upload_store

    try:
        source = vnext_upload_store.get_verified_transcription_source(context, task_id)
    except vnext_upload_store.VNextUploadError as error:
        if error.code in {"VERIFIED_ASSET_NOT_FOUND", "VERIFIED_ASSET_UNAVAILABLE"}:
            return None
        raise VNextImportTranscriptError(
            "TRANSCRIPT_SOURCE_UNAVAILABLE",
            error.message,
            error.status_code,
        ) from error
    source["task_id"] = task_id
    return ensure_run(context, source)


def mark_running(
    context: ImportOwnerContext,
    task_id: str,
    attempt_id: str,
    lease_owner: str,
) -> bool:
    ensure_vnext_import_transcript_schema()
    now = utc_now()
    with control_connection() as connection:
        cursor = connection.execute(
            """UPDATE vnext_import_transcript_runs
                    SET state = 'running', error_code = NULL, terminal_at = NULL, updated_at = ?
                 WHERE task_id = ? AND device_id = ? AND epoch_id = ?
                   AND state IN ('queued','running')
                   AND EXISTS (
                     SELECT 1 FROM vnext_task_attempts attempt
                      WHERE attempt.attempt_id = ? AND attempt.task_id = ?
                        AND attempt.state = 'running' AND attempt.lease_owner = ?
                   )""",
            (
                now,
                task_id,
                context.device_id,
                context.epoch_id,
                attempt_id,
                task_id,
                lease_owner,
            ),
        )
        connection.commit()
        return cursor.rowcount == 1


def append_stable_event(
    context: ImportOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
    stable_segment_key: str,
    text: str,
    source_start_ms: int,
    source_end_ms: int,
    model_revision: str,
) -> dict[str, Any]:
    ensure_vnext_import_transcript_schema()
    task_id = _safe(task_id, "task_id", 512)
    stable_segment_key = _safe(stable_segment_key, "stable_segment_key", 180)
    event_seed = {
        "stable_segment_key": stable_segment_key,
        "text": str(text or "").strip(),
        "source_start_ms": int(source_start_ms),
        "source_end_ms": int(source_end_ms),
        "model_revision": _safe(model_revision, "model_revision", 180),
    }
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        run = connection.execute(
            """SELECT * FROM vnext_import_transcript_runs
                 WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
        attempt = connection.execute(
            """SELECT * FROM vnext_task_attempts
                 WHERE attempt_id = ? AND task_id = ?""",
            (attempt_id, task_id),
        ).fetchone()
        if (
            run is None
            or run["state"] not in {"queued", "running"}
            or attempt is None
            or attempt["state"] != "running"
            or attempt["lease_owner"] != lease_owner
        ):
            connection.rollback()
            raise VNextImportTranscriptError("TRANSCRIPT_WORKER_FENCED", "转写任务已被接替", 409)
        existing = connection.execute(
            """SELECT * FROM vnext_import_transcript_events
                 WHERE task_id = ? AND stable_segment_key = ? AND segment_revision = 1""",
            (task_id, stable_segment_key),
        ).fetchone()
        event_seq = int(existing["event_seq"]) if existing is not None else int(run["last_event_seq"]) + 1
        event = TranscriptStreamEventV2(
            schema_version=2,
            contract_revision="transcript.stream.v2",
            session_id=task_id,
            event_sequence=event_seq,
            event_kind="stable",
            stable_segment_key=stable_segment_key,
            segment_revision=1,
            text_state="stable",
            outcome="text" if event_seed["text"] else "no_speech",
            text=event_seed["text"],
            source_start_ms=event_seed["source_start_ms"],
            source_end_ms=event_seed["source_end_ms"],
            model_revision=event_seed["model_revision"],
        ).model_dump()
        payload = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        payload_sha256 = "sha256:" + hashlib.sha256(payload).hexdigest()
        encrypted = vnext_realtime_crypto.seal_event(
            f"import:{task_id}:event:{event_seq}",
            payload,
        )
        if existing is not None:
            same = (
                existing["payload_sha256"] == payload_sha256
                and bytes(existing["encrypted_payload"]) == encrypted
            )
            # AES-GCM uses a fresh nonce, so compare the authenticated plaintext
            # when replaying an existing event.
            if not same:
                observed = vnext_realtime_crypto.open_event(
                    f"import:{task_id}:event:{event_seq}",
                    bytes(existing["encrypted_payload"]),
                )
                same = observed == payload
            connection.commit()
            if not same:
                raise VNextImportTranscriptError("TRANSCRIPT_EVENT_CONFLICT", "转写事件重放不一致", 409)
            return {"event": event, "reused": True}
        connection.execute(
            """INSERT INTO vnext_import_transcript_events(
                 task_id, event_seq, event_kind, stable_segment_key,
                 segment_revision, outcome, source_start_ms, source_end_ms,
                 payload_sha256, encrypted_payload, created_at
               ) VALUES (?, ?, 'stable', ?, 1, ?, ?, ?, ?, ?, ?)""",
            (
                task_id,
                event_seq,
                stable_segment_key,
                event["outcome"],
                event["source_start_ms"],
                event["source_end_ms"],
                payload_sha256,
                encrypted,
                utc_now(),
            ),
        )
        connection.execute(
            """UPDATE vnext_import_transcript_runs
                  SET state = 'running', last_event_seq = ?, model_revision = ?, updated_at = ?
                WHERE task_id = ?""",
            (event_seq, event["model_revision"], utc_now(), task_id),
        )
        connection.commit()
    return {"event": event, "reused": False}


def commit_final(
    context: ImportOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
    outcome: str,
    source_duration_ms: int,
    model_revision: str,
) -> dict[str, Any]:
    ensure_vnext_import_transcript_schema()
    if outcome not in {"text", "no_speech"}:
        raise VNextImportTranscriptError("TRANSCRIPT_OUTCOME_INVALID", "转写结果无效", 422)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        run = connection.execute(
            """SELECT * FROM vnext_import_transcript_runs
                 WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
        if run is None:
            connection.rollback()
            raise VNextImportTranscriptError("TRANSCRIPT_RUN_NOT_FOUND", "转写任务不存在", 404)
        if run["state"] in {"succeeded", "no_content"}:
            connection.commit()
            return {"task_id": task_id, "state": str(run["state"]), "reused": True}
        event_seq = int(run["last_event_seq"]) + 1
        event = TranscriptStreamEventV2(
            schema_version=2,
            contract_revision="transcript.stream.v2",
            session_id=task_id,
            event_sequence=event_seq,
            event_kind="final",
            stable_segment_key=None,
            segment_revision=1,
            text_state="final",
            outcome=outcome,
            text="",
            source_start_ms=0,
            source_end_ms=max(0, int(source_duration_ms)),
            model_revision=_safe(model_revision, "model_revision", 180),
        ).model_dump()
        payload = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        payload_sha256 = "sha256:" + hashlib.sha256(payload).hexdigest()
        encrypted = vnext_realtime_crypto.seal_event(
            f"import:{task_id}:event:{event_seq}",
            payload,
        )
        connection.execute(
            """INSERT INTO vnext_import_transcript_events(
                 task_id, event_seq, event_kind, stable_segment_key,
                 segment_revision, outcome, source_start_ms, source_end_ms,
                 payload_sha256, encrypted_payload, created_at
               ) VALUES (?, ?, 'final', NULL, 1, ?, 0, ?, ?, ?, ?)""",
            (
                task_id,
                event_seq,
                outcome,
                event["source_end_ms"],
                payload_sha256,
                encrypted,
                utc_now(),
            ),
        )
        state = "succeeded" if outcome == "text" else "no_content"
        completed = vnext_task_store.mark_success_in_transaction(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            result={
                "kind": "transcript_revision",
                "task_id": task_id,
                "source_sha256": str(run["source_sha256"]),
                "last_event_seq": event_seq,
                "outcome": outcome,
            },
            result_kind="content_outcome" if outcome == "no_speech" else "artifact",
            lease_owner=lease_owner,
        )
        if not completed:
            connection.rollback()
            raise VNextImportTranscriptError("TRANSCRIPT_WORKER_FENCED", "转写任务已被接替", 409)
        now = utc_now()
        connection.execute(
            """UPDATE vnext_import_transcript_runs
                  SET state = ?, last_event_seq = ?, model_revision = ?,
                      source_duration_ms = ?, error_code = NULL,
                      updated_at = ?, terminal_at = ?
                WHERE task_id = ?""",
            (
                state,
                event_seq,
                event["model_revision"],
                event["source_end_ms"],
                now,
                now,
                task_id,
            ),
        )
        from app.services import vnext_upload_store

        vnext_upload_store.queue_verified_asset_cleanup_in_transaction(
            connection,
            task_id=task_id,
            not_before_epoch=int(time.time()) + 24 * 60 * 60,
        )
        connection.commit()
    return {"task_id": task_id, "state": state, "event": event, "reused": False}


def mark_failure(
    context: ImportOwnerContext,
    task_id: str,
    *,
    attempt_id: str,
    lease_owner: str,
    error_code: str,
    retryable: bool,
    retry_after_seconds: float | None = None,
) -> bool:
    ensure_vnext_import_transcript_schema()
    code = _safe(error_code, "error_code", 160)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        attempt = connection.execute(
            "SELECT attempt_number FROM vnext_task_attempts WHERE attempt_id = ? AND task_id = ?",
            (attempt_id, task_id),
        ).fetchone()
        attempt_number = int(attempt["attempt_number"]) if attempt is not None else 1
        retry_delay = (
            float(retry_after_seconds)
            if retry_after_seconds is not None
            else (5.0 if attempt_number <= 1 else 30.0)
        )
        marked = vnext_task_store.mark_failure_in_transaction(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            error_code=code,
            retryable=retryable,
            retry_after_seconds=retry_delay,
            lease_owner=lease_owner,
        )
        if not marked:
            connection.rollback()
            return False
        task = connection.execute(
            "SELECT state FROM vnext_tasks WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        next_state = "queued" if task is not None and task["state"] == "active" else "failed"
        now = utc_now()
        connection.execute(
            """UPDATE vnext_import_transcript_runs
                  SET state = ?, error_code = ?, updated_at = ?,
                      terminal_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
                WHERE task_id = ?""",
            (next_state, code, now, next_state, now, task_id),
        )
        if next_state == "failed":
            from app.services import vnext_upload_store

            vnext_upload_store.queue_verified_asset_cleanup_in_transaction(
                connection,
                task_id=task_id,
                not_before_epoch=int(time.time()),
            )
        connection.commit()
        return True


def get_event_snapshot(
    context: ImportOwnerContext,
    task_id: str,
    *,
    after_event_seq: int = 0,
    limit: int = 256,
) -> dict[str, Any] | None:
    ensure_vnext_import_transcript_schema()
    bounded = max(1, min(1024, int(limit)))
    with control_connection() as connection:
        run = connection.execute(
            """SELECT * FROM vnext_import_transcript_runs
                 WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
    if run is None:
        # Self-heal the upload-complete -> worker handoff.  This closes the
        # short race where the phone polls before the maintenance scan has
        # materialized the durable import run.
        ensure_run_for_task(context, task_id)
        with control_connection() as connection:
            run = connection.execute(
                """SELECT * FROM vnext_import_transcript_runs
                     WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
                (task_id, context.device_id, context.epoch_id),
            ).fetchone()
        if run is None:
            return None
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT * FROM vnext_import_transcript_events
                 WHERE task_id = ? AND event_seq > ? ORDER BY event_seq LIMIT ?""",
            (task_id, max(0, int(after_event_seq)), bounded),
        ).fetchall()
    events = []
    for row in rows:
        plaintext = vnext_realtime_crypto.open_event(
            f"import:{task_id}:event:{int(row['event_seq'])}",
            bytes(row["encrypted_payload"]),
        )
        events.append(json.loads(plaintext.decode("utf-8")))
    return {
        "schema_version": 2,
        "task_id": task_id,
        "state": str(run["state"]),
        "last_event_seq": int(run["last_event_seq"]),
        "last_acked_event_seq": int(run["last_acked_event_seq"]),
        "source_sha256": str(run["source_sha256"]),
        "model_revision": run["model_revision"],
        "error_code": run["error_code"],
        "payload_expired": run["payload_purged_at"] is not None,
        "events": events,
    }


def ack_events(
    context: ImportOwnerContext,
    task_id: str,
    *,
    through_event_seq: int,
    projection_sha256: str,
) -> dict[str, Any]:
    """Acknowledge only events already committed to the phone's SQLite owner."""
    ensure_vnext_import_transcript_schema()
    task_id = _safe(task_id, "task_id", 512)
    through = int(through_event_seq)
    if through < 1:
        raise VNextImportTranscriptError("TRANSCRIPT_ACK_INVALID", "文字记录确认序号无效", 422)
    projection = _sha256(projection_sha256, "projection_sha256")
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        run = connection.execute(
            """SELECT * FROM vnext_import_transcript_runs
                 WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
        if run is None:
            connection.rollback()
            raise VNextImportTranscriptError("TRANSCRIPT_RUN_NOT_FOUND", "转写任务不存在", 404)
        last_event = int(run["last_event_seq"])
        last_acked = int(run["last_acked_event_seq"])
        if through > last_event:
            connection.rollback()
            raise VNextImportTranscriptError("TRANSCRIPT_ACK_AHEAD", "文字记录确认超过服务端进度", 409)
        if through < last_acked:
            connection.rollback()
            raise VNextImportTranscriptError("TRANSCRIPT_ACK_REWIND", "文字记录确认序号不能回退", 409)
        if through == last_acked:
            if run["ack_projection_sha256"] != projection:
                connection.rollback()
                raise VNextImportTranscriptError("TRANSCRIPT_ACK_CONFLICT", "文字记录确认内容不一致", 409)
            connection.commit()
            return {
                "schema_version": 2,
                "task_id": task_id,
                "through_event_seq": through,
                "state": str(run["state"]),
                "reused": True,
            }
        expected = through - last_acked
        observed = int(connection.execute(
            """SELECT COUNT(*) FROM vnext_import_transcript_events
                 WHERE task_id = ? AND event_seq > ? AND event_seq <= ?""",
            (task_id, last_acked, through),
        ).fetchone()[0])
        if observed != expected:
            connection.rollback()
            raise VNextImportTranscriptError("TRANSCRIPT_ACK_GAP", "文字记录确认范围不连续", 409)
        now = utc_now()
        connection.execute(
            """UPDATE vnext_import_transcript_events SET device_acked_at = ?
                 WHERE task_id = ? AND event_seq > ? AND event_seq <= ?""",
            (now, task_id, last_acked, through),
        )
        connection.execute(
            """UPDATE vnext_import_transcript_runs
                  SET last_acked_event_seq = ?, ack_projection_sha256 = ?,
                      device_acked_at = ?, updated_at = ?
                WHERE task_id = ?""",
            (through, projection, now, now, task_id),
        )
        cleanup_id = None
        if through == last_event and run["state"] in {"succeeded", "no_content"}:
            from app.services import vnext_upload_store

            cleanup_id = vnext_upload_store.queue_verified_asset_cleanup_in_transaction(
                connection,
                task_id=task_id,
                not_before_epoch=int(time.time()),
            )
        connection.execute(
            "DELETE FROM vnext_import_transcript_events WHERE task_id = ? AND event_seq <= ?",
            (task_id, through),
        )
        connection.commit()
    return {
        "schema_version": 2,
        "task_id": task_id,
        "through_event_seq": through,
        "state": str(run["state"]),
        "cleanup_id": cleanup_id,
        "reused": False,
    }


def purge_expired_event_payloads(*, now_epoch: int | None = None, limit: int = 128) -> int:
    """Delete terminal encrypted events after the bounded recovery window."""
    ensure_vnext_import_transcript_schema()
    current = int(time.time()) if now_epoch is None else int(now_epoch)
    cutoff = current - EVENT_PAYLOAD_TTL_SECONDS
    bounded = max(1, min(1024, int(limit)))
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            """SELECT task_id FROM vnext_import_transcript_runs
                WHERE state IN ('succeeded','no_content','failed','cancelled')
                  AND payload_purged_at IS NULL
                  AND terminal_at IS NOT NULL
                  AND CAST(strftime('%s', terminal_at) AS INTEGER) <= ?
                ORDER BY terminal_at, task_id LIMIT ?""",
            (cutoff, bounded),
        ).fetchall()
        task_ids = [str(row["task_id"]) for row in rows]
        if task_ids:
            placeholders = ",".join("?" for _ in task_ids)
            connection.execute(
                f"DELETE FROM vnext_import_transcript_events WHERE task_id IN ({placeholders})",
                task_ids,
            )
            connection.execute(
                f"UPDATE vnext_import_transcript_runs SET payload_purged_at = ?, updated_at = ? "
                f"WHERE task_id IN ({placeholders})",
                [now, now, *task_ids],
            )
        connection.commit()
    return len(task_ids)
