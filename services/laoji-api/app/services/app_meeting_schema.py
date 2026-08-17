"""Schema compatibility helpers for LaoJi App meeting fields.

The project uses SQLite in local/workspace mode without Alembic. Existing
installations already have a meetings table, so create_all() cannot add new
columns. Keep this helper small and idempotent.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from urllib.parse import unquote

from app.config import settings


_REQUIRED_COLUMNS: dict[str, str] = {
    "user_id": "INTEGER",
    "created_at": "DATETIME",
    "updated_at": "DATETIME",
    "app_owned": "INTEGER NOT NULL DEFAULT 0",
    "client_request_id": "VARCHAR(96)",
    "audio_path": "VARCHAR(512)",
    "audio_mime_type": "VARCHAR(120)",
    "audio_file_name": "VARCHAR(255)",
    "audio_duration_sec": "FLOAT",
    "location": "VARCHAR(500)",
    "recorded_at": "DATETIME",
}

_ACTION_REQUIRED_COLUMNS: dict[str, str] = {
    "client_created_at_ms": "BIGINT NOT NULL DEFAULT 0",
    "user_edited_at_ms": "BIGINT",
    "completed_at_ms": "BIGINT",
    "generation_fingerprint": "VARCHAR(512)",
}


def _sqlite_path_from_url(url: str) -> Path | None:
    prefix = "sqlite+aiosqlite:///"
    if not url.startswith(prefix):
        return None
    raw = url[len(prefix):]
    return Path(unquote(raw))


def ensure_app_meeting_schema() -> None:
    db_path = _sqlite_path_from_url(settings.DATABASE_URL)
    if db_path is None:
        return
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        existing = {row[1] for row in conn.execute("PRAGMA table_info(meetings)")}
        if not existing:
            return
        for column, ddl in _REQUIRED_COLUMNS.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE meetings ADD COLUMN {column} {ddl}")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON meetings(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_meetings_app_owned ON meetings(app_owned)")
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_user_client_request
            ON meetings(user_id, client_request_id)
            WHERE client_request_id IS NOT NULL
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_note_roots_v2 (
                meeting_id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                client_note_id VARCHAR(160) NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                origin VARCHAR(32) NOT NULL,
                entry_point VARCHAR(40),
                lifecycle VARCHAR(20) NOT NULL DEFAULT 'active',
                deleted_at DATETIME,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_note_root_client_identity
                    UNIQUE (user_id, client_note_id),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_note_root_operations_v2 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(64) NOT NULL,
                operation_kind VARCHAR(20) NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                response_status INTEGER NOT NULL,
                response_revision INTEGER NOT NULL,
                response_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_note_root_operation_key
                    UNIQUE (user_id, idempotency_key),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_retention_cleanup_jobs_v2 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                paths_json TEXT NOT NULL DEFAULT '[]',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error_code VARCHAR(96),
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_retention_cleanup_meeting UNIQUE (meeting_id),
                CHECK (attempt_count >= 0)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_attachments_v1 (
                id VARCHAR(36) PRIMARY KEY,
                meeting_id VARCHAR(36) NOT NULL,
                user_id INTEGER NOT NULL,
                client_attachment_id VARCHAR(512) NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                lifecycle VARCHAR(20) NOT NULL,
                position_ms BIGINT NOT NULL,
                kind VARCHAR(20) NOT NULL,
                text_content TEXT,
                mime_type VARCHAR(160),
                file_name VARCHAR(255),
                byte_size BIGINT,
                checksum_sha256 VARCHAR(71),
                storage_path VARCHAR(1024),
                client_created_at_ms BIGINT NOT NULL,
                client_updated_at_ms BIGINT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                deleted_at DATETIME,
                CONSTRAINT uq_meeting_attachment_v1_user_client
                    UNIQUE (user_id, client_attachment_id),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_attachment_operations_v1 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                attachment_id VARCHAR(36) NOT NULL,
                operation_kind VARCHAR(24) NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(71) NOT NULL,
                response_status INTEGER NOT NULL,
                response_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_attachment_operation_v1_user_key
                    UNIQUE (user_id, idempotency_key),
                FOREIGN KEY(attachment_id) REFERENCES meeting_attachments_v1(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_markers_v1 (
                id VARCHAR(36) PRIMARY KEY,
                meeting_id VARCHAR(36) NOT NULL,
                user_id INTEGER NOT NULL,
                client_marker_id VARCHAR(512) NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                lifecycle VARCHAR(20) NOT NULL,
                position_ms BIGINT NOT NULL,
                label VARCHAR(500),
                kind VARCHAR(20) NOT NULL DEFAULT 'important',
                client_created_at_ms BIGINT NOT NULL,
                client_updated_at_ms BIGINT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                deleted_at DATETIME,
                CONSTRAINT uq_meeting_marker_v1_user_client
                    UNIQUE (user_id, client_marker_id),
                CHECK (revision >= 1),
                CHECK (lifecycle IN ('active', 'deleted')),
                CHECK (position_ms >= 0),
                CHECK (kind = 'important'),
                CHECK (client_created_at_ms >= 0),
                CHECK (client_updated_at_ms >= client_created_at_ms),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_marker_operations_v1 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                marker_id VARCHAR(36) NOT NULL,
                operation_kind VARCHAR(24) NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(71) NOT NULL,
                response_status INTEGER NOT NULL,
                response_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_marker_operation_v1_user_key
                    UNIQUE (user_id, idempotency_key),
                FOREIGN KEY(marker_id) REFERENCES meeting_markers_v1(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_summary_versions_v1 (
                id VARCHAR(160) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'ready',
                template_id VARCHAR(80) NOT NULL,
                template_revision INTEGER NOT NULL,
                generated_document_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                completed_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_summary_version_v1_owner
                    UNIQUE (user_id, meeting_id, id),
                CHECK (status IN ('ready', 'stale')),
                CHECK (template_revision >= 1),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_summary_section_states_v1 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                version_id VARCHAR(160) NOT NULL,
                section_id VARCHAR(512) NOT NULL,
                stable_key VARCHAR(160) NOT NULL,
                ordinal INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                user_text TEXT,
                visible_citation_ids_json TEXT NOT NULL DEFAULT '[]',
                client_updated_at_ms BIGINT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_summary_section_state_v1_identity
                    UNIQUE (user_id, version_id, section_id),
                CHECK (ordinal >= 0),
                CHECK (revision >= 1),
                CHECK (client_updated_at_ms >= 0),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
                FOREIGN KEY(version_id) REFERENCES meeting_summary_versions_v1(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_summary_current_v1 (
                meeting_id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                version_id VARCHAR(160) NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                client_updated_at_ms BIGINT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_summary_current_v1_owner UNIQUE (user_id, meeting_id),
                CHECK (revision >= 1),
                CHECK (client_updated_at_ms >= 0),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
                FOREIGN KEY(version_id) REFERENCES meeting_summary_versions_v1(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_summary_operations_v1 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                aggregate_id VARCHAR(512) NOT NULL,
                operation_kind VARCHAR(32) NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(71) NOT NULL,
                response_status INTEGER NOT NULL,
                response_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_summary_operation_v1_user_key
                    UNIQUE (user_id, idempotency_key),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO meeting_note_roots_v2 (
                meeting_id, user_id, client_note_id, revision, origin,
                entry_point, lifecycle, deleted_at, created_at, updated_at
            )
            SELECT
                id, user_id, COALESCE(NULLIF(client_request_id, ''), id), 1,
                'ad_hoc', 'legacy_store', 'active', NULL,
                COALESCE(created_at, CURRENT_TIMESTAMP),
                COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
            FROM meetings
            WHERE user_id IS NOT NULL AND app_owned = 1
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_action_items (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                client_action_id VARCHAR(512) NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                client_created_at_ms BIGINT NOT NULL,
                client_updated_at_ms BIGINT NOT NULL,
                user_edited_at_ms BIGINT,
                completed_at_ms BIGINT,
                content TEXT NOT NULL,
                status VARCHAR(20) NOT NULL,
                assignee VARCHAR(500),
                due_at_ms BIGINT,
                reminder_at_ms BIGINT,
                followup_event_source_id VARCHAR(512),
                source_kind VARCHAR(20) NOT NULL,
                source_summary_version_id VARCHAR(512),
                source_segment_id VARCHAR(512),
                source_start_ms BIGINT,
                generation_fingerprint VARCHAR(512),
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_action_client_identity
                    UNIQUE (user_id, meeting_id, client_action_id),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        action_existing = {
            row[1] for row in conn.execute("PRAGMA table_info(meeting_action_items)")
        }
        for column, ddl in _ACTION_REQUIRED_COLUMNS.items():
            if column not in action_existing:
                conn.execute(
                    f"ALTER TABLE meeting_action_items ADD COLUMN {column} {ddl}"
                )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_action_operations (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(64) NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                client_action_id VARCHAR(512) NOT NULL,
                action_id VARCHAR(36) NOT NULL,
                response_status INTEGER NOT NULL,
                response_revision INTEGER NOT NULL,
                response_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_action_operation_key UNIQUE (user_id, idempotency_key),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
                FOREIGN KEY(action_id) REFERENCES meeting_action_items(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_action_shares (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                action_id VARCHAR(36) NOT NULL,
                client_share_id VARCHAR(512) NOT NULL,
                token_hash VARCHAR(64) NOT NULL,
                permission VARCHAR(20) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'active',
                revision INTEGER NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                revoked_at DATETIME,
                CONSTRAINT uq_meeting_action_share_client_identity
                    UNIQUE (owner_user_id, client_share_id),
                CONSTRAINT uq_meeting_action_share_token_hash UNIQUE (token_hash),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
                FOREIGN KEY(action_id) REFERENCES meeting_action_items(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_action_collaboration_operations (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id INTEGER NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(64) NOT NULL,
                share_id VARCHAR(36) NOT NULL,
                action_id VARCHAR(36) NOT NULL,
                actor_id VARCHAR(160) NOT NULL,
                operation_kind VARCHAR(20) NOT NULL,
                response_status INTEGER NOT NULL,
                response_revision INTEGER NOT NULL,
                response_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_action_collaboration_operation_key
                    UNIQUE (owner_user_id, idempotency_key),
                FOREIGN KEY(share_id) REFERENCES meeting_action_shares(id) ON DELETE CASCADE,
                FOREIGN KEY(action_id) REFERENCES meeting_action_items(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_action_collaboration_events (
                id VARCHAR(36) PRIMARY KEY,
                share_id VARCHAR(36) NOT NULL,
                action_id VARCHAR(36) NOT NULL,
                actor_id VARCHAR(160) NOT NULL,
                actor_role VARCHAR(20) NOT NULL,
                action_revision BIGINT NOT NULL,
                changed_fields_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                FOREIGN KEY(share_id) REFERENCES meeting_action_shares(id) ON DELETE CASCADE,
                FOREIGN KEY(action_id) REFERENCES meeting_action_items(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_manual_notes (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                client_note_revision INTEGER NOT NULL,
                client_updated_at_ms BIGINT NOT NULL,
                user_edited_at_ms BIGINT,
                content TEXT NOT NULL DEFAULT '',
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_manual_note_owner UNIQUE (user_id, meeting_id),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_manual_note_operations (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(64) NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                note_id VARCHAR(36) NOT NULL,
                response_status INTEGER NOT NULL,
                response_revision INTEGER NOT NULL,
                response_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_manual_note_operation_key UNIQUE (user_id, idempotency_key),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
                FOREIGN KEY(note_id) REFERENCES meeting_manual_notes(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_tag_catalogs_v1 (
                user_id INTEGER PRIMARY KEY,
                revision INTEGER NOT NULL DEFAULT 1,
                client_updated_at_ms BIGINT NOT NULL,
                snapshot_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_tag_catalog_operations_v1 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(64) NOT NULL,
                response_status INTEGER NOT NULL,
                response_revision INTEGER NOT NULL,
                response_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_tag_catalog_operation_key
                    UNIQUE (user_id, idempotency_key),
                FOREIGN KEY(user_id) REFERENCES meeting_tag_catalogs_v1(user_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_occurrence_links_v2 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                source_event_id VARCHAR(512) NOT NULL,
                occurrence_date VARCHAR(10) NOT NULL,
                calendar_revision BIGINT,
                recurrence_segment_id VARCHAR(512),
                series_key VARCHAR(512),
                link_state VARCHAR(20) NOT NULL DEFAULT 'active',
                client_updated_at_ms BIGINT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_occurrence_owner_identity
                    UNIQUE (user_id, source_event_id, occurrence_date),
                CONSTRAINT uq_meeting_occurrence_owner_meeting
                    UNIQUE (user_id, meeting_id),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_schedule_snapshots_v2 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                event_title TEXT NOT NULL DEFAULT '',
                planned_start_ms BIGINT,
                planned_end_ms BIGINT,
                all_day INTEGER NOT NULL DEFAULT 0,
                timezone_id VARCHAR(160),
                location VARCHAR(2000),
                participants_json TEXT NOT NULL DEFAULT '[]',
                description TEXT,
                captured_event_revision BIGINT,
                captured_at_ms BIGINT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_schedule_snapshot_owner_meeting
                    UNIQUE (user_id, meeting_id),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_occurrence_operations (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(64) NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                link_id VARCHAR(36) NOT NULL,
                response_status INTEGER NOT NULL,
                response_revision INTEGER NOT NULL,
                response_json TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_occurrence_operation_key
                    UNIQUE (user_id, idempotency_key),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
                FOREIGN KEY(link_id) REFERENCES meeting_occurrence_links_v2(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_question_threads (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                client_thread_id VARCHAR(512) NOT NULL,
                input_fingerprint VARCHAR(71) NOT NULL,
                transcript_revision_id VARCHAR(512) NOT NULL,
                summary_version_id VARCHAR(512),
                manual_note_revision BIGINT,
                include_manual_note INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_question_thread_client
                    UNIQUE (user_id, meeting_id, client_thread_id),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_question_turns (
                id VARCHAR(36) PRIMARY KEY,
                thread_id VARCHAR(36) NOT NULL,
                client_request_id VARCHAR(512) NOT NULL,
                request_hash VARCHAR(64) NOT NULL,
                ordinal INTEGER NOT NULL,
                question TEXT NOT NULL,
                answer_scope VARCHAR(20) NOT NULL DEFAULT 'meeting',
                answer_kind VARCHAR(20) NOT NULL,
                answer TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                completed_at DATETIME NOT NULL,
                CONSTRAINT uq_meeting_question_request UNIQUE (thread_id, client_request_id),
                CONSTRAINT uq_meeting_question_ordinal UNIQUE (thread_id, ordinal),
                FOREIGN KEY(thread_id) REFERENCES meeting_question_threads(id) ON DELETE CASCADE
            )
            """
        )
        question_turn_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(meeting_question_turns)")
        }
        if "answer_scope" not in question_turn_columns:
            conn.execute(
                "ALTER TABLE meeting_question_turns "
                "ADD COLUMN answer_scope VARCHAR(20) NOT NULL DEFAULT 'meeting'"
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_question_citations (
                id VARCHAR(36) PRIMARY KEY,
                turn_id VARCHAR(36) NOT NULL,
                kind VARCHAR(20) NOT NULL,
                source_id VARCHAR(512) NOT NULL,
                ordinal INTEGER NOT NULL,
                CONSTRAINT uq_meeting_question_citation_ordinal UNIQUE (turn_id, ordinal),
                FOREIGN KEY(turn_id) REFERENCES meeting_question_turns(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_speaker_corrections_v2 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                client_request_id VARCHAR(512) NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(64) NOT NULL,
                transcript_revision_id VARCHAR(512) NOT NULL,
                scope VARCHAR(24) NOT NULL,
                segment_ids_json TEXT NOT NULL,
                cluster_id VARCHAR(512),
                speaker_profile_id VARCHAR(160),
                display_name VARCHAR(120) NOT NULL,
                consent_to_profile_update INTEGER NOT NULL DEFAULT 0,
                base_revision INTEGER NOT NULL,
                assignment_revision INTEGER NOT NULL,
                profile_revision INTEGER,
                sample_state VARCHAR(32) NOT NULL DEFAULT 'not_requested',
                sample_error_code VARCHAR(96),
                model_version VARCHAR(120),
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                CONSTRAINT uq_speaker_correction_client
                    UNIQUE (user_id, client_request_id),
                CONSTRAINT uq_speaker_correction_operation
                    UNIQUE (user_id, idempotency_key),
                CONSTRAINT uq_speaker_assignment_revision
                    UNIQUE (meeting_id, assignment_revision),
                CHECK (scope IN ('segment', 'cluster', 'future_profile')),
                CHECK (consent_to_profile_update IN (0, 1)),
                CHECK (
                    scope <> 'future_profile'
                    OR (speaker_profile_id IS NOT NULL AND consent_to_profile_update = 1)
                ),
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_speaker_reprocess_jobs_v2 (
                id VARCHAR(36) PRIMARY KEY,
                user_id INTEGER NOT NULL,
                speaker_profile_id VARCHAR(160) NOT NULL,
                idempotency_key VARCHAR(512) NOT NULL,
                request_hash VARCHAR(64) NOT NULL,
                status VARCHAR(24) NOT NULL DEFAULT 'queued',
                attempt INTEGER NOT NULL DEFAULT 0,
                progress FLOAT,
                total_meetings INTEGER NOT NULL DEFAULT 0,
                processed_meetings INTEGER NOT NULL DEFAULT 0,
                matched_segments INTEGER NOT NULL DEFAULT 0,
                skipped_locked_segments INTEGER NOT NULL DEFAULT 0,
                error_code VARCHAR(96),
                retryable INTEGER NOT NULL DEFAULT 0,
                profile_revision INTEGER NOT NULL,
                model_version VARCHAR(120) NOT NULL,
                result_speaker_revision_id VARCHAR(160),
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL,
                completed_at DATETIME,
                CONSTRAINT uq_speaker_reprocess_operation
                    UNIQUE (user_id, idempotency_key),
                CHECK (status IN ('queued', 'running', 'completed', 'failed')),
                CHECK (retryable IN (0, 1))
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_speaker_assignments_v2 (
                id VARCHAR(36) PRIMARY KEY,
                correction_id VARCHAR(36),
                reprocess_job_id VARCHAR(36),
                user_id INTEGER NOT NULL,
                meeting_id VARCHAR(36) NOT NULL,
                transcript_line_id VARCHAR(36) NOT NULL,
                speaker_profile_id VARCHAR(160),
                display_name VARCHAR(120) NOT NULL,
                assignment_revision INTEGER NOT NULL,
                source VARCHAR(24) NOT NULL,
                user_locked INTEGER NOT NULL DEFAULT 1,
                model_version VARCHAR(120),
                profile_revision INTEGER,
                confidence FLOAT,
                created_at DATETIME NOT NULL,
                CONSTRAINT uq_speaker_correction_line
                    UNIQUE (correction_id, transcript_line_id),
                CONSTRAINT uq_speaker_reprocess_line
                    UNIQUE (reprocess_job_id, transcript_line_id),
                CHECK (
                    (correction_id IS NOT NULL AND reprocess_job_id IS NULL)
                    OR (correction_id IS NULL AND reprocess_job_id IS NOT NULL)
                ),
                CHECK (source IN ('manual', 'reprocessed')),
                CHECK (user_locked IN (0, 1)),
                FOREIGN KEY(correction_id)
                    REFERENCES meeting_speaker_corrections_v2(id) ON DELETE CASCADE,
                FOREIGN KEY(reprocess_job_id)
                    REFERENCES meeting_speaker_reprocess_jobs_v2(id) ON DELETE CASCADE,
                FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
                FOREIGN KEY(transcript_line_id) REFERENCES transcript_lines(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_action_user
               ON meeting_action_items(user_id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_note_root_user
               ON meeting_note_roots_v2(user_id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_note_root_pull_cursor
               ON meeting_note_roots_v2(user_id, updated_at, meeting_id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_note_root_operation_created
               ON meeting_note_root_operations_v2(created_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_retention_cleanup_ready
               ON meeting_retention_cleanup_jobs_v2(updated_at, id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_attachment_v1_meeting
               ON meeting_attachments_v1(user_id, meeting_id, created_at, id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_attachment_operation_v1_attachment
               ON meeting_attachment_operations_v1(attachment_id, created_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_marker_v1_meeting
               ON meeting_markers_v1(user_id, meeting_id, created_at, id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_marker_operation_v1_marker
               ON meeting_marker_operations_v1(marker_id, created_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_summary_version_v1_meeting
               ON meeting_summary_versions_v1(user_id, meeting_id, created_at, id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_summary_section_state_v1_version
               ON meeting_summary_section_states_v1(user_id, version_id, ordinal, section_id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_summary_current_v1_version
               ON meeting_summary_current_v1(user_id, version_id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_summary_operation_v1_created
               ON meeting_summary_operations_v1(created_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_action_meeting_revision
               ON meeting_action_items(meeting_id, revision)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_action_pull_cursor
               ON meeting_action_items(user_id, meeting_id, updated_at, id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_action_operation_created
               ON meeting_action_operations(created_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_action_share_owner_action
               ON meeting_action_shares(owner_user_id, meeting_id, action_id, updated_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_action_collaboration_operation_created
               ON meeting_action_collaboration_operations(created_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_action_collaboration_event_share
               ON meeting_action_collaboration_events(share_id, created_at, id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_manual_note_user
               ON meeting_manual_notes(user_id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_manual_note_owner_revision
               ON meeting_manual_notes(user_id, meeting_id, revision)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_manual_note_operation_created
               ON meeting_manual_note_operations(created_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_tag_catalog_operation_created
               ON meeting_tag_catalog_operations_v1(created_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_occurrence_user
               ON meeting_occurrence_links_v2(user_id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_occurrence_owner_series
               ON meeting_occurrence_links_v2(user_id, series_key, occurrence_date)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_schedule_snapshot_user
               ON meeting_schedule_snapshots_v2(user_id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_occurrence_operation_created
               ON meeting_occurrence_operations(created_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_question_thread_user
               ON meeting_question_threads(user_id)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_question_thread_meeting
               ON meeting_question_threads(user_id, meeting_id, updated_at)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_question_turn_thread
               ON meeting_question_turns(thread_id, ordinal)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_meeting_question_citation_turn
               ON meeting_question_citations(turn_id, ordinal)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_speaker_correction_owner_meeting
               ON meeting_speaker_corrections_v2(user_id, meeting_id, assignment_revision)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_speaker_assignment_line_locked
               ON meeting_speaker_assignments_v2(transcript_line_id, user_locked, assignment_revision)"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_speaker_reprocess_owner_profile
               ON meeting_speaker_reprocess_jobs_v2(user_id, speaker_profile_id, created_at)"""
        )
        conn.commit()
    finally:
        conn.close()
