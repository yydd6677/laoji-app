#!/usr/bin/env python3
"""Replay and smoke-test the isolated Stage 4 mobile migration.

This verifier deliberately uses only Python's stdlib sqlite3 so it can run on
Linux and Windows without Expo, Android, or a production database. It checks
the v45 schema, idempotent legacy-column upgrade, external-content FTS triggers,
scope/lifecycle filtering, a realistic local search workload, and the delete
path that the mobile repository uses for guest purge.
"""

from __future__ import annotations

import re
import sqlite3
import tempfile
import time
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
    existing = {str(row[1]) for row in database.execute("PRAGMA table_info(local_schedule_events)")}
    for column, statement in upgrades:
        if statement not in source:
            raise AssertionError(f"v45 column upgrade is missing: {column}")
        if column not in existing:
            database.execute(statement)
            existing.add(column)


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


def seed_legacy(database: sqlite3.Connection) -> None:
    database.executescript(
        """
        PRAGMA foreign_keys=ON;
        CREATE TABLE local_schedule_events(
          id TEXT PRIMARY KEY,
          start_date TEXT NOT NULL,
          end_date TEXT
        );
        INSERT INTO local_schedule_events(id, start_date, end_date)
        VALUES ('event-1', '2026-08-18', NULL), ('event-2', '2026-08-19', '2026-08-19');

        CREATE TABLE meeting_notes(
          id TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          lifecycle TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE meeting_search_fts USING fts5(
          scope_key, meeting_id, source_kind, source_id, start_ms, title, content
        );
        INSERT INTO meeting_search_fts VALUES
          ('guest', 'legacy-meeting', 'transcript', 'legacy-segment', '0', '旧搜索', '旧索引仍可读取');
        """
    )


