"""Durable owner for vNext voiceprints, speaker inputs and overlay revisions."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import time
from typing import Any, Protocol
import uuid

import numpy as np

from app.services.device_identity import control_connection, utc_now
from app.services import vnext_speaker_crypto, vnext_task_store


MAX_SEGMENT_BYTES = 1024 * 1024
MAX_SESSION_SEGMENTS = 20_000
SPEAKER_PAYLOAD_TTL_SECONDS = 24 * 60 * 60


class SpeakerOwnerContext(Protocol):
    device_id: str
    epoch_id: str


@dataclass(frozen=True)
class StoredSpeakerContext:
    device_id: str
    epoch_id: str


class VNextSpeakerError(RuntimeError):
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
        raise VNextSpeakerError("IDENTIFIER_INVALID", f"{field}无效", 422)
    return normalized


def _sha256(value: str, field: str = "content_sha256") -> str:
    normalized = _safe(value, field, 71).lower()
    if len(normalized) != 71 or not normalized.startswith("sha256:"):
        raise VNextSpeakerError("HASH_INVALID", f"{field}无效", 422)
    try:
        int(normalized[7:], 16)
    except ValueError as error:
        raise VNextSpeakerError("HASH_INVALID", f"{field}无效", 422) from error
    return normalized


def _canonical_sha256(payload: Any) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _profile_name_identity(device_id: str, epoch_id: str, speaker_id: str) -> str:
    return f"speaker-profile-name:{device_id}:{epoch_id}:{speaker_id}"


def _profile_embedding_identity(
    device_id: str,
    epoch_id: str,
    speaker_id: str,
    profile_revision: int,
) -> str:
    return f"speaker-profile-embedding:{device_id}:{epoch_id}:{speaker_id}:{profile_revision}"


def _overlay_identity(session_id: str, overlay_revision: int) -> str:
    return f"speaker-overlay:{session_id}:{overlay_revision}"


def import_speaker_run_id(task_id: str) -> str:
    normalized = _safe(task_id, "source_task_id", 512)
    if len(normalized) <= 173:
        return f"import:{normalized}"
    return "import:sha256:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def ensure_vnext_speaker_schema() -> None:
    vnext_task_store.ensure_vnext_task_schema()
    with control_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS vnext_voiceprint_profiles (
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                speaker_id TEXT NOT NULL,
                profile_revision INTEGER NOT NULL CHECK(profile_revision >= 1),
                status TEXT NOT NULL CHECK(status IN ('enrolling','active','revoked')),
                encrypted_display_name BLOB,
                display_name_sha256 TEXT,
                encrypted_embedding BLOB,
                embedding_sha256 TEXT,
                embedding_model_revision TEXT,
                sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                revoked_at TEXT,
                PRIMARY KEY(device_id, epoch_id, speaker_id)
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_voiceprints_active
                ON vnext_voiceprint_profiles(device_id, epoch_id, status, updated_at);

            CREATE TABLE IF NOT EXISTS vnext_speaker_runs (
                session_id TEXT PRIMARY KEY,
                task_id TEXT UNIQUE REFERENCES vnext_tasks(task_id) ON DELETE SET NULL,
                source_task_id TEXT REFERENCES vnext_tasks(task_id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                epoch_id TEXT NOT NULL,
                binding_id TEXT NOT NULL,
                binding_generation TEXT NOT NULL,
                binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
                cancel_revision INTEGER NOT NULL CHECK(cancel_revision >= 0),
                asset_generation TEXT NOT NULL,
                source_manifest_sha256 TEXT,
                profile_manifest_sha256 TEXT,
                model_revision TEXT,
                state TEXT NOT NULL CHECK(state IN (
                    'collecting','queued','running','succeeded','no_content','failed','cancelled'
                )),
                overlay_revision INTEGER NOT NULL DEFAULT 0 CHECK(overlay_revision >= 0),
                error_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                terminal_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_vnext_speaker_runs_ready
                ON vnext_speaker_runs(state, updated_at, session_id);
            CREATE INDEX IF NOT EXISTS idx_vnext_speaker_runs_scope
                ON vnext_speaker_runs(device_id, epoch_id, binding_id, state);

            CREATE TABLE IF NOT EXISTS vnext_speaker_inputs (
                session_id TEXT NOT NULL REFERENCES vnext_speaker_runs(session_id) ON DELETE CASCADE,
                stable_segment_key TEXT NOT NULL,
                source_start_ms INTEGER NOT NULL CHECK(source_start_ms >= 0),
                source_end_ms INTEGER NOT NULL CHECK(source_end_ms >= source_start_ms),
                byte_size INTEGER NOT NULL CHECK(byte_size >= 1 AND byte_size <= 1048576),
                content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 71),
                encrypted_spool_locator TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(session_id, stable_segment_key)
            );

            CREATE TABLE IF NOT EXISTS vnext_speaker_overlay_revisions (
                session_id TEXT NOT NULL REFERENCES vnext_speaker_runs(session_id) ON DELETE CASCADE,
                overlay_revision INTEGER NOT NULL CHECK(overlay_revision >= 1),
                source_manifest_sha256 TEXT NOT NULL CHECK(length(source_manifest_sha256) = 71),
                profile_manifest_sha256 TEXT NOT NULL CHECK(length(profile_manifest_sha256) = 71),
                model_revision TEXT NOT NULL,
                output_sha256 TEXT NOT NULL CHECK(length(output_sha256) = 71),
                encrypted_payload BLOB NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active','archived')),
                created_at TEXT NOT NULL,
                activated_at TEXT,
                PRIMARY KEY(session_id, overlay_revision)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_vnext_speaker_overlay_active
                ON vnext_speaker_overlay_revisions(session_id) WHERE status = 'active';
            """
        )
        columns = {
            str(row[1])
            for row in connection.execute("PRAGMA table_info(vnext_speaker_runs)").fetchall()
        }
        if "source_task_id" not in columns:
            connection.execute(
                "ALTER TABLE vnext_speaker_runs ADD COLUMN source_task_id TEXT REFERENCES vnext_tasks(task_id)"
            )
        connection.commit()


def _decode_name(row: Any) -> str:
    encrypted = row["encrypted_display_name"]
    if encrypted is None:
        return ""
    identity = _profile_name_identity(
        str(row["device_id"]),
        str(row["epoch_id"]),
        str(row["speaker_id"]),
    )
    return vnext_speaker_crypto.open_payload(identity, bytes(encrypted)).decode("utf-8")


