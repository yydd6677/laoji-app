#!/usr/bin/env python3
"""Read-only audit for a Stage 5A adopted candidate database.

Stage 5A closes legacy submission barriers for an isolated candidate while
retaining every legacy reader and asset as a cold rollback.  This audit is
deliberately separate from the Stage 5 deletion gate: passing here must never
be interpreted as permission to delete legacy data or publish the candidate.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
from typing import Any, Mapping

from product_owner_risk_waiver import verify_waiver


REQUIRED_CAPABILITIES = (
    "media.upload",
    "transcript.realtime",
    "summary",
    "question",
    "schedule",
)

LIFECYCLE_TABLES = {
    "tasks": ("vnext_tasks", "state"),
    "attempts": ("vnext_task_attempts", "state"),
    "uploads": ("vnext_upload_sessions", "state"),
    "transcripts": ("vnext_import_transcript_runs", "state"),
    "purges": ("v2_purges", "state"),
    "cleanup_obligations": ("vnext_object_cleanup_obligations", "state"),
}

TERMINAL_STATES = frozenset({
    "success",
    "succeeded",
    "failure",
    "failed",
    "cancelled",
    "canceled",
    "confirmed",
    "consumed",
    "expired",
    "purged",
    "revoked",
    "completed",
    "verified",
    "terminal_failure",
    "terminal",
})


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def _lifecycle_state(
    connection: sqlite3.Connection,
    tables: set[str],
) -> tuple[dict[str, Any], bool]:
    result: dict[str, Any] = {}
    passed = True
    for name, (table, column) in LIFECYCLE_TABLES.items():
        if table not in tables or column not in _columns(connection, table):
            result[name] = {"status": "missing", "total_count": None, "nonterminal_count": None}
            passed = False
            continue
        rows = connection.execute(
            f"SELECT {column}, COUNT(*) FROM {table} GROUP BY {column}"
        ).fetchall()
        counts = {
            str(row[0] if row[0] is not None else "<null>"): int(row[1])
            for row in rows
        }
        nonterminal = sum(
            count for state, count in counts.items() if state not in TERMINAL_STATES
        )
        result[name] = {
            "status": "drained" if nonterminal == 0 else "pending",
            "total_count": sum(counts.values()),
            "nonterminal_count": nonterminal,
            "state_counts": counts,
        }
        passed = passed and nonterminal == 0
    return result, passed


def audit(
    *,
    candidate_database: Path,
    candidate_root: Path,
    production_database: Path,
    owner_waiver: Mapping[str, Any],
) -> dict[str, Any]:
    candidate = candidate_database.expanduser().resolve()
    root = candidate_root.expanduser().resolve()
    production = production_database.expanduser().resolve()
    checks: dict[str, bool] = {
        "candidate_root_exists": root.is_dir(),
        "candidate_database_exists": candidate.is_file(),
        "production_database_exists": production.is_file(),
        "candidate_database_inside_candidate_root": _inside(candidate, root),
        "candidate_database_name_is_not_production_name": candidate.name != "local.db",
    }
    checks["candidate_database_is_distinct_from_production"] = bool(
        candidate.is_file()
        and production.is_file()
        and not candidate.samefile(production)
    )
    waiver_valid, waiver_reason, _scopes = verify_waiver(owner_waiver)
    checks["owner_waiver_valid"] = waiver_valid

    report: dict[str, Any] = {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "production_release_authorized": False,
        "physical_legacy_deletion_performed": False,
        "legacy_source_retained": True,
        "safe_to_delete": False,
        "active_path_policy": "single-owner-no-dual-write-no-silent-fallback",
        "candidate_database_file": candidate.name,
        "candidate_root": str(root),
        "owner_waiver": {
            "verified": waiver_valid,
            "reason": waiver_reason,
            "report_sha256": owner_waiver.get("report_sha256"),
        },
        "checks": checks,
        "capabilities": {},
        "lifecycle": {},
        "backup_files": [],
        "passed": False,
        "blocking_reasons": [],
    }

    if not all(checks.values()):
        report["blocking_reasons"].append("candidate_boundary_or_owner_waiver_invalid")
        return report

    backups = sorted(path.name for path in root.glob(f"{candidate.name}.pre-stage5a-*") if path.is_file())
    report["backup_files"] = backups
    checks["pre_adoption_sqlite_backup_present"] = bool(backups)

    try:
        with sqlite3.connect(f"file:{candidate}?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row
            tables = {
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
            foreign_key_violations = len(connection.execute("PRAGMA foreign_key_check").fetchall())
            checks["sqlite_integrity"] = integrity == "ok"
            checks["sqlite_foreign_keys"] = foreign_key_violations == 0
            checks["capability_cutovers_table_present"] = "capability_cutovers" in tables
            report["database"] = {
                "integrity": integrity,
                "foreign_key_violation_count": foreign_key_violations,
                "table_count": len(tables),
            }

            rows: dict[str, sqlite3.Row] = {}
            if "capability_cutovers" in tables:
                rows = {
                    str(row["capability"]): row
                    for row in connection.execute(
                        "SELECT * FROM capability_cutovers ORDER BY capability"
                    )
                }
            waiver_sha = str(owner_waiver.get("report_sha256") or "")
            capability_passed = True
            for capability in REQUIRED_CAPABILITIES:
                row = rows.get(capability)
                state = {
                    "present": row is not None,
                    "activated": bool(row and row["activated_at"]),
                    "legacy_submission_closed": bool(row and row["legacy_submit_closed_at"]),
                    "adoption_basis_verified": bool(
                        row and row["adoption_basis"] == "product_owner_risk_waiver"
                    ),
                    "adoption_evidence_verified": bool(
                        row and row["adoption_evidence_sha256"] == waiver_sha
                    ),
                    "cold_rollback_retained": bool(
                        row and row["legacy_retention_mode"] == "cold_rollback"
                    ),
                    "legacy_reader_not_removed": bool(
                        row and row["legacy_reader_removed_at"] is None
                    ),
                }
                state["passed"] = all(state.values())
                capability_passed = capability_passed and state["passed"]
                report["capabilities"][capability] = state
            checks["all_required_capabilities_adopted"] = capability_passed

            lifecycle, lifecycle_passed = _lifecycle_state(connection, tables)
            report["lifecycle"] = lifecycle
            checks["all_candidate_lifecycles_drained"] = lifecycle_passed
    except (OSError, sqlite3.Error) as error:
        report["database"] = {"status": "unreadable", "error_code": type(error).__name__}
        report["blocking_reasons"].append("candidate_database_unreadable")
        return report

    failed = sorted(name for name, passed in checks.items() if not passed)
    report["blocking_reasons"].extend(failed)
    report["passed"] = not failed
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-database", type=Path, required=True)
    parser.add_argument("--candidate-root", type=Path, required=True)
    parser.add_argument("--production-database", type=Path, required=True)
    parser.add_argument("--owner-waiver", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    waiver = json.loads(args.owner_waiver.read_text(encoding="utf-8"))
    report = audit(
        candidate_database=args.candidate_database,
        candidate_root=args.candidate_root,
        production_database=args.production_database,
        owner_waiver=waiver,
    )
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
