"""Durable Stage 2 realtime ASR session, chunk and stable-event owner."""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Literal, Protocol

from app.services.device_identity import control_connection, utc_now
from app.services import vnext_task_store


SessionState = Literal[
    "open", "reconnecting", "finalizing", "succeeded", "cancelled", "expired",
]
EventKind = Literal["stable", "final", "error"]
EventOutcome = Literal["text", "no_speech", "error"]

MAX_CHUNK_BYTES = 1024 * 1024
MAX_EVENT_BYTES = 256 * 1024
MAX_ACTIVE_DEVICE_SESSIONS = 2
MAX_ACTIVE_GLOBAL_SESSIONS = 4


class RealtimeOwnerContext(Protocol):
    device_id: str
    epoch_id: str


class VNextRealtimeError(RuntimeError):
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
        or any(ord(char) < 32 or ord(char) == 127 for char in normalized)
    ):
        raise VNextRealtimeError("IDENTIFIER_INVALID", f"{field}无效", 422)
    return normalized


def _generation(value: str, field: str) -> str:
    normalized = _safe(value, field, 32).lower()
    if len(normalized) != 32:
        raise VNextRealtimeError("GENERATION_INVALID", f"{field}无效", 422)
    try:
        int(normalized, 16)
    except ValueError as error:
        raise VNextRealtimeError("GENERATION_INVALID", f"{field}无效", 422) from error
    return normalized


def _sha256(value: str, field: str = "content_sha256") -> str:
    normalized = _safe(value, field, 71).lower()
    if not normalized.startswith("sha256:") or len(normalized) != 71:
        raise VNextRealtimeError("HASH_INVALID", f"{field}无效", 422)
    try:
        int(normalized[7:], 16)
    except ValueError as error:
        raise VNextRealtimeError("HASH_INVALID", f"{field}无效", 422) from error
    return normalized