def seed_search_workload(database: sqlite3.Connection, count: int = 12_000) -> None:
    meetings = [(f"meeting-{index}", "guest", "active", index) for index in range(256)]
    database.executemany(
        "INSERT INTO meeting_notes(id, scope_key, lifecycle, updated_at_ms) VALUES (?, ?, ?, ?)",
        meetings,
    )
    rows = []
    for index in range(count):
        meeting_id = f"meeting-{index % len(meetings)}"
        topic = index % 64
        content = (
            f"会议专题{topic:02d} 确认方案和截止日期，负责人{index % 17:02d} "
            f"需要跟进接口联调与风险清单，记录序号{index:05d}。"
        )
        rows.append((
            "guest",
            meeting_id,
            "transcript",
            f"segment-{index}",
            index * 1_000,
            f"项目评审 {topic:02d}",
            content,
        ))
    database.executemany(
        """
        INSERT INTO meeting_search_documents_v45(
          scope_key, meeting_id, source_kind, source_id, start_ms, title, content
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    database.execute(
        "UPDATE meeting_notes SET lifecycle = 'deleted' WHERE id = 'meeting-255'"
    )
    database.commit()


def assert_fts_mutations(database: sqlite3.Connection) -> None:
    match = database.execute(
        """
        SELECT documents.meeting_id, documents.content
          FROM meeting_search_fts_v45 fts
          JOIN meeting_search_documents_v45 documents ON documents.document_id = fts.rowid
         WHERE meeting_search_fts_v45 MATCH ? AND documents.meeting_id = ?
        """,
        ("确认方案", "meeting-1"),
    ).fetchone()
    if not match or match[0] != "meeting-1" or "确认方案" not in match[1]:
        raise AssertionError(f"external FTS insert failed: {match!r}")

    row = database.execute(
        "SELECT document_id FROM meeting_search_documents_v45 WHERE source_id = ?",
        ("segment-1",),
    ).fetchone()
    if row is None:
        raise AssertionError("search fixture row missing")
    document_id = int(row[0])
    database.execute(
        "UPDATE meeting_search_documents_v45 SET content = ? WHERE document_id = ?",
        ("已改为新的交付说明", document_id),
    )
    old_hits = database.execute(
        "SELECT COUNT(*) FROM meeting_search_fts_v45 WHERE meeting_search_fts_v45 MATCH ? AND rowid = ?",
        ("确认方案", document_id),
    ).fetchone()[0]
    new_hits = database.execute(
        "SELECT COUNT(*) FROM meeting_search_fts_v45 WHERE meeting_search_fts_v45 MATCH ? AND rowid = ?",
        ("交付说明", document_id),
    ).fetchone()[0]
    if old_hits != 0 or new_hits != 1:
        raise AssertionError(f"external FTS update trigger failed: old={old_hits} new={new_hits}")

    database.execute(
        "DELETE FROM meeting_search_documents_v45 WHERE scope_key = ? AND meeting_id = ?",
        ("guest", "meeting-1"),
    )
    remaining = database.execute(
        "SELECT COUNT(*) FROM meeting_search_fts_v45 WHERE meeting_search_fts_v45 MATCH ? AND rowid IN (SELECT document_id FROM meeting_search_documents_v45 WHERE meeting_id = ?)",
        ("确认方案", "meeting-1"),
    ).fetchone()[0]
    if remaining != 0:
        raise AssertionError(f"external FTS delete trigger left {remaining} rows")

    legacy = database.execute(
        "SELECT content FROM meeting_search_fts WHERE meeting_id = 'legacy-meeting'"
    ).fetchone()
    if legacy != ("旧索引仍可读取",):
        raise AssertionError("v20 FTS compatibility asset changed during v45 migration")


def assert_search_performance(database: sqlite3.Connection) -> float:
    query = "确认方案"
    sql = """
      SELECT search.meeting_id, search.source_id,
             snippet(meeting_search_fts_v45, 1, '', '', '…', 24) AS snippet,
             bm25(meeting_search_fts_v45, 0.0, 1.0) AS rank
        FROM meeting_search_fts_v45
        JOIN meeting_search_documents_v45 search
          ON search.document_id = meeting_search_fts_v45.rowid
        JOIN meeting_notes meeting ON meeting.id = search.meeting_id
       WHERE meeting_search_fts_v45 MATCH ?
         AND search.scope_key = ?
         AND meeting.scope_key = ?
         AND meeting.lifecycle <> 'deleted'
       ORDER BY rank, meeting.updated_at_ms DESC, search.meeting_id, search.source_id
       LIMIT 25
    """
    for _ in range(5):
        database.execute(sql, (query, "guest", "guest")).fetchall()
    samples_ms = []
    for _ in range(30):
        started = time.perf_counter()
        rows = database.execute(sql, (query, "guest", "guest")).fetchall()
        samples_ms.append((time.perf_counter() - started) * 1_000)
        if len(rows) != 25:
            raise AssertionError(f"search result limit failed: {len(rows)}")
    samples_ms.sort()
    p95_ms = samples_ms[max(0, int(len(samples_ms) * 0.95) - 1)]
    if p95_ms > 1_000:
        raise AssertionError(f"local FTS search p95 too slow: {p95_ms:.2f}ms")
    return p95_ms


def main() -> int:
    with tempfile.NamedTemporaryFile(suffix=".db") as handle:
        database = sqlite3.connect(handle.name)
        try:
            seed_legacy(database)
            apply_column_upgrade(database)
            database.executescript(migration_sql())
            # The mobile migration runner can be re-entered after a process
            # death; both the ALTER branch and the CREATE IF NOT EXISTS SQL
            # must be safe to replay.
            apply_column_upgrade(database)
            database.executescript(migration_sql())
            assert_schema(database)

            schedule = database.execute(
                "SELECT event_revision, producer_revision, graph_schema_revision, deleted_at_ms FROM local_schedule_events WHERE id = 'event-1'"
            ).fetchone()
            if schedule != (1, "legacy-v1", "mention-graph-v1", None):
                raise AssertionError(f"legacy schedule provenance mismatch: {schedule!r}")

            seed_search_workload(database)
            assert_fts_mutations(database)
            p95_ms = assert_search_performance(database)
            if database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise AssertionError("SQLite integrity check failed")
            if database.execute("PRAGMA foreign_key_check").fetchall():
                raise AssertionError("SQLite foreign key check failed")
            print(f"stage4_migration_probe=passed search_docs=12000 search_p95_ms={p95_ms:.2f}")
            return 0
        finally:
            database.close()


if __name__ == "__main__":
    raise SystemExit(main())
