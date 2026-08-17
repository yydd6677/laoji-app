"""Cross-store cleanup for a LaoJi account.

Account data spans the lightweight auth/schedule SQLite database, the meeting
database, and meeting artifacts on disk. This module owns the meeting side of
the deletion workflow. The auth row is deleted only after this cleanup returns
successfully, so a failed cleanup remains retryable with the original account.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import unquote

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.meeting import Meeting, MeetingSegment
from app.models.summary import FinalSummary, PeriodSummary
from app.models.transcript import TranscriptLine
from app.services.speaker_db_service import get_speaker_db


ACTIVE_MEETING_STATUSES = {"recording", "processing"}
TOMBSTONE_RETENTION_DAYS = 30
USER_DELETION_LEASE_SECONDS = 30 * 60


class AccountDeletionConflict(RuntimeError):
    """The account still has work that must finish before deletion."""


class AccountDeletionCleanupError(RuntimeError):
    """Meeting metadata was tombstoned, but one or more files need a retry."""


@dataclass(frozen=True)
class MeetingDeletionReport:
    meetings_deleted: int
    meeting_ids: tuple[str, ...]


def delete_user_voiceprints(user_id: int) -> int:
    """Delete every private voiceprint owned by an App account."""
    return get_speaker_db().delete_owned_speakers(int(user_id))


def _backend_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def _audio_root() -> Path:
    return Path(settings.audio_storage_abs_path).resolve()


def _summary_root() -> Path:
    return (_backend_dir() / "summaries").resolve()


def _sqlite_path_from_url(url: str) -> Path | None:
    prefix = "sqlite+aiosqlite:///"
    if not url.startswith(prefix):
        return None
    return Path(unquote(url[len(prefix):])).resolve()


async def _ensure_tombstone_schema(db: AsyncSession) -> None:
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS laoji_meeting_deletion_tombstones (
            meeting_id          VARCHAR(36) PRIMARY KEY,
            user_id             INTEGER,
            artifact_paths_json TEXT NOT NULL DEFAULT '[]',
            deleted_at          TEXT NOT NULL,
            cleaned_at          TEXT
        )
    """))
    await db.execute(text("""
        CREATE INDEX IF NOT EXISTS idx_laoji_meeting_deletion_user
        ON laoji_meeting_deletion_tombstones(user_id, deleted_at)
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS laoji_user_deletion_tombstones (
            user_id         INTEGER PRIMARY KEY,
            started_at      TEXT NOT NULL,
            active_until    REAL NOT NULL,
            operation_id    TEXT,
            deleted_at      TEXT
        )
    """))
    user_tombstone_columns = {
        str(row["name"])
        for row in (
            await db.execute(text("PRAGMA table_info(laoji_user_deletion_tombstones)"))
        ).mappings().all()
    }
    if "operation_id" not in user_tombstone_columns:
        await db.execute(
            text("ALTER TABLE laoji_user_deletion_tombstones ADD COLUMN operation_id TEXT")
        )
    await db.execute(text("DROP TRIGGER IF EXISTS laoji_block_deleted_user_meeting_insert"))
    await db.execute(text("""
        CREATE TRIGGER laoji_block_deleted_user_meeting_insert
        BEFORE INSERT ON meetings
        WHEN NEW.app_owned = 1 AND NEW.user_id IS NOT NULL
          AND COALESCE(NULLIF(TRIM(NEW.data_epoch_id), ''), '') = ''
          AND EXISTS (
            SELECT 1 FROM laoji_user_deletion_tombstones tombstone
            WHERE tombstone.user_id = NEW.user_id
              AND (tombstone.deleted_at IS NOT NULL
                   OR tombstone.active_until > CAST(strftime('%s', 'now') AS REAL))
        )
        BEGIN
            SELECT RAISE(ABORT, 'account deletion in progress');
        END
    """))
    await db.execute(text("DROP TRIGGER IF EXISTS laoji_block_deleted_user_meeting_update"))
    await db.execute(text("""
        CREATE TRIGGER laoji_block_deleted_user_meeting_update
        BEFORE UPDATE ON meetings
        WHEN NEW.app_owned = 1 AND NEW.user_id IS NOT NULL
          AND COALESCE(NULLIF(TRIM(NEW.data_epoch_id), ''), '') = ''
          AND EXISTS (
            SELECT 1 FROM laoji_user_deletion_tombstones tombstone
            WHERE tombstone.user_id = NEW.user_id
              AND (tombstone.deleted_at IS NOT NULL
                   OR tombstone.active_until > CAST(strftime('%s', 'now') AS REAL))
        )
        BEGIN
            SELECT RAISE(ABORT, 'account deletion in progress');
        END
    """))
    cutoff = (datetime.utcnow() - timedelta(days=TOMBSTONE_RETENTION_DAYS)).isoformat()
    await db.execute(
        text("""
            DELETE FROM laoji_meeting_deletion_tombstones
            WHERE user_id IS NULL AND cleaned_at IS NOT NULL AND cleaned_at < :cutoff
        """),
        {"cutoff": cutoff},
    )
    await db.execute(
        text("""
            DELETE FROM laoji_user_deletion_tombstones
            WHERE deleted_at IS NOT NULL AND deleted_at < :cutoff
        """),
        {"cutoff": cutoff},
    )


