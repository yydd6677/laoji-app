#!/usr/bin/env python3
"""Close vNext production submission barriers after an explicit release grant.

The default mode is read-only.  Apply mode refuses active work, creates an
online SQLite backup, records the same quality-waiver provenance used by the
Stage 5A candidate, and keeps every legacy reader/source available only for a
whole-release cold rollback.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
from typing import Any, Mapping

from app.config import settings
from app.services import device_identity, vnext_capability_cutover
from product_owner_risk_waiver import verify_waiver
from production_release_authorization import verify_authorization


ADOPTION_BASIS = "product_owner_risk_waiver"
LEGACY_RETENTION_MODE = "cold_rollback"
CAPABILITIES = (
    (
        vnext_capability_cutover.MEDIA_UPLOAD_CAPABILITY,
        vnext_capability_cutover.MEDIA_UPLOAD_CONTRACT_REVISION,
    ),
    (
        vnext_capability_cutover.REALTIME_ASR_CAPABILITY,
        vnext_capability_cutover.REALTIME_ASR_CONTRACT_REVISION,
    ),
    (
        vnext_capability_cutover.SOURCE_STREAM_CAPABILITY,
        vnext_capability_cutover.SOURCE_STREAM_CONTRACT_REVISION,
    ),
    (
        vnext_capability_cutover.QUESTION_READER_CAPABILITY,
        vnext_capability_cutover.QUESTION_READER_CONTRACT_REVISION,
    ),
    (
        vnext_capability_cutover.SCHEDULE_GRAPH_CAPABILITY,
        vnext_capability_cutover.SCHEDULE_GRAPH_CONTRACT_REVISION,
    ),
)


class ProductionAdoptionError(RuntimeError):
    pass


ACTIVE_QUERIES = (
    ("summary_tasks_v2", "status", ("queued", "running")),
    ("meeting_recording_r2_uploads_v1", "status", ("active",)),
    ("meeting_recording_transcription_jobs_v2", "status", ("queued", "running")),
    ("meeting_retention_cleanup_jobs_v2", "status", ("queued", "running")),
    ("meeting_media_clip_jobs_v1", "status", ("queued", "running")),
    ("meeting_speaker_reprocess_jobs_v2", "status", ("queued", "running")),
    ("vnext_tasks", "state", ("active",)),
    ("vnext_task_attempts", "state", ("queued", "running", "retryable_failure", "lease_expired")),
    ("vnext_import_transcript_runs", "state", ("queued", "running")),
    ("vnext_speaker_runs", "state", ("collecting", "queued", "running")),
    ("vnext_upload_sessions", "state", ("provisioning", "active", "completing", "verified")),
    ("vnext_object_cleanup_obligations", "state", ("pending", "running")),
    ("v2_purges", "state", ("pending", "running")),
)


def _normalize_activation_id(value: str) -> str:
    normalized = str(value or "").strip()
    if (
        not normalized
        or len(normalized) > 80
        or any(not (character.isalnum() or character in "-_.") for character in normalized)
    ):
        raise ProductionAdoptionError("activation_id_invalid")
    return normalized


def _validate_database(path: Path, authorization: Mapping[str, Any]) -> Path:
    database = path.expanduser().resolve(strict=True)
    authorized = Path(str(authorization["production_database"])).expanduser().resolve(strict=True)
    if not database.is_file() or not database.samefile(authorized):
        raise ProductionAdoptionError("production_database_not_authorized")
    if database.name != "local.db":
        raise ProductionAdoptionError("production_database_name_invalid")
    return database


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def inspect_active_work(database: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        tables = _tables(connection)
        for table, column, states in ACTIVE_QUERIES:
            if table not in tables:
                counts[table] = 0
                continue
            placeholders = ",".join("?" for _ in states)
            count = int(connection.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {column} IN ({placeholders})",
                states,
            ).fetchone()[0])
            counts[table] = count
    return counts


def _backup_sqlite(source: Path, destination: Path) -> None:
    if destination.exists():
        raise ProductionAdoptionError("production_backup_already_exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_connection:
        with sqlite3.connect(destination) as destination_connection:
            source_connection.backup(destination_connection)
            integrity = str(destination_connection.execute("PRAGMA integrity_check").fetchone()[0])
            foreign_keys = len(destination_connection.execute("PRAGMA foreign_key_check").fetchall())
    if integrity != "ok" or foreign_keys != 0:
        raise ProductionAdoptionError("production_backup_integrity_failed")


def adopt(
    *,
    database_path: Path,
    release_authorization: Mapping[str, Any],
    owner_waiver: Mapping[str, Any],
    activation_id: str,
    backup_path: Path,
    apply: bool,
) -> dict[str, Any]:
    authorization_valid, authorization_reason = verify_authorization(release_authorization)
    if not authorization_valid:
        raise ProductionAdoptionError(authorization_reason)
    waiver_valid, waiver_reason, _scopes = verify_waiver(owner_waiver)
    if not waiver_valid:
        raise ProductionAdoptionError(f"owner_waiver_invalid:{waiver_reason}")
    database = _validate_database(database_path, release_authorization)
    normalized_activation_id = _normalize_activation_id(activation_id)
    active_work = inspect_active_work(database)
    active_total = sum(active_work.values())
    report: dict[str, Any] = {
        "schema_version": 1,
        "production_mutation": False,
        "public_traffic_switched": False,
        "physical_legacy_deletion_performed": False,
        "legacy_retention_mode": LEGACY_RETENTION_MODE,
        "release_authorization_sha256": release_authorization["report_sha256"],
        "waiver_report_sha256": owner_waiver["report_sha256"],
        "database": str(database),
        "active_work": active_work,
        "active_work_total": active_total,
        "planned_capabilities": [capability for capability, _revision in CAPABILITIES],
        "applied": False,
    }
    if active_total:
        raise ProductionAdoptionError("production_work_not_drained")
    if not apply:
        return report

    backup = backup_path.expanduser().resolve()
    if backup == database or backup.exists() or backup.parent == database.parent:
        raise ProductionAdoptionError("production_backup_path_invalid")
    _backup_sqlite(database, backup)

    original_url = settings.DATABASE_URL
    settings.DATABASE_URL = f"sqlite+aiosqlite:///{database}"
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    try:
        activated = [
            vnext_capability_cutover.activate_cutover(
                capability,
                revision,
                barrier_id=(
                    f"production-{normalized_activation_id}-"
                    f"{capability.replace('.', '-')}"
                ),
                adoption_basis=ADOPTION_BASIS,
                adoption_evidence_sha256=str(owner_waiver["report_sha256"]),
                legacy_retention_mode=LEGACY_RETENTION_MODE,
            )
            for capability, revision in CAPABILITIES
        ]
    finally:
        settings.DATABASE_URL = original_url
        device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]

    for row in activated:
        if (
            row.get("closed") is not True
            or row.get("legacy_reader_removed_at") is not None
            or row.get("legacy_retention_mode") != LEGACY_RETENTION_MODE
            or row.get("adoption_basis") != ADOPTION_BASIS
            or row.get("adoption_evidence_sha256") != owner_waiver["report_sha256"]
        ):
            raise ProductionAdoptionError("production_cutover_postcondition_failed")

    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        foreign_keys = len(connection.execute("PRAGMA foreign_key_check").fetchall())
    if integrity != "ok" or foreign_keys != 0:
        raise ProductionAdoptionError("production_database_integrity_failed")
    report.update({
        "production_mutation": True,
        "applied": True,
        "backup": str(backup),
        "integrity": integrity,
        "foreign_key_violations": foreign_keys,
        "activated_capabilities": [
            {
                "capability": row["capability"],
                "contract_revision": row["contract_revision"],
                "closed": row["closed"],
                "legacy_submit_count_preserved": row["legacy_submit_count"],
            }
            for row in activated
        ],
    })
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--release-authorization", type=Path, required=True)
    parser.add_argument("--owner-waiver", type=Path, required=True)
    parser.add_argument("--activation-id", required=True)
    parser.add_argument("--backup", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        report = adopt(
            database_path=args.database,
            release_authorization=json.loads(args.release_authorization.read_text(encoding="utf-8")),
            owner_waiver=json.loads(args.owner_waiver.read_text(encoding="utf-8")),
            activation_id=args.activation_id,
            backup_path=args.backup,
            apply=args.apply,
        )
    except (ProductionAdoptionError, OSError, sqlite3.Error) as error:
        print(json.dumps({
            "schema_version": 1,
            "production_mutation": False,
            "applied": False,
            "error_code": str(error),
        }, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

