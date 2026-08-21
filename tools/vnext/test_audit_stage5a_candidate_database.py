from __future__ import annotations

import sqlite3
from pathlib import Path

from audit_stage5a_candidate_database import audit, LIFECYCLE_TABLES
from product_owner_risk_waiver import (
    ACTIVE_PATH_POLICY,
    EVIDENCE_CONTRACT,
    OWNER_DECISION,
    OWNER_ROLE,
    REQUIRED_SCOPES,
    RISK_ACKNOWLEDGEMENTS,
    seal_waiver,
)


def _waiver() -> dict:
    return seal_waiver({
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "owner_role": OWNER_ROLE,
        "decision": OWNER_DECISION,
        "issued_at": "2026-08-21T15:00:00+00:00",
        "authorization_reference": "codex-thread:test",
        "baseline_revision": "test",
        "applies_to": sorted(REQUIRED_SCOPES),
        "active_path_policy": ACTIVE_PATH_POLICY,
        "physical_legacy_deletion_authorized": False,
        "production_release_authorized": False,
        "risk_acknowledgements": list(RISK_ACKNOWLEDGEMENTS),
    })


def _database(path: Path, waiver_sha: str, *, pending: bool = False) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE meetings (id TEXT PRIMARY KEY)")
        connection.execute(
            """
            CREATE TABLE capability_cutovers (
                capability TEXT PRIMARY KEY,
                activated_at TEXT,
                legacy_submit_closed_at TEXT,
                adoption_basis TEXT,
                adoption_evidence_sha256 TEXT,
                legacy_retention_mode TEXT,
                legacy_reader_removed_at TEXT
            )
            """
        )
        for capability in ("media.upload", "transcript.realtime", "summary", "question", "schedule"):
            connection.execute(
                "INSERT INTO capability_cutovers VALUES (?, 'now', 'now', ?, ?, ?, NULL)",
                (capability, "product_owner_risk_waiver", waiver_sha, "cold_rollback"),
            )
        for _name, (table, column) in LIFECYCLE_TABLES.items():
            connection.execute(f"CREATE TABLE {table} ({column} TEXT)")
        if pending:
            connection.execute("INSERT INTO vnext_tasks(state) VALUES ('running')")


def test_stage5a_candidate_passes_with_closed_barriers_and_drained_stores(tmp_path: Path) -> None:
    root = tmp_path / "candidate"
    root.mkdir()
    candidate = root / "api.db"
    production = tmp_path / "local.db"
    waiver = _waiver()
    _database(candidate, waiver["report_sha256"])
    with sqlite3.connect(production) as connection:
        connection.execute("CREATE TABLE meetings (id TEXT PRIMARY KEY)")
    (root / "api.db.pre-stage5a-test").write_bytes(b"backup")

    report = audit(
        candidate_database=candidate,
        candidate_root=root,
        production_database=production,
        owner_waiver=waiver,
    )

    assert report["passed"] is True
    assert report["safe_to_delete"] is False
    assert report["physical_legacy_deletion_performed"] is False
    assert all(row["legacy_reader_not_removed"] for row in report["capabilities"].values())


def test_stage5a_candidate_fails_closed_for_pending_task(tmp_path: Path) -> None:
    root = tmp_path / "candidate"
    root.mkdir()
    candidate = root / "api.db"
    production = tmp_path / "local.db"
    waiver = _waiver()
    _database(candidate, waiver["report_sha256"], pending=True)
    with sqlite3.connect(production) as connection:
        connection.execute("CREATE TABLE meetings (id TEXT PRIMARY KEY)")
    (root / "api.db.pre-stage5a-test").write_bytes(b"backup")

    report = audit(
        candidate_database=candidate,
        candidate_root=root,
        production_database=production,
        owner_waiver=waiver,
    )

    assert report["passed"] is False
    assert report["checks"]["all_candidate_lifecycles_drained"] is False


def test_stage5a_candidate_rejects_reader_removal(tmp_path: Path) -> None:
    root = tmp_path / "candidate"
    root.mkdir()
    candidate = root / "api.db"
    production = tmp_path / "local.db"
    waiver = _waiver()
    _database(candidate, waiver["report_sha256"])
    with sqlite3.connect(candidate) as connection:
        connection.execute(
            "UPDATE capability_cutovers SET legacy_reader_removed_at='now' WHERE capability='summary'"
        )
    with sqlite3.connect(production) as connection:
        connection.execute("CREATE TABLE meetings (id TEXT PRIMARY KEY)")
    (root / "api.db.pre-stage5a-test").write_bytes(b"backup")

    report = audit(
        candidate_database=candidate,
        candidate_root=root,
        production_database=production,
        owner_waiver=waiver,
    )

    assert report["passed"] is False
    assert report["capabilities"]["summary"]["legacy_reader_not_removed"] is False