def _summary_artifacts(meeting_id: str) -> list[Path]:
    prefix = meeting_id[:8]
    paths: list[Path] = []
    patterns = (
        (_summary_root() / "final", f"final_{meeting_id}_*"),
        (_summary_root() / "final", f"final3_{meeting_id}_*"),
        (_summary_root() / "period", f"period_{meeting_id}_*"),
        (_summary_root() / "final", f"final_{prefix}*"),
        (_summary_root() / "final", f"final3_{prefix}*"),
        (_summary_root() / "period", f"period_{prefix}*"),
    )
    for directory, pattern in patterns:
        if directory.exists():
            paths.extend(path for path in directory.glob(pattern) if path.is_file() or path.is_symlink())
    return paths


def _path_is_inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return path != root
    except ValueError:
        return False


def _remove_artifact(path_value: str) -> None:
    path = Path(path_value).expanduser().resolve(strict=False)
    allowed = (_audio_root(), _summary_root())
    if not any(_path_is_inside(path, root) for root in allowed):
        raise ValueError(f"refusing to delete artifact outside managed storage: {path}")
    if not path.exists() and not path.is_symlink():
        return
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def is_meeting_tombstoned(meeting_id: str) -> bool:
    """Synchronous guard used by background summary workers before DB writes."""
    db_path = _sqlite_path_from_url(settings.DATABASE_URL)
    if db_path is None or not db_path.exists():
        return False
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='laoji_meeting_deletion_tombstones'"
        ).fetchone()
        if not exists:
            return False
        return conn.execute(
            "SELECT 1 FROM laoji_meeting_deletion_tombstones WHERE meeting_id = ?",
            (meeting_id,),
        ).fetchone() is not None
    finally:
        conn.close()


def is_user_meeting_tombstoned(user_id: int) -> bool:
    """Return whether an App account is currently or permanently guarded from writes."""
    db_path = _sqlite_path_from_url(settings.DATABASE_URL)
    if db_path is None or not db_path.exists():
        return False
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        exists = conn.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type='table' AND name='laoji_user_deletion_tombstones'
            """
        ).fetchone()
        if not exists:
            return False
        row = conn.execute(
            """
            SELECT active_until, deleted_at
            FROM laoji_user_deletion_tombstones WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()
        return bool(row and (row[1] is not None or float(row[0]) > time.time()))
    finally:
        conn.close()


def _normalize_operation_id(operation_id: str) -> str:
    normalized = operation_id.strip()
    if not normalized or len(normalized) > 120:
        raise ValueError("账号删除操作标识不正确")
    return normalized


async def _assert_user_deletion_operation(
    user_id: int,
    db: AsyncSession,
    operation_id: str,
) -> None:
    operation = _normalize_operation_id(operation_id)
    row = (
        await db.execute(
            text("""
                SELECT operation_id, active_until, deleted_at
                FROM laoji_user_deletion_tombstones WHERE user_id = :user_id
            """),
            {"user_id": user_id},
        )
    ).mappings().first()
    if (
        row is None
        or row["deleted_at"] is not None
        or str(row["operation_id"] or "") != operation
        or float(row["active_until"] or 0) <= time.time()
    ):
        raise AccountDeletionConflict("账号删除操作租约已失效或由其他请求持有")


async def begin_user_meeting_deletion(
    user_id: int,
    db: AsyncSession,
    operation_id: str,
) -> None:
    """Install a leased database guard before any account-owned meetings are removed."""
    await _ensure_tombstone_schema(db)
    operation = _normalize_operation_id(operation_id)
    now = datetime.utcnow().isoformat()
    now_timestamp = time.time()
    await db.execute(
        text("""
            INSERT INTO laoji_user_deletion_tombstones
                (user_id, started_at, active_until, operation_id, deleted_at)
            VALUES (:user_id, :started_at, :active_until, :operation_id, NULL)
            ON CONFLICT(user_id) DO UPDATE SET
                started_at = excluded.started_at,
                active_until = excluded.active_until,
                operation_id = excluded.operation_id,
                deleted_at = NULL
            WHERE laoji_user_deletion_tombstones.deleted_at IS NULL
              AND (
                laoji_user_deletion_tombstones.active_until <= :now_timestamp
                OR laoji_user_deletion_tombstones.operation_id = :operation_id
              )
        """),
        {
            "user_id": user_id,
            "started_at": now,
            "active_until": now_timestamp + USER_DELETION_LEASE_SECONDS,
            "now_timestamp": now_timestamp,
            "operation_id": operation,
        },
    )
    owner = (
        await db.execute(
            text("""
                SELECT operation_id, active_until, deleted_at
                FROM laoji_user_deletion_tombstones WHERE user_id = :user_id
            """),
            {"user_id": user_id},
        )
    ).mappings().first()
    if (
        owner is None
        or owner["deleted_at"] is not None
        or str(owner["operation_id"] or "") != operation
        or float(owner["active_until"] or 0) <= now_timestamp
    ):
        await db.rollback()
        raise AccountDeletionConflict("另一项账号删除操作正在进行，请稍后重试")
    await db.commit()


