#!/usr/bin/env python3
"""Replay and smoke-test the isolated Stage 4 mobile migration.

This verifier deliberately uses only Python's stdlib sqlite3 so it can run on
Linux and Windows without Expo, Android, or a production database. It checks
the v45 schema, external-content FTS triggers, and the delete path that the
mobile repository uses for guest purge.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "src" / "data" / "db" / "migrations" / "0045ScheduleMentionGraphVNext.ts"


def migration_sql() -> str:
    source = MIGRATION.read_text(encoding="utf-8")
    match = re.search(
        r"SCHEDULE_MENTION_GRAPH_VNEXT_V45_SQL\s*=\s*`([\s\S]*?)`;",
        source,
    )
    if not match or not match.group(1).strip():
        raise AssertionError("v45 migration SQL was not found")
    return match.group(1)


def apply_column_upgrade(database: sqlite3.Connection) -> None:
    """Replay the idempotent ALTER branch from the TypeScript migration."""
    source = MIGRATION.read_text(encoding="utf-8")
    upgrades = (
        ("event_revision", "ALTER TABLE local_schedule_events ADD COLUMN event_revision INTEGER NOT NULL DEFAULT 1"),
        ("draft_source_sha256", "ALTER TABLE local_schedule_events ADD COLUMN draft_source_sha256 TEXT"),
        ("producer_revision", "ALTER TABLE local_schedule_events ADD COLUMN producer_revision TEXT NOT NULL DEFAULT 'legacy-v1'"),
        ("graph_schema_revision", "ALTER TABLE local_schedule_events ADD COLUMN graph_schema_revision TEXT NOT NULL DEFAULT 'mention-graph-v1'"),
        ("deleted_at_ms", "ALTER TABLE local_schedule_events ADD COLUMN deleted_at_ms INTEGER"),
    )
    for column, statement in upgrades:
        if statement not in source:
            raise AssertionError(f"v45 column upgrade is missing: {column}")
        database.execute(statement)


def assert_schema(database: sqlite3.Connection) -> None:
    tables = {
        row[0]
        for row in database.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')"
        )
    }
    required = {
        "meeting_search_documents_v45",
        "meeting_search_fts_v45",
        "local_schedule_events",
    }
    if not required <= tables:
        raise AssertionError(f"missing v45 tables: {sorted(required - tables)}")
    columns = {
        row[1]
        for row in database.execute("PRAGMA table_info(local_schedule_events)")
    }
    required_columns = {
        "event_revision",
        "draft_source_sha256",
        "producer_revision",
        "graph_schema_revision",
        "deleted_at_ms",
    }
    if not required_columns <= columns:
        raise AssertionError(f"missing schedule provenance columns: {sorted(required_columns - columns)}")


def main() -> int:
    database = sqlite3.connect(":memory:")
    database.executescript(
        """
        CREATE TABLE local_schedule_events(
          id TEXT PRIMARY KEY,
          start_date TEXT NOT NULL,
          end_date TEXT
        );
        """
    )
    apply_column_upgrade(database)
    database.executescript(migration_sql())
    assert_schema(database)

    database.execute(
        """
        INSERT INTO meeting_search_documents_v45(
          scope_key, meeting_id, source_kind, source_id, start_ms, title, content
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        ("guest", "meeting-1", "transcript", "segment-1", 0, "评审会", "确认方案和截止日期"),
    )
    match = database.execute(
        """
        SELECT documents.meeting_id, documents.content
          FROM meeting_search_fts_v45 fts
          JOIN meeting_search_documents_v45 documents ON documents.document_id = fts.rowid
         WHERE meeting_search_fts_v45 MATCH ?
        """,
        ("确认方案",),
    ).fetchone()
    if match != ("meeting-1", "确认方案和截止日期"):
        raise AssertionError(f"external FTS insert failed: {match!r}")

    database.execute(
        "DELETE FROM meeting_search_documents_v45 WHERE scope_key = ? AND meeting_id = ?",
        ("guest", "meeting-1"),
    )
    remaining = database.execute(
        "SELECT COUNT(*) FROM meeting_search_fts_v45 WHERE meeting_search_fts_v45 MATCH ?",
        ("确认方案",),
    ).fetchone()[0]
    if remaining != 0:
        raise AssertionError(f"external FTS delete trigger left {remaining} rows")
    print("stage4_migration_probe=passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
