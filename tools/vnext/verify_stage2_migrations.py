#!/usr/bin/env python3
"""Replay the Stage 2 v43/v44 schema on a disposable SQLite database."""

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


def columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def bootstrap_fixture(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA foreign_keys=ON;
        CREATE TABLE meeting_notes (
          id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, title TEXT NOT NULL,
          lifecycle TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
          deleted_at_ms INTEGER
        );
        CREATE TABLE manual_notes (
          meeting_id TEXT PRIMARY KEY REFERENCES meeting_notes(id) ON DELETE CASCADE,
          content TEXT NOT NULL
        );
        CREATE TABLE device_operations(
          operation_id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          capability TEXT NOT NULL,
          generation_id TEXT NOT NULL,
          remote_state TEXT NOT NULL DEFAULT 'queued',
          updated_at_ms INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE meeting_recording_merge_tasks (
          id TEXT PRIMARY KEY,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE recording_assets (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
          checksum_sha256 TEXT, local_state TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
          remote_asset_id TEXT
        );
        CREATE TABLE transcript_revisions (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
          status TEXT NOT NULL, source_model TEXT, is_active INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL, finalized_at_ms INTEGER
        );
        CREATE TABLE transcript_segments (
          id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES transcript_revisions(id) ON DELETE CASCADE,
          meeting_id TEXT NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
          source_segment_id TEXT, ordinal INTEGER NOT NULL, speaker_cluster_id TEXT,
          speaker_profile_id TEXT, speaker_label TEXT, text TEXT NOT NULL,
          confidence REAL, is_final INTEGER NOT NULL
        );
        CREATE TABLE speaker_corrections (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, transcript_revision_id TEXT NOT NULL
        );
        CREATE TABLE speaker_assignments (
          id TEXT PRIMARY KEY, correction_id TEXT NOT NULL, meeting_id TEXT NOT NULL,
          transcript_revision_id TEXT NOT NULL, segment_id TEXT NOT NULL,
          speaker_profile_id TEXT, display_name TEXT NOT NULL,
          assignment_revision INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
        );
        INSERT INTO meeting_notes VALUES (
          'meeting-1', 'guest', '项目周会', 'deleted', 1000, 2000
        );
        INSERT INTO manual_notes VALUES ('meeting-1', '跟进接口联调');
        INSERT INTO recording_assets VALUES (
          'asset-1', 'meeting-1',
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'local_ready', 1000, NULL
        );
        INSERT INTO meeting_recording_merge_tasks VALUES ('merge-1', 1000);
        INSERT INTO device_operations VALUES (
          'operation-1', 'meeting-1', 'media.upload',
          '11111111111111111111111111111111', 'queued', 1000
        );
        INSERT INTO transcript_revisions VALUES (
          'revision-1', 'meeting-1', 'ready', 'asr-r1', 1, 1000, 1500
        );
        INSERT INTO transcript_segments VALUES (
          'segment-1', 'revision-1', 'meeting-1', 'stable-1', 0,
          'cluster-1', NULL, '讲话人 1', '确认上传方案', 0.9, 1
        );
        INSERT INTO speaker_corrections VALUES ('correction-1', 'meeting-1', 'revision-1');
        INSERT INTO speaker_assignments VALUES (
          'assignment-1', 'correction-1', 'meeting-1', 'revision-1', 'segment-1',
          NULL, '小王', 2, 1600
        );
        """
    )
    connection.executescript(sql_constant(
        ROOT / "src/data/db/migrations/0020MeetingOrganizationSearch.ts",
        "MEETING_ORGANIZATION_SEARCH_V20_SQL",
    ))
    connection.execute(
        """INSERT INTO meeting_search_fts(
             scope_key, meeting_id, source_kind, source_id, start_ms, title, content
           ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            "guest", "meeting-1", "transcript", "stable-1", "0",
            "项目周会", "确认上传方案",
        ),
    )


def apply_stage2(connection: sqlite3.Connection) -> None:
    for table, name, ddl in (
        ("transcript_revisions", "source_manifest_sha256", "TEXT"),
        ("transcript_revisions", "text_final_at_ms", "INTEGER"),
        ("transcript_segments", "stable_segment_key", "TEXT"),
        ("transcript_segments", "segment_revision", "INTEGER"),
        ("transcript_segments", "text_state", "TEXT"),
    ):
        if name not in columns(connection, table):
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    connection.executescript(
        """
        UPDATE transcript_revisions SET text_final_at_ms = finalized_at_ms
         WHERE text_final_at_ms IS NULL AND status = 'ready';
        UPDATE transcript_segments
           SET stable_segment_key = COALESCE(NULLIF(source_segment_id, ''), id),
               segment_revision = COALESCE(segment_revision, 1),
               text_state = COALESCE(text_state, CASE WHEN is_final = 1 THEN 'final' ELSE 'partial' END)
         WHERE stable_segment_key IS NULL OR segment_revision IS NULL OR text_state IS NULL;
        """
    )
    connection.executescript(sql_constant(
        ROOT / "src/data/db/migrations/0043TranscriptOverlayAndSearchVNext.ts",
        "TRANSCRIPT_OVERLAY_AND_SEARCH_VNEXT_V43_SQL",
    ))
    connection.executescript(
        """
        INSERT OR IGNORE INTO speaker_overlay_revisions(
          revision_id, meeting_id, transcript_revision_id, overlay_revision,
          model_revision, status, created_at_ms, activated_at_ms
        ) VALUES ('migrated-overlay:revision-1', 'meeting-1', 'revision-1', 1,
                  'asr-r1', 'active', 1000, 1500);
        INSERT OR IGNORE INTO speaker_overlay_assignments(
          revision_id, stable_segment_key, automatic_label, speaker_cluster_id,
          speaker_profile_id, confidence
        ) VALUES ('migrated-overlay:revision-1', 'stable-1', '讲话人 1', 'cluster-1', NULL, 0.9);
        INSERT OR IGNORE INTO speaker_manual_overrides(
          override_id, meeting_id, stable_segment_key, expected_transcript_revision,
          label, speaker_profile_id, override_revision, needs_review,
          source_correction_id, created_at_ms, updated_at_ms
        ) VALUES ('migrated-manual:assignment-1', 'meeting-1', 'stable-1', 'revision-1',
                  '小王', NULL, 2, 0, 'correction-1', 1600, 1600);
        """
    )
    for table, name, ddl in (
        ("recording_assets", "asset_generation", "TEXT"),
        ("recording_assets", "source_sha256", "TEXT"),
        ("recording_assets", "upload_operation_id", "TEXT REFERENCES device_operations(operation_id)"),
        ("recording_assets", "remote_object_revision", "INTEGER"),
        ("meeting_notes", "purge_after_ms", "INTEGER"),
        ("meeting_recording_merge_tasks", "target_asset_generation", "TEXT"),
    ):
        if name not in columns(connection, table):
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    connection.executescript(
        """
        UPDATE recording_assets SET asset_generation = '11111111111111111111111111111111'
         WHERE asset_generation IS NULL;
        UPDATE recording_assets SET source_sha256 = checksum_sha256
         WHERE source_sha256 IS NULL AND length(checksum_sha256) = 71;
        UPDATE meeting_notes SET purge_after_ms = deleted_at_ms + 2592000000
         WHERE deleted_at_ms IS NOT NULL AND purge_after_ms IS NULL;
        UPDATE meeting_recording_merge_tasks
           SET target_asset_generation = '22222222222222222222222222222222'
         WHERE target_asset_generation IS NULL;
        """
    )
    connection.executescript(sql_constant(
        ROOT / "src/data/db/migrations/0044MediaGenerationAndTrashVNext.ts",
        "MEDIA_GENERATION_AND_TRASH_VNEXT_V44_SQL",
    ))
    connection.commit()


def apply_upload_executor(connection: sqlite3.Connection) -> None:
    existing = columns(connection, "device_operations")
    if "executor_kind" not in existing:
        connection.execute(
            "ALTER TABLE device_operations ADD COLUMN executor_kind TEXT "
            "CHECK(executor_kind IS NULL OR executor_kind IN ('workmanager'))"
        )
    if "executor_id" not in existing:
        connection.execute("ALTER TABLE device_operations ADD COLUMN executor_id TEXT")
    connection.executescript(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_device_operation_executor
          ON device_operations(executor_kind, executor_id)
          WHERE executor_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_device_upload_pending_asset
          ON device_operations(capability, remote_state, updated_at_ms, operation_id)
          WHERE capability = 'media.upload' AND remote_state IN ('queued', 'running', 'failure');
        """
    )
    connection.commit()


def main() -> None:
    with tempfile.NamedTemporaryFile(suffix=".db") as handle:
        connection = sqlite3.connect(handle.name)
        try:
            bootstrap_fixture(connection)
            apply_stage2(connection)
            segment = connection.execute(
                "SELECT stable_segment_key, segment_revision, text_state FROM transcript_segments"
            ).fetchone()
            if segment != ("stable-1", 1, "final"):
                raise AssertionError(f"segment migration failed: {segment}")
            if connection.execute("SELECT automatic_label FROM speaker_overlay_assignments").fetchone()[0] != "讲话人 1":
                raise AssertionError("automatic speaker overlay missing")
            if connection.execute("SELECT label FROM speaker_manual_overrides").fetchone()[0] != "小王":
                raise AssertionError("manual speaker override missing")
            fts_columns = columns(connection, "meeting_search_fts")
            expected_fts_columns = {
                "scope_key", "meeting_id", "source_kind", "source_id",
                "start_ms", "title", "content",
            }
            if fts_columns != expected_fts_columns:
                raise AssertionError(f"v20 FTS schema changed during Stage 2: {fts_columns}")
            search = connection.execute(
                "SELECT rowid FROM meeting_search_fts WHERE meeting_search_fts MATCH '上传方'"
            ).fetchall()
            if len(search) != 1:
                raise AssertionError("existing meeting FTS transcript search regressed")
            short_search = connection.execute(
                "SELECT rowid FROM meeting_search_fts WHERE content LIKE '%上传%'"
            ).fetchall()
            if len(short_search) != 1:
                raise AssertionError("meeting FTS short Chinese search failed")
            asset = connection.execute(
                "SELECT asset_generation, source_sha256 FROM recording_assets"
            ).fetchone()
            if len(asset[0]) != 32 or not str(asset[1]).startswith("sha256:"):
                raise AssertionError("recording generation/hash migration failed")
            merge_generation = connection.execute(
                "SELECT target_asset_generation FROM meeting_recording_merge_tasks"
            ).fetchone()[0]
            if merge_generation != "22222222222222222222222222222222":
                raise AssertionError("recording merge generation migration failed")
            if connection.execute("SELECT purge_after_ms FROM meeting_notes").fetchone()[0] != 2592002000:
                raise AssertionError("trash purge deadline migration failed")
            connection.execute(
                "UPDATE recording_assets SET upload_operation_id = 'operation-1' WHERE id = 'asset-1'"
            )
            if connection.execute(
                "SELECT upload_operation_id FROM recording_assets WHERE id = 'asset-1'"
            ).fetchone()[0] != "operation-1":
                raise AssertionError("valid upload operation ownership was rejected")
            apply_stage2(connection)
            apply_upload_executor(connection)
            connection.execute(
                "UPDATE device_operations SET executor_kind = 'workmanager', executor_id = 'work-1' "
                "WHERE operation_id = 'operation-1'"
            )
            if connection.execute(
                "SELECT executor_kind, executor_id FROM device_operations WHERE operation_id = 'operation-1'"
            ).fetchone() != ("workmanager", "work-1"):
                raise AssertionError("upload executor handle was not persisted")
            # Recovery ordering probe: a process may die after the canonical
            # asset identity is written but before the operation reaches
            # success.  The pending query must still discover that operation;
            # only a terminal operation may suppress the compatibility queue.
            connection.execute(
                "UPDATE recording_assets SET remote_asset_id = 'remote-1' WHERE id = 'asset-1'"
            )
            pending_with_identity = connection.execute(
                """SELECT COUNT(*) FROM device_operations operation
                   INNER JOIN recording_assets asset
                           ON asset.upload_operation_id = operation.operation_id
                   INNER JOIN meeting_notes meeting ON meeting.id = asset.meeting_id
                  WHERE meeting.scope_key = 'guest'
                    AND operation.capability = 'media.upload'
                    AND operation.remote_state IN ('queued', 'running', 'failure')
                    AND asset.local_state = 'local_ready'"""
            ).fetchone()[0]
            if pending_with_identity != 1:
                raise AssertionError("in-flight upload with remote identity was hidden from recovery")
            connection.execute(
                "UPDATE device_operations SET remote_state = 'success' WHERE operation_id = 'operation-1'"
            )
            terminal_suppressed = connection.execute(
                """SELECT COUNT(*) FROM recording_assets asset
                   INNER JOIN device_operations operation
                           ON operation.operation_id = asset.upload_operation_id
                   INNER JOIN meeting_notes meeting ON meeting.id = asset.meeting_id
                  WHERE meeting.scope_key = 'guest'
                    AND operation.capability = 'media.upload'
                    AND (operation.remote_state IN ('success', 'cancelled')
                         OR asset.remote_asset_id IS NOT NULL)"""
            ).fetchone()[0]
            if terminal_suppressed != 1:
                raise AssertionError("terminal upload did not suppress legacy registry")
            if connection.execute("SELECT COUNT(*) FROM speaker_overlay_revisions").fetchone()[0] != 1:
                raise AssertionError("migration replay duplicated overlay")
            apply_upload_executor(connection)
            if connection.execute("PRAGMA foreign_key_check").fetchall():
                raise AssertionError("foreign key check failed")
            try:
                connection.execute(
                    "UPDATE recording_assets SET asset_generation = ? WHERE id = 'asset-1'",
                    ("33333333333333333333333333333333",),
                )
            except sqlite3.IntegrityError:
                connection.rollback()
            else:
                raise AssertionError("recording asset generation mutation was accepted")
            print("stage2_migration_probe=passed")
        finally:
            connection.close()


if __name__ == "__main__":
    main()
