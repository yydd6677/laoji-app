"""
老记最小账号服务
================
使用 SQLite 保存用户和服务端 token。密码使用 PBKDF2-HMAC-SHA256 哈希，
token 只保存 SHA256 摘要，避免明文 token 落库。
"""

import base64
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional


PBKDF2_ITERATIONS = 240_000
SESSION_DAYS = 30
DELETION_LEASE_MINUTES = 30
ACCOUNT_DELETION_PENDING_RETENTION_DAYS = 90
ACCOUNT_DELETION_PROCESSING_LEASE_HOURS = 24
PASSWORD_RESET_PENDING_RETENTION_DAYS = 30
PASSWORD_RESET_HANDLED_RETENTION_DAYS = 30
AUTH_RATE_LIMIT_RETENTION_HOURS = 48
_ACCOUNT_RE = re.compile(r"^[^\s]{3,120}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE_RE = re.compile(r"^\+?[0-9][0-9\s-]{5,24}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_DEFAULT_AVATAR_COLORS = ["#9268E0", "#6A38B2"]

_local = threading.local()
_logger = logging.getLogger(__name__)


class AccountWriteBlocked(ValueError):
    """A write arrived after irreversible account deletion had started."""


class AccountDeletionInProgress(ValueError):
    """Another deletion operation currently owns the account lease."""


def _get_default_db_path() -> str:
    configured = os.getenv("LAOJI_DB_PATH", "").strip()
    if configured:
        path = Path(configured).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return str(path)
    backend_dir = Path(__file__).resolve().parent.parent.parent
    db_dir = backend_dir / "data"
    db_dir.mkdir(exist_ok=True)
    return str(db_dir / "schedule.db")


def _get_avatar_dir() -> Path:
    configured = os.getenv("LAOJI_AVATAR_DIR", "").strip()
    path = Path(configured).expanduser() if configured else Path(_get_default_db_path()).parent / "laoji-avatars"
    path = path.resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _get_conn() -> sqlite3.Connection:
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(_get_default_db_path(), check_same_thread=False, timeout=10.0)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA foreign_keys=ON")
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA busy_timeout=10000")
    return _local.conn


def close_auth_db() -> None:
    """Close the current thread's connection (used by tests and graceful reloads)."""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _parse_iso(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.fromtimestamp(0, tz=timezone.utc)


def _normalize_account(account: str) -> str:
    return re.sub(r"\s+", "", account.strip()).lower()


def _split_account(account: str) -> tuple[Optional[str], Optional[str]]:
    if _EMAIL_RE.match(account):
        return account, None
    if _PHONE_RE.match(account):
        return None, account
    return None, None


def _hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


_DUMMY_PASSWORD_HASH = _hash_password(
    "laoji-dummy-password-for-timing",
    salt=b"\x00" * 16,
)


def _verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt_b64, digest_b64 = stored.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_b64.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_b64.encode("ascii"))
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def init_auth_db() -> None:
    conn = _get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS laoji_users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            account       TEXT    NOT NULL UNIQUE,
            email         TEXT,
            phone         TEXT,
            nickname      TEXT    NOT NULL,
            password_hash TEXT    NOT NULL,
            deletion_started_at TEXT,
            deletion_lease_expires_at TEXT,
            deletion_revoked_sessions INTEGER NOT NULL DEFAULT 0,
            deletion_operation_id TEXT,
            created_at    TEXT    NOT NULL,
            updated_at    TEXT    NOT NULL
        )
    """)
    user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(laoji_users)")}
    if "avatar_filename" not in user_columns:
        conn.execute("ALTER TABLE laoji_users ADD COLUMN avatar_filename TEXT")
    if "avatar_colors" not in user_columns:
        conn.execute("ALTER TABLE laoji_users ADD COLUMN avatar_colors TEXT")
    if "deletion_started_at" not in user_columns:
        conn.execute("ALTER TABLE laoji_users ADD COLUMN deletion_started_at TEXT")
    if "deletion_lease_expires_at" not in user_columns:
        conn.execute("ALTER TABLE laoji_users ADD COLUMN deletion_lease_expires_at TEXT")
    if "deletion_revoked_sessions" not in user_columns:
        conn.execute(
            "ALTER TABLE laoji_users "
            "ADD COLUMN deletion_revoked_sessions INTEGER NOT NULL DEFAULT 0"
        )
    if "deletion_operation_id" not in user_columns:
        conn.execute("ALTER TABLE laoji_users ADD COLUMN deletion_operation_id TEXT")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS laoji_sessions (
            token_hash    TEXT    PRIMARY KEY,
            user_id       INTEGER NOT NULL,
            expires_at    TEXT    NOT NULL,
            created_at    TEXT    NOT NULL,
            last_seen_at  TEXT    NOT NULL,
            FOREIGN KEY(user_id) REFERENCES laoji_users(id) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS laoji_password_reset_requests (
            request_id    TEXT PRIMARY KEY,
            user_id       INTEGER,
            account       TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'pending',
            created_at    TEXT NOT NULL,
            handled_at    TEXT,
            FOREIGN KEY(user_id) REFERENCES laoji_users(id) ON DELETE SET NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS laoji_auth_rate_limits (
            scope             TEXT    NOT NULL,
            key_hash          TEXT    NOT NULL,
            window_started_at TEXT    NOT NULL,
            hit_count         INTEGER NOT NULL,
            updated_at        TEXT    NOT NULL,
            PRIMARY KEY(scope, key_hash)
        )
    """)
    conn.execute("DELETE FROM laoji_password_reset_requests WHERE user_id IS NULL")
    conn.execute(
        """
        DELETE FROM laoji_password_reset_requests
        WHERE status = 'pending' AND user_id IS NOT NULL
          AND rowid NOT IN (
              SELECT MAX(rowid) FROM laoji_password_reset_requests
              WHERE status = 'pending' AND user_id IS NOT NULL
              GROUP BY user_id
          )
        """
    )
    conn.execute("""
        CREATE TABLE IF NOT EXISTS laoji_account_deletion_requests (
            request_id    TEXT PRIMARY KEY,
            user_id       INTEGER,
            account       TEXT,
            contact       TEXT,
            reason        TEXT,
            status        TEXT NOT NULL DEFAULT 'pending',
            created_at    TEXT NOT NULL,
            handled_at    TEXT,
            processing_started_at TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error    TEXT,
            FOREIGN KEY(user_id) REFERENCES laoji_users(id) ON DELETE SET NULL
        )
    """)
    deletion_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(laoji_account_deletion_requests)")
    }
    if "processing_started_at" not in deletion_columns:
        conn.execute(
            "ALTER TABLE laoji_account_deletion_requests ADD COLUMN processing_started_at TEXT"
        )
    if "attempt_count" not in deletion_columns:
        conn.execute(
            "ALTER TABLE laoji_account_deletion_requests "
            "ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0"
        )
    if "last_error" not in deletion_columns:
        conn.execute("ALTER TABLE laoji_account_deletion_requests ADD COLUMN last_error TEXT")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS laoji_file_deletion_queue (
            path          TEXT PRIMARY KEY,
            created_at    TEXT NOT NULL,
            last_error    TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_laoji_sessions_user_id ON laoji_sessions(user_id)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_laoji_password_resets_status "
        "ON laoji_password_reset_requests(status, created_at)"
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_laoji_password_reset_pending_user
        ON laoji_password_reset_requests(user_id)
        WHERE status = 'pending' AND user_id IS NOT NULL
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_laoji_auth_rate_limits_updated "
        "ON laoji_auth_rate_limits(updated_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_laoji_account_deletions_status "
        "ON laoji_account_deletion_requests(status, created_at)"
    )
    now = _utc_now()
    processing_cutoff = _iso(now - timedelta(hours=ACCOUNT_DELETION_PROCESSING_LEASE_HOURS))
    pending_cutoff = _iso(now - timedelta(days=ACCOUNT_DELETION_PENDING_RETENTION_DAYS))
    handled_cutoff = _iso(now - timedelta(days=30))
    reset_pending_cutoff = _iso(now - timedelta(days=PASSWORD_RESET_PENDING_RETENTION_DAYS))
    reset_handled_cutoff = _iso(now - timedelta(days=PASSWORD_RESET_HANDLED_RETENTION_DAYS))
    rate_limit_cutoff = _iso(now - timedelta(hours=AUTH_RATE_LIMIT_RETENTION_HOURS))
    conn.execute(
        """
        DELETE FROM laoji_password_reset_requests
        WHERE status = 'pending' AND created_at < ?
        """,
        (reset_pending_cutoff,),
    )
    conn.execute(
        """
        DELETE FROM laoji_password_reset_requests
        WHERE status IN ('completed', 'rejected')
          AND handled_at IS NOT NULL AND handled_at < ?
        """,
        (reset_handled_cutoff,),
    )
    conn.execute(
        "DELETE FROM laoji_auth_rate_limits WHERE updated_at < ?",
        (rate_limit_cutoff,),
    )
    conn.execute(
        """
        UPDATE laoji_account_deletion_requests
        SET status = 'pending', processing_started_at = NULL,
            last_error = '处理租约超过 24 小时，已自动恢复为待处理'
        WHERE status = 'processing'
          AND COALESCE(processing_started_at, created_at) < ?
        """,
        (processing_cutoff,),
    )
    conn.execute(
        """
        DELETE FROM laoji_account_deletion_requests
        WHERE status = 'pending' AND created_at < ?
        """,
        (pending_cutoff,),
    )
    conn.execute(
        """
        DELETE FROM laoji_account_deletion_requests
        WHERE status IN ('completed', 'rejected')
          AND handled_at IS NOT NULL AND handled_at < ?
        """,
        (handled_cutoff,),
    )
    conn.commit()
    _drain_file_deletion_queue(conn)


