"""Durable realtime ASR session, chunk and stable-event owner."""

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
MAX_SESSION_SPOOL_BYTES = 512 * 1024 * 1024
MAX_GLOBAL_SPOOL_BYTES = 4 * 1024 * 1024 * 1024


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
                worker_generation TEXT,
                payload_released_at TEXT,
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
        columns = {
            str(row[1])
            for row in connection.execute(
                "PRAGMA table_info(vnext_realtime_asr_sessions)"
            ).fetchall()
        }
        if "worker_generation" not in columns:
            connection.execute(
                "ALTER TABLE vnext_realtime_asr_sessions ADD COLUMN worker_generation TEXT"
            )
        if "payload_released_at" not in columns:
            connection.execute(
                "ALTER TABLE vnext_realtime_asr_sessions ADD COLUMN payload_released_at TEXT"
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
    result.pop("worker_generation", None)
    result.pop("payload_released_at", None)
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


def _assert_worker(session: Any, worker_generation: str) -> str:
    normalized = _generation(worker_generation, "worker_generation")
    if session["worker_generation"] != normalized:
        raise VNextRealtimeError("REALTIME_WORKER_FENCED", "实时转写连接已被新的连接接替", 409)
    return normalized


def _assert_not_expired(session: Any) -> None:
    if int(session["expires_at_epoch"]) <= int(time.time()):
        raise VNextRealtimeError("REALTIME_SESSION_EXPIRED", "实时转写会话已过期", 410)


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
    now_epoch = int(time.time())
    if expires_at_epoch <= now_epoch or expires_at_epoch > now_epoch + 24 * 60 * 60:
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
    })
    task_input_sha256 = _request_sha256({
        "contract_revision": "realtime.transcript.v2",
        "asset_id": asset_id,
        "asset_generation": asset_generation,
        "codec_revision": codec_revision,
    })
    task_generation_id = f"realtime:{asset_generation}"
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
            if int(existing["expires_at_epoch"]) <= now_epoch:
                connection.rollback()
                raise VNextRealtimeError("REALTIME_SESSION_EXPIRED", "实时转写会话已过期", 410)
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
        synthetic = {
            "binding_id": binding_id,
            "binding_generation": binding_generation,
            "binding_revision": binding_revision,
            "cancel_revision": cancel_revision,
        }
        _assert_binding(connection, context, synthetic)
        try:
            task, _task_reused = vnext_task_store.create_task_in_transaction(
                connection,
                context,
                task_id=task_id,
                binding_id=binding_id,
                binding_generation=binding_generation,
                capability="transcript",
                entity_id=asset_id,
                entity_revision=1,
                input_sha256=task_input_sha256,
                generation_id=task_generation_id,
            )
        except vnext_task_store.VNextTaskError as error:
            connection.rollback()
            raise VNextRealtimeError(error.code, error.message, error.status_code) from error
        if task["state"] != "active":
            connection.rollback()
            raise VNextRealtimeError("TRANSCRIPT_TASK_TERMINAL", "实时转写任务已结束", 409)
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
    worker_generation: str,
) -> dict[str, Any]:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    chunk_seq = _nonnegative(chunk_seq, "chunk_seq")
    start_ms = _nonnegative(start_ms, "start_ms")
    end_ms = _nonnegative(end_ms, "end_ms")
    byte_size = _positive(byte_size, "byte_size")
    expected_bytes = (end_ms - start_ms) * 32
    if (
        end_ms <= start_ms
        or byte_size > MAX_CHUNK_BYTES
        or abs(byte_size - expected_bytes) > 31
    ):
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
        _assert_not_expired(session)
        _assert_worker(session, worker_generation)
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
        if chunk_seq == 0:
            expected_start_ms = 0
        else:
            previous = connection.execute(
                """SELECT end_ms FROM vnext_realtime_chunk_checkpoints
                     WHERE session_id = ? AND chunk_seq = ?""",
                (session_id, chunk_seq - 1),
            ).fetchone()
            expected_start_ms = int(previous["end_ms"]) if previous is not None else -1
        if start_ms != expected_start_ms:
            connection.rollback()
            raise VNextRealtimeError("CHUNK_TIMELINE_GAP", "实时音频时间轴不连续", 409)
        session_bytes = int(connection.execute(
            """SELECT COALESCE(SUM(byte_size), 0)
               FROM vnext_realtime_chunk_checkpoints
               WHERE session_id = ? AND state = 'spooled'""",
            (session_id,),
        ).fetchone()[0])
        global_bytes = int(connection.execute(
            """SELECT COALESCE(SUM(byte_size), 0)
               FROM vnext_realtime_chunk_checkpoints WHERE state = 'spooled'"""
        ).fetchone()[0])
        if (
            session_bytes + byte_size > MAX_SESSION_SPOOL_BYTES
            or global_bytes + byte_size > MAX_GLOBAL_SPOOL_BYTES
        ):
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SPOOL_CAPACITY", "实时音频暂存空间不足", 429)
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