def _nonnegative(value: int, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise VNextRealtimeError("VALUE_INVALID", f"{field}无效", 422)
    return value


def _positive(value: int, field: str) -> int:
    normalized = _nonnegative(value, field)
    if normalized < 1:
        raise VNextRealtimeError("VALUE_INVALID", f"{field}无效", 422)
    return normalized


def _request_sha256(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def ensure_vnext_realtime_schema() -> None:
    vnext_task_store.ensure_vnext_task_schema()
    with control_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS vnext_realtime_asr_sessions (
                session_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL UNIQUE REFERENCES vnext_tasks(task_id) ON DELETE CASCADE,
                client_operation_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
                cancel_revision INTEGER NOT NULL CHECK(cancel_revision >= 0),
                asset_id TEXT NOT NULL,
                asset_generation TEXT NOT NULL,
                codec_revision TEXT NOT NULL,
                request_sha256 TEXT NOT NULL,
                last_contiguous_chunk_seq INTEGER NOT NULL DEFAULT -1
                    CHECK(last_contiguous_chunk_seq >= -1),
                last_durable_event_seq INTEGER NOT NULL DEFAULT 0
                    CHECK(last_durable_event_seq >= 0),
                state TEXT NOT NULL CHECK(state IN (
                    'open','reconnecting','finalizing','succeeded','cancelled','expired'
                )),
                opened_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                expires_at_epoch INTEGER NOT NULL,
                UNIQUE(device_id, epoch_id, client_operation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_realtime_active
                ON vnext_realtime_asr_sessions(state, device_id, epoch_id, last_seen_at);

            CREATE TABLE IF NOT EXISTS vnext_realtime_chunk_checkpoints (
                session_id TEXT NOT NULL REFERENCES vnext_realtime_asr_sessions(session_id)
                    ON DELETE CASCADE,
                chunk_seq INTEGER NOT NULL CHECK(chunk_seq >= 0),
                start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
                end_ms INTEGER NOT NULL CHECK(end_ms >= start_ms),
                byte_size INTEGER NOT NULL CHECK(byte_size >= 1 AND byte_size <= 1048576),
                content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 71),
                encrypted_spool_locator TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('spooled','consumed')),
                created_at TEXT NOT NULL,
                PRIMARY KEY(session_id, chunk_seq)
            );

            CREATE TABLE IF NOT EXISTS vnext_realtime_event_ledger (
                session_id TEXT NOT NULL REFERENCES vnext_realtime_asr_sessions(session_id)
                    ON DELETE CASCADE,
                event_seq INTEGER NOT NULL CHECK(event_seq >= 1),
                event_kind TEXT NOT NULL CHECK(event_kind IN ('stable','final','error')),
                stable_segment_key TEXT,
                segment_revision INTEGER NOT NULL CHECK(segment_revision >= 1),
                outcome TEXT NOT NULL CHECK(outcome IN ('text','no_speech','error')),
                source_start_ms INTEGER NOT NULL CHECK(source_start_ms >= 0),
                source_end_ms INTEGER NOT NULL CHECK(source_end_ms >= source_start_ms),
                payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 71),
                encrypted_payload BLOB NOT NULL,
                created_at TEXT NOT NULL,
                device_acked_at TEXT,
                PRIMARY KEY(session_id, event_seq)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_realtime_segment_revision
                ON vnext_realtime_event_ledger(
                    session_id, stable_segment_key, segment_revision, event_seq
                );
            """
        )
        connection.commit()


def _session_row(connection: Any, context: RealtimeOwnerContext, session_id: str) -> Any:
    return connection.execute(
        """SELECT * FROM vnext_realtime_asr_sessions
           WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
        (session_id, context.device_id, context.epoch_id),
    ).fetchone()


def _decode_session(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    result = dict(row)
    result.pop("device_id", None)
    result["schema_version"] = 2
    return result


def _assert_binding(connection: Any, context: RealtimeOwnerContext, session: Any) -> None:
    binding = connection.execute(
        """SELECT * FROM vnext_bindings
           WHERE device_id = ? AND epoch_id = ? AND binding_id = ?""",
        (context.device_id, context.epoch_id, session["binding_id"]),
    ).fetchone()
    if binding is None or binding["binding_generation"] != session["binding_generation"]:
        raise VNextRealtimeError("BINDING_REQUIRED", "会议服务连接未登记", 428)
    if binding["state"] != "active":
        raise VNextRealtimeError("BINDING_PURGING", "会议服务连接正在清理", 409)
    if (
        int(binding["binding_revision"]) != int(session["binding_revision"])
        or int(binding["cancel_revision"]) != int(session["cancel_revision"])
    ):
        raise VNextRealtimeError("BINDING_REVISION_CHANGED", "会议服务连接版本已变化", 409)


def open_realtime_session(
    context: RealtimeOwnerContext,
    *,
    session_id: str,
    task_id: str,
    client_operation_id: str,
    binding_id: str,
    binding_generation: str,
    binding_revision: int,
    cancel_revision: int,
    asset_id: str,
    asset_generation: str,
    codec_revision: str,
    expires_at_epoch: int,
) -> tuple[dict[str, Any], bool]:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    task_id = _safe(task_id, "task_id", 180)
    client_operation_id = _safe(client_operation_id, "client_operation_id", 180)
    binding_id = _safe(binding_id, "binding_id", 180)
    binding_generation = _generation(binding_generation, "binding_generation")
    binding_revision = _positive(binding_revision, "binding_revision")
    cancel_revision = _nonnegative(cancel_revision, "cancel_revision")
    asset_id = _safe(asset_id, "asset_id", 180)
    asset_generation = _generation(asset_generation, "asset_generation")
    codec_revision = _safe(codec_revision, "codec_revision", 120)
    expires_at_epoch = _positive(expires_at_epoch, "expires_at_epoch")
    if expires_at_epoch <= int(time.time()):
        raise VNextRealtimeError("SESSION_EXPIRY_INVALID", "实时转写会话已过期", 422)
    request_sha256 = _request_sha256({
        "session_id": session_id,
        "task_id": task_id,
        "client_operation_id": client_operation_id,
        "binding_id": binding_id,
        "binding_generation": binding_generation,
        "binding_revision": binding_revision,
        "cancel_revision": cancel_revision,
        "asset_id": asset_id,
        "asset_generation": asset_generation,
        "codec_revision": codec_revision,
        "expires_at_epoch": expires_at_epoch,
    })
    now = utc_now()
    created = False
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = _session_row(connection, context, session_id)
        if existing is None:
            existing = connection.execute(
                """SELECT * FROM vnext_realtime_asr_sessions
                   WHERE device_id = ? AND epoch_id = ? AND client_operation_id = ?""",
                (context.device_id, context.epoch_id, client_operation_id),
            ).fetchone()
        if existing is not None:
            if existing["request_sha256"] != request_sha256:
                connection.rollback()
                raise VNextRealtimeError("REALTIME_SESSION_CONFLICT", "实时转写标识已用于其他输入", 409)
            connection.commit()
            decoded = _decode_session(existing)
            assert decoded is not None
            return decoded, True
        active_device = int(connection.execute(
            """SELECT COUNT(*) FROM vnext_realtime_asr_sessions
               WHERE device_id = ? AND epoch_id = ?
                 AND state IN ('open','reconnecting','finalizing')""",
            (context.device_id, context.epoch_id),
        ).fetchone()[0])
        active_global = int(connection.execute(
            """SELECT COUNT(*) FROM vnext_realtime_asr_sessions
               WHERE state IN ('open','reconnecting','finalizing')"""
        ).fetchone()[0])
        if active_device >= MAX_ACTIVE_DEVICE_SESSIONS or active_global >= MAX_ACTIVE_GLOBAL_SESSIONS:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_CAPACITY_BUSY", "实时转写会话较多，请稍后重试", 429)
        task = connection.execute(
            """SELECT * FROM vnext_tasks
               WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
            (task_id, context.device_id, context.epoch_id),
        ).fetchone()
        synthetic = {
            "binding_id": binding_id,
            "binding_generation": binding_generation,
            "binding_revision": binding_revision,
            "cancel_revision": cancel_revision,
        }
        _assert_binding(connection, context, synthetic)
        if (
            task is None
            or task["state"] != "active"
            or task["capability"] != "transcript"
            or task["binding_id"] != binding_id
            or task["binding_generation"] != binding_generation
            or task["entity_id"] != asset_id
        ):
            connection.rollback()
            raise VNextRealtimeError("TRANSCRIPT_TASK_REQUIRED", "实时转写任务尚未登记", 428)
        connection.execute(
            """INSERT INTO vnext_realtime_asr_sessions(
                 session_id, task_id, client_operation_id, device_id, epoch_id,
                 binding_id, binding_generation, binding_revision, cancel_revision,
                 asset_id, asset_generation, codec_revision, request_sha256,
                 state, opened_at, last_seen_at, expires_at_epoch
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)""",
            (
                session_id, task_id, client_operation_id, context.device_id,
                context.epoch_id, binding_id, binding_generation, binding_revision,
                cancel_revision, asset_id, asset_generation, codec_revision,
                request_sha256, now, now, expires_at_epoch,
            ),
        )
        row = _session_row(connection, context, session_id)
        connection.commit()
        created = True
    decoded = _decode_session(row)
    assert decoded is not None
    return decoded, not created


def append_chunk_checkpoint(
    context: RealtimeOwnerContext,
    session_id: str,
    *,
    chunk_seq: int,
    start_ms: int,
    end_ms: int,
    byte_size: int,
    content_sha256: str,
    encrypted_spool_locator: str,
) -> dict[str, Any]:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    chunk_seq = _nonnegative(chunk_seq, "chunk_seq")
    start_ms = _nonnegative(start_ms, "start_ms")
    end_ms = _nonnegative(end_ms, "end_ms")
    byte_size = _positive(byte_size, "byte_size")
    if end_ms < start_ms or byte_size > MAX_CHUNK_BYTES:
        raise VNextRealtimeError("CHUNK_RANGE_INVALID", "实时音频分块无效", 422)
    content_sha256 = _sha256(content_sha256)
    encrypted_spool_locator = _safe(encrypted_spool_locator, "encrypted_spool_locator", 2048)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = _session_row(connection, context, session_id)
        if session is None:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        _assert_binding(connection, context, session)
        if session["state"] not in {"open", "reconnecting"}:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_NOT_OPEN", "实时转写会话已结束", 409)
        existing = connection.execute(
            """SELECT * FROM vnext_realtime_chunk_checkpoints
               WHERE session_id = ? AND chunk_seq = ?""",
            (session_id, chunk_seq),
        ).fetchone()
        if existing is not None:
            same = (
                int(existing["start_ms"]) == start_ms
                and int(existing["end_ms"]) == end_ms
                and int(existing["byte_size"]) == byte_size
                and existing["content_sha256"] == content_sha256
                and existing["encrypted_spool_locator"] == encrypted_spool_locator
            )
            connection.commit()
            if not same:
                raise VNextRealtimeError("CHUNK_REPLAY_CONFLICT", "实时音频分块重放不一致", 409)
            return {
                "schema_version": 2,
                "session_id": session_id,
                "chunk_seq": chunk_seq,
                "last_contiguous_chunk_seq": int(session["last_contiguous_chunk_seq"]),
                "reused": True,
            }
        expected = int(session["last_contiguous_chunk_seq"]) + 1
        if chunk_seq != expected:
            connection.rollback()
            raise VNextRealtimeError("CHUNK_SEQUENCE_GAP", "实时音频分块序号不连续", 409)
        connection.execute(
            """INSERT INTO vnext_realtime_chunk_checkpoints(
                 session_id, chunk_seq, start_ms, end_ms, byte_size,
                 content_sha256, encrypted_spool_locator, state, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'spooled', ?)""",
            (
                session_id, chunk_seq, start_ms, end_ms, byte_size,
                content_sha256, encrypted_spool_locator, now,
            ),
        )
        connection.execute(
            """UPDATE vnext_realtime_asr_sessions
               SET last_contiguous_chunk_seq = ?, last_seen_at = ?, state = 'open'
               WHERE session_id = ?""",
            (chunk_seq, now, session_id),
        )
        connection.commit()
    return {
        "schema_version": 2,
        "session_id": session_id,
        "chunk_seq": chunk_seq,
        "last_contiguous_chunk_seq": chunk_seq,
        "reused": False,
    }


def append_durable_event(
    context: RealtimeOwnerContext,
    session_id: str,
    *,
    event_seq: int,
    event_kind: EventKind,
    stable_segment_key: str | None,
    segment_revision: int,
    outcome: EventOutcome,
    source_start_ms: int,
    source_end_ms: int,
    payload_sha256: str,
    encrypted_payload: bytes,
) -> dict[str, Any]:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    event_seq = _positive(event_seq, "event_seq")
    if event_kind not in {"stable", "final", "error"}:
        raise VNextRealtimeError("EVENT_KIND_INVALID", "转写事件类型无效", 422)
    stable_segment_key = (
        _safe(stable_segment_key, "stable_segment_key", 180)
        if stable_segment_key is not None else None
    )
    if event_kind == "stable" and stable_segment_key is None:
        raise VNextRealtimeError("SEGMENT_KEY_REQUIRED", "稳定转写片段缺少标识", 422)
    segment_revision = _positive(segment_revision, "segment_revision")
    if outcome not in {"text", "no_speech", "error"}:
        raise VNextRealtimeError("CONTENT_OUTCOME_INVALID", "转写内容结果无效", 422)
    if (event_kind == "error") != (outcome == "error"):
        raise VNextRealtimeError("EVENT_OUTCOME_MISMATCH", "转写事件结果与类型不一致", 422)
    source_start_ms = _nonnegative(source_start_ms, "source_start_ms")
    source_end_ms = _nonnegative(source_end_ms, "source_end_ms")
    if source_end_ms < source_start_ms:
        raise VNextRealtimeError("EVENT_RANGE_INVALID", "转写事件时间范围无效", 422)
    payload_sha256 = _sha256(payload_sha256, "payload_sha256")
    if not isinstance(encrypted_payload, bytes) or not 1 <= len(encrypted_payload) <= MAX_EVENT_BYTES:
        raise VNextRealtimeError("EVENT_PAYLOAD_INVALID", "转写事件载荷无效", 422)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = _session_row(connection, context, session_id)
        if session is None:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        _assert_binding(connection, context, session)
        existing = connection.execute(
            """SELECT * FROM vnext_realtime_event_ledger
               WHERE session_id = ? AND event_seq = ?""",
            (session_id, event_seq),
        ).fetchone()
        if existing is not None:
            same = (
                existing["event_kind"] == event_kind
                and existing["stable_segment_key"] == stable_segment_key
                and int(existing["segment_revision"]) == segment_revision
                and existing["outcome"] == outcome
                and int(existing["source_start_ms"]) == source_start_ms
                and int(existing["source_end_ms"]) == source_end_ms
                and existing["payload_sha256"] == payload_sha256
                and bytes(existing["encrypted_payload"]) == encrypted_payload
            )
            connection.commit()
            if not same:
                raise VNextRealtimeError("EVENT_REPLAY_CONFLICT", "转写事件重放不一致", 409)
            return {"schema_version": 2, "event_seq": event_seq, "reused": True}
        if session["state"] in {"succeeded", "cancelled", "expired"}:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_TERMINAL", "实时转写会话已结束", 409)
        if event_seq != int(session["last_durable_event_seq"]) + 1:
            connection.rollback()
            raise VNextRealtimeError("EVENT_SEQUENCE_GAP", "转写事件序号不连续", 409)
        if stable_segment_key is not None:
            previous = connection.execute(
                """SELECT segment_revision FROM vnext_realtime_event_ledger
                   WHERE session_id = ? AND stable_segment_key = ?
                   ORDER BY segment_revision DESC, event_seq DESC LIMIT 1""",
                (session_id, stable_segment_key),
            ).fetchone()
            if previous is not None and segment_revision <= int(previous["segment_revision"]):
                connection.rollback()
                raise VNextRealtimeError("SEGMENT_REVISION_NOT_MONOTONIC", "转写片段版本未推进", 409)
        connection.execute(
            """INSERT INTO vnext_realtime_event_ledger(
                 session_id, event_seq, event_kind, stable_segment_key,
                 segment_revision, outcome, source_start_ms, source_end_ms,
                 payload_sha256, encrypted_payload, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                session_id, event_seq, event_kind, stable_segment_key,
                segment_revision, outcome, source_start_ms, source_end_ms,
                payload_sha256, encrypted_payload, now,
            ),
        )
        next_state = "succeeded" if event_kind == "final" else session["state"]
        connection.execute(
            """UPDATE vnext_realtime_asr_sessions
               SET last_durable_event_seq = ?, last_seen_at = ?, state = ?
               WHERE session_id = ?""",
            (event_seq, now, next_state, session_id),
        )
        connection.commit()
    return {"schema_version": 2, "event_seq": event_seq, "reused": False}


def acknowledge_events(
    context: RealtimeOwnerContext,
    session_id: str,
    through_event_seq: int,
) -> dict[str, Any]:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    through_event_seq = _nonnegative(through_event_seq, "through_event_seq")
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = _session_row(connection, context, session_id)
        if session is None:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        if through_event_seq > int(session["last_durable_event_seq"]):
            connection.rollback()
            raise VNextRealtimeError("EVENT_ACK_AHEAD", "转写事件确认超出服务端游标", 409)
        connection.execute(
            """UPDATE vnext_realtime_event_ledger
               SET device_acked_at = COALESCE(device_acked_at, ?)
               WHERE session_id = ? AND event_seq <= ?""",
            (now, session_id, through_event_seq),
        )
        connection.commit()
    return {
        "schema_version": 2,
        "session_id": session_id,
        "acked_through": through_event_seq,
        "last_durable_event_seq": int(session["last_durable_event_seq"]),
    }


def get_realtime_snapshot(
    context: RealtimeOwnerContext,
    session_id: str,
    *,
    after_event_seq: int = 0,
    limit: int = 128,
) -> dict[str, Any] | None:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    after_event_seq = _nonnegative(after_event_seq, "after_event_seq")
    bounded_limit = max(1, min(256, int(limit)))
    with control_connection() as connection:
        session = _session_row(connection, context, session_id)
        if session is None:
            return None
        events = connection.execute(
            """SELECT * FROM vnext_realtime_event_ledger
               WHERE session_id = ? AND event_seq > ?
               ORDER BY event_seq LIMIT ?""",
            (session_id, after_event_seq, bounded_limit),
        ).fetchall()
    return {
        "schema_version": 2,
        "session": _decode_session(session),
        "events": [dict(row) for row in events],
    }