async def cancel_user_meeting_deletion(
    user_id: int,
    db: AsyncSession,
    operation_id: str,
) -> None:
    """Remove an unfinished leased guard after a retryable deletion failure."""
    await _ensure_tombstone_schema(db)
    await db.execute(
        text("""
            DELETE FROM laoji_user_deletion_tombstones
            WHERE user_id = :user_id AND deleted_at IS NULL
              AND operation_id = :operation_id
        """),
        {"user_id": user_id, "operation_id": _normalize_operation_id(operation_id)},
    )
    await db.commit()


async def finalize_user_deletion_guard(
    user_id: int,
    db: AsyncSession,
    operation_id: str,
) -> None:
    """Retain a short pseudonymous guard against late in-flight meeting writes."""
    await _ensure_tombstone_schema(db)
    result = await db.execute(
        text("""
            UPDATE laoji_user_deletion_tombstones
            SET active_until = 0, operation_id = NULL, deleted_at = :deleted_at
            WHERE user_id = :user_id AND operation_id = :operation_id
        """),
        {
            "user_id": user_id,
            "operation_id": _normalize_operation_id(operation_id),
            "deleted_at": datetime.utcnow().isoformat(),
        },
    )
    if result.rowcount != 1:
        await db.rollback()
        raise AccountDeletionCleanupError("账号删除写入保护未完成")
    await db.commit()


def remove_generated_summary_artifacts(meeting_id: str) -> None:
    for path in _summary_artifacts(meeting_id):
        _remove_artifact(str(path))


async def preflight_user_meeting_deletion(
    user_id: int,
    db: AsyncSession,
    operation_id: str,
) -> None:
    """Reject retryable conflicts before auth sessions are physically revoked."""
    await _ensure_tombstone_schema(db)
    await _assert_user_deletion_operation(user_id, db, operation_id)
    meeting_rows = (
        await db.execute(
            select(Meeting.id, Meeting.status)
            .where(Meeting.user_id == user_id, Meeting.app_owned == 1)
        )
    ).all()
    active = [str(row.id) for row in meeting_rows if (row.status or "").lower() in ACTIVE_MEETING_STATUSES]
    if active:
        raise AccountDeletionConflict("请先结束正在录制或处理中的会议")

    existing_tombstone_ids = set(
        str(value)
        for value in (
            await db.execute(
                text("""
                    SELECT meeting_id FROM laoji_meeting_deletion_tombstones
                    WHERE user_id = :user_id
                """),
                {"user_id": user_id},
            )
        ).scalars().all()
    )
    meeting_ids = {str(row.id) for row in meeting_rows} | existing_tombstone_ids
    if meeting_ids:
        all_ids = set((await db.execute(select(Meeting.id))).scalars().all())
        target_prefixes = {meeting_id[:8] for meeting_id in meeting_ids}
        if any(
            other_id not in meeting_ids and other_id[:8] in target_prefixes
            for other_id in all_ids
        ):
            raise AccountDeletionConflict("检测到会议文件前缀冲突，需要管理员人工清理")