def _decode_embedding(row: Any) -> np.ndarray | None:
    encrypted = row["encrypted_embedding"]
    if encrypted is None:
        return None
    identity = _profile_embedding_identity(
        str(row["device_id"]),
        str(row["epoch_id"]),
        str(row["speaker_id"]),
        int(row["profile_revision"]),
    )
    raw = vnext_speaker_crypto.open_payload(identity, bytes(encrypted))
    embedding = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    norm = float(np.linalg.norm(embedding))
    if embedding.size < 1 or not math.isfinite(norm) or norm < 1e-6:
        raise VNextSpeakerError("VOICEPRINT_INVALID", "声纹数据无效", 500)
    return embedding / norm


def _profile_public(row: Any) -> dict[str, Any]:
    return {
        "speaker_id": str(row["speaker_id"]),
        "display_name": _decode_name(row) if row["status"] != "revoked" else "",
        "profile_revision": int(row["profile_revision"]),
        "status": str(row["status"]),
        "sample_count": int(row["sample_count"]),
        "model_revision": row["embedding_model_revision"],
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def create_profile(
    context: SpeakerOwnerContext,
    *,
    speaker_id: str,
    display_name: str,
) -> tuple[dict[str, Any], bool]:
    ensure_vnext_speaker_schema()
    speaker_id = _safe(speaker_id, "speaker_id", 180)
    display_name = _safe(display_name, "display_name", 120)
    encoded_name = display_name.encode("utf-8")
    name_sha256 = "sha256:" + hashlib.sha256(encoded_name).hexdigest()
    encrypted_name = vnext_speaker_crypto.seal_payload(
        _profile_name_identity(context.device_id, context.epoch_id, speaker_id),
        encoded_name,
    )
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            """SELECT * FROM vnext_voiceprint_profiles
                 WHERE device_id = ? AND epoch_id = ? AND speaker_id = ?""",
            (context.device_id, context.epoch_id, speaker_id),
        ).fetchone()
        if existing is not None:
            same = (
                existing["status"] != "revoked"
                and existing["display_name_sha256"] == name_sha256
            )
            connection.commit()
            if not same:
                raise VNextSpeakerError("SPEAKER_PROFILE_CONFLICT", "讲话人档案标识已被使用", 409)
            return _profile_public(existing), True
        connection.execute(
            """INSERT INTO vnext_voiceprint_profiles(
                 device_id, epoch_id, speaker_id, profile_revision, status,
                 encrypted_display_name, display_name_sha256, sample_count,
                 created_at, updated_at
               ) VALUES (?, ?, ?, 1, 'enrolling', ?, ?, 0, ?, ?)""",
            (
                context.device_id,
                context.epoch_id,
                speaker_id,
                encrypted_name,
                name_sha256,
                now,
                now,
            ),
        )
        row = connection.execute(
            """SELECT * FROM vnext_voiceprint_profiles
                 WHERE device_id = ? AND epoch_id = ? AND speaker_id = ?""",
            (context.device_id, context.epoch_id, speaker_id),
        ).fetchone()
        connection.commit()
    assert row is not None
    return _profile_public(row), False


def save_profile_embedding(
    context: SpeakerOwnerContext,
    *,
    speaker_id: str,
    embedding: np.ndarray,
    model_revision: str,
) -> dict[str, Any]:
    ensure_vnext_speaker_schema()
    speaker_id = _safe(speaker_id, "speaker_id", 180)
    model_revision = _safe(model_revision, "model_revision", 180)
    candidate = np.asarray(embedding, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(candidate))
    if candidate.size < 1 or candidate.size > 4096 or not math.isfinite(norm) or norm < 1e-6:
        raise VNextSpeakerError("VOICEPRINT_INVALID", "声纹数据无效", 422)
    candidate = candidate / norm
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            """SELECT * FROM vnext_voiceprint_profiles
                 WHERE device_id = ? AND epoch_id = ? AND speaker_id = ?""",
            (context.device_id, context.epoch_id, speaker_id),
        ).fetchone()
        if row is None or row["status"] == "revoked":
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_PROFILE_NOT_FOUND", "讲话人档案不存在", 404)
        previous = _decode_embedding(row)
        sample_count = int(row["sample_count"])
        if previous is not None and sample_count > 0:
            candidate = previous * sample_count + candidate
            candidate_norm = float(np.linalg.norm(candidate))
            if candidate_norm < 1e-6:
                connection.rollback()
                raise VNextSpeakerError("VOICEPRINT_INVALID", "声纹数据无效", 422)
            candidate = candidate / candidate_norm
        next_revision = int(row["profile_revision"]) + 1
        raw = candidate.astype("<f4").tobytes()
        encrypted = vnext_speaker_crypto.seal_payload(
            _profile_embedding_identity(
                context.device_id,
                context.epoch_id,
                speaker_id,
                next_revision,
            ),
            raw,
        )
        embedding_sha256 = "sha256:" + hashlib.sha256(raw).hexdigest()
        connection.execute(
            """UPDATE vnext_voiceprint_profiles
                  SET profile_revision = ?, status = 'active', encrypted_embedding = ?,
                      embedding_sha256 = ?, embedding_model_revision = ?,
                      sample_count = ?, updated_at = ?, revoked_at = NULL
                WHERE device_id = ? AND epoch_id = ? AND speaker_id = ?""",
            (
                next_revision,
                encrypted,
                embedding_sha256,
                model_revision,
                sample_count + 1,
                now,
                context.device_id,
                context.epoch_id,
                speaker_id,
            ),
        )
        updated = connection.execute(
            """SELECT * FROM vnext_voiceprint_profiles
                 WHERE device_id = ? AND epoch_id = ? AND speaker_id = ?""",
            (context.device_id, context.epoch_id, speaker_id),
        ).fetchone()
        connection.commit()
    assert updated is not None
    return _profile_public(updated)