def _drain_file_deletion_queue(conn: sqlite3.Connection) -> None:
    """Retry avatar cleanup without ever deleting outside the managed directory."""
    avatar_dir = _get_avatar_dir().resolve()
    rows = conn.execute("SELECT path FROM laoji_file_deletion_queue").fetchall()
    for row in rows:
        stored_path = str(row["path"])
        path = Path(stored_path).expanduser().resolve(strict=False)
        try:
            path.relative_to(avatar_dir)
            if path == avatar_dir:
                raise ValueError("refusing to delete avatar root")
            path.unlink(missing_ok=True)
            conn.execute("DELETE FROM laoji_file_deletion_queue WHERE path = ?", (stored_path,))
        except Exception as exc:
            conn.execute(
                "UPDATE laoji_file_deletion_queue SET last_error = ? WHERE path = ?",
                (str(exc)[:500], stored_path),
            )
    conn.commit()


def user_to_public(row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Any]:
    data = dict(row)
    avatar_filename = data.get("avatar_filename")
    return {
        "id": data["id"],
        "account": data["account"],
        "nickname": data.get("nickname") or data["account"],
        "email": data.get("email"),
        "phone": data.get("phone"),
        "avatar_url": f"/api/auth/avatars/{avatar_filename}" if avatar_filename else None,
        "created_at": data["created_at"],
    }


