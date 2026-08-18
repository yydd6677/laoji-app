from __future__ import annotations

import json
import sqlite3

from audit_stage5_deletion_gate import audit


def _db(path):
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE capability_cutovers (
                capability TEXT PRIMARY KEY,
                contract_revision TEXT NOT NULL,
                barrier_id TEXT,
                activated_at TEXT,
                legacy_submit_closed_at TEXT,
                legacy_reader_removed_at TEXT,
                legacy_submit_count INTEGER NOT NULL DEFAULT 0,
                last_legacy_submit_at TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "INSERT INTO capability_cutovers(capability, contract_revision, updated_at) VALUES (?, ?, ?)",
            ("media.upload", "r1", "2026-08-18T00:00:00Z"),
        )


def test_stage5_audit_is_fail_closed_without_database(tmp_path):
    report = audit(tmp_path)

    assert report["candidate_only"] is True
    assert report["production_mutation"] is False
    assert report["safe_to_delete"] is False
    assert report["deletion_performed"] is False
    assert report["database"]["status"] == "not_provided"
    assert report["blocking_reasons"]


def test_stage5_audit_reports_active_marker_and_incomplete_barrier(tmp_path):
    source = tmp_path / "src"
    source.mkdir()
    (source / "legacy.ts").write_text("import { meetingContentMirror } from './old';\n", encoding="utf-8")
    database = tmp_path / "candidate.sqlite"
    _db(database)

    report = audit(tmp_path, database)

    assert report["legacy_reference_count"] == 1
    assert report["legacy_reference_counts"] == {"account_sync": 1}
    assert report["barriers"]["media.upload"]["present"] is True
    assert report["barriers"]["media.upload"]["legacy_closed"] is False
    assert report["safe_to_delete"] is False
    encoded = json.dumps(report, ensure_ascii=False)
    assert "meetingContentMirror" in encoded


def test_stage5_audit_reports_lifecycle_drain_without_identifiers(tmp_path):
    database = tmp_path / "candidate.sqlite"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE capability_cutovers (
                capability TEXT PRIMARY KEY,
                contract_revision TEXT NOT NULL,
                barrier_id TEXT,
                activated_at TEXT,
                legacy_submit_closed_at TEXT,
                legacy_reader_removed_at TEXT,
                legacy_submit_count INTEGER NOT NULL DEFAULT 0,
                last_legacy_submit_at TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE vnext_tasks (task_id TEXT, state TEXT);
            CREATE TABLE vnext_task_attempts (attempt_id TEXT, state TEXT);
            CREATE TABLE vnext_upload_sessions (upload_id TEXT, state TEXT);
            CREATE TABLE vnext_import_transcript_runs (run_id TEXT, state TEXT);
            CREATE TABLE v2_purges (purge_id TEXT, state TEXT);
            CREATE TABLE vnext_object_cleanup_obligations (obligation_id TEXT, state TEXT);
            INSERT INTO vnext_tasks VALUES ('private-task-id', 'success');
            INSERT INTO vnext_task_attempts VALUES ('private-attempt-id', 'retryable_failure');
            INSERT INTO vnext_upload_sessions VALUES ('private-upload-id', 'verified');
            INSERT INTO vnext_import_transcript_runs VALUES ('private-run-id', 'failed');
            INSERT INTO v2_purges VALUES ('private-purge-id', 'confirmed');
            INSERT INTO vnext_object_cleanup_obligations VALUES ('private-cleanup-id', 'consumed');
            """
        )

    report = audit(tmp_path, database)

    assert report["lifecycle_drain"]["status"] == "pending"
    assert report["lifecycle_drain"]["pending"] == {"attempts": 1}
    assert report["lifecycle_drain"]["old_client_query_recovery"] == "unverified"
    # Aggregates must not leak task IDs, object keys, or meeting data.
    encoded = json.dumps(report, ensure_ascii=False)
    assert "private-task-id" not in encoded
    assert "private-cleanup-id" not in encoded
    assert "candidate task, lease, upload, transcript, purge, or R2 cleanup lifecycle is not drained" in report["blocking_reasons"]


def test_stage5_audit_ignores_dependency_lockfile_markers(tmp_path):
    (tmp_path / "package-lock.json").write_text('{"name":"fixture","note":"Q0"}\n', encoding="utf-8")
    report = audit(tmp_path)

    assert report["legacy_reference_count"] == 0
