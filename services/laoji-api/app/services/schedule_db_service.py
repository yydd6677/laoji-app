"""
日程数据库服务 - 存储和管理日程事件
=====================================
使用独立 SQLite 文件，支持一次性、每日、每周、每月、每年重复事件。
查询时动态展开重复事件。发布版 App 登录用户按 user_id 隔离；user_id=None
保留为内部兼容查询。
"""

import os
import hashlib
import json
import sqlite3
import threading
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any, Iterable, Tuple


# ==================== 路径配置 ====================

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


# ==================== 连接管理 ====================

_db_path: Optional[str] = None
_local = threading.local()


class ScheduleWriteBlocked(RuntimeError):
    """The owner is missing or currently being deleted."""


class ScheduleIdempotencyConflict(RuntimeError):
    """The same request key was reused with a different create payload."""


class ScheduleCommandConflict(RuntimeError):
    """An event state command conflicts with a previous command or revision."""

    def __init__(self, message: str, code: Optional[str] = None):
        super().__init__(message)
        self.code = code or message


EDITABLE_FIELDS = {
    "title",
    "event_type",
    "start_date",
    "end_date",
    "color",
    "start_time",
    "end_time",
    "is_all_day",
    "description",
    "raw_text",
    "location",
    "category",
    "detail",
    "status",
    "reminder_minutes",
}

RECURRENCE_FIELDS = {
    "recurrence_interval",
    "recurrence_weekdays",
    "recurrence_until_date",
}

RECURRENCE_GEOMETRY_FIELDS = {
    "event_type",
    "start_date",
    "recurrence_interval",
    "recurrence_weekdays",
    "recurrence_until_date",
}

VALID_EVENT_TYPES = {"once", "daily", "weekly", "monthly", "yearly"}


def _get_conn() -> sqlite3.Connection:
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(
            _get_db_path(),
            check_same_thread=False,
            timeout=10.0,
        )
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA foreign_keys=ON")
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA busy_timeout=10000")
    return _local.conn


def _get_db_path() -> str:
    global _db_path
    return _db_path or _get_default_db_path()


def set_db_path(path: Optional[str]):
    global _db_path
    close_db()
    _db_path = path


def close_db() -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


# ==================== 数据库初始化 ====================

def _column_names(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _init_db():
    conn = _get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schedule_events (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id          INTEGER,
            title            TEXT    NOT NULL,
            event_type       TEXT    NOT NULL DEFAULT 'once',
            start_date       TEXT    NOT NULL,
            end_date         TEXT,
            color            TEXT,
            start_time       TEXT,
            end_time         TEXT,
            is_all_day       INTEGER NOT NULL DEFAULT 0,
            description      TEXT,
            location         TEXT,
            category         TEXT,
            detail           TEXT,
            status           TEXT,
            reminder_minutes INTEGER,
            raw_text         TEXT,
            client_request_id TEXT,
            revision         INTEGER NOT NULL DEFAULT 1,
            deleted_at       TEXT,
            excluded_after_date TEXT,
            recurrence_interval INTEGER NOT NULL DEFAULT 1,
            recurrence_weekdays_json TEXT,
            recurrence_until_date TEXT,
            created_at       TEXT    NOT NULL,
            updated_at       TEXT    NOT NULL
        )
    """)
    columns = _column_names(conn, "schedule_events")
    if "user_id" not in columns:
        conn.execute("ALTER TABLE schedule_events ADD COLUMN user_id INTEGER")
    migrations = {
        "end_date": "ALTER TABLE schedule_events ADD COLUMN end_date TEXT",
        "color": "ALTER TABLE schedule_events ADD COLUMN color TEXT",
        "location": "ALTER TABLE schedule_events ADD COLUMN location TEXT",
        "category": "ALTER TABLE schedule_events ADD COLUMN category TEXT",
        "detail": "ALTER TABLE schedule_events ADD COLUMN detail TEXT",
        "status": "ALTER TABLE schedule_events ADD COLUMN status TEXT",
        "reminder_minutes": "ALTER TABLE schedule_events ADD COLUMN reminder_minutes INTEGER",
        "client_request_id": "ALTER TABLE schedule_events ADD COLUMN client_request_id TEXT",
        "revision": "ALTER TABLE schedule_events ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
        "deleted_at": "ALTER TABLE schedule_events ADD COLUMN deleted_at TEXT",
        "excluded_after_date": "ALTER TABLE schedule_events ADD COLUMN excluded_after_date TEXT",
        "recurrence_interval": "ALTER TABLE schedule_events ADD COLUMN recurrence_interval INTEGER NOT NULL DEFAULT 1",
        "recurrence_weekdays_json": "ALTER TABLE schedule_events ADD COLUMN recurrence_weekdays_json TEXT",
        "recurrence_until_date": "ALTER TABLE schedule_events ADD COLUMN recurrence_until_date TEXT",
    }
    for column, statement in migrations.items():
        if column not in columns:
            conn.execute(statement)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_schedule_start_date
        ON schedule_events(start_date)
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schedule_event_exceptions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id         INTEGER NOT NULL,
            source_event_id INTEGER NOT NULL,
            occurrence_date TEXT NOT NULL,
            exception_type  TEXT NOT NULL,
            patch_json      TEXT,
            patch_revision  INTEGER,
            orphaned_at_revision INTEGER,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL,
            UNIQUE(user_id, source_event_id, occurrence_date, exception_type)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_schedule_exception_source
        ON schedule_event_exceptions(user_id, source_event_id, occurrence_date)
    """)
    exception_columns = _column_names(conn, "schedule_event_exceptions")
    exception_migrations = {
        "patch_json": "ALTER TABLE schedule_event_exceptions ADD COLUMN patch_json TEXT",
        "patch_revision": "ALTER TABLE schedule_event_exceptions ADD COLUMN patch_revision INTEGER",
        "orphaned_at_revision": "ALTER TABLE schedule_event_exceptions ADD COLUMN orphaned_at_revision INTEGER",
    }
    for column, statement in exception_migrations.items():
        if column not in exception_columns:
            conn.execute(statement)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schedule_event_segments (
            id                             INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id                        INTEGER NOT NULL,
            source_event_id                INTEGER NOT NULL,
            effective_from_occurrence_date TEXT NOT NULL,
            patch_json                     TEXT NOT NULL DEFAULT '{}',
            template_json                  TEXT NOT NULL,
            segment_revision               INTEGER NOT NULL DEFAULT 1,
            created_at                     TEXT NOT NULL,
            updated_at                     TEXT NOT NULL,
            UNIQUE(source_event_id, effective_from_occurrence_date)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_schedule_segment_source
        ON schedule_event_segments(user_id, source_event_id, effective_from_occurrence_date)
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schedule_event_commands (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id           INTEGER NOT NULL,
            client_request_id TEXT NOT NULL,
            source_event_id   INTEGER NOT NULL,
            payload_hash      TEXT NOT NULL,
            response_json     TEXT NOT NULL,
            command_type      TEXT NOT NULL DEFAULT 'state',
            request_json      TEXT,
            created_at        TEXT NOT NULL,
            completed_at      TEXT,
            UNIQUE(user_id, client_request_id)
        )
    """)
    command_columns = _column_names(conn, "schedule_event_commands")
    command_migrations = {
        "command_type": "ALTER TABLE schedule_event_commands ADD COLUMN command_type TEXT NOT NULL DEFAULT 'state'",
        "request_json": "ALTER TABLE schedule_event_commands ADD COLUMN request_json TEXT",
        "completed_at": "ALTER TABLE schedule_event_commands ADD COLUMN completed_at TEXT",
    }
    for column, statement in command_migrations.items():
        if column not in command_columns:
            conn.execute(statement)
    conn.execute(
        """UPDATE schedule_event_commands SET command_type = 'state'
           WHERE command_type IS NULL OR command_type = ''"""
    )
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_schedule_user_start_date
        ON schedule_events(user_id, start_date)
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_schedule_user_date_range
        ON schedule_events(user_id, start_date, end_date)
    """)
    conn.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_user_client_request
        ON schedule_events(user_id, client_request_id)
        WHERE client_request_id IS NOT NULL
    """)
    conn.commit()


def ensure_schedule_database() -> None:
    """Create/migrate the shared schedule database and enforce WAL pragmas."""
    _init_db()


def _assert_user_accepts_writes(conn: sqlite3.Connection, user_id: Optional[int]) -> None:
    if user_id is None:
        return
    users_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='laoji_users'"
    ).fetchone()
    if users_table is None:
        return
    columns = _column_names(conn, "laoji_users")
    if "deletion_lease_expires_at" not in columns:
        return
    row = conn.execute(
        "SELECT deletion_lease_expires_at FROM laoji_users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if row is None:
        raise ScheduleWriteBlocked("账号不存在，不能写入日程")
    lease = row["deletion_lease_expires_at"]
    if lease:
        try:
            expires_at = datetime.fromisoformat(str(lease).replace("Z", "+00:00"))
            now = datetime.now(expires_at.tzinfo) if expires_at.tzinfo else datetime.now()
            if expires_at > now:
                raise ScheduleWriteBlocked("账号正在删除，不能写入日程")
        except ValueError:
            raise ScheduleWriteBlocked("账号删除状态异常，不能写入日程") from None


# ==================== CRUD ====================

def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _parse_iso_date(value: str, field: str = "date") -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        raise ValueError(f"{field} 必须是 YYYY-MM-DD") from None


def _normalize_interval(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("recurrence interval 必须是正整数")
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        raise ValueError("recurrence interval 必须是正整数") from None
    if normalized < 1 or normalized != value:
        raise ValueError("recurrence interval 必须是正整数")
    return normalized


def _normalize_weekdays(value: Optional[Iterable[Any]]) -> Optional[List[int]]:
    if value is None:
        return None
    weekdays: set[int] = set()
    for item in value:
        if isinstance(item, bool):
            raise ValueError("recurrence weekdays 必须使用 ISO 1..7")
        try:
            weekday = int(item)
        except (TypeError, ValueError):
            raise ValueError("recurrence weekdays 必须使用 ISO 1..7") from None
        if weekday < 1 or weekday > 7 or weekday != item:
            raise ValueError("recurrence weekdays 必须使用 ISO 1..7")
        weekdays.add(weekday)
    if not weekdays:
        raise ValueError("recurrence weekdays 不能为空列表；使用 null 清除自定义星期")
    return sorted(weekdays)

def create_event(
    title: str,
    start_date: str,
    end_date: Optional[str] = None,
    color: Optional[str] = None,
    event_type: str = "once",
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    is_all_day: bool = False,
    description: Optional[str] = None,
    location: Optional[str] = None,
    category: Optional[str] = None,
    detail: Optional[str] = None,
    status: Optional[str] = None,
    reminder_minutes: Optional[int] = None,
    raw_text: Optional[str] = None,
    client_request_id: Optional[str] = None,
    recurrence_interval: int = 1,
    recurrence_weekdays: Optional[List[int]] = None,
    recurrence_until_date: Optional[str] = None,
    user_id: Optional[int] = None,
) -> Dict[str, Any]:
    _init_db()
    now = datetime.now().isoformat()
    conn = _get_conn()
    client_request_id = client_request_id.strip() if client_request_id else None
    recurrence_interval = _normalize_interval(recurrence_interval)
    recurrence_weekdays = _normalize_weekdays(recurrence_weekdays)
    if recurrence_until_date is not None:
        _parse_iso_date(recurrence_until_date, "recurrence_until_date")
    weekdays_json = _json_dumps(recurrence_weekdays) if recurrence_weekdays is not None else None
    try:
        conn.execute("BEGIN IMMEDIATE")
        _assert_user_accepts_writes(conn, user_id)
        existing = None
        if client_request_id is not None:
            existing = conn.execute(
                """
                SELECT * FROM schedule_events
                WHERE user_id = ? AND client_request_id = ?
                """,
                (user_id, client_request_id),
            ).fetchone()
        if existing is not None:
            if existing["deleted_at"] is not None:
                raise ScheduleIdempotencyConflict("该创建请求对应的日程已经删除")
            expected = {
                "title": title,
                "event_type": event_type,
                "start_date": start_date,
                "end_date": end_date,
                "color": color,
                "start_time": start_time,
                "end_time": end_time,
                "is_all_day": int(is_all_day),
                "description": description,
                "location": location,
                "category": category,
                "detail": detail,
                "status": status,
                "reminder_minutes": reminder_minutes,
                "raw_text": raw_text,
                "recurrence_interval": recurrence_interval,
                "recurrence_weekdays_json": weekdays_json,
                "recurrence_until_date": recurrence_until_date,
            }
            if any(existing[field] != value for field, value in expected.items()):
                raise ScheduleIdempotencyConflict("同一创建请求标识不能用于不同日程内容")
            event_id = int(existing["id"])
        else:
            cur = conn.execute(
                """
                INSERT INTO schedule_events
                    (user_id, title, event_type, start_date, end_date, color, start_time, end_time,
                     is_all_day, description, location, category, detail, status, reminder_minutes,
                     raw_text, client_request_id, recurrence_interval, recurrence_weekdays_json,
                     recurrence_until_date, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (user_id, title, event_type, start_date, end_date, color, start_time, end_time,
                 int(is_all_day), description, location, category, detail, status, reminder_minutes,
                 raw_text, client_request_id, recurrence_interval, weekdays_json,
                 recurrence_until_date, now, now),
            )
            event_id = int(cur.lastrowid)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    event = get_event(event_id, user_id=user_id)
    if event is None:
        raise RuntimeError("event was not created")
    return event


