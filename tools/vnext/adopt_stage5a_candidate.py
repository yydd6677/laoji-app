#!/usr/bin/env python3
"""Persist vNext Stage 5A capability barriers in an isolated candidate DB.

This tool is intentionally incapable of authorizing production release or
legacy deletion.  It requires a verified product-owner waiver, an explicit
candidate root, and a distinct production database inode.  The default mode is
read-only; ``--apply`` first creates a SQLite backup, then closes each candidate
submission barrier with immutable adoption provenance.
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


class CandidateAdoptionError(RuntimeError):
    pass


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def validate_boundaries(
    candidate_database: Path,
    candidate_root: Path,
    production_database: Path,
) -> tuple[Path, Path, Path]:
    candidate = candidate_database.expanduser().resolve(strict=True)
    root = candidate_root.expanduser().resolve(strict=True)
    production = production_database.expanduser().resolve(strict=True)
    if not root.is_dir() or not candidate.is_file() or not production.is_file():
        raise CandidateAdoptionError("candidate_or_production_path_invalid")
    if not _inside(candidate, root):
        raise CandidateAdoptionError("candidate_database_outside_candidate_root")
    if candidate.samefile(production):
        raise CandidateAdoptionError("candidate_database_is_production_database")
    if candidate.name == "local.db":
        raise CandidateAdoptionError("production_database_name_is_forbidden")
    return candidate, root, production


def _existing_cutovers(database: Path) -> list[dict[str, Any]]:
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if "capability_cutovers" not in tables:
            return []
        columns = {
            str(row[1])
            for row in connection.execute("PRAGMA table_info(capability_cutovers)")
        }
        selected = [
            field
            for field in (
                "capability",
                "contract_revision",
                "activated_at",
                "legacy_submit_closed_at",
                "legacy_submit_count",
                "adoption_basis",
                "adoption_evidence_sha256",
                "legacy_retention_mode",
                "legacy_reader_removed_at",
            )
            if field in columns
        ]
        return [
            dict(row)
            for row in connection.execute(
                f"SELECT {','.join(selected)} FROM capability_cutovers ORDER BY capability"
            )
        ]


def _backup_sqlite(source: Path, destination: Path) -> None:
    if destination.exists():
        raise CandidateAdoptionError("candidate_backup_already_exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_connection:
        with sqlite3.connect(destination) as destination_connection:
            source_connection.backup(destination_connection)
            integrity = str(destination_connection.execute("PRAGMA integrity_check").fetchone()[0])
            if integrity != "ok":
                raise CandidateAdoptionError("candidate_backup_integrity_failed")


def adopt(
    *,
    candidate_database: Path,
    candidate_root: Path,
    production_database: Path,
    owner_waiver: Mapping[str, Any],
    activation_id: str,
    apply: bool,
    backup_path: Path | None = None,
) -> dict[str, Any]:
    candidate, root, production = validate_boundaries(
        candidate_database,
        candidate_root,
        production_database,
    )
    verified, reason, _scopes = verify_waiver(owner_waiver)
    if not verified:
        raise CandidateAdoptionError(f"owner_waiver_invalid:{reason}")
    evidence_sha256 = str(owner_waiver["report_sha256"])
    normalized_activation_id = str(activation_id or "").strip()
    if (
        not normalized_activation_id
        or len(normalized_activation_id) > 80
        or any(not (character.isalnum() or character in "-_.") for character in normalized_activation_id)
    ):
        raise CandidateAdoptionError("activation_id_invalid")
    before = _existing_cutovers(candidate)
    planned = [capability for capability, _revision in CAPABILITIES]
    if not apply:
        return {
            "schema_version": 1,
            "candidate_only": True,
            "production_mutation": False,
            "applied": False,
            "database_file": candidate.name,
            "candidate_root": str(root),
            "production_database_distinct": not candidate.samefile(production),
            "waiver_report_sha256": evidence_sha256,
            "planned_capabilities": planned,
            "existing_cutovers": before,
        }
    backup = (
        backup_path.expanduser().resolve()
        if backup_path is not None
        else candidate.with_name(f"{candidate.name}.pre-stage5a-{normalized_activation_id}")
    )
    if not _inside(backup, root):
        raise CandidateAdoptionError("candidate_backup_outside_candidate_root")
    _backup_sqlite(candidate, backup)
    settings.DATABASE_URL = f"sqlite+aiosqlite:///{candidate}"
    device_identity._SCHEMA_READY.clear()  # type: ignore[attr-defined]
    activated = []
    for capability, revision in CAPABILITIES:
        activated.append(vnext_capability_cutover.activate_cutover(
            capability,
            revision,
            barrier_id=f"stage5a-{normalized_activation_id}-{capability.replace('.', '-')}",
            adoption_basis=ADOPTION_BASIS,
            adoption_evidence_sha256=evidence_sha256,
            legacy_retention_mode=LEGACY_RETENTION_MODE,
        ))
    for row in activated:
        if (
            row.get("closed") is not True
            or row.get("adoption_basis") != ADOPTION_BASIS
            or row.get("adoption_evidence_sha256") != evidence_sha256
            or row.get("legacy_retention_mode") != LEGACY_RETENTION_MODE
            or row.get("legacy_reader_removed_at") is not None
        ):
            raise CandidateAdoptionError("candidate_cutover_postcondition_failed")
    with sqlite3.connect(f"file:{candidate}?mode=ro", uri=True) as connection:
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        foreign_keys = len(list(connection.execute("PRAGMA foreign_key_check")))
    if integrity != "ok" or foreign_keys != 0:
        raise CandidateAdoptionError("candidate_database_integrity_failed")
    return {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "applied": True,
        "database_file": candidate.name,
        "backup_file": backup.name,
        "waiver_report_sha256": evidence_sha256,
        "active_path_policy": owner_waiver["active_path_policy"],
        "legacy_retention_mode": LEGACY_RETENTION_MODE,
        "physical_legacy_deletion_performed": False,
        "activated_capabilities": [
            {
                "capability": row["capability"],
                "contract_revision": row["contract_revision"],
                "closed": row["closed"],
                "legacy_submit_count_preserved": row["legacy_submit_count"],
            }
            for row in activated
        ],
        "integrity": integrity,
        "foreign_key_violations": foreign_keys,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-database", type=Path, required=True)
    parser.add_argument("--candidate-root", type=Path, required=True)
    parser.add_argument("--production-database", type=Path, required=True)
    parser.add_argument("--owner-waiver", type=Path, required=True)
    parser.add_argument("--activation-id", required=True)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    waiver = json.loads(args.owner_waiver.read_text(encoding="utf-8"))
    try:
        report = adopt(
            candidate_database=args.candidate_database,
            candidate_root=args.candidate_root,
            production_database=args.production_database,
            owner_waiver=waiver,
            activation_id=args.activation_id,
            apply=args.apply,
            backup_path=args.backup,
        )
    except (CandidateAdoptionError, OSError, sqlite3.Error) as error:
        print(json.dumps({
            "schema_version": 1,
            "candidate_only": True,
            "production_mutation": False,
            "applied": False,
            "error_code": str(error),
        }, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