def _deletion_lease_active(row: sqlite3.Row | Dict[str, Any]) -> bool:
    expires_at = dict(row).get("deletion_lease_expires_at")
    return bool(expires_at and _parse_iso(str(expires_at)) > _utc_now())


def _assert_account_accepts_writes(row: sqlite3.Row | Dict[str, Any]) -> None:
    data = dict(row)
    if data.get("deletion_started_at"):
        raise AccountWriteBlocked("账号正在删除，不能修改资料")


def _clear_stale_deletion_lease(conn: sqlite3.Connection, user_id: int) -> None:
    conn.execute(
        """
        UPDATE laoji_users
        SET deletion_started_at = NULL, deletion_lease_expires_at = NULL,
            deletion_revoked_sessions = 0, deletion_operation_id = NULL
        WHERE id = ?
        """,
        (user_id,),
    )
    conn.commit()


def profile_to_public(row: sqlite3.Row | Dict[str, Any]) -> Dict[str, Any]:
    data = dict(row)
    colors = _DEFAULT_AVATAR_COLORS
    try:
        parsed = json.loads(data.get("avatar_colors") or "null")
        if isinstance(parsed, list) and len(parsed) == 2 and all(_COLOR_RE.match(str(item)) for item in parsed):
            colors = [str(parsed[0]), str(parsed[1])]
    except (TypeError, ValueError, json.JSONDecodeError):
        pass
    avatar_filename = data.get("avatar_filename")
    return {
        "nickname": data.get("nickname") or data["account"],
        "email": data.get("email"),
        "phone": data.get("phone"),
        "avatar_initial": "",
        "avatar_colors": colors,
        "avatar_url": f"/api/auth/avatars/{avatar_filename}" if avatar_filename else None,
    }


def register_user(account: str, password: str, nickname: Optional[str] = None) -> Dict[str, Any]:
    init_auth_db()
    normalized = _normalize_account(account)
    if not _ACCOUNT_RE.match(normalized):
        raise ValueError("账号格式不正确")
    if len(password) < 8:
        raise ValueError("密码至少需要 8 位")

    email, phone = _split_account(normalized)
    now = _iso(_utc_now())
    display_name = (nickname or normalized.split("@", 1)[0]).strip()[:50] or "老记用户"
    conn = _get_conn()
    try:
        cur = conn.execute(
            """
            INSERT INTO laoji_users
                (account, email, phone, nickname, password_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (normalized, email, phone, display_name, _hash_password(password), now, now),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise ValueError("账号已存在") from exc

    user = get_user_by_id(int(cur.lastrowid))
    if user is None:
        raise RuntimeError("用户创建失败")
    return user


def authenticate_user(account: str, password: str) -> Optional[Dict[str, Any]]:
    init_auth_db()
    normalized = _normalize_account(account)
    conn = _get_conn()
    row = conn.execute("SELECT * FROM laoji_users WHERE account = ?", (normalized,)).fetchone()
    password_hash = row["password_hash"] if row is not None else _DUMMY_PASSWORD_HASH
    password_valid = _verify_password(password, password_hash)
    if row is None or not password_valid:
        return None
    if _deletion_lease_active(row):
        return None
    if row["deletion_started_at"]:
        _clear_stale_deletion_lease(conn, int(row["id"]))
        row = conn.execute("SELECT * FROM laoji_users WHERE id = ?", (int(row["id"]),)).fetchone()
        if row is None:
            return None
    return user_to_public(row)


def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    init_auth_db()
    row = _get_conn().execute("SELECT * FROM laoji_users WHERE id = ?", (user_id,)).fetchone()
    return user_to_public(row) if row else None


def create_session(user_id: int) -> Dict[str, Any]:
    init_auth_db()
    token = secrets.token_urlsafe(32)
    now = _utc_now()
    expires = now + timedelta(days=SESSION_DAYS)
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM laoji_users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise RuntimeError("用户不存在")
        _assert_account_accepts_writes(row)
        conn.execute(
            """
            INSERT INTO laoji_sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (_token_hash(token), user_id, _iso(expires), _iso(now), _iso(now)),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"access_token": token, "expires_at": _iso(expires), "user": user_to_public(row)}