async def delete_user_meeting_data(
    user_id: int,
    db: AsyncSession,
    operation_id: str,
) -> MeetingDeletionReport:
    """Delete App-owned meeting rows and managed artifacts for one account.

    Tombstones make retries idempotent and prevent a background summary worker
    from recreating data after the meeting rows are removed.
    """
    await _ensure_tombstone_schema(db)
    await preflight_user_meeting_deletion(user_id, db, operation_id)

    meeting_rows = (
        await db.execute(
            select(Meeting.id, Meeting.status, Meeting.audio_path)
            .where(Meeting.user_id == user_id, Meeting.app_owned == 1)
        )
    ).all()
    active = [str(row.id) for row in meeting_rows if (row.status or "").lower() in ACTIVE_MEETING_STATUSES]
    if active:
        raise AccountDeletionConflict("请先结束正在录制或处理中的会议")

    existing_tombstones = (
        await db.execute(
            text("""
                SELECT meeting_id, artifact_paths_json
                FROM laoji_meeting_deletion_tombstones
                WHERE user_id = :user_id
            """),
            {"user_id": user_id},
        )
    ).mappings().all()

    meeting_ids = {str(row.id) for row in meeting_rows}
    meeting_ids.update(str(row["meeting_id"]) for row in existing_tombstones)
    if meeting_ids:
        all_ids = set((await db.execute(select(Meeting.id))).scalars().all())
        targets_by_prefix = {meeting_id[:8]: meeting_id for meeting_id in meeting_ids}
        collision = next(
            (
                other_id
                for other_id in all_ids
                if other_id not in meeting_ids
                and other_id[:8] in targets_by_prefix
            ),
            None,
        )
        if collision is not None:
            raise AccountDeletionConflict("检测到会议文件前缀冲突，需要管理员人工清理")

    segment_paths: dict[str, list[str]] = {meeting_id: [] for meeting_id in meeting_ids}
    if meeting_ids:
        rows = (
            await db.execute(
                select(MeetingSegment.meeting_id, MeetingSegment.audio_path)
                .where(MeetingSegment.meeting_id.in_(meeting_ids))
            )
        ).all()
        for row in rows:
            if row.audio_path:
                segment_paths.setdefault(str(row.meeting_id), []).append(str(row.audio_path))

    paths_by_meeting: dict[str, set[str]] = {meeting_id: set() for meeting_id in meeting_ids}
    for row in existing_tombstones:
        try:
            stored = json.loads(row["artifact_paths_json"] or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            stored = []
        if isinstance(stored, list):
            paths_by_meeting.setdefault(str(row["meeting_id"]), set()).update(str(path) for path in stored)

    for row in meeting_rows:
        meeting_id = str(row.id)
        if row.audio_path:
            paths_by_meeting[meeting_id].add(str(row.audio_path))
        paths_by_meeting[meeting_id].update(segment_paths.get(meeting_id, []))
        paths_by_meeting[meeting_id].update(str(path) for path in _summary_artifacts(meeting_id))

    now = datetime.utcnow().isoformat()
    for meeting_id, paths in paths_by_meeting.items():
        await db.execute(
            text("""
                INSERT INTO laoji_meeting_deletion_tombstones
                    (meeting_id, user_id, artifact_paths_json, deleted_at, cleaned_at)
                VALUES (:meeting_id, :user_id, :paths, :deleted_at, NULL)
                ON CONFLICT(meeting_id) DO UPDATE SET
                    user_id = excluded.user_id,
                    artifact_paths_json = excluded.artifact_paths_json,
                    deleted_at = excluded.deleted_at,
                    cleaned_at = NULL
            """),
            {
                "meeting_id": meeting_id,
                "user_id": user_id,
                "paths": json.dumps(sorted(paths), ensure_ascii=True),
                "deleted_at": now,
            },
        )

    deleted_count = len(meeting_rows)
    if deleted_count:
        await db.execute(delete(TranscriptLine).where(TranscriptLine.meeting_id.in_(meeting_ids)))
        await db.execute(delete(PeriodSummary).where(PeriodSummary.meeting_id.in_(meeting_ids)))
        await db.execute(delete(FinalSummary).where(FinalSummary.meeting_id.in_(meeting_ids)))
        await db.execute(delete(MeetingSegment).where(MeetingSegment.meeting_id.in_(meeting_ids)))
        await db.execute(
            delete(Meeting).where(Meeting.user_id == user_id, Meeting.app_owned == 1)
        )
    await db.commit()

    failures: list[str] = []
    all_paths = {path for paths in paths_by_meeting.values() for path in paths}
    user_storage = _audio_root() / "app-meetings" / f"user-{user_id}"
    all_paths.add(str(user_storage))
    for path in sorted(all_paths, key=len, reverse=True):
        try:
            _remove_artifact(path)
        except Exception:
            failures.append(path)
    if failures:
        raise AccountDeletionCleanupError(f"仍有 {len(failures)} 个会议文件需要清理")

    return MeetingDeletionReport(
        meetings_deleted=deleted_count,
        meeting_ids=tuple(sorted(meeting_ids)),
    )


async def finalize_user_meeting_deletion(
    user_id: int,
    db: AsyncSession,
    operation_id: str,
) -> None:
    """Detach retained tombstones from the deleted account after full success."""
    await _ensure_tombstone_schema(db)
    await _assert_user_deletion_operation(user_id, db, operation_id)
    await db.execute(
        text("""
            UPDATE laoji_meeting_deletion_tombstones
            SET user_id = NULL, artifact_paths_json = '[]', cleaned_at = :cleaned_at
            WHERE user_id = :user_id
        """),
        {"cleaned_at": datetime.utcnow().isoformat(), "user_id": user_id},
    )
    await db.commit()