def list_profiles(context: SpeakerOwnerContext) -> list[dict[str, Any]]:
    ensure_vnext_speaker_schema()
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT * FROM vnext_voiceprint_profiles
                 WHERE device_id = ? AND epoch_id = ? AND status != 'revoked'
                 ORDER BY created_at, speaker_id""",
            (context.device_id, context.epoch_id),
        ).fetchall()
    return [_profile_public(row) for row in rows]


def revoke_profile(context: SpeakerOwnerContext, speaker_id: str) -> bool:
    ensure_vnext_speaker_schema()
    speaker_id = _safe(speaker_id, "speaker_id", 180)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        cursor = connection.execute(
            """UPDATE vnext_voiceprint_profiles
                  SET profile_revision = profile_revision + 1, status = 'revoked',
                      encrypted_display_name = NULL, display_name_sha256 = NULL,
                      encrypted_embedding = NULL, embedding_sha256 = NULL,
                      embedding_model_revision = NULL, sample_count = 0,
                      updated_at = ?, revoked_at = ?
                WHERE device_id = ? AND epoch_id = ? AND speaker_id = ?
                  AND status != 'revoked'""",
            (now, now, context.device_id, context.epoch_id, speaker_id),
        )
        connection.commit()
        return cursor.rowcount == 1


def _profile_manifest_in_transaction(
    connection: Any,
    context: SpeakerOwnerContext,
) -> str:
    rows = connection.execute(
        """SELECT speaker_id, profile_revision, display_name_sha256,
                  embedding_sha256, embedding_model_revision
             FROM vnext_voiceprint_profiles
            WHERE device_id = ? AND epoch_id = ? AND status = 'active'
              AND encrypted_embedding IS NOT NULL
            ORDER BY speaker_id""",
        (context.device_id, context.epoch_id),
    ).fetchall()
    return _canonical_sha256([
        {
            "speaker_id": str(row["speaker_id"]),
            "profile_revision": int(row["profile_revision"]),
            "display_name_sha256": row["display_name_sha256"],
            "embedding_sha256": row["embedding_sha256"],
            "model_revision": row["embedding_model_revision"],
        }
        for row in rows
    ])


def load_profiles_for_inference(context: SpeakerOwnerContext) -> list[dict[str, Any]]:
    ensure_vnext_speaker_schema()
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT * FROM vnext_voiceprint_profiles
                 WHERE device_id = ? AND epoch_id = ? AND status = 'active'
                   AND encrypted_embedding IS NOT NULL
                 ORDER BY speaker_id""",
            (context.device_id, context.epoch_id),
        ).fetchall()
    profiles: list[dict[str, Any]] = []
    for row in rows:
        embedding = _decode_embedding(row)
        if embedding is None:
            continue
        profiles.append({
            "speaker_id": str(row["speaker_id"]),
            "name": _decode_name(row),
            "profile_revision": int(row["profile_revision"]),
            "embedding": embedding,
        })
    return profiles


def collect_speaker_segment(
    context: SpeakerOwnerContext,
    session_id: str,
    *,
    stable_segment_key: str,
    source_start_ms: int,
    source_end_ms: int,
    byte_size: int,
    content_sha256: str,
    encrypted_spool_locator: str,
    worker_generation: str,
) -> dict[str, Any]:
    ensure_vnext_speaker_schema()
    session_id = _safe(session_id, "session_id", 180)
    stable_segment_key = _safe(stable_segment_key, "stable_segment_key", 180)
    content_sha256 = _sha256(content_sha256)
    encrypted_spool_locator = _safe(encrypted_spool_locator, "encrypted_spool_locator", 180)
    worker_generation = _safe(worker_generation, "worker_generation", 32)
    if not isinstance(byte_size, int) or not 1 <= byte_size <= MAX_SEGMENT_BYTES:
        raise VNextSpeakerError("SPEAKER_AUDIO_INVALID", "讲话人音频片段无效", 422)
    if (
        not isinstance(source_start_ms, int)
        or not isinstance(source_end_ms, int)
        or source_start_ms < 0
        or source_end_ms < source_start_ms
    ):
        raise VNextSpeakerError("SPEAKER_RANGE_INVALID", "讲话人音频范围无效", 422)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session = connection.execute(
            """SELECT * FROM vnext_realtime_asr_sessions
                 WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
            (session_id, context.device_id, context.epoch_id),
        ).fetchone()
        if session is None:
            connection.rollback()
            raise VNextSpeakerError("REALTIME_SESSION_NOT_FOUND", "实时转写会话不存在", 404)
        if session["worker_generation"] != worker_generation:
            connection.rollback()
            raise VNextSpeakerError("REALTIME_WORKER_FENCED", "实时转写连接已被接替", 409)
        event = connection.execute(
            """SELECT source_start_ms, source_end_ms, outcome
                 FROM vnext_realtime_event_ledger
                WHERE session_id = ? AND stable_segment_key = ? AND event_kind = 'stable'
                ORDER BY event_seq DESC LIMIT 1""",
            (session_id, stable_segment_key),
        ).fetchone()
        if (
            event is None
            or event["outcome"] != "text"
            or int(event["source_start_ms"]) != source_start_ms
            or int(event["source_end_ms"]) != source_end_ms
        ):
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_SOURCE_MISMATCH", "讲话人片段不属于当前文字记录", 409)
        run = connection.execute(
            "SELECT * FROM vnext_speaker_runs WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if run is None:
            connection.execute(
                """INSERT INTO vnext_speaker_runs(
                     session_id, source_task_id, device_id, epoch_id, binding_id, binding_generation,
                     binding_revision, cancel_revision, asset_generation,
                     state, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'collecting', ?, ?)""",
                (
                    session_id,
                    session["task_id"],
                    context.device_id,
                    context.epoch_id,
                    session["binding_id"],
                    session["binding_generation"],
                    int(session["binding_revision"]),
                    int(session["cancel_revision"]),
                    session["asset_generation"],
                    now,
                    now,
                ),
            )
        elif run["state"] not in {"collecting", "queued", "running"}:
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_RUN_TERMINAL", "讲话人处理已结束", 409)
        existing = connection.execute(
            """SELECT * FROM vnext_speaker_inputs
                 WHERE session_id = ? AND stable_segment_key = ?""",
            (session_id, stable_segment_key),
        ).fetchone()
        if existing is not None:
            same = (
                int(existing["source_start_ms"]) == source_start_ms
                and int(existing["source_end_ms"]) == source_end_ms
                and int(existing["byte_size"]) == byte_size
                and existing["content_sha256"] == content_sha256
                and existing["encrypted_spool_locator"] == encrypted_spool_locator
            )
            connection.commit()
            if not same:
                raise VNextSpeakerError("SPEAKER_SEGMENT_REPLAY_CONFLICT", "讲话人片段重放不一致", 409)
            return {"session_id": session_id, "stable_segment_key": stable_segment_key, "reused": True}
        count = int(connection.execute(
            "SELECT COUNT(*) FROM vnext_speaker_inputs WHERE session_id = ?",
            (session_id,),
        ).fetchone()[0])
        if count >= MAX_SESSION_SEGMENTS:
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_SEGMENT_LIMIT", "讲话人片段数量过多", 413)
        connection.execute(
            """INSERT INTO vnext_speaker_inputs(
                 session_id, stable_segment_key, source_start_ms, source_end_ms,
                 byte_size, content_sha256, encrypted_spool_locator, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                session_id,
                stable_segment_key,
                source_start_ms,
                source_end_ms,
                byte_size,
                content_sha256,
                encrypted_spool_locator,
                now,
            ),
        )
        connection.execute(
            "UPDATE vnext_speaker_runs SET updated_at = ? WHERE session_id = ?",
            (now, session_id),
        )
        connection.commit()
    return {"session_id": session_id, "stable_segment_key": stable_segment_key, "reused": False}


