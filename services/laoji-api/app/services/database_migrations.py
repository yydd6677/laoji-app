"""Small, lossless SQLite repairs required before strict FK enforcement."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sqlite3

from sqlalchemy.engine import make_url

from app.config import settings


def _main_path() -> Path:
    url = make_url(settings.DATABASE_URL)
    if not url.drivername.startswith("sqlite") or not url.database:
        raise RuntimeError("main_database_not_sqlite")
    return Path(url.database).expanduser().resolve()


def archive_orphan_final_summaries() -> int:
    """Preserve legacy orphan rows outside the live FK graph, then remove them."""
    path = _main_path()
    with sqlite3.connect(path, timeout=30) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS legacy_orphan_final_summaries_v1 (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                overview TEXT NOT NULL,
                key_decisions_json TEXT NOT NULL,
                action_items_json TEXT NOT NULL,
                generated_at TEXT,
                archived_at TEXT NOT NULL,
                archive_reason TEXT NOT NULL
            )
            """
        )
        orphan_ids = [
            str(row[0])
            for row in connection.execute(
                """
                SELECT summary.id
                FROM final_summaries AS summary
                LEFT JOIN meetings AS meeting ON meeting.id = summary.meeting_id
                WHERE meeting.id IS NULL
                ORDER BY summary.id
                """
            ).fetchall()
        ]
        archived_at = datetime.now(timezone.utc).isoformat()
        connection.execute(
            """
            INSERT OR IGNORE INTO legacy_orphan_final_summaries_v1 (
                id, meeting_id, overview, key_decisions_json, action_items_json,
                generated_at, archived_at, archive_reason
            )
            SELECT
                summary.id, summary.meeting_id, summary.overview,
                summary.key_decisions_json, summary.action_items_json,
                summary.generated_at, ?, 'missing_parent_before_fk_enforcement'
            FROM final_summaries AS summary
            LEFT JOIN meetings AS meeting ON meeting.id = summary.meeting_id
            WHERE meeting.id IS NULL
            """,
            (archived_at,),
        )
        if orphan_ids:
            placeholders = ",".join("?" for _ in orphan_ids)
            connection.execute(
                f"DELETE FROM final_summaries WHERE id IN ({placeholders})",
                orphan_ids,
            )
        connection.commit()
        return len(orphan_ids)