def get_user_by_token(token: str) -> Optional[Dict[str, Any]]:
    init_auth_db()
    token = token.strip()
    if not token:
        return None
    conn = _get_conn()
    row = conn.execute(
        """
        SELECT s.token_hash, s.expires_at, u.*
        FROM laoji_sessions s
        JOIN laoji_users u ON u.id = s.user_id
        WHERE s.token_hash = ?
        """,
        (_token_hash(token),),
    ).fetchone()
    if row is None:
        return None
    if _deletion_lease_active(row):
        return None
    if row["deletion_started_at"]:
        _clear_stale_deletion_lease(conn, int(row["id"]))
        row = conn.execute(
            """
            SELECT s.token_hash, s.expires_at, u.*
            FROM laoji_sessions s
            JOIN laoji_users u ON u.id = s.user_id
            WHERE s.token_hash = ?
            """,
            (_token_hash(token),),
        ).fetchone()
        if row is None:
            return None
    if _parse_iso(row["expires_at"]) <= _utc_now():
        conn.execute("DELETE FROM laoji_sessions WHERE token_hash = ?", (row["token_hash"],))
        conn.commit()
        return None
    conn.execute(
        "UPDATE laoji_sessions SET last_seen_at = ? WHERE token_hash = ?",
        (_iso(_utc_now()), row["token_hash"]),
    )
    conn.commit()
    return user_to_public(row)


def refresh_session(token: str) -> Optional[Dict[str, Any]]:
    user = get_user_by_token(token)
    if user is None:
        return None
    revoke_session(token)
    return create_session(int(user["id"]))


def revoke_session(token: str) -> None:
    init_auth_db()
    _get_conn().execute("DELETE FROM laoji_sessions WHERE token_hash = ?", (_token_hash(token.strip()),))
    _get_conn().commit()


def revoke_user_sessions(user_id: int, keep_token: Optional[str] = None) -> None:
    init_auth_db()
    conn = _get_conn()
    if keep_token:
        conn.execute(
            "DELETE FROM laoji_sessions WHERE user_id = ? AND token_hash != ?",
            (user_id, _token_hash(keep_token.strip())),
        )
    else:
        conn.execute("DELETE FROM laoji_sessions WHERE user_id = ?", (user_id,))
    conn.commit()