def create_import_speaker_run(
    context: SpeakerOwnerContext,
    *,
    speaker_run_id: str,
    source_task_id: str,
    asset_generation: str,
) -> dict[str, Any]:
    ensure_vnext_speaker_schema()
    speaker_run_id = _safe(speaker_run_id, "speaker_run_id", 180)
    source_task_id = _safe(source_task_id, "source_task_id", 512)
    asset_generation = _safe(asset_generation, "asset_generation", 180)
    now = utc_now()
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        task = connection.execute(
            """SELECT task.*, binding.binding_revision, binding.cancel_revision,
                      binding.state AS binding_state
                 FROM vnext_tasks task
                 JOIN vnext_bindings binding
                   ON binding.device_id = task.device_id AND binding.epoch_id = task.epoch_id
                  AND binding.binding_id = task.binding_id
                WHERE task.task_id = ? AND task.device_id = ? AND task.epoch_id = ?""",
            (source_task_id, context.device_id, context.epoch_id),
        ).fetchone()
        if task is None or task["capability"] != "transcript":
            connection.rollback()
            raise VNextSpeakerError("TRANSCRIPT_TASK_NOT_FOUND", "转写任务不存在", 404)
        if task["binding_state"] != "active":
            connection.rollback()
            raise VNextSpeakerError("BINDING_PURGING", "会议服务连接正在清理", 409)
        existing = connection.execute(
            "SELECT * FROM vnext_speaker_runs WHERE session_id = ?",
            (speaker_run_id,),
        ).fetchone()
        if existing is not None:
            same = (
                existing["device_id"] == context.device_id
                and existing["epoch_id"] == context.epoch_id
                and existing["source_task_id"] == source_task_id
                and existing["asset_generation"] == asset_generation
            )
            connection.commit()
            if not same:
                raise VNextSpeakerError("SPEAKER_RUN_CONFLICT", "讲话人任务标识已被使用", 409)
            return dict(existing)
        connection.execute(
            """INSERT INTO vnext_speaker_runs(
                 session_id, source_task_id, device_id, epoch_id, binding_id,
                 binding_generation, binding_revision, cancel_revision,
                 asset_generation, state, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'collecting', ?, ?)""",
            (
                speaker_run_id,
                source_task_id,
                context.device_id,
                context.epoch_id,
                task["binding_id"],
                task["binding_generation"],
                int(task["binding_revision"]),
                int(task["cancel_revision"]),
                asset_generation,
                now,
                now,
            ),
        )
        row = connection.execute(
            "SELECT * FROM vnext_speaker_runs WHERE session_id = ?",
            (speaker_run_id,),
        ).fetchone()
        connection.commit()
    assert row is not None
    return dict(row)


def collect_import_speaker_segment(
    context: SpeakerOwnerContext,
    speaker_run_id: str,
    *,
    stable_segment_key: str,
    source_start_ms: int,
    source_end_ms: int,
    pcm_bytes: bytes,
) -> dict[str, Any]:
    ensure_vnext_speaker_schema()
    speaker_run_id = _safe(speaker_run_id, "speaker_run_id", 180)
    stable_segment_key = _safe(stable_segment_key, "stable_segment_key", 180)
    if not isinstance(pcm_bytes, bytes) or not 1 <= len(pcm_bytes) <= MAX_SEGMENT_BYTES:
        raise VNextSpeakerError("SPEAKER_AUDIO_INVALID", "讲话人音频片段无效", 422)
    content_sha256 = "sha256:" + hashlib.sha256(pcm_bytes).hexdigest()
    locator = vnext_speaker_crypto.seal_segment(
        device_id=context.device_id,
        epoch_id=context.epoch_id,
        session_id=speaker_run_id,
        stable_segment_key=stable_segment_key,
        content_sha256=content_sha256,
        pcm_bytes=pcm_bytes,
    )
    now = utc_now()
    try:
        with control_connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute(
                """SELECT * FROM vnext_speaker_runs
                     WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
                (speaker_run_id, context.device_id, context.epoch_id),
            ).fetchone()
            if run is None:
                connection.rollback()
                raise VNextSpeakerError("SPEAKER_RUN_NOT_FOUND", "讲话人处理不存在", 404)
            if run["state"] != "collecting":
                connection.rollback()
                raise VNextSpeakerError("SPEAKER_RUN_TERMINAL", "讲话人处理已结束", 409)
            existing = connection.execute(
                """SELECT * FROM vnext_speaker_inputs
                     WHERE session_id = ? AND stable_segment_key = ?""",
                (speaker_run_id, stable_segment_key),
            ).fetchone()
            if existing is not None:
                same = (
                    int(existing["source_start_ms"]) == int(source_start_ms)
                    and int(existing["source_end_ms"]) == int(source_end_ms)
                    and existing["content_sha256"] == content_sha256
                    and existing["encrypted_spool_locator"] == locator
                )
                connection.commit()
                if not same:
                    raise VNextSpeakerError("SPEAKER_SEGMENT_REPLAY_CONFLICT", "讲话人片段重放不一致", 409)
                return {"stable_segment_key": stable_segment_key, "reused": True}
            connection.execute(
                """INSERT INTO vnext_speaker_inputs(
                     session_id, stable_segment_key, source_start_ms, source_end_ms,
                     byte_size, content_sha256, encrypted_spool_locator, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    speaker_run_id,
                    stable_segment_key,
                    int(source_start_ms),
                    int(source_end_ms),
                    len(pcm_bytes),
                    content_sha256,
                    locator,
                    now,
                ),
            )
            connection.execute(
                "UPDATE vnext_speaker_runs SET updated_at = ? WHERE session_id = ?",
                (now, speaker_run_id),
            )
            connection.commit()
    except Exception:
        if not is_spool_locator_referenced(locator):
            vnext_speaker_crypto.delete_segment(locator)
        raise
    return {"stable_segment_key": stable_segment_key, "reused": False}


