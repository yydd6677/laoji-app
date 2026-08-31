"""Device-primary identity and data-epoch storage.

The mobile application has no account session.  A device credential scopes
service jobs and a rotating data epoch scopes the user's local data lifetime.
This module deliberately uses a small SQLite control table; the public API
never exposes ``user_id`` semantics.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import uuid
from typing import Any

from sqlalchemy.engine import make_url

from app.config import settings


_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
_SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{43,64}$")
_SCHEMA_LOCK = __import__("threading").Lock()
_SCHEMA_READY: set[Path] = set()


class _ClosingConnection(sqlite3.Connection):
    """Commit/rollback like sqlite3's context manager, then release its FDs."""

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
        try:
            return bool(super().__exit__(exc_type, exc_value, traceback))
        finally:
            self.close()


class DeviceIdentityError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 401):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class DeviceContext:
    principal_id: int
    device_id: str
    epoch_id: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _database_path() -> Path:
    url = make_url(settings.DATABASE_URL)
    if not url.drivername.startswith("sqlite") or not url.database:
        raise RuntimeError("device_identity_requires_sqlite")
    return Path(url.database).expanduser().resolve()


def _connect() -> sqlite3.Connection:
    path = _database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30, factory=_ClosingConnection)
    connection.row_factory = sqlite3.Row
    # WAL is enabled once by ensure_device_schema.  Reissuing the pragma on
    # every authenticated request can itself take a SQLite write lock.
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=10000")
    return connection


def control_connection() -> sqlite3.Connection:
    """Return a configured connection for the device control store.

    Device routers must use this public helper rather than reaching into this
    module's private globals.  The caller owns and closes the connection.
    """
    ensure_device_schema()
    return _connect()


def utc_now() -> str:
    """Return the canonical UTC timestamp used by control rows."""
    return _now()


