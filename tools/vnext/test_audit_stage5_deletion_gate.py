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
    assert report["barriers"]["media.upload"]["present"] is True
    assert report["barriers"]["media.upload"]["legacy_closed"] is False
    assert report["safe_to_delete"] is False
    encoded = json.dumps(report, ensure_ascii=False)
    assert "meetingContentMirror" in encoded