def _source_segments_in_transaction(connection: Any, session_id: str) -> list[dict[str, Any]]:
    rows = connection.execute(
        """SELECT stable_segment_key, source_start_ms, source_end_ms, content_sha256
             FROM vnext_speaker_inputs
            WHERE session_id = ?
            ORDER BY source_start_ms, source_end_ms, stable_segment_key""",
        (session_id,),
    ).fetchall()
    return [
        {
            "stable_segment_key": str(row["stable_segment_key"]),
            "source_start_ms": int(row["source_start_ms"]),
            "source_end_ms": int(row["source_end_ms"]),
            "audio_sha256": str(row["content_sha256"]),
        }
        for row in rows
    ]


def _insert_overlay_in_transaction(
    connection: Any,
    *,
    session_id: str,
    source_manifest_sha256: str,
    profile_manifest_sha256: str,
    model_revision: str,
    assignments: list[dict[str, Any]],
) -> tuple[int, str]:
    current = connection.execute(
        "SELECT overlay_revision FROM vnext_speaker_runs WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    if current is None:
        raise VNextSpeakerError("SPEAKER_RUN_NOT_FOUND", "讲话人处理不存在", 404)
    overlay_revision = int(current["overlay_revision"]) + 1
    canonical = json.dumps(
        assignments,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    output_sha256 = "sha256:" + hashlib.sha256(canonical).hexdigest()
    encrypted = vnext_speaker_crypto.seal_payload(
        _overlay_identity(session_id, overlay_revision),
        canonical,
    )
    now = utc_now()
    connection.execute(
        """UPDATE vnext_speaker_overlay_revisions SET status = 'archived'
             WHERE session_id = ? AND status = 'active'""",
        (session_id,),
    )
    connection.execute(
        """INSERT INTO vnext_speaker_overlay_revisions(
             session_id, overlay_revision, source_manifest_sha256,
             profile_manifest_sha256, model_revision, output_sha256,
             encrypted_payload, status, created_at, activated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)""",
        (
            session_id,
            overlay_revision,
            source_manifest_sha256,
            profile_manifest_sha256,
            model_revision,
            output_sha256,
            encrypted,
            now,
            now,
        ),
    )
    return overlay_revision, output_sha256


def finalize_speaker_run(
    context: SpeakerOwnerContext,
    session_id: str,
    *,
    model_revision: str,
) -> dict[str, Any]:
    ensure_vnext_speaker_schema()
    session_id = _safe(session_id, "session_id", 180)
    model_revision = _safe(model_revision, "model_revision", 180)
    cleanup_locators: list[str] = []
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        run = connection.execute(
            """SELECT * FROM vnext_speaker_runs
                 WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
            (session_id, context.device_id, context.epoch_id),
        ).fetchone()
        now = utc_now()
        if run is None:
            session = connection.execute(
                """SELECT * FROM vnext_realtime_asr_sessions
                     WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
                (session_id, context.device_id, context.epoch_id),
            ).fetchone()
            if session is None:
                connection.rollback()
                raise VNextSpeakerError("SPEAKER_RUN_NOT_FOUND", "讲话人处理不存在", 404)
            connection.execute(
                """INSERT INTO vnext_speaker_runs(
                     session_id, source_task_id, device_id, epoch_id, binding_id, binding_generation,
                     binding_revision, cancel_revision, asset_generation,
                     state, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'collecting', ?, ?)""",
                (
                    session_id,
                    session["task_id"],
                    context.device_id,
                    context.epoch_id,
                    session["binding_id"],
                    session["binding_generation"],
                    int(session["binding_revision"]),
                    int(session["cancel_revision"]),
                    session["asset_generation"],
                    now,
                    now,
                ),
            )
            run = connection.execute(
                "SELECT * FROM vnext_speaker_runs WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        assert run is not None
        source_task = connection.execute(
            """SELECT state FROM vnext_tasks
                 WHERE task_id = ? AND device_id = ? AND epoch_id = ?""",
            (run["source_task_id"], context.device_id, context.epoch_id),
        ).fetchone()
        if source_task is None or source_task["state"] != "success":
            connection.rollback()
            raise VNextSpeakerError("TRANSCRIPT_NOT_FINAL", "文字记录尚未完成", 409)
        binding = connection.execute(
            """SELECT * FROM vnext_bindings
                 WHERE device_id = ? AND epoch_id = ? AND binding_id = ?""",
            (context.device_id, context.epoch_id, run["binding_id"]),
        ).fetchone()
        if (
            binding is None
            or binding["state"] != "active"
            or binding["binding_generation"] != run["binding_generation"]
            or int(binding["binding_revision"]) != int(run["binding_revision"])
            or int(binding["cancel_revision"]) != int(run["cancel_revision"])
        ):
            connection.rollback()
            raise VNextSpeakerError("BINDING_REVISION_CHANGED", "会议服务连接版本已变化", 409)
        if run["state"] in {"succeeded", "no_content"}:
            connection.commit()
            return {
                "session_id": session_id,
                "state": str(run["state"]),
                "task_id": run["task_id"],
                "reused": True,
            }
        segments = _source_segments_in_transaction(connection, session_id)
        source_manifest_sha256 = _canonical_sha256(segments)
        profile_manifest_sha256 = _profile_manifest_in_transaction(connection, context)
        if not segments:
            overlay_revision, output_sha256 = _insert_overlay_in_transaction(
                connection,
                session_id=session_id,
                source_manifest_sha256=source_manifest_sha256,
                profile_manifest_sha256=profile_manifest_sha256,
                model_revision="no-speaker-inference",
                assignments=[],
            )
            cleanup_locators = [
                str(row["encrypted_spool_locator"])
                for row in connection.execute(
                    "SELECT encrypted_spool_locator FROM vnext_speaker_inputs WHERE session_id = ?",
                    (session_id,),
                ).fetchall()
            ]
            connection.execute("DELETE FROM vnext_speaker_inputs WHERE session_id = ?", (session_id,))
            connection.execute(
                """UPDATE vnext_speaker_runs
                      SET source_manifest_sha256 = ?, profile_manifest_sha256 = ?,
                          model_revision = ?, state = 'no_content', overlay_revision = ?,
                          error_code = NULL, updated_at = ?, terminal_at = ?
                    WHERE session_id = ?""",
                (
                    source_manifest_sha256,
                    profile_manifest_sha256,
                    "no-speaker-inference",
                    overlay_revision,
                    now,
                    now,
                    session_id,
                ),
            )
            connection.commit()
            result = {
                "session_id": session_id,
                "state": "no_content",
                "task_id": None,
                "overlay_revision": overlay_revision,
                "output_sha256": output_sha256,
                "reused": False,
            }
        else:
            task_material = {
                "session_id": session_id,
                "source_manifest_sha256": source_manifest_sha256,
                "profile_manifest_sha256": profile_manifest_sha256,
                "model_revision": model_revision,
            }
            input_sha256 = _canonical_sha256(task_material)
            suffix = hashlib.sha256(input_sha256.encode("ascii")).hexdigest()[:24]
            task_id = f"speaker:{session_id}:{suffix}"
            generation_id = f"speaker-generation:{suffix}"
            _task, _reused = vnext_task_store.create_task_in_transaction(
                connection,
                context,
                task_id=task_id,
                binding_id=str(run["binding_id"]),
                binding_generation=str(run["binding_generation"]),
                capability="speaker.overlay.v2",
                entity_id=session_id,
                entity_revision=1,
                input_sha256=input_sha256,
                generation_id=generation_id,
            )
            connection.execute(
                """UPDATE vnext_speaker_runs
                      SET task_id = ?, source_manifest_sha256 = ?,
                          profile_manifest_sha256 = ?, model_revision = ?,
                          state = 'queued', error_code = NULL, updated_at = ?, terminal_at = NULL
                    WHERE session_id = ?""",
                (
                    task_id,
                    source_manifest_sha256,
                    profile_manifest_sha256,
                    model_revision,
                    now,
                    session_id,
                ),
            )
            connection.commit()
            result = {
                "session_id": session_id,
                "state": "queued",
                "task_id": task_id,
                "reused": bool(_reused),
            }
    for locator in cleanup_locators:
        vnext_speaker_crypto.delete_segment(locator)
    return result


def list_ready_runs(limit: int = 32) -> list[dict[str, Any]]:
    ensure_vnext_speaker_schema()
    bounded = max(1, min(128, int(limit)))
    with control_connection() as connection:
        rows = connection.execute(
            """SELECT run.* FROM vnext_speaker_runs run
                 JOIN vnext_tasks task ON task.task_id = run.task_id
                WHERE run.state IN ('queued','running') AND task.state = 'active'
                ORDER BY CASE run.state WHEN 'queued' THEN 0 ELSE 1 END,
                         run.updated_at, run.session_id
                LIMIT ?""",
            (bounded,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_run_work(context: SpeakerOwnerContext, session_id: str) -> dict[str, Any]:
    ensure_vnext_speaker_schema()
    session_id = _safe(session_id, "session_id", 180)
    with control_connection() as connection:
        run = connection.execute(
            """SELECT * FROM vnext_speaker_runs
                 WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
            (session_id, context.device_id, context.epoch_id),
        ).fetchone()
        if run is None:
            raise VNextSpeakerError("SPEAKER_RUN_NOT_FOUND", "讲话人处理不存在", 404)
        source_segments = _source_segments_in_transaction(connection, session_id)
        inputs = connection.execute(
            """SELECT * FROM vnext_speaker_inputs
                 WHERE session_id = ? ORDER BY source_start_ms, source_end_ms, stable_segment_key""",
            (session_id,),
        ).fetchall()
        profile_manifest = _profile_manifest_in_transaction(connection, context)
    return {
        "run": dict(run),
        "source_segments": source_segments,
        "inputs": [dict(row) for row in inputs],
        "profile_manifest_sha256": profile_manifest,
    }


def mark_run_running(context: SpeakerOwnerContext, session_id: str, task_id: str) -> bool:
    ensure_vnext_speaker_schema()
    now = utc_now()
    with control_connection() as connection:
        cursor = connection.execute(
            """UPDATE vnext_speaker_runs SET state = 'running', updated_at = ?
                 WHERE session_id = ? AND task_id = ? AND device_id = ? AND epoch_id = ?
                   AND state IN ('queued','running')""",
            (now, session_id, task_id, context.device_id, context.epoch_id),
        )
        connection.commit()
        return cursor.rowcount == 1


def replace_task_after_profile_change(
    context: SpeakerOwnerContext,
    session_id: str,
    *,
    task_id: str,
    attempt_id: str,
    lease_owner: str,
) -> dict[str, Any]:
    """Fence one stale profile snapshot and create its deterministic successor."""
    ensure_vnext_speaker_schema()
    session_id = _safe(session_id, "session_id", 180)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        run = connection.execute(
            """SELECT * FROM vnext_speaker_runs
                 WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
            (session_id, context.device_id, context.epoch_id),
        ).fetchone()
        if run is None or run["task_id"] != task_id:
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_WORKER_FENCED", "讲话人任务已被接替", 409)
        source_manifest = _canonical_sha256(
            _source_segments_in_transaction(connection, session_id)
        )
        profile_manifest = _profile_manifest_in_transaction(connection, context)
        if (
            source_manifest == run["source_manifest_sha256"]
            and profile_manifest == run["profile_manifest_sha256"]
        ):
            connection.commit()
            return {"task_id": task_id, "replaced": False}
        marked = vnext_task_store.mark_failure_in_transaction(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            error_code="SPEAKER_PROFILE_CHANGED",
            retryable=False,
            lease_owner=lease_owner,
        )
        if not marked:
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_WORKER_FENCED", "讲话人任务已被接替", 409)
        material = {
            "session_id": session_id,
            "source_manifest_sha256": source_manifest,
            "profile_manifest_sha256": profile_manifest,
            "model_revision": str(run["model_revision"] or "campplus-zh-v1"),
        }
        input_sha256 = _canonical_sha256(material)
        suffix = hashlib.sha256(input_sha256.encode("ascii")).hexdigest()[:24]
        successor_task_id = f"speaker:{session_id}:{suffix}"
        successor, reused = vnext_task_store.create_task_in_transaction(
            connection,
            context,
            task_id=successor_task_id,
            binding_id=str(run["binding_id"]),
            binding_generation=str(run["binding_generation"]),
            capability="speaker.overlay.v2",
            entity_id=session_id,
            entity_revision=1,
            input_sha256=input_sha256,
            generation_id=f"speaker-generation:{suffix}",
            predecessor_task_id=task_id,
            creation_reason="retry",
        )
        now = utc_now()
        connection.execute(
            """UPDATE vnext_speaker_runs
                  SET task_id = ?, source_manifest_sha256 = ?,
                      profile_manifest_sha256 = ?, state = 'queued',
                      error_code = NULL, updated_at = ?, terminal_at = NULL
                WHERE session_id = ? AND task_id = ?""",
            (
                successor_task_id,
                source_manifest,
                profile_manifest,
                now,
                session_id,
                task_id,
            ),
        )
        connection.commit()
    return {
        "task_id": successor_task_id,
        "replaced": True,
        "reused": reused,
        "task": successor,
    }


def commit_overlay(
    context: SpeakerOwnerContext,
    session_id: str,
    *,
    task_id: str,
    attempt_id: str,
    lease_owner: str,
    source_manifest_sha256: str,
    profile_manifest_sha256: str,
    model_revision: str,
    assignments: list[dict[str, Any]],
) -> dict[str, Any]:
    ensure_vnext_speaker_schema()
    session_id = _safe(session_id, "session_id", 180)
    source_manifest_sha256 = _sha256(source_manifest_sha256, "source_manifest_sha256")
    profile_manifest_sha256 = _sha256(profile_manifest_sha256, "profile_manifest_sha256")
    model_revision = _safe(model_revision, "model_revision", 180)
    cleanup_locators: list[str] = []
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        run = connection.execute(
            """SELECT * FROM vnext_speaker_runs
                 WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
            (session_id, context.device_id, context.epoch_id),
        ).fetchone()
        if (
            run is None
            or run["task_id"] != task_id
            or run["state"] not in {"queued", "running"}
        ):
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_WORKER_FENCED", "讲话人任务已被接替", 409)
        current_source_manifest = _canonical_sha256(
            _source_segments_in_transaction(connection, session_id)
        )
        current_profile_manifest = _profile_manifest_in_transaction(connection, context)
        if current_source_manifest != source_manifest_sha256:
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_SOURCE_CHANGED", "文字记录来源已变化", 409)
        if current_profile_manifest != profile_manifest_sha256:
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_PROFILE_CHANGED", "讲话人档案已变化", 409)
        overlay_revision, output_sha256 = _insert_overlay_in_transaction(
            connection,
            session_id=session_id,
            source_manifest_sha256=source_manifest_sha256,
            profile_manifest_sha256=profile_manifest_sha256,
            model_revision=model_revision,
            assignments=assignments,
        )
        completed = vnext_task_store.mark_success_in_transaction(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            result={
                "kind": "speaker_overlay",
                "session_id": session_id,
                "overlay_revision": overlay_revision,
                "output_sha256": output_sha256,
            },
            result_kind="artifact",
            lease_owner=lease_owner,
        )
        if not completed:
            connection.rollback()
            raise VNextSpeakerError("SPEAKER_WORKER_FENCED", "讲话人任务已被接替", 409)
        cleanup_locators = [
            str(row["encrypted_spool_locator"])
            for row in connection.execute(
                "SELECT encrypted_spool_locator FROM vnext_speaker_inputs WHERE session_id = ?",
                (session_id,),
            ).fetchall()
        ]
        connection.execute("DELETE FROM vnext_speaker_inputs WHERE session_id = ?", (session_id,))
        now = utc_now()
        connection.execute(
            """UPDATE vnext_speaker_runs
                  SET state = 'succeeded', overlay_revision = ?, model_revision = ?,
                      error_code = NULL, updated_at = ?, terminal_at = ?
                WHERE session_id = ? AND task_id = ?""",
            (overlay_revision, model_revision, now, now, session_id, task_id),
        )
        connection.commit()
    for locator in cleanup_locators:
        vnext_speaker_crypto.delete_segment(locator)
    return {
        "session_id": session_id,
        "state": "succeeded",
        "overlay_revision": overlay_revision,
        "output_sha256": output_sha256,
    }


def mark_run_failure(
    context: SpeakerOwnerContext,
    session_id: str,
    *,
    task_id: str,
    attempt_id: str,
    lease_owner: str,
    error_code: str,
    retryable: bool,
) -> bool:
    ensure_vnext_speaker_schema()
    code = _safe(error_code, "error_code", 160)
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        marked = vnext_task_store.mark_failure_in_transaction(
            connection,
            context,
            task_id=task_id,
            attempt_id=attempt_id,
            error_code=code,
            retryable=retryable,
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
            """UPDATE vnext_speaker_runs
                  SET state = ?, error_code = ?, updated_at = ?,
                      terminal_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
                WHERE session_id = ? AND task_id = ? AND device_id = ? AND epoch_id = ?""",
            (
                next_state,
                code,
                now,
                next_state,
                now,
                session_id,
                task_id,
                context.device_id,
                context.epoch_id,
            ),
        )
        connection.commit()
        return True


def get_overlay_snapshot(
    context: SpeakerOwnerContext,
    session_id: str,
) -> dict[str, Any] | None:
    ensure_vnext_speaker_schema()
    session_id = _safe(session_id, "session_id", 180)
    with control_connection() as connection:
        run = connection.execute(
            """SELECT * FROM vnext_speaker_runs
                 WHERE session_id = ? AND device_id = ? AND epoch_id = ?""",
            (session_id, context.device_id, context.epoch_id),
        ).fetchone()
        if run is None:
            return None
        overlay = connection.execute(
            """SELECT * FROM vnext_speaker_overlay_revisions
                 WHERE session_id = ? AND status = 'active'""",
            (session_id,),
        ).fetchone()
        active_profiles = {
            str(row["speaker_id"]): int(row["profile_revision"])
            for row in connection.execute(
                """SELECT speaker_id, profile_revision FROM vnext_voiceprint_profiles
                     WHERE device_id = ? AND epoch_id = ? AND status = 'active'
                       AND encrypted_embedding IS NOT NULL""",
                (context.device_id, context.epoch_id),
            ).fetchall()
        }
    assignments: list[dict[str, Any]] = []
    overlay_payload: dict[str, Any] | None = None
    if overlay is not None:
        plaintext = vnext_speaker_crypto.open_payload(
            _overlay_identity(session_id, int(overlay["overlay_revision"])),
            bytes(overlay["encrypted_payload"]),
        )
        decoded = json.loads(plaintext.decode("utf-8"))
        for raw in decoded:
            assignment = dict(raw)
            profile_id = assignment.get("speaker_profile_id")
            profile_revision = assignment.get("profile_revision")
            if profile_id is not None and active_profiles.get(str(profile_id)) != profile_revision:
                assignment["speaker_profile_id"] = None
                assignment["profile_revision"] = None
                assignment["automatic_label"] = assignment.get("anonymous_label")
                assignment["confidence"] = None
            assignment.pop("anonymous_label", None)
            assignment.pop("profile_revision", None)
            assignments.append(assignment)
        overlay_payload = {
            "overlay_revision": int(overlay["overlay_revision"]),
            "source_manifest_sha256": str(overlay["source_manifest_sha256"]),
            "profile_manifest_sha256": str(overlay["profile_manifest_sha256"]),
            "model_revision": str(overlay["model_revision"]),
            "output_sha256": str(overlay["output_sha256"]),
            "activated_at": overlay["activated_at"],
            "assignments": assignments,
        }
    return {
        "schema_version": 2,
        "contract_revision": "speaker.overlay.v2",
        "session_id": session_id,
        "state": str(run["state"]),
        "task_id": run["task_id"],
        "error_code": run["error_code"],
        "overlay": overlay_payload,
    }


def referenced_spool_locators() -> set[str]:
    ensure_vnext_speaker_schema()
    with control_connection() as connection:
        rows = connection.execute(
            "SELECT encrypted_spool_locator FROM vnext_speaker_inputs"
        ).fetchall()
    return {str(row["encrypted_spool_locator"]) for row in rows}


def is_spool_locator_referenced(locator: str) -> bool:
    ensure_vnext_speaker_schema()
    with control_connection() as connection:
        row = connection.execute(
            "SELECT 1 FROM vnext_speaker_inputs WHERE encrypted_spool_locator = ? LIMIT 1",
            (str(locator),),
        ).fetchone()
    return row is not None


def cleanup_expired_speaker_payloads(
    *,
    now_epoch: int | None = None,
) -> dict[str, int]:
    ensure_vnext_speaker_schema()
    now_value = int(time.time()) if now_epoch is None else int(now_epoch)
    cutoff = now_value - SPEAKER_PAYLOAD_TTL_SECONDS
    cleanup_locators: list[str] = []
    expired_runs = 0
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            """SELECT run.session_id, input.encrypted_spool_locator
                 FROM vnext_speaker_runs run
                 LEFT JOIN vnext_speaker_inputs input ON input.session_id = run.session_id
                WHERE run.state IN ('collecting','queued','running','failed','cancelled')
                  AND CAST(strftime('%s', run.updated_at) AS INTEGER) <= ?""",
            (cutoff,),
        ).fetchall()
        session_ids = sorted({str(row["session_id"]) for row in rows})
        cleanup_locators = [
            str(row["encrypted_spool_locator"])
            for row in rows
            if row["encrypted_spool_locator"] is not None
        ]
        if session_ids:
            placeholders = ",".join("?" for _ in session_ids)
            connection.execute(
                f"DELETE FROM vnext_speaker_inputs WHERE session_id IN ({placeholders})",
                session_ids,
            )
            now = utc_now()
            connection.execute(
                f"""UPDATE vnext_speaker_runs
                       SET state = 'failed', error_code = 'SPEAKER_PAYLOAD_EXPIRED',
                           updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
                     WHERE session_id IN ({placeholders})
                       AND state IN ('collecting','queued','running')""",
                [now, now, *session_ids],
            )
            expired_runs = len(session_ids)
        connection.commit()
    for locator in cleanup_locators:
        vnext_speaker_crypto.delete_segment(locator)
    orphan = vnext_speaker_crypto.delete_orphan_segments(
        referenced_spool_locators(),
        older_than_epoch=cutoff,
    )
    return {
        "expired_runs": expired_runs,
        "released_segments": len(cleanup_locators),
        "orphan_files": orphan["files"],
        "orphan_bytes": orphan["bytes"],
    }


def purge_scope(
    context: SpeakerOwnerContext,
    *,
    binding_id: str | None = None,
) -> list[str]:
    ensure_vnext_speaker_schema()
    values: list[Any] = [context.device_id, context.epoch_id]
    clause = "device_id = ? AND epoch_id = ?"
    if binding_id is not None:
        clause += " AND binding_id = ?"
        values.append(_safe(binding_id, "binding_id", 180))
    with control_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            f"""SELECT input.encrypted_spool_locator
                  FROM vnext_speaker_inputs input
                  JOIN vnext_speaker_runs run ON run.session_id = input.session_id
                 WHERE {clause}""",
            values,
        ).fetchall()
        connection.execute(f"DELETE FROM vnext_speaker_runs WHERE {clause}", values)
        if binding_id is None:
            connection.execute(
                "DELETE FROM vnext_voiceprint_profiles WHERE device_id = ? AND epoch_id = ?",
                (context.device_id, context.epoch_id),
            )
        connection.commit()
    locators = [str(row["encrypted_spool_locator"]) for row in rows]
    for locator in locators:
        vnext_speaker_crypto.delete_segment(locator)
    return locators


def purge_scope_in_transaction(
    connection: Any,
    *,
    device_id: str,
    epoch_id: str,
    binding_id: str | None = None,
    binding_generation: str | None = None,
) -> int:
    """Remove DB references inside the purge owner's transaction.

    Encrypted files become unreferenced and are deleted immediately after the
    transaction by ``cleanup_orphaned_after_purge``. A crash leaves only opaque
    ciphertext for the normal orphan sweep.
    """
    device_id = _safe(device_id, "device_id", 180)
    epoch_id = _safe(epoch_id, "epoch_id", 180)
    values: list[Any] = [device_id, epoch_id]
    clause = "device_id = ? AND epoch_id = ?"
    if binding_id is not None:
        clause += " AND binding_id = ?"
        values.append(_safe(binding_id, "binding_id", 180))
    if binding_generation is not None:
        clause += " AND binding_generation = ?"
        values.append(_safe(binding_generation, "binding_generation", 256))
    count = int(connection.execute(
        f"SELECT COUNT(*) FROM vnext_speaker_inputs input JOIN vnext_speaker_runs run "
        f"ON run.session_id = input.session_id WHERE {clause}",
        values,
    ).fetchone()[0])
    connection.execute(f"DELETE FROM vnext_speaker_runs WHERE {clause}", values)
    if binding_id is None:
        connection.execute(
            "DELETE FROM vnext_voiceprint_profiles WHERE device_id = ? AND epoch_id = ?",
            (device_id, epoch_id),
        )
    return count


def cleanup_orphaned_after_purge() -> dict[str, int]:
    return vnext_speaker_crypto.delete_orphan_segments(
        referenced_spool_locators(),
        older_than_epoch=time.time() + 1,
    )