def change_password(
    user_id: int,
    current_password: str,
    new_password: str,
    keep_token: Optional[str] = None,
) -> None:
    init_auth_db()
    if len(new_password) < 8:
        raise ValueError("新密码至少需要 8 位")
    if current_password == new_password:
        raise ValueError("新密码不能与当前密码相同")
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM laoji_users WHERE id = ?", (user_id,)).fetchone()
        if row is None or not _verify_password(current_password, row["password_hash"]):
            raise ValueError("当前密码错误")
        _assert_account_accepts_writes(row)
        now = _iso(_utc_now())
        conn.execute(
            "UPDATE laoji_users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (_hash_password(new_password), now, user_id),
        )
        if keep_token:
            conn.execute(
                "DELETE FROM laoji_sessions WHERE user_id = ? AND token_hash != ?",
                (user_id, _token_hash(keep_token.strip())),
            )
        else:
            conn.execute("DELETE FROM laoji_sessions WHERE user_id = ?", (user_id,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def create_password_reset_request(account: str) -> str:
    """Store a generic reset request without revealing whether the account exists."""
    init_auth_db()
    normalized = _normalize_account(account)
    if not _ACCOUNT_RE.match(normalized):
        raise ValueError("账号格式不正确")
    conn = _get_conn()
    request_id = secrets.token_urlsafe(12)
    duplicate_cutoff = _iso(_utc_now() - timedelta(hours=24))
    try:
        conn.execute("BEGIN IMMEDIATE")
        user = conn.execute("SELECT id FROM laoji_users WHERE account = ?", (normalized,)).fetchone()
        if user is None:
            conn.commit()
            return request_id
        existing = conn.execute(
            """
            SELECT request_id FROM laoji_password_reset_requests
            WHERE user_id = ? AND status = 'pending' AND created_at >= ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (int(user["id"]), duplicate_cutoff),
        ).fetchone()
        if existing is not None:
            conn.commit()
            return str(existing["request_id"])
        conn.execute(
            """
            INSERT INTO laoji_password_reset_requests
                (request_id, user_id, account, status, created_at)
            VALUES (?, ?, ?, 'pending', ?)
            """,
            (request_id, int(user["id"]), normalized, _iso(_utc_now())),
        )
        conn.commit()
        return request_id
    except Exception:
        conn.rollback()
        raise


def auth_rate_limit_account_key(account: str) -> str:
    return _normalize_account(account)


def consume_auth_rate_limit(
    scope: str,
    key: str,
    *,
    limit: int,
    window_seconds: int,
    now: Optional[datetime] = None,
) -> tuple[bool, int]:
    """Consume one fixed-window auth quota without storing raw IPs or accounts."""
    if limit < 1 or window_seconds < 1:
        raise ValueError("rate limit and window must be positive")
    init_auth_db()
    current = now or _utc_now()
    scope = scope.strip()[:80]
    if not scope:
        raise ValueError("rate limit scope is required")
    key_hash = hashlib.sha256(f"{scope}\0{key}".encode("utf-8")).hexdigest()
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT window_started_at, hit_count
            FROM laoji_auth_rate_limits
            WHERE scope = ? AND key_hash = ?
            """,
            (scope, key_hash),
        ).fetchone()
        started_at = _parse_iso(str(row["window_started_at"])) if row else current
        expired = row is None or (current - started_at).total_seconds() >= window_seconds
        if expired:
            conn.execute(
                """
                INSERT INTO laoji_auth_rate_limits
                    (scope, key_hash, window_started_at, hit_count, updated_at)
                VALUES (?, ?, ?, 1, ?)
                ON CONFLICT(scope, key_hash) DO UPDATE SET
                    window_started_at = excluded.window_started_at,
                    hit_count = 1,
                    updated_at = excluded.updated_at
                """,
                (scope, key_hash, _iso(current), _iso(current)),
            )
            conn.commit()
            return True, 0
        hit_count = int(row["hit_count"])
        if hit_count >= limit:
            retry_after = max(
                1,
                math.ceil(window_seconds - (current - started_at).total_seconds()),
            )
            conn.execute(
                """
                UPDATE laoji_auth_rate_limits SET updated_at = ?
                WHERE scope = ? AND key_hash = ?
                """,
                (_iso(current), scope, key_hash),
            )
            conn.commit()
            return False, retry_after
        conn.execute(
            """
            UPDATE laoji_auth_rate_limits
            SET hit_count = hit_count + 1, updated_at = ?
            WHERE scope = ? AND key_hash = ?
            """,
            (_iso(current), scope, key_hash),
        )
        conn.commit()
        return True, 0
    except Exception:
        conn.rollback()
        raise


def reset_auth_rate_limit(scope: str, key: str) -> None:
    init_auth_db()
    key_hash = hashlib.sha256(f"{scope.strip()[:80]}\0{key}".encode("utf-8")).hexdigest()
    conn = _get_conn()
    conn.execute(
        "DELETE FROM laoji_auth_rate_limits WHERE scope = ? AND key_hash = ?",
        (scope.strip()[:80], key_hash),
    )
    conn.commit()


def list_password_reset_requests(status: str = "pending", limit: int = 100) -> list[Dict[str, Any]]:
    init_auth_db()
    if status not in {"pending", "completed", "rejected", "all"}:
        raise ValueError("不支持的请求状态")
    limit = max(1, min(500, int(limit)))
    conn = _get_conn()
    if status == "all":
        rows = conn.execute(
            "SELECT * FROM laoji_password_reset_requests ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM laoji_password_reset_requests WHERE status = ? ORDER BY created_at LIMIT ?",
            (status, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def complete_password_reset_request(request_id: str, new_password: str) -> Dict[str, Any]:
    init_auth_db()
    if len(new_password) < 8:
        raise ValueError("新密码至少需要 8 位")
    request_id = request_id.strip()
    if not request_id:
        raise ValueError("重置请求 ID 不能为空")
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM laoji_password_reset_requests WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        if row is None:
            raise ValueError("重置请求不存在")
        if row["status"] != "pending":
            raise ValueError("重置请求已处理")
        if row["user_id"] is None:
            raise ValueError("重置请求未关联到有效账号")
        now = _iso(_utc_now())
        conn.execute(
            "UPDATE laoji_users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (_hash_password(new_password), now, int(row["user_id"])),
        )
        conn.execute("DELETE FROM laoji_sessions WHERE user_id = ?", (int(row["user_id"]),))
        conn.execute(
            "UPDATE laoji_password_reset_requests SET status = 'completed', handled_at = ? WHERE request_id = ?",
            (now, request_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {
        "request_id": request_id,
        "account": row["account"],
        "status": "completed",
        "handled_at": now,
    }


def reject_password_reset_request(request_id: str) -> Dict[str, Any]:
    init_auth_db()
    request_id = request_id.strip()
    conn = _get_conn()
    now = _iso(_utc_now())
    cur = conn.execute(
        """
        UPDATE laoji_password_reset_requests
        SET status = 'rejected', handled_at = ?
        WHERE request_id = ? AND status = 'pending'
        """,
        (now, request_id),
    )
    conn.commit()
    if cur.rowcount == 0:
        row = conn.execute(
            "SELECT status FROM laoji_password_reset_requests WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        if row is None:
            raise ValueError("重置请求不存在")
        raise ValueError("重置请求已处理")
    return {"request_id": request_id, "status": "rejected", "handled_at": now}


def create_account_deletion_request(account: str, contact: str, reason: Optional[str] = None) -> str:
    """Create a generic web deletion request without exposing account existence."""
    init_auth_db()
    normalized = _normalize_account(account)
    normalized_contact = contact.strip()
    normalized_reason = (reason or "").strip() or None
    if not _ACCOUNT_RE.match(normalized):
        raise ValueError("账号格式不正确")
    if len(normalized_contact) < 3 or len(normalized_contact) > 200:
        raise ValueError("联系方式长度应为 3 到 200 个字符")
    if normalized_reason and len(normalized_reason) > 500:
        raise ValueError("补充说明不能超过 500 个字符")

    conn = _get_conn()
    duplicate_cutoff = _iso(_utc_now() - timedelta(hours=24))
    try:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            """
            SELECT request_id FROM laoji_account_deletion_requests
            WHERE account = ? AND contact = ?
              AND status IN ('pending', 'processing') AND created_at >= ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (normalized, normalized_contact, duplicate_cutoff),
        ).fetchone()
        if existing is not None:
            conn.commit()
            return str(existing["request_id"])

        user = conn.execute("SELECT id FROM laoji_users WHERE account = ?", (normalized,)).fetchone()
        request_id = secrets.token_urlsafe(18)
        conn.execute(
            """
            INSERT INTO laoji_account_deletion_requests
                (request_id, user_id, account, contact, reason, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                request_id,
                int(user["id"]) if user else None,
                normalized,
                normalized_contact,
                normalized_reason,
                _iso(_utc_now()),
            ),
        )
        conn.commit()
        return request_id
    except Exception:
        conn.rollback()
        raise


def get_account_deletion_request_status(request_id: str) -> Optional[Dict[str, Any]]:
    init_auth_db()
    request_id = request_id.strip()
    if not request_id:
        return None
    row = _get_conn().execute(
        """
        SELECT request_id, status, created_at, handled_at
        FROM laoji_account_deletion_requests WHERE request_id = ?
        """,
        (request_id,),
    ).fetchone()
    return dict(row) if row else None


def list_account_deletion_requests(status: str = "pending", limit: int = 100) -> list[Dict[str, Any]]:
    init_auth_db()
    if status not in {"pending", "processing", "completed", "rejected", "all"}:
        raise ValueError("不支持的请求状态")
    limit = max(1, min(500, int(limit)))
    conn = _get_conn()
    if status == "all":
        rows = conn.execute(
            "SELECT * FROM laoji_account_deletion_requests ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT * FROM laoji_account_deletion_requests
            WHERE status = ? ORDER BY created_at LIMIT ?
            """,
            (status, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def claim_account_deletion_request(request_id: str, *, resume: bool = False) -> Dict[str, Any]:
    """Claim one request for an operator without holding a cross-database lock.

    A crashed process deliberately leaves the row in ``processing``. Operators
    must then use the explicit resume flag, preventing two terminals from
    silently deleting the same account at once.
    """
    init_auth_db()
    request_id = request_id.strip()
    if not request_id:
        raise ValueError("删除请求 ID 不能为空")
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM laoji_account_deletion_requests WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        if row is None:
            raise ValueError("删除请求不存在")
        current_status = str(row["status"])
        if current_status == "processing" and not resume:
            raise ValueError("删除请求正在处理；确认上次进程已停止后使用 --resume")
        if current_status not in {"pending", "processing"}:
            raise ValueError("删除请求已处理")
        now = _iso(_utc_now())
        conn.execute(
            """
            UPDATE laoji_account_deletion_requests
            SET status = 'processing', processing_started_at = ?,
                attempt_count = attempt_count + 1, last_error = NULL
            WHERE request_id = ?
            """,
            (now, request_id),
        )
        claimed = conn.execute(
            "SELECT * FROM laoji_account_deletion_requests WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    if claimed is None:
        raise RuntimeError("删除请求锁定失败")
    return dict(claimed)


def release_account_deletion_request(request_id: str, error: str) -> None:
    """Return a failed operator attempt to pending while retaining a short audit hint."""
    init_auth_db()
    conn = _get_conn()
    conn.execute(
        """
        UPDATE laoji_account_deletion_requests
        SET status = 'pending', processing_started_at = NULL, last_error = ?
        WHERE request_id = ? AND status = 'processing'
        """,
        (str(error)[:500], request_id.strip()),
    )
    conn.commit()


def reject_account_deletion_request(request_id: str) -> Dict[str, Any]:
    init_auth_db()
    request_id = request_id.strip()
    now = _iso(_utc_now())
    conn = _get_conn()
    cur = conn.execute(
        """
        UPDATE laoji_account_deletion_requests
        SET status = 'rejected', handled_at = ?, user_id = NULL,
            account = NULL, contact = NULL, reason = NULL,
            processing_started_at = NULL, last_error = NULL
        WHERE request_id = ? AND status = 'pending'
        """,
        (now, request_id),
    )
    conn.commit()
    if cur.rowcount == 0:
        raise ValueError("删除请求不存在或已处理")
    return {"request_id": request_id, "status": "rejected", "handled_at": now}


def verify_user_password(user_id: int, password: str) -> bool:
    init_auth_db()
    row = _get_conn().execute(
        "SELECT password_hash FROM laoji_users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return bool(row and _verify_password(password, row["password_hash"]))


def begin_account_deletion(
    user_id: int,
    password: Optional[str] = None,
    *,
    operation_id: Optional[str] = None,
    revoke_sessions: bool = True,
) -> int:
    """Lease an account for one deletion operation.

    Cross-store callers defer physical session revocation until the final auth
    transaction. Tokens are temporarily rejected while the lease is active and
    become usable again if the operation releases its own lease.
    """
    init_auth_db()
    requested_operation = (operation_id or secrets.token_urlsafe(18)).strip()
    if not requested_operation or len(requested_operation) > 120:
        raise ValueError("账号删除操作标识不正确")
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM laoji_users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise ValueError("用户不存在")
        if password is not None and not _verify_password(password, row["password_hash"]):
            raise ValueError("当前密码错误")
        existing_operation = str(row["deletion_operation_id"] or "")
        if _deletion_lease_active(row) and existing_operation != requested_operation:
            raise AccountDeletionInProgress("另一项账号删除操作正在进行，请稍后重试")
        session_count = int(
            conn.execute(
                "SELECT COUNT(*) FROM laoji_sessions WHERE user_id = ?",
                (user_id,),
            ).fetchone()[0]
        )
        revoked_sessions = int(row["deletion_revoked_sessions"] or 0)
        if revoke_sessions:
            conn.execute("DELETE FROM laoji_sessions WHERE user_id = ?", (user_id,))
            revoked_sessions += session_count
        now = _utc_now()
        conn.execute(
            """
            UPDATE laoji_users
            SET deletion_started_at = ?, deletion_lease_expires_at = ?,
                deletion_revoked_sessions = ?, deletion_operation_id = ?
            WHERE id = ?
            """,
            (
                _iso(now),
                _iso(now + timedelta(minutes=DELETION_LEASE_MINUTES)),
                revoked_sessions,
                requested_operation,
                user_id,
            ),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return session_count


def cancel_account_deletion(user_id: int, *, operation_id: Optional[str] = None) -> bool:
    """Release only the caller-owned failed deletion lease."""
    init_auth_db()
    conn = _get_conn()
    if operation_id is None:
        cur = conn.execute(
            """
            UPDATE laoji_users
            SET deletion_started_at = NULL, deletion_lease_expires_at = NULL,
                deletion_revoked_sessions = 0, deletion_operation_id = NULL
            WHERE id = ?
            """,
            (user_id,),
        )
    else:
        cur = conn.execute(
            """
            UPDATE laoji_users
            SET deletion_started_at = NULL, deletion_lease_expires_at = NULL,
                deletion_revoked_sessions = 0, deletion_operation_id = NULL
            WHERE id = ? AND deletion_operation_id = ?
            """,
            (user_id, operation_id.strip()),
        )
    conn.commit()
    return cur.rowcount == 1


def delete_account_data(user_id: int, password: str) -> Dict[str, Any]:
    """Verify the current password, then delete auth and schedule data."""
    if not verify_user_password(user_id, password):
        raise ValueError("当前密码错误")
    return delete_account_data_after_verification(user_id)


def delete_account_data_after_verification(
    user_id: int,
    *,
    operation_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Operator/internal continuation after identity and meeting cleanup."""
    init_auth_db()
    conn = _get_conn()
    avatar_filename: Optional[str] = None
    account = ""
    now = _iso(_utc_now())
    try:
        conn.execute("BEGIN IMMEDIATE")
        user = conn.execute(
            """
            SELECT account, avatar_filename, deletion_revoked_sessions,
                   deletion_operation_id
            FROM laoji_users WHERE id = ?
            """,
            (user_id,),
        ).fetchone()
        if user is None:
            raise ValueError("用户不存在")
        if operation_id is not None and user["deletion_operation_id"] != operation_id.strip():
            raise AccountDeletionInProgress("账号删除操作租约已失效或由其他请求持有")
        account = str(user["account"])
        avatar_filename = user["avatar_filename"]
        revoked_sessions = int(user["deletion_revoked_sessions"] or 0)

        has_events = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schedule_events'"
        ).fetchone()
        events_deleted = 0
        if has_events:
            event_cur = conn.execute("DELETE FROM schedule_events WHERE user_id = ?", (user_id,))
            events_deleted = max(0, int(event_cur.rowcount))

        conn.execute(
            "DELETE FROM laoji_password_reset_requests WHERE user_id = ? OR account = ?",
            (user_id, account),
        )
        conn.execute(
            """
            UPDATE laoji_account_deletion_requests
            SET status = 'completed', handled_at = ?, user_id = NULL,
                account = NULL, contact = NULL, reason = NULL,
                processing_started_at = NULL, last_error = NULL
            WHERE user_id = ? OR account = ?
            """,
            (now, user_id, account),
        )
        session_cur = conn.execute("DELETE FROM laoji_sessions WHERE user_id = ?", (user_id,))
        user_cur = conn.execute("DELETE FROM laoji_users WHERE id = ?", (user_id,))
        if user_cur.rowcount != 1:
            raise RuntimeError("账号删除未生效")
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    cleanup_pending = 0
    if avatar_filename:
        avatar_path = (_get_avatar_dir() / Path(avatar_filename).name).resolve(strict=False)
        try:
            avatar_path.unlink(missing_ok=True)
        except Exception as exc:
            cleanup_pending = 1
            conn.execute(
                """
                INSERT INTO laoji_file_deletion_queue(path, created_at, last_error)
                VALUES (?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET last_error = excluded.last_error
                """,
                (str(avatar_path), now, str(exc)[:500]),
            )
            conn.commit()
            _logger.warning("Account avatar cleanup queued for user_id=%s", user_id)

    return {
        "deleted": True,
        "events_deleted": events_deleted,
        "sessions_deleted": revoked_sessions + max(0, int(session_cur.rowcount)),
        "cleanup_pending": cleanup_pending,
    }


def get_profile(user_id: int) -> Optional[Dict[str, Any]]:
    init_auth_db()
    row = _get_conn().execute("SELECT * FROM laoji_users WHERE id = ?", (user_id,)).fetchone()
    return profile_to_public(row) if row else None


def update_profile(user_id: int, values: Dict[str, Any]) -> Dict[str, Any]:
    init_auth_db()
    updates: Dict[str, Any] = {}
    if "nickname" in values:
        nickname = str(values["nickname"] or "").strip()
        if not nickname:
            raise ValueError("昵称不能为空")
        updates["nickname"] = nickname[:50]
    if "email" in values:
        email = str(values["email"] or "").strip().lower() or None
        if email is not None and not _EMAIL_RE.match(email):
            raise ValueError("邮箱格式不正确")
        updates["email"] = email
    if "phone" in values:
        phone = str(values["phone"] or "").strip() or None
        if phone is not None and not _PHONE_RE.match(phone):
            raise ValueError("手机号格式不正确")
        updates["phone"] = phone
    if "avatar_colors" in values:
        colors = values["avatar_colors"]
        if not isinstance(colors, list) or len(colors) != 2 or not all(_COLOR_RE.match(str(item)) for item in colors):
            raise ValueError("头像颜色格式不正确")
        updates["avatar_colors"] = json.dumps([str(colors[0]), str(colors[1])], ensure_ascii=True)

    if updates:
        updates["updated_at"] = _iso(_utc_now())
        columns = ", ".join(f"{key} = ?" for key in updates)
        params = [*updates.values(), user_id]
        conn = _get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM laoji_users WHERE id = ?", (user_id,)).fetchone()
            if row is None:
                raise ValueError("用户不存在")
            _assert_account_accepts_writes(row)
            cur = conn.execute(f"UPDATE laoji_users SET {columns} WHERE id = ?", params)
            if cur.rowcount != 1:
                raise RuntimeError("资料更新未生效")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    profile = get_profile(user_id)
    if profile is None:
        raise ValueError("用户不存在")
    return profile


def save_avatar(user_id: int, content: bytes, extension: str) -> Dict[str, Any]:
    init_auth_db()
    extension = extension.lower().lstrip(".")
    if extension not in {"jpg", "png", "webp"}:
        raise ValueError("不支持的头像格式")
    conn = _get_conn()
    filename = f"u{user_id}-{secrets.token_urlsafe(18)}.{extension}"
    avatar_dir = _get_avatar_dir()
    final_path = avatar_dir / filename
    temp_path = avatar_dir / f".{filename}.tmp"
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM laoji_users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise ValueError("用户不存在")
        _assert_account_accepts_writes(row)
        old_filename = row["avatar_filename"]
        temp_path.write_bytes(content)
        os.replace(temp_path, final_path)
        cur = conn.execute(
            "UPDATE laoji_users SET avatar_filename = ?, updated_at = ? WHERE id = ?",
            (filename, _iso(_utc_now()), user_id),
        )
        if cur.rowcount != 1:
            raise RuntimeError("头像更新未生效")
        conn.commit()
    except Exception:
        conn.rollback()
        temp_path.unlink(missing_ok=True)
        final_path.unlink(missing_ok=True)
        raise
    if old_filename and old_filename != filename:
        _remove_avatar_file_or_queue(_get_avatar_dir() / Path(old_filename).name)
    profile = get_profile(user_id)
    if profile is None:
        raise ValueError("用户不存在")
    return profile


def delete_avatar(user_id: int) -> Dict[str, Any]:
    init_auth_db()
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM laoji_users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise ValueError("用户不存在")
        _assert_account_accepts_writes(row)
        filename = row["avatar_filename"]
        conn.execute(
            "UPDATE laoji_users SET avatar_filename = NULL, updated_at = ? WHERE id = ?",
            (_iso(_utc_now()), user_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    if filename:
        _remove_avatar_file_or_queue(_get_avatar_dir() / Path(filename).name)
    profile = get_profile(user_id)
    if profile is None:
        raise ValueError("用户不存在")
    return profile


def _remove_avatar_file_or_queue(path: Path) -> bool:
    """Remove one managed avatar or queue a retry without surfacing partial failure."""
    avatar_dir = _get_avatar_dir().resolve()
    resolved = path.resolve(strict=False)
    try:
        resolved.relative_to(avatar_dir)
        if resolved == avatar_dir:
            raise ValueError("refusing to delete avatar root")
        resolved.unlink(missing_ok=True)
        return True
    except Exception as exc:
        conn = _get_conn()
        conn.execute(
            """
            INSERT INTO laoji_file_deletion_queue(path, created_at, last_error)
            VALUES (?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET last_error = excluded.last_error
            """,
            (str(resolved), _iso(_utc_now()), str(exc)[:500]),
        )
        conn.commit()
        _logger.warning("Avatar cleanup queued: %s", resolved)
        return False


def avatar_path(filename: str) -> Optional[Path]:
    if not filename or Path(filename).name != filename:
        return None
    path = _get_avatar_dir() / filename
    return path if path.is_file() else None