def get_event(
    event_id: int,
    user_id: Optional[int] = None,
    include_deleted: bool = False,
) -> Optional[Dict[str, Any]]:
    _init_db()
    conn = _get_conn()
    if user_id is None:
        row = conn.execute(
            "SELECT * FROM schedule_events WHERE id = ? AND (? OR deleted_at IS NULL)",
            (event_id, int(include_deleted)),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM schedule_events WHERE id = ? AND user_id = ? AND (? OR deleted_at IS NULL)",
            (event_id, user_id, int(include_deleted)),
        ).fetchone()
    if row is None:
        return None
    event = _row_to_dict(row)
    _attach_excluded_occurrences(conn, [event], user_id=user_id)
    return event


def update_event(
    event_id: int,
    title: Optional[str] = None,
    event_type: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    color: Optional[str] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    is_all_day: Optional[bool] = None,
    description: Optional[str] = None,
    location: Optional[str] = None,
    category: Optional[str] = None,
    detail: Optional[str] = None,
    status: Optional[str] = None,
    reminder_minutes: Optional[int] = None,
    user_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    _init_db()
    conn = _get_conn()
    existing = get_event(event_id, user_id=user_id)
    if existing is None:
        return None

    now = datetime.now().isoformat()
    if user_id is None:
        where = "id = ?"
        params_tail = (event_id,)
    else:
        where = "id = ? AND user_id = ?"
        params_tail = (event_id, user_id)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _assert_user_accepts_writes(conn, user_id)
        conn.execute(
            f"""
            UPDATE schedule_events SET
                title       = ?,
                event_type  = ?,
                start_date  = ?,
                end_date    = ?,
                color       = ?,
                start_time  = ?,
                end_time    = ?,
                is_all_day  = ?,
                description = ?,
                location    = ?,
                category    = ?,
                detail      = ?,
                status      = ?,
                reminder_minutes = ?,
                updated_at  = ?,
                revision    = revision + 1
            WHERE {where}
            """,
            (
                title if title is not None else existing["title"],
                event_type if event_type is not None else existing["event_type"],
                start_date if start_date is not None else existing["start_date"],
                end_date if end_date is not None else existing["end_date"],
                color if color is not None else existing["color"],
                start_time if start_time is not None else existing["start_time"],
                end_time if end_time is not None else existing["end_time"],
                int(is_all_day) if is_all_day is not None else existing["is_all_day"],
                description if description is not None else existing["description"],
                location if location is not None else existing["location"],
                category if category is not None else existing["category"],
                detail if detail is not None else existing["detail"],
                status if status is not None else existing["status"],
                reminder_minutes if reminder_minutes is not None else existing["reminder_minutes"],
                now,
                *params_tail,
            ),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return get_event(event_id, user_id=user_id)


def update_event_fields(
    event_id: int,
    changes: Dict[str, Any],
    user_id: Optional[int] = None,
    legacy_compat: bool = False,
) -> Optional[Dict[str, Any]]:
    """Apply only fields present in the PATCH-like request, including explicit nulls."""
    _init_db()
    existing = get_event(event_id, user_id=user_id)
    if existing is None:
        return None
    allowed = EDITABLE_FIELDS | RECURRENCE_FIELDS
    patch = {key: value for key, value in changes.items() if key in allowed}
    if legacy_compat:
        for field in ("detail", "status", "color"):
            if patch.get(field) is None:
                patch.pop(field, None)
    for required in ("title", "event_type", "start_date"):
        if required in patch and patch[required] is None:
            raise ValueError(f"{required} 不能为空")
    if "event_type" in patch and patch["event_type"] not in VALID_EVENT_TYPES:
        raise ValueError("event_type 不受支持")
    if "is_all_day" in patch and patch["is_all_day"] is not None:
        patch["is_all_day"] = int(bool(patch["is_all_day"]))
    if "recurrence_interval" in patch:
        patch["recurrence_interval"] = _normalize_interval(patch["recurrence_interval"])
    if "recurrence_until_date" in patch and patch["recurrence_until_date"] is not None:
        _parse_iso_date(patch["recurrence_until_date"], "recurrence_until_date")
    if "recurrence_weekdays" in patch:
        weekdays = _normalize_weekdays(patch.pop("recurrence_weekdays"))
        patch["recurrence_weekdays_json"] = _json_dumps(weekdays) if weekdays is not None else None
    if "start_date" in patch and "end_date" not in patch and existing.get("end_date"):
        patch["end_date"] = _shift_end_date(
            existing["start_date"], existing["end_date"], patch["start_date"]
        )
    patch = {
        key: value for key, value in patch.items()
        if existing.get(key) != value
        and not (key == "recurrence_weekdays_json" and existing.get("recurrence_weekdays_json") == value)
    }
    if not patch:
        return existing
    recurrence_geometry_changed = bool(
        set(patch) & (RECURRENCE_GEOMETRY_FIELDS - {"recurrence_weekdays"})
        or "recurrence_weekdays_json" in patch
    )
    patch["updated_at"] = datetime.now().isoformat()
    if recurrence_geometry_changed:
        patch["excluded_after_date"] = None
    assignments = ", ".join(f"{column} = ?" for column in patch)
    if user_id is None:
        where = "id = ?"
        tail = (event_id,)
    else:
        where = "id = ? AND user_id = ?"
        tail = (event_id, user_id)
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        _assert_user_accepts_writes(conn, user_id)
        conn.execute(
            f"UPDATE schedule_events SET {assignments}, revision = revision + 1 WHERE {where}",
            (*patch.values(), *tail),
        )
        if user_id is not None:
            current_row = conn.execute(
                "SELECT * FROM schedule_events WHERE id = ? AND user_id = ?",
                (event_id, user_id),
            ).fetchone()
            current_event = _row_to_dict(current_row)
            current_revision = int(current_event.get("revision") or 1)
            _rebase_segments(
                conn,
                current_event,
                user_id,
                patch["updated_at"],
                current_revision,
                validate_anchors=recurrence_geometry_changed,
            )
            if recurrence_geometry_changed:
                _refresh_exception_orphans(conn, current_event, user_id, current_revision)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return get_event(event_id, user_id=user_id)


def delete_event(event_id: int, user_id: Optional[int] = None) -> bool:
    _init_db()
    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        _assert_user_accepts_writes(conn, user_id)
        now = datetime.now().isoformat()
        if user_id is None:
            cur = conn.execute(
                """UPDATE schedule_events
                   SET deleted_at = ?, updated_at = ?, revision = revision + 1
                   WHERE id = ? AND deleted_at IS NULL""",
                (now, now, event_id),
            )
        else:
            cur = conn.execute(
                """UPDATE schedule_events
                   SET deleted_at = ?, updated_at = ?, revision = revision + 1
                   WHERE id = ? AND user_id = ? AND deleted_at IS NULL""",
                (now, now, event_id, user_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return cur.rowcount > 0


def _command_payload_hash(payload: Dict[str, Any]) -> str:
    encoded = _json_dumps(payload)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _shift_end_date(old_start: str, old_end: Optional[str], new_start: str) -> Optional[str]:
    if old_end is None:
        return None
    try:
        duration = _parse_iso_date(old_end) - _parse_iso_date(old_start)
        return (_parse_iso_date(new_start) + duration).isoformat()
    except ValueError:
        return old_end


def _normalize_edit_patch(patch: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(patch, dict):
        raise ValueError("patch 必须是对象")
    unknown = set(patch) - EDITABLE_FIELDS - RECURRENCE_FIELDS - {"spanning", "recurrence"}
    if unknown:
        raise ValueError(f"patch 包含不受支持字段: {', '.join(sorted(unknown))}")

    normalized = {
        field: value for field, value in patch.items()
        if field in EDITABLE_FIELDS and field != "event_type"
    }
    if "recurrence_interval" in patch:
        normalized["recurrence_interval"] = _normalize_interval(patch["recurrence_interval"])
    if "recurrence_weekdays" in patch:
        normalized["recurrence_weekdays"] = _normalize_weekdays(patch["recurrence_weekdays"])
    if "recurrence_until_date" in patch:
        until_date = patch["recurrence_until_date"]
        if until_date is not None:
            _parse_iso_date(until_date, "recurrence_until_date")
        normalized["recurrence_until_date"] = until_date
    event_type = patch.get("event_type") if "event_type" in patch else None
    recurrence = patch.get("recurrence", {})
    if recurrence is None:
        raise ValueError("recurrence 不能为 null")
    if not isinstance(recurrence, dict):
        raise ValueError("recurrence 必须是对象")
    recurrence_unknown = set(recurrence) - {"frequency", "interval", "weekdays", "until_date"}
    if recurrence_unknown:
        raise ValueError(
            f"recurrence 包含不受支持字段: {', '.join(sorted(recurrence_unknown))}"
        )
    if "frequency" in recurrence:
        frequency = recurrence["frequency"]
        if event_type is not None and frequency != event_type:
            raise ValueError("event_type 与 recurrence.frequency 不一致")
        event_type = frequency
    if event_type is not None:
        if event_type not in VALID_EVENT_TYPES:
            raise ValueError("event_type 不受支持")
        normalized["event_type"] = event_type
    if "interval" in recurrence:
        interval = _normalize_interval(recurrence["interval"])
        if "recurrence_interval" in normalized and normalized["recurrence_interval"] != interval:
            raise ValueError("recurrence interval 字段不一致")
        normalized["recurrence_interval"] = interval
    if "weekdays" in recurrence:
        weekdays = _normalize_weekdays(recurrence["weekdays"])
        if "recurrence_weekdays" in normalized and normalized["recurrence_weekdays"] != weekdays:
            raise ValueError("recurrence weekdays 字段不一致")
        normalized["recurrence_weekdays"] = weekdays
    if "until_date" in recurrence:
        until_date = recurrence["until_date"]
        if until_date is not None:
            _parse_iso_date(until_date, "recurrence.until_date")
        if (
            "recurrence_until_date" in normalized
            and normalized["recurrence_until_date"] != until_date
        ):
            raise ValueError("recurrence until_date 字段不一致")
        normalized["recurrence_until_date"] = until_date

    for required in ("title", "event_type", "start_date"):
        if required in normalized and normalized[required] is None:
            raise ValueError(f"{required} 不能为空")
    if "is_all_day" in normalized and normalized["is_all_day"] is None:
        raise ValueError("is_all_day 不能为空")
    for field in ("start_date", "end_date"):
        if field in normalized and normalized[field] is not None:
            _parse_iso_date(normalized[field], field)
    return normalized


def _event_template(event: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "title": event.get("title"),
        "event_type": event.get("event_type", "once"),
        "start_date": event.get("start_date"),
        "end_date": event.get("end_date"),
        "color": event.get("color"),
        "start_time": event.get("start_time"),
        "end_time": event.get("end_time"),
        "is_all_day": bool(event.get("is_all_day")),
        "description": event.get("description"),
        "raw_text": event.get("raw_text"),
        "location": event.get("location"),
        "category": event.get("category"),
        "detail": event.get("detail"),
        "status": event.get("status"),
        "reminder_minutes": event.get("reminder_minutes"),
        "recurrence_interval": int(event.get("recurrence_interval") or 1),
        "recurrence_weekdays": event.get("recurrence_weekdays"),
        "recurrence_until_date": event.get("recurrence_until_date"),
    }


def _apply_template_patch(template: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    result = template.copy()
    old_start = result.get("start_date")
    old_end = result.get("end_date")
    if "start_date" in patch and "end_date" not in patch and old_start:
        result["end_date"] = _shift_end_date(old_start, old_end, patch["start_date"])
    result.update(patch)
    if result.get("title") is None or result.get("event_type") is None or result.get("start_date") is None:
        raise ValueError("title、event_type、start_date 不能为空")
    if result["event_type"] not in VALID_EVENT_TYPES:
        raise ValueError("event_type 不受支持")
    _parse_iso_date(result["start_date"], "start_date")
    if result.get("end_date") is not None:
        end_date = _parse_iso_date(result["end_date"], "end_date")
        if end_date < _parse_iso_date(result["start_date"], "start_date"):
            raise ValueError("end_date 不能早于 start_date")
    result["is_all_day"] = bool(result.get("is_all_day"))
    result["recurrence_interval"] = _normalize_interval(result.get("recurrence_interval", 1))
    result["recurrence_weekdays"] = _normalize_weekdays(result.get("recurrence_weekdays"))
    until_date = result.get("recurrence_until_date")
    if until_date is not None:
        _parse_iso_date(until_date, "recurrence_until_date")
    return result


def _template_diff(base: Dict[str, Any], desired: Dict[str, Any]) -> Dict[str, Any]:
    fields = EDITABLE_FIELDS | RECURRENCE_FIELDS
    return {
        field: desired.get(field)
        for field in sorted(fields)
        if base.get(field) != desired.get(field)
    }


def _template_equal(left: Dict[str, Any], right: Dict[str, Any]) -> bool:
    return not _template_diff(left, right)


def _decode_json_object(raw: Optional[str]) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _template_matches_anchor(
    template: Dict[str, Any],
    occurrence_date: str,
    effective_from: Optional[str],
) -> bool:
    try:
        anchor = _parse_iso_date(occurrence_date)
        effective = _parse_iso_date(effective_from or template["start_date"])
        display_origin = _parse_iso_date(template["start_date"])
    except (KeyError, TypeError, ValueError):
        return False
    if anchor < effective:
        return False
    until_date = template.get("recurrence_until_date")
    if until_date is not None and anchor > _parse_iso_date(until_date):
        return False
    if anchor == effective:
        return True

    display_date = display_origin + (anchor - effective)
    event_type = template.get("event_type", "once")
    interval = int(template.get("recurrence_interval") or 1)
    if event_type == "once":
        return False
    if event_type == "daily":
        return (display_date - display_origin).days % interval == 0
    if event_type == "weekly":
        weekdays = template.get("recurrence_weekdays") or [display_origin.isoweekday()]
        origin_week = display_origin - timedelta(days=display_origin.isoweekday() - 1)
        display_week = display_date - timedelta(days=display_date.isoweekday() - 1)
        week_index = (display_week - origin_week).days // 7
        return week_index >= 0 and week_index % interval == 0 and display_date.isoweekday() in weekdays
    if event_type == "monthly":
        month_index = (display_date.year - display_origin.year) * 12 + display_date.month - display_origin.month
        return month_index >= 0 and month_index % interval == 0 and display_date.day == display_origin.day
    if event_type == "yearly":
        year_index = display_date.year - display_origin.year
        return (
            year_index >= 0
            and year_index % interval == 0
            and (display_date.month, display_date.day) == (display_origin.month, display_origin.day)
        )
    return False


def _load_segments(
    conn: sqlite3.Connection,
    source_event_id: int,
    user_id: Optional[int],
) -> List[Dict[str, Any]]:
    if user_id is None:
        rows = conn.execute(
            """SELECT * FROM schedule_event_segments
               WHERE source_event_id = ? ORDER BY effective_from_occurrence_date, id""",
            (source_event_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT * FROM schedule_event_segments
               WHERE source_event_id = ? AND user_id = ?
               ORDER BY effective_from_occurrence_date, id""",
            (source_event_id, user_id),
        ).fetchall()
    segments: List[Dict[str, Any]] = []
    for row in rows:
        segment = dict(row)
        segment["patch"] = _decode_json_object(segment.get("patch_json"))
        segment["template"] = _decode_json_object(segment.get("template_json"))
        segments.append(segment)
    return segments


def _template_context_for_anchor(
    event: Dict[str, Any],
    segments: List[Dict[str, Any]],
    occurrence_date: str,
    before_effective: Optional[str] = None,
) -> Tuple[Dict[str, Any], str, Optional[int]]:
    template = _event_template(event)
    effective_from = event["start_date"]
    segment_id: Optional[int] = None
    for segment in segments:
        effective = segment["effective_from_occurrence_date"]
        if before_effective is not None and effective >= before_effective:
            break
        if effective > occurrence_date:
            break
        decoded = segment.get("template") or {}
        if decoded:
            template = _apply_template_patch(template, decoded)
        effective_from = effective
        segment_id = int(segment["id"])
    return template, effective_from, segment_id


def _materialize_template_occurrence(
    source_event: Dict[str, Any],
    template: Dict[str, Any],
    occurrence_date: str,
    effective_from: str,
    segment_id: Optional[int],
) -> Dict[str, Any]:
    anchor = _parse_iso_date(occurrence_date)
    effective = _parse_iso_date(effective_from)
    template_start = _parse_iso_date(template["start_date"])
    display_start = template_start + (anchor - effective)
    display_end: Optional[str] = None
    if template.get("end_date") is not None:
        duration = _parse_iso_date(template["end_date"]) - template_start
        display_end = (display_start + duration).isoformat()

    result = source_event.copy()
    result.update(template)
    source_id = int(source_event["id"])
    result.update({
        "id": source_id,
        "source_event_id": source_id,
        "occurrence_date": occurrence_date,
        "occurrence_id": (
            str(source_id)
            if template.get("event_type") == "once" and occurrence_date == source_event.get("start_date")
            else f"{source_id}@{occurrence_date}"
        ),
        "is_expanded": template.get("event_type") != "once",
        "is_recurrence_exception": False,
        "segment_id": segment_id,
        "recurrence_effective_from_date": effective_from,
        "series_start_date": source_event.get("start_date"),
        "series_end_date": source_event.get("end_date"),
        "start_date": display_start.isoformat(),
        "end_date": display_end,
        "spanning": bool(display_end and display_end != display_start.isoformat()),
        "is_all_day": bool(template.get("is_all_day")),
        "revision": int(source_event.get("revision") or 1),
    })
    return result


def _apply_occurrence_patch(event: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    template = _event_template(event)
    desired = _apply_template_patch(template, patch)
    result = event.copy()
    result.update(desired)
    result["spanning"] = bool(
        result.get("end_date") and result.get("end_date") != result.get("start_date")
    )
    result["is_recurrence_exception"] = True
    return result


def _active_exception_rows(
    conn: sqlite3.Connection,
    source_event_id: int,
    user_id: Optional[int],
) -> List[sqlite3.Row]:
    if user_id is None:
        return conn.execute(
            """SELECT * FROM schedule_event_exceptions
               WHERE source_event_id = ? AND orphaned_at_revision IS NULL""",
            (source_event_id,),
        ).fetchall()
    return conn.execute(
        """SELECT * FROM schedule_event_exceptions
           WHERE source_event_id = ? AND user_id = ? AND orphaned_at_revision IS NULL""",
        (source_event_id, user_id),
    ).fetchall()


def _materialize_occurrence(
    conn: sqlite3.Connection,
    event: Dict[str, Any],
    occurrence_date: str,
    user_id: Optional[int],
    segments: Optional[List[Dict[str, Any]]] = None,
    include_patch: bool = True,
    before_effective: Optional[str] = None,
    require_match: bool = True,
) -> Optional[Dict[str, Any]]:
    segments = segments if segments is not None else _load_segments(conn, int(event["id"]), user_id)
    template, effective_from, segment_id = _template_context_for_anchor(
        event, segments, occurrence_date, before_effective=before_effective
    )
    if require_match and not _template_matches_anchor(template, occurrence_date, effective_from):
        return None
    materialized = _materialize_template_occurrence(
        event, template, occurrence_date, effective_from, segment_id
    )
    if include_patch:
        for row in _active_exception_rows(conn, int(event["id"]), user_id):
            if row["occurrence_date"] != occurrence_date or row["exception_type"] != "patch":
                continue
            materialized = _apply_occurrence_patch(
                materialized, _decode_json_object(row["patch_json"])
            )
            break
    return materialized


def _attach_excluded_occurrences(
    conn: sqlite3.Connection,
    events: List[Dict[str, Any]],
    user_id: Optional[int],
) -> None:
    source_ids = sorted({int(event["id"]) for event in events})
    if not source_ids:
        return
    placeholders = ",".join("?" for _ in source_ids)
    if user_id is None:
        rows = conn.execute(
            f"""SELECT source_event_id, occurrence_date FROM schedule_event_exceptions
                WHERE source_event_id IN ({placeholders}) AND exception_type = 'deleted'
                  AND orphaned_at_revision IS NULL""",
            source_ids,
        ).fetchall()
    else:
        rows = conn.execute(
            f"""SELECT source_event_id, occurrence_date FROM schedule_event_exceptions
                WHERE user_id = ? AND source_event_id IN ({placeholders})
                  AND exception_type = 'deleted' AND orphaned_at_revision IS NULL""",
            (user_id, *source_ids),
        ).fetchall()
    excluded: Dict[int, List[str]] = {source_id: [] for source_id in source_ids}
    for row in rows:
        excluded[int(row["source_event_id"])].append(row["occurrence_date"])
    for event in events:
        event["excluded_occurrence_dates"] = sorted(excluded[int(event["id"])])


def _recurrence_matches(event: Dict[str, Any], occurrence_date: str) -> bool:
    template = _event_template(event)
    return _template_matches_anchor(template, occurrence_date, event.get("start_date"))


def _validate_template_until(template: Dict[str, Any], effective_from: str) -> None:
    until_date = template.get("recurrence_until_date")
    if until_date is not None and _parse_iso_date(until_date) < _parse_iso_date(effective_from):
        raise ValueError("recurrence_until_date 不能早于生效实例 anchor")


def _update_root_template(
    conn: sqlite3.Connection,
    event: Dict[str, Any],
    desired: Dict[str, Any],
    changed_fields: Dict[str, Any],
    user_id: int,
    now: str,
    new_revision: int,
) -> None:
    db_patch: Dict[str, Any] = {}
    for field in changed_fields:
        if field == "recurrence_weekdays":
            weekdays = desired.get(field)
            db_patch["recurrence_weekdays_json"] = (
                _json_dumps(weekdays) if weekdays is not None else None
            )
        elif field == "is_all_day":
            db_patch[field] = int(bool(desired.get(field)))
        else:
            db_patch[field] = desired.get(field)
    if set(changed_fields) & RECURRENCE_GEOMETRY_FIELDS:
        db_patch["excluded_after_date"] = None
    db_patch["updated_at"] = now
    db_patch["revision"] = new_revision
    assignments = ", ".join(f"{field} = ?" for field in db_patch)
    conn.execute(
        f"UPDATE schedule_events SET {assignments} WHERE id = ? AND user_id = ?",
        (*db_patch.values(), int(event["id"]), user_id),
    )


def _rebase_segments(
    conn: sqlite3.Connection,
    event: Dict[str, Any],
    user_id: int,
    now: str,
    revision: int,
    validate_anchors: bool,
) -> None:
    original = _load_segments(conn, int(event["id"]), user_id)
    active: List[Dict[str, Any]] = []
    for segment in original:
        anchor = segment["effective_from_occurrence_date"]
        base_event = _materialize_occurrence(
            conn,
            event,
            anchor,
            user_id,
            segments=active,
            include_patch=False,
            require_match=validate_anchors,
        )
        if base_event is None:
            conn.execute(
                "DELETE FROM schedule_event_segments WHERE id = ? AND user_id = ?",
                (int(segment["id"]), user_id),
            )
            continue
        base_template = _event_template(base_event)
        desired = _apply_template_patch(base_template, segment.get("patch") or {})
        _validate_template_until(desired, anchor)
        conn.execute(
            """UPDATE schedule_event_segments
               SET template_json = ?, segment_revision = ?, updated_at = ?
               WHERE id = ? AND user_id = ?""",
            (_json_dumps(desired), revision, now, int(segment["id"]), user_id),
        )
        rebased = segment.copy()
        rebased["template"] = desired
        rebased["segment_revision"] = revision
        active.append(rebased)


def _refresh_exception_orphans(
    conn: sqlite3.Connection,
    event: Dict[str, Any],
    user_id: int,
    revision: int,
) -> None:
    segments = _load_segments(conn, int(event["id"]), user_id)
    rows = conn.execute(
        """SELECT id, occurrence_date FROM schedule_event_exceptions
           WHERE source_event_id = ? AND user_id = ?""",
        (int(event["id"]), user_id),
    ).fetchall()
    for row in rows:
        active = _materialize_occurrence(
            conn,
            event,
            row["occurrence_date"],
            user_id,
            segments=segments,
            include_patch=False,
            require_match=True,
        ) is not None
        conn.execute(
            """UPDATE schedule_event_exceptions SET orphaned_at_revision = ?
               WHERE id = ? AND user_id = ?""",
            (None if active else revision, int(row["id"]), user_id),
        )


def _event_command_range(
    scope: str,
    occurrence_date: str,
    event: Dict[str, Any],
    response_event: Dict[str, Any],
) -> Dict[str, Optional[str]]:
    if scope == "occurrence":
        start = occurrence_date
        end = occurrence_date
    elif scope == "following":
        start = occurrence_date
        end = response_event.get("recurrence_until_date")
        if response_event.get("event_type") == "once":
            end = occurrence_date
    else:
        start = event.get("start_date")
        end = event.get("recurrence_until_date")
        if event.get("event_type") == "once":
            end = start
    return {
        "from_occurrence_date": start,
        "through_occurrence_date": end,
    }


def command_event_edit(
    event_id: int,
    user_id: int,
    client_request_id: str,
    scope: str,
    occurrence_date: str,
    patch: Dict[str, Any],
    expected_revision: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Apply a replay-safe sparse edit to one occurrence, following instances, or a series."""
    _init_db()
    client_request_id = (client_request_id or "").strip()
    if not client_request_id:
        raise ValueError("client_request_id 不能为空")
    if scope not in {"occurrence", "following", "series"}:
        raise ValueError("scope 不受支持")
    _parse_iso_date(occurrence_date, "occurrence_date")
    normalized_patch = _normalize_edit_patch(patch)
    payload = {
        "command_type": "edit",
        "event_id": int(event_id),
        "scope": scope,
        "occurrence_date": occurrence_date,
        "expected_revision": expected_revision,
        "patch": normalized_patch,
    }
    request_json = _json_dumps(payload)
    payload_hash = _command_payload_hash(payload)
    conn = _get_conn()
    now = datetime.now().isoformat()

    try:
        conn.execute("BEGIN IMMEDIATE")
        _assert_user_accepts_writes(conn, user_id)
        replay = conn.execute(
            """SELECT command_type, payload_hash, response_json
               FROM schedule_event_commands
               WHERE user_id = ? AND client_request_id = ?""",
            (user_id, client_request_id),
        ).fetchone()
        if replay is not None:
            if replay["command_type"] != "edit" or replay["payload_hash"] != payload_hash:
                raise ScheduleCommandConflict(
                    "idempotency_key_reused", code="idempotency_key_reused"
                )
            conn.commit()
            return json.loads(replay["response_json"])

        row = conn.execute(
            """SELECT * FROM schedule_events
               WHERE id = ? AND user_id = ? AND deleted_at IS NULL""",
            (event_id, user_id),
        ).fetchone()
        if row is None:
            conn.rollback()
            return None
        event = _row_to_dict(row)
        previous_revision = int(event.get("revision") or 1)
        if expected_revision is not None and expected_revision != previous_revision:
            raise ScheduleCommandConflict("revision_conflict", code="revision_conflict")
        if event.get("event_type") == "once" and scope != "series":
            raise ValueError("一次性日程只支持 series 编辑")

        segments = _load_segments(conn, event_id, user_id)
        selected = _materialize_occurrence(
            conn, event, occurrence_date, user_id, segments=segments, include_patch=True
        )
        if selected is None:
            raise ValueError("occurrence_date 不是该重复日程的有效实例")

        changed = False
        segment_id: Optional[int] = None
        recurrence_changed = False
        next_revision = previous_revision + 1

        if scope == "occurrence":
            if set(normalized_patch) & (RECURRENCE_FIELDS | {"event_type"}):
                raise ValueError("单个实例不能修改重复规则")
            base_event = _materialize_occurrence(
                conn,
                event,
                occurrence_date,
                user_id,
                segments=segments,
                include_patch=False,
            )
            if base_event is None:
                raise ValueError("occurrence_date 不是该重复日程的有效实例")
            current_template = _event_template(selected)
            desired = _apply_template_patch(current_template, normalized_patch)
            changed = not _template_equal(current_template, desired)
            if changed:
                sparse_patch = _template_diff(_event_template(base_event), desired)
                if sparse_patch:
                    conn.execute(
                        """INSERT INTO schedule_event_exceptions
                           (user_id, source_event_id, occurrence_date, exception_type,
                            patch_json, patch_revision, orphaned_at_revision, created_at, updated_at)
                           VALUES (?, ?, ?, 'patch', ?, ?, NULL, ?, ?)
                           ON CONFLICT(user_id, source_event_id, occurrence_date, exception_type)
                           DO UPDATE SET patch_json = excluded.patch_json,
                                         patch_revision = excluded.patch_revision,
                                         orphaned_at_revision = NULL,
                                         updated_at = excluded.updated_at""",
                        (
                            user_id,
                            event_id,
                            occurrence_date,
                            _json_dumps(sparse_patch),
                            next_revision,
                            now,
                            now,
                        ),
                    )
                else:
                    conn.execute(
                        """DELETE FROM schedule_event_exceptions
                           WHERE user_id = ? AND source_event_id = ?
                             AND occurrence_date = ? AND exception_type = 'patch'""",
                        (user_id, event_id, occurrence_date),
                    )

        elif scope == "following":
            base_event = _materialize_occurrence(
                conn,
                event,
                occurrence_date,
                user_id,
                segments=segments,
                include_patch=False,
                before_effective=occurrence_date,
            )
            current_event = _materialize_occurrence(
                conn,
                event,
                occurrence_date,
                user_id,
                segments=segments,
                include_patch=False,
            )
            if base_event is None or current_event is None:
                raise ValueError("occurrence_date 不是该重复日程的有效实例")
            current_template = _event_template(current_event)
            desired = _apply_template_patch(current_template, normalized_patch)
            _validate_template_until(desired, occurrence_date)
            following_changes = _template_diff(current_template, desired)
            changed = bool(following_changes)
            recurrence_changed = bool(set(following_changes) & RECURRENCE_GEOMETRY_FIELDS)
            if changed:
                sparse_patch = _template_diff(_event_template(base_event), desired)
                existing_segment = next(
                    (
                        item for item in segments
                        if item["effective_from_occurrence_date"] == occurrence_date
                    ),
                    None,
                )
                if sparse_patch:
                    conn.execute(
                        """INSERT INTO schedule_event_segments
                           (user_id, source_event_id, effective_from_occurrence_date,
                            patch_json, template_json, segment_revision, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT(source_event_id, effective_from_occurrence_date)
                           DO UPDATE SET patch_json = excluded.patch_json,
                                         template_json = excluded.template_json,
                                         segment_revision = excluded.segment_revision,
                                         updated_at = excluded.updated_at""",
                        (
                            user_id,
                            event_id,
                            occurrence_date,
                            _json_dumps(sparse_patch),
                            _json_dumps(desired),
                            next_revision,
                            now,
                            now,
                        ),
                    )
                elif existing_segment is not None:
                    conn.execute(
                        "DELETE FROM schedule_event_segments WHERE id = ? AND user_id = ?",
                        (int(existing_segment["id"]), user_id),
                    )

        else:
            current_template = _event_template(event)
            desired = _apply_template_patch(current_template, normalized_patch)
            _validate_template_until(desired, desired["start_date"])
            changed_fields = _template_diff(current_template, desired)
            changed = bool(changed_fields)
            recurrence_changed = bool(set(changed_fields) & RECURRENCE_GEOMETRY_FIELDS)
            if changed:
                _update_root_template(
                    conn,
                    event,
                    desired,
                    changed_fields,
                    user_id,
                    now,
                    next_revision,
                )

        if changed:
            if scope != "series":
                conn.execute(
                    """UPDATE schedule_events
                       SET revision = ?, updated_at = ? WHERE id = ? AND user_id = ?""",
                    (next_revision, now, event_id, user_id),
                )
            current_row = conn.execute(
                "SELECT * FROM schedule_events WHERE id = ? AND user_id = ?",
                (event_id, user_id),
            ).fetchone()
            event = _row_to_dict(current_row)
            if scope in {"following", "series"}:
                _rebase_segments(
                    conn,
                    event,
                    user_id,
                    now,
                    next_revision,
                    validate_anchors=recurrence_changed,
                )
            if recurrence_changed:
                _refresh_exception_orphans(conn, event, user_id, next_revision)

        current_row = conn.execute(
            "SELECT * FROM schedule_events WHERE id = ? AND user_id = ?",
            (event_id, user_id),
        ).fetchone()
        current_event = _row_to_dict(current_row)
        _attach_excluded_occurrences(conn, [current_event], user_id)
        current_segments = _load_segments(conn, event_id, user_id)
        if scope == "series":
            response_event = _base_occurrence(current_event)
        else:
            response_event = _materialize_occurrence(
                conn,
                current_event,
                occurrence_date,
                user_id,
                segments=current_segments,
                include_patch=True,
                require_match=False,
            )
            if response_event is None:
                raise RuntimeError("edited occurrence could not be materialized")
        if scope == "following":
            segment = next(
                (
                    item for item in current_segments
                    if item["effective_from_occurrence_date"] == occurrence_date
                ),
                None,
            )
            segment_id = int(segment["id"]) if segment is not None else None

        revision = int(current_event.get("revision") or previous_revision)
        affected_range = _event_command_range(
            scope, occurrence_date, current_event, response_event
        )
        reminder_rebuild = None
        if changed:
            reminder_rebuild = {
                "token": f"event-edit:{event_id}:{revision}:{client_request_id}",
                **affected_range,
            }
        response = {
            "client_request_id": client_request_id,
            "source_event_id": event_id,
            "canonical_ref": {
                "source_event_id": event_id,
                "occurrence_date": occurrence_date,
            },
            "scope": scope,
            "segment_id": segment_id,
            "previous_revision": previous_revision,
            "revision": revision,
            "changed": changed,
            "event": response_event,
            "affected_range": affected_range,
            "reminder_rebuild": reminder_rebuild,
        }
        response_json = json.dumps(response, ensure_ascii=False, sort_keys=True)
        conn.execute(
            """INSERT INTO schedule_event_commands
               (user_id, client_request_id, source_event_id, payload_hash, response_json,
                command_type, request_json, created_at, completed_at)
               VALUES (?, ?, ?, ?, ?, 'edit', ?, ?, ?)""",
            (
                user_id,
                client_request_id,
                event_id,
                payload_hash,
                response_json,
                request_json,
                now,
                now,
            ),
        )
        conn.commit()
        return response
    except Exception:
        conn.rollback()
        raise


def get_event_command(
    client_request_id: str,
    user_id: int,
    command_type: str = "edit",
) -> Optional[Dict[str, Any]]:
    _init_db()
    row = _get_conn().execute(
        """SELECT response_json FROM schedule_event_commands
           WHERE user_id = ? AND client_request_id = ? AND command_type = ?""",
        (user_id, (client_request_id or "").strip(), command_type),
    ).fetchone()
    return json.loads(row["response_json"]) if row is not None else None


# Both names are kept because callers in staging historically used verb-first service names.
edit_event_command = command_event_edit
get_event_edit_command = get_event_command


def command_event_state(
    event_id: int,
    user_id: int,
    client_request_id: str,
    desired_state: str,
    scope: str = "series",
    occurrence_date: Optional[str] = None,
    expected_revision: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Apply a replay-safe desired-state command without changing the source id."""
    _init_db()
    client_request_id = (client_request_id or "").strip()
    if not client_request_id:
        raise ValueError("client_request_id 不能为空")
    if desired_state not in {"present", "absent"}:
        raise ValueError("desired_state 不受支持")
    if scope not in {"occurrence", "following", "series"}:
        raise ValueError("scope 不受支持")

    payload = {
        "event_id": event_id,
        "desired_state": desired_state,
        "scope": scope,
        "occurrence_date": occurrence_date,
        "expected_revision": expected_revision,
    }
    payload_hash = _command_payload_hash(payload)
    conn = _get_conn()
    now = datetime.now().isoformat()
    try:
        conn.execute("BEGIN IMMEDIATE")
        _assert_user_accepts_writes(conn, user_id)
        replay = conn.execute(
            """SELECT command_type, payload_hash, response_json FROM schedule_event_commands
               WHERE user_id = ? AND client_request_id = ?""",
            (user_id, client_request_id),
        ).fetchone()
        if replay is not None:
            if replay["command_type"] != "state" or replay["payload_hash"] != payload_hash:
                raise ScheduleCommandConflict("同一事件命令标识不能用于不同操作")
            conn.commit()
            return json.loads(replay["response_json"])

        row = conn.execute(
            "SELECT * FROM schedule_events WHERE id = ? AND user_id = ?",
            (event_id, user_id),
        ).fetchone()
        if row is None:
            conn.rollback()
            return None
        event = _row_to_dict(row)
        if expected_revision is not None and event["revision"] != expected_revision:
            raise ScheduleCommandConflict(
                f"日程版本已变化，当前版本为 {event['revision']}"
            )

        effective_scope = scope
        if event.get("event_type") == "once":
            effective_scope = "series"
            occurrence_date = event["start_date"]
        elif effective_scope != "series":
            if occurrence_date is None:
                raise ValueError("实例或此后操作必须提供 occurrence_date")
            if _materialize_occurrence(
                conn,
                event,
                occurrence_date,
                user_id,
                include_patch=False,
                require_match=True,
            ) is None:
                raise ValueError("occurrence_date 不是该重复日程的有效实例")

        changed = False
        if effective_scope == "series":
            currently_present = event.get("deleted_at") is None
            should_be_present = desired_state == "present"
            if currently_present != should_be_present:
                conn.execute(
                    """UPDATE schedule_events
                       SET deleted_at = ?, updated_at = ?, revision = revision + 1
                       WHERE id = ? AND user_id = ?""",
                    (None if should_be_present else now, now, event_id, user_id),
                )
                changed = True
        elif event.get("deleted_at") is not None:
            raise ScheduleCommandConflict("整个重复系列已删除，不能单独修改实例状态")
        elif effective_scope == "occurrence":
            if desired_state == "absent":
                cur = conn.execute(
                    """INSERT OR IGNORE INTO schedule_event_exceptions
                       (user_id, source_event_id, occurrence_date, exception_type, created_at, updated_at)
                       VALUES (?, ?, ?, 'deleted', ?, ?)""",
                    (user_id, event_id, occurrence_date, now, now),
                )
            else:
                cur = conn.execute(
                    """DELETE FROM schedule_event_exceptions
                       WHERE user_id = ? AND source_event_id = ?
                         AND occurrence_date = ? AND exception_type = 'deleted'""",
                    (user_id, event_id, occurrence_date),
                )
            changed = cur.rowcount > 0
        else:
            current_cutoff = event.get("excluded_after_date")
            if desired_state == "absent":
                next_cutoff = min(current_cutoff, occurrence_date) if current_cutoff else occurrence_date
                if next_cutoff != current_cutoff:
                    conn.execute(
                        """UPDATE schedule_events SET excluded_after_date = ?, updated_at = ?
                           WHERE id = ? AND user_id = ?""",
                        (next_cutoff, now, event_id, user_id),
                    )
                    changed = True
            elif current_cutoff is None:
                changed = False
            elif current_cutoff != occurrence_date:
                raise ScheduleCommandConflict("此后日程的截断点已经变化")
            else:
                conn.execute(
                    """UPDATE schedule_events SET excluded_after_date = NULL, updated_at = ?
                       WHERE id = ? AND user_id = ?""",
                    (now, event_id, user_id),
                )
                changed = True

        if changed and effective_scope != "series":
            conn.execute(
                "UPDATE schedule_events SET revision = revision + 1 WHERE id = ? AND user_id = ?",
                (event_id, user_id),
            )
        current = conn.execute(
            "SELECT * FROM schedule_events WHERE id = ? AND user_id = ?",
            (event_id, user_id),
        ).fetchone()
        current_event = _row_to_dict(current)
        _attach_excluded_occurrences(conn, [current_event], user_id)
        observed_state = desired_state
        response = {
            "client_request_id": client_request_id,
            "source_event_id": event_id,
            "desired_state": desired_state,
            "observed_state": observed_state,
            "scope": effective_scope,
            "occurrence_date": occurrence_date,
            "revision": int(current_event["revision"]),
            "changed": changed,
            "event": _base_occurrence(current_event) if desired_state == "present" else None,
        }
        response_json = json.dumps(response, ensure_ascii=False, sort_keys=True)
        conn.execute(
            """INSERT INTO schedule_event_commands
               (user_id, client_request_id, source_event_id, payload_hash, response_json,
                command_type, request_json, created_at, completed_at)
               VALUES (?, ?, ?, ?, ?, 'state', ?, ?, ?)""",
            (
                user_id,
                client_request_id,
                event_id,
                payload_hash,
                response_json,
                _json_dumps(payload),
                now,
                now,
            ),
        )
        conn.commit()
        return response
    except Exception:
        conn.rollback()
        raise


def _iso_date_or_none(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    try:
        _parse_iso_date(value)
    except ValueError:
        return None
    return value


def _earliest_exclusive_boundary(*values: Optional[str]) -> Optional[str]:
    boundaries = [value for value in values if _iso_date_or_none(value) is not None]
    return min(boundaries) if boundaries else None


def _catalog_template_entry(
    source_event: Dict[str, Any],
    template: Dict[str, Any],
    effective_from: str,
    segment_id: Optional[int],
    excluded_after: Optional[str],
    excluded_occurrence_dates: List[str],
) -> Dict[str, Any]:
    source_id = int(source_event["id"])
    effective_iso = _iso_date_or_none(effective_from)
    entry = source_event.copy()
    entry.update(template)
    entry.update({
        "id": source_id,
        "source_event_id": source_id,
        "occurrence_date": effective_iso or source_event.get("start_date"),
        "occurrence_id": (
            str(source_id) if segment_id is None else f"catalog:{source_id}:segment:{segment_id}"
        ),
        "is_expanded": False,
        "is_recurrence_exception": False,
        "segment_id": segment_id,
        "recurrence_effective_from_date": effective_iso,
        "series_start_date": template.get("start_date"),
        "series_end_date": template.get("end_date"),
        "excluded_after_date": excluded_after,
        "excluded_occurrence_dates": sorted(set(excluded_occurrence_dates)),
        "is_all_day": bool(template.get("is_all_day")),
        "spanning": bool(
            template.get("end_date")
            and template.get("end_date") != template.get("start_date")
        ),
        "revision": int(source_event.get("revision") or 1),
    })
    return entry


def _build_event_catalog(
    events: List[Dict[str, Any]],
    user_id: Optional[int],
) -> List[Dict[str, Any]]:
    """Return locally-expandable root/segment templates plus one-off patch entries."""
    conn = _get_conn()
    catalog: List[Dict[str, Any]] = []
    for source_event in events:
        source_id = int(source_event["id"])
        if source_event.get("event_type") == "once":
            entry = _base_occurrence(source_event)
            entry["recurrence_effective_from_date"] = _iso_date_or_none(
                source_event.get("start_date")
            )
            catalog.append(entry)
            continue

        source_cutoff = _iso_date_or_none(source_event.get("excluded_after_date"))
        segments = [
            segment
            for segment in _load_segments(conn, source_id, user_id)
            if source_cutoff is None
            or segment["effective_from_occurrence_date"] < source_cutoff
        ]
        contexts: List[Tuple[Dict[str, Any], str, Optional[int]]] = [
            (_event_template(source_event), source_event["start_date"], None)
        ]
        contexts.extend(
            (
                segment.get("template") or _event_template(source_event),
                segment["effective_from_occurrence_date"],
                int(segment["id"]),
            )
            for segment in segments
        )

        exception_rows = _active_exception_rows(conn, source_id, user_id)
        patch_rows = {
            row["occurrence_date"]: row
            for row in exception_rows
            if row["exception_type"] == "patch"
        }
        deleted_anchors = {
            row["occurrence_date"]
            for row in exception_rows
            if row["exception_type"] == "deleted"
        }
        excluded_anchors = set(patch_rows) | deleted_anchors

        for index, (template, effective_from, segment_id) in enumerate(contexts):
            next_effective = contexts[index + 1][1] if index + 1 < len(contexts) else None
            boundary = _earliest_exclusive_boundary(next_effective, source_cutoff)
            effective_iso = _iso_date_or_none(effective_from)
            owned_exclusions = [
                anchor
                for anchor in excluded_anchors
                if (effective_iso is None or anchor >= effective_iso)
                and (boundary is None or anchor < boundary)
            ]
            catalog.append(
                _catalog_template_entry(
                    source_event,
                    template,
                    effective_from,
                    segment_id,
                    boundary,
                    owned_exclusions,
                )
            )

        for occurrence_date in sorted(patch_rows):
            if occurrence_date in deleted_anchors:
                continue
            if source_cutoff is not None and occurrence_date >= source_cutoff:
                continue
            exception = _materialize_occurrence(
                conn,
                source_event,
                occurrence_date,
                user_id,
                segments=segments,
                include_patch=True,
                require_match=True,
            )
            if exception is None:
                continue
            exception.update({
                "event_type": "once",
                "is_expanded": False,
                "is_recurrence_exception": True,
                "recurrence_effective_from_date": occurrence_date,
                "recurrence_interval": 1,
                "recurrence_weekdays": None,
                "recurrence_until_date": None,
                "excluded_after_date": None,
                "excluded_occurrence_dates": [],
            })
            catalog.append(exception)
    return catalog


def list_events(
    year: Optional[int] = None,
    month: Optional[int] = None,
    day: Optional[int] = None,
    user_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """
    按年月查询日程，monthly/weekly/daily 事件会在查询时动态展开。
    - year + month: 返回该月所有事件（含重复展开）
    - day: 返回该日所有事件
    - 无年月/日: 返回可供客户端本地展开的根、分段与单次例外 catalog
    """
    _init_db()
    conn = _get_conn()
    user_clause = "deleted_at IS NULL AND " if user_id is None else "user_id = ? AND deleted_at IS NULL AND "
    user_params = tuple() if user_id is None else (user_id,)

    if year and month:
        from calendar import monthrange

        month_str = f"{year}-{month:02d}"
        month_start = f"{month_str}-01"
        month_end = f"{month_str}-{monthrange(year, month)[1]:02d}"
        pattern = f"{month_str}%"
        rows = conn.execute(
            f"""
            SELECT * FROM schedule_events
            WHERE {user_clause}(
                start_date LIKE ?
                OR event_type IN ('daily', 'weekly', 'monthly', 'yearly')
                OR (end_date IS NOT NULL AND start_date <= ? AND end_date >= ?)
            )
            ORDER BY start_time, id
            """,
            (*user_params, pattern, month_end, month_start),
        ).fetchall()
        events = [_row_to_dict(r) for r in rows]
    elif day:
        day_str = day if isinstance(day, str) else str(day)
        rows = conn.execute(
            f"""
            SELECT * FROM schedule_events
            WHERE {user_clause}(
                start_date = ?
                OR (end_date IS NOT NULL AND start_date <= ? AND end_date >= ?)
            )
            ORDER BY start_time, id
            """,
            (*user_params, day_str, day_str, day_str),
        ).fetchall()
        events = [_row_to_dict(r) for r in rows]
    else:
        rows = conn.execute(
            f"SELECT * FROM schedule_events WHERE {user_clause}1 = 1 ORDER BY start_date, start_time, id",
            user_params,
        ).fetchall()
        events = [_row_to_dict(r) for r in rows]

    if year and month:
        _attach_excluded_occurrences(conn, events, user_id=user_id)
        events = _expand_recurring_events(events, year, month, user_id=user_id)
        events = _exclude_deleted_occurrences(events, user_id=user_id)
    elif not day:
        events = _build_event_catalog(events, user_id=user_id)
    else:
        _attach_excluded_occurrences(conn, events, user_id=user_id)

    events.sort(key=lambda e: (
        e["start_date"],
        e["start_time"] or "",
        e["id"],
    ))
    return events


def _exclude_deleted_occurrences(
    events: List[Dict[str, Any]],
    user_id: Optional[int],
) -> List[Dict[str, Any]]:
    source_ids = sorted({int(event["source_event_id"]) for event in events if event.get("source_event_id")})
    if not source_ids:
        return events
    placeholders = ",".join("?" for _ in source_ids)
    conn = _get_conn()
    if user_id is None:
        rows = conn.execute(
            f"""SELECT source_event_id, occurrence_date FROM schedule_event_exceptions
                WHERE source_event_id IN ({placeholders}) AND exception_type = 'deleted'
                  AND orphaned_at_revision IS NULL""",
            source_ids,
        ).fetchall()
    else:
        rows = conn.execute(
            f"""SELECT source_event_id, occurrence_date FROM schedule_event_exceptions
                WHERE user_id = ? AND source_event_id IN ({placeholders})
                  AND exception_type = 'deleted' AND orphaned_at_revision IS NULL""",
            (user_id, *source_ids),
        ).fetchall()
    deleted = {(int(row["source_event_id"]), row["occurrence_date"]) for row in rows}
    return [
        event for event in events
        if (int(event["source_event_id"]), event.get("occurrence_date")) not in deleted
    ]


def _event_overlaps_month(ev: Dict[str, Any], year: int, month: int) -> bool:
    """Return whether a one-off event intersects the target month."""
    from calendar import monthrange

    month_start = f"{year}-{month:02d}-01"
    month_end = f"{year}-{month:02d}-{monthrange(year, month)[1]:02d}"
    start = ev.get("start_date") or ""
    end = ev.get("end_date") or start
    return bool(start and start <= month_end and end >= month_start)


def _expand_recurring_events(
    events: List[Dict[str, Any]],
    year: int,
    month: int,
    user_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Expand roots using segment templates, then occurrence patches."""
    from calendar import monthrange
    _, days_in_month = monthrange(year, month)
    month_start = date(year, month, 1)
    month_end = date(year, month, days_in_month)
    conn = _get_conn()

    expanded: List[Dict[str, Any]] = []
    for ev in events:
        et = ev.get("event_type", "once")

        if et == "once":
            if _event_overlaps_month(ev, year, month):
                expanded.append(_base_occurrence(ev))
            continue

        source_start = ev.get("start_date", "")
        source_parts = source_start.split("-") if isinstance(source_start, str) else []
        if len(source_parts) == 2 and et in {"monthly", "yearly"}:
            month_day = _extract_md(source_start)
            if month_day is None:
                continue
            for day_number in range(1, days_in_month + 1):
                cursor = date(year, month, day_number)
                matches = (
                    et == "monthly" and cursor.day == month_day[1]
                ) or (
                    et == "yearly" and (cursor.month, cursor.day) == month_day
                )
                if not matches:
                    continue
                occurrence_date = cursor.isoformat()
                if ev.get("excluded_after_date") and occurrence_date >= ev["excluded_after_date"]:
                    continue
                expanded.append(_expanded_occurrence(ev, occurrence_date))
            continue

        segments = _load_segments(conn, int(ev["id"]), user_id)
        contexts: List[Tuple[Dict[str, Any], str]] = [(_event_template(ev), ev["start_date"])]
        contexts.extend(
            (segment.get("template") or _event_template(ev), segment["effective_from_occurrence_date"])
            for segment in segments
        )
        lower_bounds: List[date] = []
        upper_bounds: List[date] = []
        for template, effective_from in contexts:
            try:
                offset = (
                    _parse_iso_date(template["start_date"]) - _parse_iso_date(effective_from)
                ).days
                duration = _series_duration_days(template)
            except (KeyError, TypeError, ValueError):
                continue
            lower_bounds.append(month_start - timedelta(days=offset + duration))
            upper_bounds.append(month_end - timedelta(days=offset))
        if not lower_bounds:
            continue
        cursor = max(min(lower_bounds), _parse_iso_date(ev["start_date"]))
        cursor_end = max(upper_bounds)
        candidates: set[str] = set()
        while cursor <= cursor_end:
            candidates.add(cursor.isoformat())
            cursor += timedelta(days=1)
        for exception in _active_exception_rows(conn, int(ev["id"]), user_id):
            if exception["exception_type"] == "patch":
                candidates.add(exception["occurrence_date"])

        for occurrence_date in sorted(candidates):
            occurrence = _materialize_occurrence(
                conn,
                ev,
                occurrence_date,
                user_id,
                segments=segments,
                include_patch=True,
                require_match=True,
            )
            if occurrence is None:
                continue
            excluded_after = ev.get("excluded_after_date")
            if excluded_after and occurrence_date >= excluded_after:
                continue
            if _event_overlaps_month(occurrence, year, month):
                expanded.append(occurrence)

    return expanded


def _before_series_start(occurrence_date: str, series_start: str) -> bool:
    return isinstance(series_start, str) and len(series_start) == 10 and series_start.count("-") == 2 and occurrence_date < series_start


def _series_duration_days(event: Dict[str, Any]) -> int:
    source_start = event.get("start_date")
    source_end = event.get("end_date")
    if not source_start or not source_end:
        return 0
    try:
        return max(
            0,
            (datetime.strptime(source_end, "%Y-%m-%d") - datetime.strptime(source_start, "%Y-%m-%d")).days,
        )
    except ValueError:
        return 0


def _base_occurrence(event: Dict[str, Any]) -> Dict[str, Any]:
    result = event.copy()
    source_id = int(event["id"])
    result.update({
        "source_event_id": source_id,
        "occurrence_date": event.get("start_date"),
        "occurrence_id": str(source_id),
        "is_expanded": False,
        "is_recurrence_exception": False,
        "segment_id": None,
        "recurrence_effective_from_date": _iso_date_or_none(event.get("start_date")),
        "series_start_date": event.get("start_date"),
        "series_end_date": event.get("end_date"),
    })
    return result


def _expanded_occurrence(event: Dict[str, Any], occurrence_date: str) -> Dict[str, Any]:
    result = _base_occurrence(event)
    source_id = int(event["id"])
    result["start_date"] = occurrence_date
    result["occurrence_date"] = occurrence_date
    result["occurrence_id"] = f"{source_id}@{occurrence_date}"
    result["is_expanded"] = True

    source_start = event.get("start_date")
    source_end = event.get("end_date")
    if source_end and source_start:
        try:
            duration_days = _series_duration_days(event)
            occurrence_end = datetime.strptime(occurrence_date, "%Y-%m-%d") + timedelta(days=duration_days)
            result["end_date"] = occurrence_end.strftime("%Y-%m-%d")
            result["spanning"] = duration_days > 0
        except ValueError:
            result["end_date"] = source_end
    return result


def _date_day_of_week(date_str: str) -> int:
    """返回日期的星期几（1=周一，7=周日）"""
    try:
        if "-" in date_str:
            parts = date_str.split("-")
            if len(parts) == 3:
                return datetime.strptime(date_str, "%Y-%m-%d").weekday() + 1
            if len(parts) == 2:
                today = date.today()
                year = today.year
                dt = datetime.strptime(f"{year}-{parts[0]}-{parts[1]}", "%Y-%m-%d")
                return dt.weekday() + 1
    except Exception:
        pass
    return 1


def _extract_md(date_str: str) -> Optional[tuple]:
    """从日期字符串提取 (month, day)"""
    try:
        if "-" in date_str:
            parts = date_str.split("-")
            if len(parts) == 3:
                return int(parts[1]), int(parts[2])
            if len(parts) == 2:
                return int(parts[0]), int(parts[1])
    except Exception:
        pass
    return None


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    d = dict(row)
    d["is_all_day"] = bool(d.get("is_all_day"))
    d["spanning"] = bool(d.get("end_date") and d.get("end_date") != d.get("start_date"))
    d["recurrence_interval"] = int(d.get("recurrence_interval") or 1)
    raw_weekdays = d.get("recurrence_weekdays_json")
    if raw_weekdays:
        try:
            decoded = json.loads(raw_weekdays)
            d["recurrence_weekdays"] = _normalize_weekdays(decoded)
        except (TypeError, ValueError, json.JSONDecodeError):
            d["recurrence_weekdays"] = None
    else:
        d["recurrence_weekdays"] = None
    d.setdefault("recurrence_until_date", None)
    d.setdefault("excluded_occurrence_dates", [])
    d.setdefault("segment_id", None)
    d.setdefault("is_recurrence_exception", False)
    d.setdefault("recurrence_effective_from_date", None)
    return d