def ensure_device_schema() -> None:
    """Create the additive device control schema and the meeting epoch column."""
    path = _database_path()
    with _SCHEMA_LOCK:
        if path in _SCHEMA_READY:
            return
        with _connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS device_principals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL UNIQUE,
                    credential_hash TEXT NOT NULL,
                    credential_version INTEGER NOT NULL DEFAULT 1,
                    current_epoch_id TEXT,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    revoked_at TEXT
                );
                CREATE TABLE IF NOT EXISTS device_epochs (
                    epoch_id TEXT PRIMARY KEY,
                    principal_id INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','closing','deleted')),
                    created_at TEXT NOT NULL,
                    closed_at TEXT,
                    FOREIGN KEY(principal_id) REFERENCES device_principals(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_device_epochs_principal
                    ON device_epochs(principal_id, status, created_at);
                CREATE TABLE IF NOT EXISTS device_idempotency (
                    principal_id INTEGER NOT NULL,
                    epoch_id TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    request_hash TEXT NOT NULL,
                    status_code INTEGER NOT NULL,
                    response_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(principal_id, epoch_id, idempotency_key)
                );
                CREATE TABLE IF NOT EXISTS device_meeting_tombstones (
                    principal_id INTEGER NOT NULL,
                    epoch_id TEXT NOT NULL,
                    binding_id TEXT NOT NULL,
                    deleted_at TEXT NOT NULL,
                    PRIMARY KEY(principal_id, epoch_id, binding_id)
                );
                CREATE TABLE IF NOT EXISTS device_delete_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    principal_id INTEGER NOT NULL,
                    epoch_id TEXT NOT NULL,
                    binding_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','completed')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    completed_at TEXT,
                    UNIQUE(principal_id, epoch_id, binding_id)
                );
                CREATE INDEX IF NOT EXISTS idx_device_delete_outbox_pending
                    ON device_delete_outbox(status, created_at);
                CREATE TABLE IF NOT EXISTS device_transient_inputs (
                    id TEXT PRIMARY KEY,
                    principal_id INTEGER NOT NULL,
                    epoch_id TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    payload_ciphertext BLOB NOT NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    consumed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_device_transient_inputs_expiry
                    ON device_transient_inputs(expires_at, consumed_at);
                CREATE TABLE IF NOT EXISTS device_quality_candidates (
                    id TEXT PRIMARY KEY,
                    principal_id INTEGER NOT NULL,
                    epoch_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    meeting_id TEXT,
                    request_hash TEXT,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_device_quality_candidates_epoch
                    ON device_quality_candidates(principal_id, epoch_id, expires_at);
                CREATE TABLE IF NOT EXISTS device_speaker_cleanup_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    principal_id INTEGER NOT NULL,
                    epoch_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','completed')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error_code TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    UNIQUE(principal_id, epoch_id)
                );
                CREATE INDEX IF NOT EXISTS idx_device_speaker_cleanup_pending
                    ON device_speaker_cleanup_outbox(status, updated_at, id);
                """
            )
            # The control store is also used by isolated capability/identity
            # probes before the domain ORM has created its tables. Do not
            # manufacture a partial meetings table here, and do not make the
            # device schema unusable just because the optional domain table is
            # absent. The normal API lifespan creates meetings first, so the
            # additive epoch column/index is applied on that path.
            meetings_exists = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meetings'"
            ).fetchone() is not None
            if meetings_exists:
                columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(meetings)").fetchall()
                }
                if "data_epoch_id" not in columns:
                    connection.execute(
                        "ALTER TABLE meetings ADD COLUMN data_epoch_id TEXT"
                    )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS idx_meetings_device_epoch "
                    "ON meetings(user_id, data_epoch_id, updated_at)"
                )
            # Existing compact-production tables predate device epochs.  Add
            # nullable columns so old rows remain readable while every new
            # device-owned object can be filtered by its epoch.  SQLite has
            # no portable conditional ALTER, therefore table existence is
            # checked before touching each optional table.
            epoch_tables = {
                "meeting_recording_assets_v2": "idx_recording_assets_v2_epoch",
                "meeting_recording_asset_operations_v2": "idx_recording_asset_ops_v2_epoch",
                "meeting_recording_transcription_jobs_v2": "idx_recording_jobs_v2_epoch",
                "meeting_question_threads": "idx_question_threads_epoch",
                "meeting_summary_versions_v1": "idx_summary_versions_v1_epoch",
                "meeting_summary_section_states_v1": "idx_summary_sections_v1_epoch",
                "meeting_summary_current_v1": "idx_summary_current_v1_epoch",
                "meeting_summary_operations_v1": "idx_summary_operations_v1_epoch",
            }
            for table, index_name in epoch_tables.items():
                exists = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                    (table,),
                ).fetchone()
                if exists is None:
                    continue
                table_columns = {
                    str(row[1])
                    for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
                }
                if "data_epoch_id" not in table_columns:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN data_epoch_id TEXT")
                connection.execute(
                    f"CREATE INDEX IF NOT EXISTS {index_name} "
                    f"ON {table}(data_epoch_id, user_id)"
                )
            quality_columns = {
                str(row[1])
                for row in connection.execute(
                    "PRAGMA table_info(device_quality_candidates)"
                ).fetchall()
            }
            for column, ddl in {
                "meeting_id": "TEXT",
                "request_hash": "TEXT",
            }.items():
                if column not in quality_columns:
                    connection.execute(
                        f"ALTER TABLE device_quality_candidates ADD COLUMN {column} {ddl}"
                    )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_device_quality_candidates_request "
                "ON device_quality_candidates(principal_id, epoch_id, kind, meeting_id, request_hash)"
            )
            connection.commit()
        _SCHEMA_READY.add(path)


def _pepper() -> bytes:
    raw = os.getenv("LAOJI_DEVICE_CREDENTIAL_PEPPER", "").strip()
    if not raw:
        raw = settings.SECRET_KEY
    return raw.encode("utf-8")


def credential_hash(device_id: str, secret: str) -> str:
    return hmac.new(
        _pepper(),
        f"device:{device_id}:{secret}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def valid_uuid(value: str) -> bool:
    return bool(_UUID_RE.fullmatch(value.strip()))


def valid_secret(value: str) -> bool:
    normalized = value.strip()
    if not _SECRET_RE.fullmatch(normalized):
        return False
    try:
        decoded = base64.urlsafe_b64decode(normalized + "=" * (-len(normalized) % 4))
    except Exception:
        return False
    return len(decoded) == 32


def bootstrap_allowed(value: str | None) -> bool:
    presented = (value or "").strip()
    configured = os.getenv("LAOJI_DEVICE_BOOTSTRAP_KEY", "").strip()
    # Legacy deployment fallback only. The client admission value is embedded
    # in the APK and therefore extractable; using a secret that protects any
    # other capability here is unsafe. Remove this fallback with the v1 caller
    # migration rather than treating admission as device authentication.
    if not configured:
        configured = os.getenv("LAOJI_ACTION_SHARE_SECRET", "").strip()
    if not configured and settings.ENV.strip().lower() != "production":
        configured = "development-bootstrap"
    return bool(configured and presented and secrets.compare_digest(configured, presented))


def register_device(device_id: str, secret: str, epoch_id: str) -> dict[str, Any]:
    ensure_device_schema()
    device_id = device_id.strip().lower()
    epoch_id = epoch_id.strip().lower()
    if not valid_uuid(device_id) or not valid_uuid(epoch_id) or not valid_secret(secret):
        raise DeviceIdentityError("DEVICE_IDENTITY_INVALID", "设备身份参数无效", 422)
    now = _now()
    digest = credential_hash(device_id, secret)
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM device_principals WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        if row is None:
            cursor = connection.execute(
                """INSERT INTO device_principals
                   (device_id, credential_hash, credential_version, current_epoch_id,
                    created_at, last_seen_at)
                   VALUES (?, ?, 1, ?, ?, ?)""",
                (device_id, digest, epoch_id, now, now),
            )
            principal_id = int(cursor.lastrowid)
        else:
            if row["revoked_at"] is not None:
                raise DeviceIdentityError("DEVICE_REVOKED", "设备服务身份已失效，请重新注册", 409)
            if not secrets.compare_digest(str(row["credential_hash"]), digest):
                raise DeviceIdentityError("DEVICE_IDENTITY_CONFLICT", "设备身份校验失败", 409)
            principal_id = int(row["id"])
            connection.execute(
                "UPDATE device_principals SET last_seen_at = ? WHERE id = ?",
                (now, principal_id),
            )
        epoch = connection.execute(
            "SELECT status, principal_id FROM device_epochs WHERE epoch_id = ?",
            (epoch_id,),
        ).fetchone()
        if epoch is not None:
            if int(epoch["principal_id"]) != principal_id or epoch["status"] != "active":
                raise DeviceIdentityError("EPOCH_CLOSED", "本机数据域已关闭，请创建新的数据域", 409)
        else:
            connection.execute(
                "INSERT INTO device_epochs(epoch_id, principal_id, status, created_at) "
                "VALUES (?, ?, 'active', ?)",
                (epoch_id, principal_id, now),
            )
        connection.execute(
            "UPDATE device_principals SET current_epoch_id = ?, last_seen_at = ? WHERE id = ?",
            (epoch_id, now, principal_id),
        )
        connection.commit()
    return {
        "schema_version": 1,
        "device_id": device_id,
        "epoch_id": epoch_id,
        "credential_version": 1,
        "registered": True,
    }


def authenticate(device_id: str, secret: str, epoch_id: str) -> DeviceContext:
    ensure_device_schema()
    device_id = device_id.strip().lower()
    epoch_id = epoch_id.strip().lower()
    if not valid_uuid(device_id) or not valid_uuid(epoch_id) or not valid_secret(secret):
        raise DeviceIdentityError("DEVICE_CREDENTIAL_INVALID", "设备服务凭据无效", 401)
    digest = credential_hash(device_id, secret)
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, credential_hash, revoked_at FROM device_principals WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        if row is None or row["revoked_at"] is not None or not secrets.compare_digest(
            str(row["credential_hash"]), digest
        ):
            raise DeviceIdentityError("DEVICE_CREDENTIAL_INVALID", "设备服务凭据无效", 401)
        epoch = connection.execute(
            "SELECT status, principal_id FROM device_epochs WHERE epoch_id = ?",
            (epoch_id,),
        ).fetchone()
        if epoch is None or int(epoch["principal_id"]) != int(row["id"]):
            raise DeviceIdentityError("EPOCH_UNKNOWN", "本机数据域不存在", 409)
        if epoch["status"] != "active":
            raise DeviceIdentityError("EPOCH_CLOSED", "本机数据域已关闭", 409)
        # Authentication is deliberately read-only.  Updating last_seen_at on
        # every upload chunk/transcript poll makes concurrent device requests
        # contend on the control SQLite writer lock and can stall WebSockets.
        # Registration and explicit lifecycle operations still refresh the
        # timestamp.
    return DeviceContext(int(row["id"]), device_id, epoch_id)


def close_epoch(context: DeviceContext, epoch_id: str) -> dict[str, Any]:
    """Close an epoch and delete all service-owned meeting data atomically.

    Existing model tables use ``user_id`` internally.  The public contract
    only ever exposes device/epoch identifiers.
    """
    ensure_device_schema()
    target = epoch_id.strip().lower()
    if not valid_uuid(target):
        raise DeviceIdentityError("EPOCH_INVALID", "本机数据域无效", 422)
    now = _now()
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        epoch = connection.execute(
            "SELECT status, principal_id FROM device_epochs WHERE epoch_id = ?",
            (target,),
        ).fetchone()
        if epoch is None or int(epoch["principal_id"]) != context.principal_id:
            raise DeviceIdentityError("EPOCH_UNKNOWN", "本机数据域不存在", 404)
        connection.execute(
            "UPDATE device_epochs SET status = 'closing', closed_at = ? WHERE epoch_id = ?",
            (now, target),
        )
        # Speaker profiles live in a separate SQLite database. Record a
        # durable cleanup intent before closing the epoch so a transient
        # speaker-database lock or process failure cannot leave embeddings
        # behind permanently.
        connection.execute(
            """INSERT OR IGNORE INTO device_speaker_cleanup_outbox
               (principal_id, epoch_id, status, attempts, created_at, updated_at)
               VALUES (?, ?, 'pending', 0, ?, ?)""",
            (context.principal_id, target, now, now),
        )
        meeting_count = connection.execute(
            "SELECT COUNT(*) FROM meetings WHERE user_id = ? AND data_epoch_id = ?",
            (context.principal_id, target),
        ).fetchone()[0]
        # A few legacy child tables use NO ACTION rather than CASCADE.  Remove
        # those rows explicitly before deleting the meeting; all other device
        # children retain their existing database cascades.
        for table in (
            "transcript_lines",
            "meeting_recording_transcript_drafts_v1",
            "meeting_segments",
            "period_summaries",
            "final_summaries",
        ):
            exists = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                (table,),
            ).fetchone()
            if exists is not None:
                connection.execute(
                    f"DELETE FROM {table} WHERE meeting_id IN (SELECT id FROM meetings WHERE user_id = ? AND data_epoch_id = ?)",
                    (context.principal_id, target),
                )
        connection.execute(
            "DELETE FROM meetings WHERE user_id = ? AND data_epoch_id = ?",
            (context.principal_id, target),
        )
        connection.execute(
            "DELETE FROM device_idempotency WHERE principal_id = ? AND epoch_id = ?",
            (context.principal_id, target),
        )
        connection.execute(
            "DELETE FROM device_meeting_tombstones WHERE principal_id = ? AND epoch_id = ?",
            (context.principal_id, target),
        )
        connection.execute(
            "DELETE FROM device_delete_outbox WHERE principal_id = ? AND epoch_id = ?",
            (context.principal_id, target),
        )
        connection.execute(
            "DELETE FROM device_transient_inputs WHERE principal_id = ? AND epoch_id = ?",
            (context.principal_id, target),
        )
        connection.execute(
            "DELETE FROM device_quality_candidates WHERE principal_id = ? AND epoch_id = ?",
            (context.principal_id, target),
        )
        connection.execute(
            "UPDATE device_epochs SET status = 'deleted', closed_at = ? WHERE epoch_id = ?",
            (now, target),
        )
        if target == context.epoch_id:
            connection.execute(
                "UPDATE device_principals SET current_epoch_id = NULL WHERE id = ?",
                (context.principal_id,),
            )
        connection.commit()
    speaker_cleaned, speaker_cleanup_failed = drain_speaker_cleanup_outbox(limit=1)
    speaker_count = speaker_cleaned
    speaker_cleanup_pending = speaker_cleanup_failed > 0 or speaker_cleanup_pending_for(
        context.principal_id,
        target,
    )
    return {
        "schema_version": 1,
        "epoch_id": target,
        "deleted": True,
        "meeting_count": int(meeting_count),
        "speaker_count": int(speaker_count),
        "speaker_cleanup_pending": bool(speaker_cleanup_pending),
    }


def speaker_cleanup_pending_for(principal_id: int, epoch_id: str) -> bool:
    """Return whether a closed epoch still has speaker cleanup to drain."""
    ensure_device_schema()
    with _connect() as connection:
        row = connection.execute(
            """SELECT 1 FROM device_speaker_cleanup_outbox
               WHERE principal_id = ? AND epoch_id = ? AND status = 'pending'
               LIMIT 1""",
            (int(principal_id), str(epoch_id)),
        ).fetchone()
    return row is not None


def drain_speaker_cleanup_outbox(limit: int = 8) -> tuple[int, int]:
    """Physically remove closed-epoch speaker profiles and embeddings.

    This is intentionally idempotent: a second drain after a successful
    deletion simply observes zero profiles and marks the intent complete.
    The retention loop calls it again after process/database failures.
    """
    ensure_device_schema()
    bounded_limit = max(1, min(32, int(limit)))
    with _connect() as connection:
        rows = connection.execute(
            """SELECT principal_id, epoch_id, created_at
               FROM device_speaker_cleanup_outbox
               WHERE status = 'pending'
               ORDER BY updated_at, id
               LIMIT ?""",
            (bounded_limit,),
        ).fetchall()
    cleaned = 0
    failed = 0
    for row in rows:
        principal_id = int(row["principal_id"])
        epoch_id = str(row["epoch_id"])
        created_at = str(row["created_at"])
        try:
            from app.services.speaker_db_service import get_speaker_db

            get_speaker_db().delete_owner_epoch(principal_id, epoch_id)
        except Exception as error:
            failed += 1
            with _connect() as connection:
                connection.execute(
                    """UPDATE device_speaker_cleanup_outbox
                       SET attempts = attempts + 1,
                           last_error_code = ?,
                           updated_at = ?
                       WHERE principal_id = ? AND epoch_id = ?
                         AND status = 'pending' AND created_at = ?""",
                    (
                        type(error).__name__[:96],
                        _now(),
                        principal_id,
                        epoch_id,
                        created_at,
                    ),
                )
                connection.commit()
            continue
        with _connect() as connection:
            cursor = connection.execute(
                """UPDATE device_speaker_cleanup_outbox
                   SET status = 'completed', completed_at = ?, updated_at = ?,
                       last_error_code = NULL
                   WHERE principal_id = ? AND epoch_id = ?
                     AND status = 'pending' AND created_at = ?""",
                (_now(), _now(), principal_id, epoch_id, created_at),
            )
            connection.commit()
            if cursor.rowcount == 1:
                cleaned += 1
    return cleaned, failed


def activate_epoch(context: DeviceContext, epoch_id: str) -> dict[str, Any]:
    """Create or select an active epoch for an authenticated device."""
    ensure_device_schema()
    target = epoch_id.strip().lower()
    if not valid_uuid(target):
        raise DeviceIdentityError("EPOCH_INVALID", "本机数据域无效", 422)
    now = _now()
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT principal_id, status FROM device_epochs WHERE epoch_id = ?",
            (target,),
        ).fetchone()
        if row is None:
            connection.execute(
                "INSERT INTO device_epochs(epoch_id, principal_id, status, created_at) "
                "VALUES (?, ?, 'active', ?)",
                (target, context.principal_id, now),
            )
        elif int(row["principal_id"]) != context.principal_id or row["status"] != "active":
            raise DeviceIdentityError("EPOCH_CLOSED", "本机数据域已关闭", 409)
        connection.execute(
            "UPDATE device_principals SET current_epoch_id = ?, last_seen_at = ? WHERE id = ?",
            (target, now, context.principal_id),
        )
        connection.commit()
    return {"schema_version": 1, "epoch_id": target, "status": "active"}


def record_meeting_tombstone(context: DeviceContext, binding_id: str) -> None:
    """Record a device-scoped delete marker without exposing user IDs."""
    target = binding_id.strip().lower()
    if not valid_uuid(target):
        raise DeviceIdentityError("BINDING_INVALID", "会议服务标识无效", 422)
    with _connect() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO device_meeting_tombstones "
            "(principal_id, epoch_id, binding_id, deleted_at) VALUES (?, ?, ?, ?)",
            (context.principal_id, context.epoch_id, target, _now()),
        )
        connection.execute(
            "INSERT OR IGNORE INTO device_delete_outbox "
            "(principal_id, epoch_id, binding_id, status, attempts, created_at) "
            "VALUES (?, ?, ?, 'pending', 0, ?)",
            (context.principal_id, context.epoch_id, target, _now()),
        )
        connection.commit()


def complete_meeting_delete(context: DeviceContext, binding_id: str) -> None:
    """Mark the device delete outbox item complete after service cleanup.

    The current compact deployment performs the database cascade in the
    request itself.  Keeping an explicit outbox row makes later file/object
    cleanup retryable without resurrecting a meeting.
    """
    target = binding_id.strip().lower()
    with _connect() as connection:
        connection.execute(
            "UPDATE device_delete_outbox SET status = 'completed', attempts = attempts + 1, completed_at = ? "
            "WHERE principal_id = ? AND epoch_id = ? AND binding_id = ?",
            (_now(), context.principal_id, context.epoch_id, target),
        )
        connection.commit()


def store_quality_candidate(
    context: DeviceContext,
    *,
    kind: str,
    meeting_id: str | None,
    request_hash: str | None,
    payload: dict[str, Any],
    ttl_seconds: int,
) -> str:
    """Persist an anonymous generated result only after explicit opt-in.

    The payload is intentionally caller-shaped and must not contain names,
    source transcript text, coordinates, or raw audio.  This table is the only
    durable device-quality store; it is purged by the regular retention loop.
    """
    ensure_device_schema()
    now = datetime.now(timezone.utc)
    result_id = str(uuid.uuid4())
    expires = now.timestamp() + max(1, int(ttl_seconds))
    expires_at = datetime.fromtimestamp(expires, timezone.utc).isoformat()
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO device_quality_candidates (
                id, principal_id, epoch_id, kind, meeting_id, request_hash,
                payload_json, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                result_id,
                context.principal_id,
                context.epoch_id,
                str(kind).strip()[:80],
                meeting_id,
                request_hash,
                encoded,
                now.isoformat(),
                expires_at,
            ),
        )
        connection.commit()
    return result_id


def find_quality_candidate(
    context: DeviceContext,
    *,
    kind: str,
    meeting_id: str | None,
    request_hash: str | None,
) -> dict[str, Any] | None:
    """Find an opted-in anonymous result for an idempotent request."""
    ensure_device_schema()
    with _connect() as connection:
        row = connection.execute(
            """
            SELECT payload_json, expires_at FROM device_quality_candidates
            WHERE principal_id = ? AND epoch_id = ? AND kind = ?
              AND meeting_id IS ? AND request_hash IS ?
              AND expires_at >= ?
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """,
            (
                context.principal_id,
                context.epoch_id,
                str(kind).strip()[:80],
                meeting_id,
                request_hash,
                _now(),
            ),
        ).fetchone()
    if row is None:
        return None
    try:
        decoded = json.loads(str(row["payload_json"]))
    except (TypeError, json.JSONDecodeError):
        return None
    return decoded if isinstance(decoded, dict) else None


def purge_expired_device_data(now: str | None = None) -> int:
    """Remove old control rows; meeting result retention is epoch-driven."""
    ensure_device_schema()
    # Keep this bounded and called by the existing retention worker.
    with _connect() as connection:
        cutoff = now or _now()
        cursor = connection.execute(
            "DELETE FROM device_transient_inputs WHERE expires_at < ?",
            (cutoff,),
        )
        quality_cursor = connection.execute(
            "DELETE FROM device_quality_candidates WHERE expires_at < ?",
            (cutoff,),
        )
        connection.execute(
            "DELETE FROM device_delete_outbox WHERE status = 'completed' AND completed_at < ?",
            (cutoff,),
        )
        connection.execute(
            "DELETE FROM device_speaker_cleanup_outbox "
            "WHERE status = 'completed' AND completed_at < ?",
            (cutoff,),
        )
        connection.commit()
        deleted_count = (
            int(cursor.rowcount)
            + int(quality_cursor.rowcount)
        )
    speaker_cleaned, _speaker_failed = drain_speaker_cleanup_outbox()
    return deleted_count + speaker_cleaned


def parse_bearer(value: str | None) -> tuple[str, str]:
    raw = (value or "").strip()
    if not raw.lower().startswith("bearer dv1."):
        raise DeviceIdentityError("DEVICE_AUTH_REQUIRED", "请先建立设备服务连接", 401)
    token = raw[len("Bearer "):].strip()
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "dv1":
        raise DeviceIdentityError("DEVICE_CREDENTIAL_INVALID", "设备服务凭据无效", 401)
    return parts[1], parts[2]
