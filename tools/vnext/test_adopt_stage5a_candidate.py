from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from adopt_stage5a_candidate import CandidateAdoptionError, adopt
from app.config import settings
from app.services import device_identity
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
        "issued_at": "2026-08-21T14:00:00+00:00",
        "authorization_reference": "codex-thread:test",
        "baseline_revision": "test",
        "applies_to": sorted(REQUIRED_SCOPES),
        "active_path_policy": ACTIVE_PATH_POLICY,
        "physical_legacy_deletion_authorized": False,
        "production_release_authorized": False,
        "risk_acknowledgements": list(RISK_ACKNOWLEDGEMENTS),
    })


def _database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )


def test_dry_run_does_not_create_cutover_table(tmp_path: Path) -> None:
    root = tmp_path / "candidate"
    root.mkdir()
    candidate = root / "api.db"
    production = tmp_path / "local.db"
    _database(candidate)
    _database(production)

    report = adopt(
        candidate_database=candidate,
        candidate_root=root,
        production_database=production,
        owner_waiver=_waiver(),
        activation_id="test",
        apply=False,
    )

    assert report["applied"] is False
    with sqlite3.connect(candidate) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='capability_cutovers'"
        ).fetchone()[0] == 0


def test_apply_closes_all_barriers_and_preserves_legacy_assets(tmp_path: Path) -> None:
    root = tmp_path / "candidate"
    root.mkdir()
    candidate = root / "api.db"
    production = tmp_path / "local.db"
    _database(candidate)
    _database(production)
    original_url = settings.DATABASE_URL
    try:
        report = adopt(
            candidate_database=candidate,
            candidate_root=root,
            production_database=production,
            owner_waiver=_waiver(),
            activation_id="test",
            apply=True,
        )
    finally:
        settings.DATABASE_URL = original_url
        device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]

    assert report["applied"] is True
    assert len(report["activated_capabilities"]) == 5
    assert report["physical_legacy_deletion_performed"] is False
    assert (root / "api.db.pre-stage5a-test").is_file()
    with sqlite3.connect(candidate) as connection:
        rows = connection.execute(
            "SELECT legacy_submit_closed_at, legacy_reader_removed_at, legacy_retention_mode "
            "FROM capability_cutovers"
        ).fetchall()
    assert len(rows) == 5
    assert all(row[0] is not None and row[1] is None and row[2] == "cold_rollback" for row in rows)


def test_production_inode_and_local_db_name_are_rejected(tmp_path: Path) -> None:
    root = tmp_path / "candidate"
    root.mkdir()
    production = root / "local.db"
    _database(production)
    with pytest.raises(CandidateAdoptionError):
        adopt(
            candidate_database=production,
            candidate_root=root,
            production_database=production,
            owner_waiver=_waiver(),
            activation_id="test",
            apply=True,
        )