def claim_realtime_worker(
    context: RealtimeOwnerContext,
    session_id: str,
    worker_generation: str,
) -> dict[str, Any]:
    """Fence any older socket/pipeline before this connection processes audio."""
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    worker_generation = _generation(worker_generation, "worker_generation")
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = _session_row(connection, context, session_id)
        if session is None:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        _assert_binding(connection, context, session)
        _assert_not_expired(session)
        if session["state"] in {"succeeded", "cancelled", "expired"}:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_TERMINAL", "实时转写会话已结束", 409)
        next_state = session["state"]
        if next_state != "finalizing":
            next_state = "reconnecting" if int(session["last_contiguous_chunk_seq"]) >= 0 else "open"
        connection.execute(
            """UPDATE vnext_realtime_asr_sessions
                  SET worker_generation = ?, state = ?, last_seen_at = ?
                WHERE session_id = ?""",
            (worker_generation, next_state, now, session_id),
        )
        row = _session_row(connection, context, session_id)
        connection.commit()
    decoded = _decode_session(row)
    assert decoded is not None
    return decoded


def advance_chunk_consumption(
    context: RealtimeOwnerContext,
    session_id: str,
    *,
    through_chunk_seq: int,
    worker_generation: str,
) -> list[str]:
    """Advance the audio cursor only after VAD reaches a replayable boundary."""
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    through_chunk_seq = _nonnegative(through_chunk_seq, "through_chunk_seq")
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = _session_row(connection, context, session_id)
        if session is None:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        _assert_binding(connection, context, session)
        _assert_not_expired(session)
        _assert_worker(session, worker_generation)
        if through_chunk_seq > int(session["last_contiguous_chunk_seq"]):
            connection.rollback()
            raise VNextRealtimeError("CHUNK_CONSUME_AHEAD", "转写消费游标超出音频游标", 409)
        rows = connection.execute(
            """SELECT encrypted_spool_locator
                 FROM vnext_realtime_chunk_checkpoints
                WHERE session_id = ? AND chunk_seq <= ? AND state = 'spooled'""",
            (session_id, through_chunk_seq),
        ).fetchall()
        connection.execute(
            """UPDATE vnext_realtime_chunk_checkpoints SET state = 'consumed'
                 WHERE session_id = ? AND chunk_seq <= ? AND state = 'spooled'""",
            (session_id, through_chunk_seq),
        )
        connection.commit()
    return [str(row["encrypted_spool_locator"]) for row in rows]


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
    worker_generation: str,
    consume_through_chunk_seq: int | None = None,
) -> dict[str, Any]:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    event_seq = _positive(event_seq, "event_seq")
    if event_kind not in {"stable", "final", "error"}:
        raise VNextRealtimeError("EVENT_KIND_INVALID", "转写事件类型无效", 422)
    if event_kind == "final":
        raise VNextRealtimeError(
            "FINAL_REQUIRES_TASK_COMMIT", "最终转写必须与任务终态一并提交", 409,
        )
    worker_generation = _generation(worker_generation, "worker_generation")
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
    if consume_through_chunk_seq is not None:
        consume_through_chunk_seq = _nonnegative(
            consume_through_chunk_seq, "consume_through_chunk_seq",
        )
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = _session_row(connection, context, session_id)
        if session is None:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        _assert_binding(connection, context, session)
        _assert_not_expired(session)
        _assert_worker(session, worker_generation)
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
        if (
            consume_through_chunk_seq is not None
            and consume_through_chunk_seq > int(session["last_contiguous_chunk_seq"])
        ):
            connection.rollback()
            raise VNextRealtimeError("CHUNK_CONSUME_AHEAD", "转写消费游标超出音频游标", 409)
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
        if consume_through_chunk_seq is not None:
            connection.execute(
                """UPDATE vnext_realtime_chunk_checkpoints SET state = 'consumed'
                   WHERE session_id = ? AND chunk_seq <= ? AND state = 'spooled'""",
                (session_id, consume_through_chunk_seq),
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


def append_terminal_event_and_complete_task(
    context: RealtimeOwnerContext,
    session_id: str,
    *,
    event_seq: int,
    outcome: Literal["text", "no_speech"],
    source_start_ms: int,
    source_end_ms: int,
    payload_sha256: str,
    encrypted_payload: bytes,
    consume_through_chunk_seq: int | None,
    worker_generation: str,
    attempt_id: str,
    lease_owner: str,
) -> dict[str, Any]:
    """Commit final event, audio cursor and generic Task terminal atomically."""
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    event_seq = _positive(event_seq, "event_seq")
    if outcome not in {"text", "no_speech"}:
        raise VNextRealtimeError("CONTENT_OUTCOME_INVALID", "转写内容结果无效", 422)
    source_start_ms = _nonnegative(source_start_ms, "source_start_ms")
    source_end_ms = _nonnegative(source_end_ms, "source_end_ms")
    if source_end_ms < source_start_ms:
        raise VNextRealtimeError("EVENT_RANGE_INVALID", "转写事件时间范围无效", 422)
    payload_sha256 = _sha256(payload_sha256, "payload_sha256")
    if not isinstance(encrypted_payload, bytes) or not 1 <= len(encrypted_payload) <= MAX_EVENT_BYTES:
        raise VNextRealtimeError("EVENT_PAYLOAD_INVALID", "转写事件载荷无效", 422)
    if consume_through_chunk_seq is not None:
        consume_through_chunk_seq = _nonnegative(
            consume_through_chunk_seq, "consume_through_chunk_seq",
        )
    worker_generation = _generation(worker_generation, "worker_generation")
    attempt_id = _safe(attempt_id, "attempt_id", 512)
    lease_owner = _safe(lease_owner, "lease_owner", 200)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = _session_row(connection, context, session_id)
        if session is None:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        _assert_binding(connection, context, session)
        _assert_not_expired(session)
        _assert_worker(session, worker_generation)
        if (
            consume_through_chunk_seq is not None
            and consume_through_chunk_seq > int(session["last_contiguous_chunk_seq"])
        ):
            connection.rollback()
            raise VNextRealtimeError("CHUNK_CONSUME_AHEAD", "转写消费游标超出音频游标", 409)
        existing = connection.execute(
            """SELECT * FROM vnext_realtime_event_ledger
                 WHERE session_id = ? AND event_seq = ?""",
            (session_id, event_seq),
        ).fetchone()
        if existing is not None:
            same = (
                existing["event_kind"] == "final"
                and existing["stable_segment_key"] is None
                and int(existing["segment_revision"]) == 1
                and existing["outcome"] == outcome
                and int(existing["source_start_ms"]) == source_start_ms
                and int(existing["source_end_ms"]) == source_end_ms
                and existing["payload_sha256"] == payload_sha256
                and bytes(existing["encrypted_payload"]) == encrypted_payload
            )
            if not same:
                connection.rollback()
                raise VNextRealtimeError("EVENT_REPLAY_CONFLICT", "转写事件重放不一致", 409)
        else:
            if session["state"] in {"succeeded", "cancelled", "expired"}:
                connection.rollback()
                raise VNextRealtimeError("REALTIME_SESSION_TERMINAL", "实时转写会话已结束", 409)
            if event_seq != int(session["last_durable_event_seq"]) + 1:
                connection.rollback()
                raise VNextRealtimeError("EVENT_SEQUENCE_GAP", "转写事件序号不连续", 409)
            connection.execute(
                """INSERT INTO vnext_realtime_event_ledger(
                     session_id, event_seq, event_kind, stable_segment_key,
                     segment_revision, outcome, source_start_ms, source_end_ms,
                     payload_sha256, encrypted_payload, created_at
                   ) VALUES (?, ?, 'final', NULL, 1, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id, event_seq, outcome, source_start_ms, source_end_ms,
                    payload_sha256, encrypted_payload, now,
                ),
            )
        if consume_through_chunk_seq is not None:
            connection.execute(
                """UPDATE vnext_realtime_chunk_checkpoints SET state = 'consumed'
                     WHERE session_id = ? AND chunk_seq <= ? AND state = 'spooled'""",
                (session_id, consume_through_chunk_seq),
            )
        task = connection.execute(
            """SELECT * FROM vnext_tasks
                 WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
            (session["task_id"], context.device_id, context.epoch_id),
        ).fetchone()
        if task is None:
            connection.rollback()
            raise VNextRealtimeError("TRANSCRIPT_TASK_REQUIRED", "实时转写任务不存在", 409)
        result = {
            "contract_revision": "transcript.stream.v2",
            "session_id": session_id,
            "final_event_sequence": event_seq,
        }
        result_kind: Literal["artifact", "content_outcome"] = "artifact"
        if outcome == "no_speech":
            result_kind = "content_outcome"
            result["code"] = "NO_SPEECH"
        if task["state"] == "active":
            try:
                completed = vnext_task_store.mark_success_in_transaction(
                    connection,
                    context,
                    task_id=str(session["task_id"]),
                    attempt_id=attempt_id,
                    result=result,
                    result_kind=result_kind,
                    lease_owner=lease_owner,
                )
            except vnext_task_store.VNextTaskError as error:
                connection.rollback()
                raise VNextRealtimeError(error.code, error.message, error.status_code) from error
            if not completed:
                connection.rollback()
                raise VNextRealtimeError("TASK_ATTEMPT_FENCED", "实时转写任务已被其他执行接替", 409)
        elif task["state"] == "success":
            decoded_task = vnext_task_store.decode_task_row(task)
            if (
                decoded_task is None
                or decoded_task["result_kind"] != result_kind
                or decoded_task["result"] != result
            ):
                connection.rollback()
                raise VNextRealtimeError(
                    "TRANSCRIPT_TASK_RESULT_CONFLICT", "实时转写任务终态不一致", 409,
                )
        else:
            connection.rollback()
            raise VNextRealtimeError("TRANSCRIPT_TASK_TERMINAL", "实时转写任务已结束", 409)
        connection.execute(
            """UPDATE vnext_realtime_asr_sessions
                  SET last_durable_event_seq = ?, last_seen_at = ?, state = 'succeeded'
                WHERE session_id = ?""",
            (event_seq, now, session_id),
        )
        connection.commit()
    return {
        "schema_version": 2,
        "event_seq": event_seq,
        "reused": existing is not None,
        "task_state": "success",
        "result_kind": result_kind,
    }


def mark_realtime_attempt_failure(
    context: RealtimeOwnerContext,
    session_id: str,
    *,
    worker_generation: str,
    attempt_id: str,
    lease_owner: str,
    error_code: str,
) -> bool:
    """Fail only the attempt still fenced by this socket worker generation."""
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    worker_generation = _generation(worker_generation, "worker_generation")
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = _session_row(connection, context, session_id)
        if session is None:
            connection.rollback()
            return False
        try:
            _assert_binding(connection, context, session)
            _assert_worker(session, worker_generation)
        except VNextRealtimeError:
            connection.rollback()
            return False
        try:
            marked = vnext_task_store.mark_failure_in_transaction(
                connection,
                context,
                task_id=str(session["task_id"]),
                attempt_id=attempt_id,
                error_code=error_code,
                retryable=True,
                lease_owner=lease_owner,
            )
        except vnext_task_store.VNextTaskError:
            connection.rollback()
            return False
        if not marked:
            connection.rollback()
            return False
        task = connection.execute(
            "SELECT state FROM vnext_tasks WHERE task_id = ?",
            (session["task_id"],),
        ).fetchone()
        next_state = "reconnecting" if task is not None and task["state"] == "active" else "cancelled"
        connection.execute(
            """UPDATE vnext_realtime_asr_sessions SET state = ?, last_seen_at = ?
                 WHERE session_id = ?""",
            (next_state, utc_now(), session_id),
        )
        connection.commit()
    return True


def acknowledge_events(
    context: RealtimeOwnerContext,
    session_id: str,
    through_event_seq: int,
) -> dict[str, Any]:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    through_event_seq = _nonnegative(through_event_seq, "through_event_seq")
    now = utc_now()
    cleanup_locators: list[str] = []
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
        if (
            session["state"] == "succeeded"
            and through_event_seq == int(session["last_durable_event_seq"])
        ):
            cleanup_locators = [
                str(row["encrypted_spool_locator"])
                for row in connection.execute(
                    """SELECT encrypted_spool_locator
                         FROM vnext_realtime_chunk_checkpoints WHERE session_id = ?""",
                    (session_id,),
                ).fetchall()
            ]
        connection.commit()
    released = False
    if cleanup_locators or (
        session["state"] == "succeeded"
        and through_event_seq == int(session["last_durable_event_seq"])
    ):
        from app.services import vnext_realtime_crypto

        try:
            for locator in cleanup_locators:
                vnext_realtime_crypto.delete_chunk(locator)
        except (OSError, ValueError):
            released = False
        else:
            with control_connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                current = _session_row(connection, context, session_id)
                if (
                    current is not None
                    and current["state"] == "succeeded"
                    and through_event_seq == int(current["last_durable_event_seq"])
                ):
                    unacked = int(connection.execute(
                        """SELECT COUNT(*) FROM vnext_realtime_event_ledger
                             WHERE session_id = ? AND device_acked_at IS NULL""",
                        (session_id,),
                    ).fetchone()[0])
                    if unacked == 0:
                        connection.execute(
                            "DELETE FROM vnext_realtime_chunk_checkpoints WHERE session_id = ?",
                            (session_id,),
                        )
                        connection.execute(
                            "DELETE FROM vnext_realtime_event_ledger WHERE session_id = ?",
                            (session_id,),
                        )
                        connection.execute(
                            """UPDATE vnext_realtime_asr_sessions
                                  SET payload_released_at = COALESCE(payload_released_at, ?)
                                WHERE session_id = ?""",
                            (utc_now(), session_id),
                        )
                        released = True
                connection.commit()
    return {
        "schema_version": 2,
        "session_id": session_id,
        "acked_through": through_event_seq,
        "last_durable_event_seq": int(session["last_durable_event_seq"]),
        "server_payload_released": released,
    }


def mark_session_finalizing(
    context: RealtimeOwnerContext,
    session_id: str,
    worker_generation: str,
) -> dict[str, Any]:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = _session_row(connection, context, session_id)
        if session is None:
            connection.rollback()
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        _assert_binding(connection, context, session)
        _assert_not_expired(session)
        _assert_worker(session, worker_generation)
        if session["state"] in {"open", "reconnecting"}:
            connection.execute(
                """UPDATE vnext_realtime_asr_sessions
                   SET state = 'finalizing', last_seen_at = ? WHERE session_id = ?""",
                (utc_now(), session_id),
            )
            session = _session_row(connection, context, session_id)
        connection.commit()
    decoded = _decode_session(session)
    assert decoded is not None
    return decoded


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
        if after_event_seq > int(session["last_durable_event_seq"]):
            raise VNextRealtimeError("EVENT_CURSOR_AHEAD", "转写事件游标超出服务端进度", 409)
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


def get_realtime_pipeline_resume(
    context: RealtimeOwnerContext,
    session_id: str,
) -> dict[str, Any]:
    """Return complete lightweight state needed to deterministically replay VAD."""
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    with control_connection() as connection:
        session = _session_row(connection, context, session_id)
        if session is None:
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        _assert_binding(connection, context, session)
        stable_rows = connection.execute(
            """SELECT stable_segment_key, outcome, source_end_ms
                 FROM vnext_realtime_event_ledger
                WHERE session_id = ? AND event_kind = 'stable'
                ORDER BY event_seq""",
            (session_id,),
        ).fetchall()
        last_stable = connection.execute(
            """SELECT event_seq, encrypted_payload
                 FROM vnext_realtime_event_ledger
                WHERE session_id = ? AND event_kind = 'stable'
                ORDER BY event_seq DESC LIMIT 1""",
            (session_id,),
        ).fetchone()
    return {
        "session": _decode_session(session),
        "stable_segments": [dict(row) for row in stable_rows],
        "last_stable": dict(last_stable) if last_stable is not None else None,
    }


def get_unconsumed_chunks(
    context: RealtimeOwnerContext,
    session_id: str,
) -> list[dict[str, Any]]:
    ensure_vnext_realtime_schema()
    session_id = _safe(session_id, "session_id", 180)
    with control_connection() as connection:
        session = _session_row(connection, context, session_id)
        if session is None:
            raise VNextRealtimeError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        _assert_binding(connection, context, session)
        rows = connection.execute(
            """SELECT chunk_seq, start_ms, end_ms, byte_size, content_sha256,
                      encrypted_spool_locator, state
               FROM vnext_realtime_chunk_checkpoints
               WHERE session_id = ? AND state = 'spooled'
               ORDER BY chunk_seq""",
            (session_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def is_spool_locator_referenced(locator: str) -> bool:
    ensure_vnext_realtime_schema()
    locator = _safe(locator, "encrypted_spool_locator", 2048)
    with control_connection() as connection:
        row = connection.execute(
            """SELECT 1 FROM vnext_realtime_chunk_checkpoints
                 WHERE encrypted_spool_locator = ? LIMIT 1""",
            (locator,),
        ).fetchone()
    return row is not None


def cleanup_realtime_payloads(
    *,
    now_epoch: int | None = None,
    orphan_grace_seconds: int = 3600,
) -> dict[str, int]:
    """Expire stale sessions and bound encrypted spool/ledger retention."""
    ensure_vnext_realtime_schema()
    effective_now = int(time.time()) if now_epoch is None else int(now_epoch)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        expired = connection.execute(
            """SELECT session_id, task_id FROM vnext_realtime_asr_sessions
                 WHERE expires_at_epoch <= ? AND payload_released_at IS NULL""",
            (effective_now,),
        ).fetchall()
        expired_session_ids = [str(row["session_id"]) for row in expired]
        expired_task_ids = [str(row["task_id"]) for row in expired]
        if expired_session_ids:
            connection.executemany(
                """UPDATE vnext_realtime_asr_sessions
                      SET state = CASE WHEN state = 'succeeded' THEN state ELSE 'expired' END,
                          last_seen_at = ?
                    WHERE session_id = ?""",
                [(now, session_id) for session_id in expired_session_ids],
            )
            connection.executemany(
                """UPDATE vnext_tasks
                      SET state = 'failure', error_code = 'REALTIME_SESSION_EXPIRED',
                          updated_at = ?, terminal_at = ?
                    WHERE task_id = ? AND state = 'active'""",
                [(now, now, task_id) for task_id in expired_task_ids],
            )
            connection.executemany(
                """UPDATE vnext_task_attempts
                      SET state = 'terminal_failure', phase = 'committing',
                          error_code = 'REALTIME_SESSION_EXPIRED', updated_at = ?, terminal_at = ?
                    WHERE task_id = ? AND state IN (
                        'queued','running','retryable_failure','lease_expired'
                    )""",
                [(now, now, task_id) for task_id in expired_task_ids],
            )
        cleanup_rows = connection.execute(
            """SELECT checkpoint.session_id, checkpoint.encrypted_spool_locator
                 FROM vnext_realtime_chunk_checkpoints checkpoint
                 JOIN vnext_realtime_asr_sessions session
                   ON session.session_id = checkpoint.session_id
                WHERE checkpoint.state = 'consumed'
                   OR (session.expires_at_epoch <= ? AND session.payload_released_at IS NULL)""",
            (effective_now,),
        ).fetchall()
        connection.commit()

    from app.services import vnext_realtime_crypto

    deleted_locators: list[str] = []
    failed_session_ids: set[str] = set()
    for row in cleanup_rows:
        locator = str(row["encrypted_spool_locator"])
        try:
            vnext_realtime_crypto.delete_chunk(locator)
        except (OSError, ValueError):
            failed_session_ids.add(str(row["session_id"]))
            continue
        deleted_locators.append(locator)
    releasable_session_ids = [
        session_id for session_id in expired_session_ids
        if session_id not in failed_session_ids
    ]
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if deleted_locators:
            connection.executemany(
                """DELETE FROM vnext_realtime_chunk_checkpoints
                     WHERE encrypted_spool_locator = ?""",
                [(locator,) for locator in deleted_locators],
            )
        if releasable_session_ids:
            connection.executemany(
                "DELETE FROM vnext_realtime_event_ledger WHERE session_id = ?",
                [(session_id,) for session_id in releasable_session_ids],
            )
            connection.executemany(
                """UPDATE vnext_realtime_asr_sessions SET payload_released_at = ?
                     WHERE session_id = ?""",
                [(now, session_id) for session_id in releasable_session_ids],
            )
        referenced = {
            str(row["encrypted_spool_locator"])
            for row in connection.execute(
                "SELECT encrypted_spool_locator FROM vnext_realtime_chunk_checkpoints"
            ).fetchall()
        }
        connection.commit()
    orphaned = vnext_realtime_crypto.delete_orphan_chunks(
        referenced,
        older_than_epoch=effective_now - max(60, int(orphan_grace_seconds)),
    )
    return {
        "expired_sessions": len(expired_session_ids),
        "released_checkpoints": len(deleted_locators),
        "orphan_files": int(orphaned["files"]),
        "orphan_bytes": int(orphaned["bytes"]),
    }
