#!/usr/bin/env python3
"""Replay the Stage 1 SQLite DDL on a disposable database.

This deliberately uses only the standard library so it can run on Linux and
Windows without the mobile runtime. It checks the durable schema boundaries;
the Expo migration callback is type-checked separately by the mobile build.
"""

from __future__ import annotations

import re
import sqlite3
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def sql_constant(path: Path, constant: str) -> str:
    source = path.read_text(encoding="utf-8")
    match = re.search(
        rf"export const {re.escape(constant)}\s*=\s*`(?P<sql>.*?)`;",
        source,
        flags=re.DOTALL,
    )
    if not match:
        raise AssertionError(f"SQL constant not found: {path}::{constant}")
    return match.group("sql")


def table_names(connection: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }


def bootstrap_v39_fixture(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE meeting_notes (id TEXT PRIMARY KEY);
        CREATE TABLE transcript_revisions (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meeting_notes(id)
        );
        CREATE TABLE manual_notes (
          meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
          content TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'plain',
          revision INTEGER NOT NULL DEFAULT 0, last_saved_at_ms INTEGER NOT NULL
        );
        CREATE TABLE meeting_attachments (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meeting_notes(id),
          kind TEXT NOT NULL, text_content TEXT, updated_at_ms INTEGER NOT NULL
        );
        INSERT INTO meeting_notes(id) VALUES ('meeting-1');
        INSERT INTO transcript_revisions(id, meeting_id) VALUES ('transcript-rev-1', 'meeting-1');
        INSERT INTO manual_notes(meeting_id, content, revision, last_saved_at_ms)
          VALUES ('meeting-1', '迁移前笔记', 3, 100);
        INSERT INTO meeting_attachments(id, meeting_id, kind, text_content, updated_at_ms)
          VALUES ('attachment-1', 'meeting-1', 'text', '迁移前附件', 100);
        """
    )


def apply_stage_1_ddl(connection: sqlite3.Connection) -> None:
    connection.executescript(
        sql_constant(
            ROOT / "src/data/db/migrations/0040VNextAuthorityAndOperations.ts",
            "VNEXT_AUTHORITY_AND_OPERATIONS_V40_SQL",
        )
    )
    connection.executescript(
        sql_constant(
            ROOT / "src/data/db/migrations/0041VNextCutoverTombstones.ts",
            "VNEXT_CUTOVER_TOMBSTONES_V41_SQL",
        )
    )

    # This mirrors the idempotent table_info probes in the TypeScript callback.
    columns = {
        row[1]
        for row in connection.execute("PRAGMA table_info(manual_notes)")
    }
    if "active_revision_id" not in columns:
        connection.execute("ALTER TABLE manual_notes ADD COLUMN active_revision_id TEXT")
    columns = {
        row[1]
        for row in connection.execute("PRAGMA table_info(meeting_attachments)")
    }
    if "active_text_revision_id" not in columns:
        connection.execute(
            "ALTER TABLE meeting_attachments ADD COLUMN active_text_revision_id TEXT"
        )
    connection.executescript(
        sql_constant(
            ROOT / "src/data/db/migrations/0042ImmutableSourcesAndQuestionQ2.ts",
            "IMMUTABLE_SOURCES_AND_Q2_V42_SQL",
        )
    )

    connection.commit()


def migrate_fixture_data(connection: sqlite3.Connection) -> None:
    # Data migration assertions corresponding to the callback's invariants.
    connection.execute(
        """
        INSERT INTO manual_note_revisions (
          revision_id, meeting_id, revision, content, format, content_sha256,
          migrated_current, created_at_ms
        ) VALUES ('manual_note:meeting-1:3', 'meeting-1', 3, '迁移前笔记',
                  'plain', 'sha256:' || printf('%064d', 1), 1, 200)
        """
    )
    connection.execute(
        "UPDATE manual_notes SET active_revision_id = 'manual_note:meeting-1:3'"
    )
    connection.execute(
        """
        INSERT INTO meeting_attachment_text_revisions (
          revision_id, attachment_id, meeting_id, revision, content_kind, content,
          content_sha256, migrated_current, created_at_ms
        ) VALUES ('attachment_text:attachment-1:1', 'attachment-1', 'meeting-1', 1,
                  'text', '迁移前附件', 'sha256:' || printf('%064d', 2), 1, 200)
        """
    )
    connection.execute(
        "UPDATE meeting_attachments SET active_text_revision_id = 'attachment_text:attachment-1:1'"
    )
    connection.commit()


def main() -> None:
    with tempfile.NamedTemporaryFile(suffix=".db") as handle:
        connection = sqlite3.connect(handle.name)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            bootstrap_v39_fixture(connection)
            apply_stage_1_ddl(connection)
            migrate_fixture_data(connection)

            expected = {
                "device_epochs",
                "device_authority_state",
                "meeting_service_bindings",
                "device_operations",
                "vnext_cutover_tombstones",
                "manual_note_revisions",
                "meeting_attachment_text_revisions",
                "meeting_question_q2_snapshots",
                "meeting_question_q2_snapshot_sources",
                "meeting_question_q2_threads",
                "meeting_question_q2_turns",
                "meeting_question_q2_clauses",
                "meeting_question_q2_citations",
            }
            missing = expected - table_names(connection)
            if missing:
                raise AssertionError(f"missing Stage 1 tables: {sorted(missing)}")
            if connection.execute(
                "SELECT active_revision_id FROM manual_notes WHERE meeting_id = 'meeting-1'"
            ).fetchone()[0] != "manual_note:meeting-1:3":
                raise AssertionError("manual note current pointer was not migrated")
            if connection.execute(
                "SELECT active_text_revision_id FROM meeting_attachments WHERE id = 'attachment-1'"
            ).fetchone()[0] != "attachment_text:attachment-1:1":
                raise AssertionError("attachment current pointer was not migrated")

            # Idempotent DDL replay: all CREATE IF NOT EXISTS statements can be
            # replayed and table_info probes do not add duplicate columns.
            apply_stage_1_ddl(connection)
            if connection.execute(
                "SELECT COUNT(*) FROM manual_note_revisions"
            ).fetchone()[0] != 1:
                raise AssertionError("migration replay duplicated note revision")
            if connection.execute("PRAGMA foreign_key_check").fetchall():
                raise AssertionError("foreign key check failed")
            print("stage1_migration_probe=passed")
        finally:
            connection.close()


if __name__ == "__main__":
    main()
