from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from adopt_vnext_production import ProductionAdoptionError, adopt
from product_owner_risk_waiver import (
    ACTIVE_PATH_POLICY,
    EVIDENCE_CONTRACT,
    OWNER_DECISION,
    OWNER_ROLE,
    REQUIRED_SCOPES,
    RISK_ACKNOWLEDGEMENTS as WAIVER_ACKNOWLEDGEMENTS,
    seal_waiver,
)
from production_release_authorization import (
    EVIDENCE_CONTRACT as RELEASE_CONTRACT,
    LEGACY_RETENTION_MODE,
    OWNER_DECISION as RELEASE_DECISION,
    OWNER_ROLE as RELEASE_OWNER_ROLE,
    RISK_ACKNOWLEDGEMENTS,
    seal_authorization,
)


def _database(path: Path, *, active: bool = False) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, user_id INTEGER, updated_at TEXT, data_epoch_id TEXT)"
        )
        connection.execute(
            "CREATE TABLE summary_tasks_v2 (id TEXT PRIMARY KEY, status TEXT NOT NULL)"
        )
        if active:
            connection.execute("INSERT INTO summary_tasks_v2 VALUES ('task-1','running')")


def _waiver() -> dict:
    return seal_waiver({
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "owner_role": OWNER_ROLE,
        "decision": OWNER_DECISION,
        "issued_at": "2026-08-21T14:00:00+00:00",
        "authorization_reference": "codex-thread:test-waiver",
        "baseline_revision": "test",
        "applies_to": sorted(REQUIRED_SCOPES),
        "active_path_policy": ACTIVE_PATH_POLICY,
        "physical_legacy_deletion_authorized": False,
        "production_release_authorized": False,
        "risk_acknowledgements": list(WAIVER_ACKNOWLEDGEMENTS),
    })


def _authorization(database: Path) -> dict:
    return seal_authorization({
        "schema_version": 1,
        "evidence_contract": RELEASE_CONTRACT,
        "owner_role": RELEASE_OWNER_ROLE,
        "decision": RELEASE_DECISION,
        "issued_at": "2026-08-22T10:00:00+08:00",
        "authorization_reference": "codex-thread:test-release",
        "baseline_revision": "test",
        "target_version_name": "1.1.56",
        "target_version_code": 164,
        "production_database": str(database.resolve()),
        "active_path_policy": ACTIVE_PATH_POLICY,
        "legacy_retention_mode": LEGACY_RETENTION_MODE,
        "production_release_authorized": True,
        "public_traffic_switch_authorized": True,
        "physical_legacy_deletion_authorized": False,
        "risk_acknowledgements": list(RISK_ACKNOWLEDGEMENTS),
    })


def test_dry_run_is_read_only(tmp_path: Path) -> None:
    database = tmp_path / "local.db"
    _database(database)
    report = adopt(
        database_path=database,
        release_authorization=_authorization(database),
        owner_waiver=_waiver(),
        activation_id="release-test",
        backup_path=tmp_path.parent / "backup.db",
        apply=False,
    )
    assert report["applied"] is False
    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='capability_cutovers'"
        ).fetchone()[0] == 0


def test_apply_backs_up_and_closes_barriers(tmp_path: Path) -> None:
    database = tmp_path / "local.db"
    backup = tmp_path.parent / f"{tmp_path.name}-backup.db"
    _database(database)
    report = adopt(
        database_path=database,
        release_authorization=_authorization(database),
        owner_waiver=_waiver(),
        activation_id="release-test",
        backup_path=backup,
        apply=True,
    )
    assert report["applied"] is True
    assert backup.is_file()
    assert len(report["activated_capabilities"]) == 5
    assert report["physical_legacy_deletion_performed"] is False
    with sqlite3.connect(database) as connection:
        rows = connection.execute(
            "SELECT legacy_submit_closed_at, legacy_reader_removed_at, legacy_retention_mode "
            "FROM capability_cutovers"
        ).fetchall()
    assert len(rows) == 5
    assert all(row[0] and row[1] is None and row[2] == "cold_rollback" for row in rows)


def test_active_work_blocks_apply(tmp_path: Path) -> None:
    database = tmp_path / "local.db"
    _database(database, active=True)
    with pytest.raises(ProductionAdoptionError, match="production_work_not_drained"):
        adopt(
            database_path=database,
            release_authorization=_authorization(database),
            owner_waiver=_waiver(),
            activation_id="release-test",
            backup_path=tmp_path.parent / "active-backup.db",
            apply=True,
        )


def test_retention_rows_without_status_block_apply(tmp_path: Path) -> None:
    database = tmp_path / "local.db"
    _database(database)
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE meeting_retention_cleanup_jobs_v2 (id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO meeting_retention_cleanup_jobs_v2 VALUES ('cleanup-1')")
    with pytest.raises(ProductionAdoptionError, match="production_work_not_drained"):
        adopt(
            database_path=database,
            release_authorization=_authorization(database),
            owner_waiver=_waiver(),
            activation_id="release-test",
            backup_path=tmp_path.parent / "retention-backup.db",
            apply=True,
        )


def test_authorization_cannot_enable_legacy_deletion(tmp_path: Path) -> None:
    database = tmp_path / "local.db"
    _database(database)
    authorization = _authorization(database)
    authorization["physical_legacy_deletion_authorized"] = True
    with pytest.raises(ProductionAdoptionError, match="physical_legacy_deletion_authorized_invalid"):
        adopt(
            database_path=database,
            release_authorization=authorization,
            owner_waiver=_waiver(),
            activation_id="release-test",
            backup_path=tmp_path.parent / "invalid-backup.db",
            apply=True,
        )
