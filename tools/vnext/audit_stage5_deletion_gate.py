#!/usr/bin/env python3
"""Read-only Stage 5 deletion-gate audit for the LaoJi vNext candidate.

The command never deletes files, changes SQLite, stops processes, or invokes
systemctl mutating commands.  It is intentionally conservative: a missing
database, missing barrier, unknown public-cycle evidence, active reference, or
unreadable runtime state keeps ``safe_to_delete`` false.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
from typing import Any, Iterable


REQUIRED_CUTOVERS = (
    "media.upload",
    "transcript.realtime",
    "summary",
    "question",
    "schedule",
)

ACTIVE_SUFFIXES = {".py", ".ts", ".tsx", ".kt", ".kts", ".java", ".gradle", ".js", ".json"}
IGNORED_PARTS = {
    ".git",
    ".venv",
    ".venv-vnext",
    "node_modules",
    "build",
    "dist",
    ".expo",
    "__pycache__",
    "tests",
    "tools",
    "docs",
    "artifacts",
}

LEGACY_MARKERS: dict[str, tuple[str, ...]] = {
    "account_sync": (
        "sync_outbox",
        "sync_conflicts",
        "meetingContentMirror",
        "meetingLegacyMirrorCoordinator",
    ),
    "stage2_legacy_upload": (
        "protocol?: 'legacy'",
        "protocol: 'legacy'",
        "18035",
        "8002",
    ),
    "stage3_legacy_summary_q0": (
        "summary_tasks_v2",
        "summarySections",
    ),
    "stage4_legacy_schedule": (
        "localScheduleParser",
        "legacy-v1",
    ),
    "retired_provider_ports": (
        "11434",
        "21435",
        "21436",
    ),
}


@dataclass(frozen=True)
class MarkerHit:
    item: str
    marker: str
    path: str
    line: int


def _active_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in ACTIVE_SUFFIXES:
            continue
        # Dependency lockfiles contain arbitrary package metadata (including
        # strings such as Q0) and are not executable LaoJi capability owners.
        if path.name in {"package-lock.json", "yarn.lock", "pnpm-lock.yaml"}:
            continue
        if any(part in IGNORED_PARTS for part in path.relative_to(root).parts):
            continue
        yield path


def _scan_markers(root: Path) -> list[MarkerHit]:
    hits: list[MarkerHit] = []
    for path in _active_files(root):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            for item, markers in LEGACY_MARKERS.items():
                for marker in markers:
                    if marker in line:
                        hits.append(
                            MarkerHit(
                                item=item,
                                marker=marker,
                                path=str(path.relative_to(root)),
                                line=line_number,
                            )
                        )
    return hits


def _sqlite_read_only(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.resolve()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    """Return columns for a fixed, internally supplied table name.

    The audit is deliberately read-only.  Table names below are constants, so
    this interpolation cannot be influenced by a database row or CLI input.
    """
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def _state_counts(
    connection: sqlite3.Connection,
    table: str,
    column: str,
) -> dict[str, Any]:
    """Aggregate lifecycle states without returning task/entity identifiers."""
    tables = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    if table not in tables:
        return {"status": "missing", "counts": {}, "pending_count": None}
    if column not in _table_columns(connection, table):
        return {"status": "column_missing", "counts": {}, "pending_count": None}
    rows = connection.execute(
        f"SELECT {column} AS state, COUNT(*) AS count FROM {table} GROUP BY {column}"
    ).fetchall()
    counts = {
        str(row["state"] if row["state"] is not None else "<null>"): int(row["count"])
        for row in rows
    }
    # These are terminal states used by the vNext stores.  Unknown states are
    # intentionally treated as pending so a schema/status addition cannot make
    # the deletion gate optimistic by accident.
    terminal = {
        "success", "succeeded", "failure", "failed", "cancelled", "canceled",
        "confirmed", "consumed", "expired", "purged", "revoked", "completed", "verified",
        "terminal_failure", "terminal",
    }
    pending_count = sum(count for state, count in counts.items() if state not in terminal)
    return {"status": "ok", "counts": counts, "pending_count": pending_count}


def _drain_state(connection: sqlite3.Connection) -> dict[str, Any]:
    """Read the lifecycle stores needed before any old asset can be removed.

    Missing tables are reported as unknown, not empty.  This is important for
    older candidate databases created before one of the recovery stores was
    introduced.
    """
    checks = {
        "tasks": _state_counts(connection, "vnext_tasks", "state"),
        "attempts": _state_counts(connection, "vnext_task_attempts", "state"),
        "uploads": _state_counts(connection, "vnext_upload_sessions", "state"),
        "transcripts": _state_counts(connection, "vnext_import_transcript_runs", "state"),
        "purges": _state_counts(connection, "v2_purges", "state"),
        "cleanup_obligations": _state_counts(
            connection, "vnext_object_cleanup_obligations", "state"
        ),
    }
    missing = [name for name, value in checks.items() if value["status"] != "ok"]
    pending = {
        name: value["pending_count"]
        for name, value in checks.items()
        if value["pending_count"] not in (None, 0)
    }
    return {
        "status": "unknown" if missing else ("drained" if not pending else "pending"),
        "checks": checks,
        "missing_checks": missing,
        "pending": pending,
        # There is no local table that proves old-client task-id query replay;
        # retain an explicit evidence slot rather than inferring it from empty
        # task rows.
        "old_client_query_recovery": "unverified",
    }


def _database_state(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"status": "not_provided", "cutovers": {}, "legacy_cycle_evidence": "unknown"}
    if not path.is_file():
        return {"status": "missing", "path": str(path), "cutovers": {}, "legacy_cycle_evidence": "unknown"}
    try:
        with _sqlite_read_only(path) as connection:
            tables = {
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            drain = _drain_state(connection)
            if "capability_cutovers" not in tables:
                return {
                    "status": "missing_capability_table",
                    "path": str(path),
                    "tables": len(tables),
                    "cutovers": {},
                    "legacy_cycle_evidence": "unknown",
                    "drain": drain,
                }
            cutovers: dict[str, Any] = {}
            capability_columns = _table_columns(connection, "capability_cutovers")
            for row in connection.execute("SELECT * FROM capability_cutovers"):
                cutovers[str(row["capability"])] = {
                    "contract_revision": str(row["contract_revision"]),
                    "activated_at": row["activated_at"],
                    "legacy_submit_closed_at": row["legacy_submit_closed_at"],
                    "legacy_reader_removed_at": (
                        row["legacy_reader_removed_at"]
                        if "legacy_reader_removed_at" in capability_columns
                        else None
                    ),
                    "legacy_reader_removal_revision": (
                        row["legacy_reader_removal_revision"]
                        if "legacy_reader_removal_revision" in capability_columns
                        else None
                    ),
                    "legacy_reader_removal_evidence_sha256": (
                        row["legacy_reader_removal_evidence_sha256"]
                        if "legacy_reader_removal_evidence_sha256" in capability_columns
                        else None
                    ),
                    "legacy_submit_count": int(row["legacy_submit_count"]),
                    "last_legacy_submit_at": row["last_legacy_submit_at"],
                }
            # A timestamp comparison cannot prove a complete public period;
            # it only records whether the database has any closed barrier data.
            cycle_evidence = (
                "requires_external_public_cycle_record"
                if any(row.get("legacy_submit_closed_at") for row in cutovers.values())
                else "missing"
            )
            return {
                "status": "ok",
                "path": str(path),
                "tables": len(tables),
                "cutovers": cutovers,
                "legacy_cycle_evidence": cycle_evidence,
                "drain": drain,
            }
    except (OSError, sqlite3.Error) as error:
        return {
            "status": "unreadable",
            "path": str(path),
            "error_code": type(error).__name__,
            "cutovers": {},
            "legacy_cycle_evidence": "unknown",
            "drain": {
                "status": "unknown",
                "checks": {},
                "missing_checks": ["database"],
                "pending": {},
                "old_client_query_recovery": "unverified",
            },
        }


def _runtime_state() -> dict[str, Any]:
    """Collect non-sensitive process/unit evidence without changing runtime."""
    result: dict[str, Any] = {"platform": sys.platform, "processes": [], "systemd_units": []}
    if sys.platform.startswith("linux"):
        proc_root = Path("/proc")
        for entry in proc_root.iterdir() if proc_root.is_dir() else ():
            if not entry.name.isdigit():
                continue
            try:
                command = (entry / "comm").read_text(encoding="utf-8", errors="replace").strip()
                cwd = os.readlink(entry / "cwd")
            except (OSError, UnicodeError):
                continue
            lowered_command = command.lower()
            lowered_cwd = cwd.lower()
            service_cwd = any(
                token in lowered_cwd
                for token in ("/services/laoji-api", "/services/laoji-asr", "\\services\\laoji-api", "\\services\\laoji-asr")
            )
            service_command = any(
                token in lowered_command
                for token in ("laoji-api", "laoji-asr", "vibevoice", "whisperlive", "cloudflared")
            )
            if (service_cwd and (command.startswith("python") or command == "uvicorn")) or service_command:
                result["processes"].append({"pid": int(entry.name), "command": command, "cwd": cwd})
        systemctl = shutil.which("systemctl")
        if systemctl:
            try:
                output = subprocess.run(
                    [systemctl, "list-unit-files", "--no-legend", "--no-pager"],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=5,
                ).stdout
                for line in output.splitlines():
                    unit = line.split(None, 1)[0] if line.split() else ""
                    if any(token in unit.lower() for token in ("laoji", "vibevoice", "whisper", "8002")):
                        result["systemd_units"].append(unit)
            except (OSError, subprocess.SubprocessError):
                result["systemd_units_status"] = "unavailable"
    else:
        result["status"] = "runtime_process_audit_not_supported_on_this_platform"
    return result


def audit(root: Path, database: Path | None = None) -> dict[str, Any]:
    marker_hits = _scan_markers(root)
    marker_counts: dict[str, int] = {}
    for hit in marker_hits:
        marker_counts[hit.item] = marker_counts.get(hit.item, 0) + 1
    db = _database_state(database)
    cutovers = db.get("cutovers", {})
    barrier_state: dict[str, Any] = {}
    for capability in REQUIRED_CUTOVERS:
        row = cutovers.get(capability)
        barrier_state[capability] = {
            "present": row is not None,
            "activated": bool(row and row.get("activated_at")),
            "legacy_closed": bool(row and row.get("legacy_submit_closed_at")),
            "reader_removed": bool(row and row.get("legacy_reader_removed_at")),
            "reader_removal_proof": bool(
                row
                and row.get("legacy_reader_removal_revision")
                and row.get("legacy_reader_removal_evidence_sha256")
            ),
        }
    barriers_ready = all(
        state["present"]
        and state["activated"]
        and state["legacy_closed"]
        and state["reader_removed"]
        and state["reader_removal_proof"]
        for state in barrier_state.values()
    )
    report = {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "root": str(root),
        "database": db,
        "barriers": barrier_state,
        "legacy_reference_count": len(marker_hits),
        "legacy_reference_counts": marker_counts,
        "legacy_references": [hit.__dict__ for hit in marker_hits[:200]],
        "runtime": _runtime_state(),
        "external_public_cycle_evidence": db.get("legacy_cycle_evidence", "unknown"),
        "lifecycle_drain": db.get("drain", {"status": "unknown"}),
        "safe_to_delete": bool(
            barriers_ready
            and not marker_hits
            and db.get("legacy_cycle_evidence") == "verified"
            and db.get("drain", {}).get("status") == "drained"
            and db.get("drain", {}).get("old_client_query_recovery") == "verified"
        ),
        "deletion_performed": False,
        "blocking_reasons": [],
    }
    if not barriers_ready:
        report["blocking_reasons"].append("all capability barriers are not activated, closed, and reader-removed")
    if marker_hits:
        report["blocking_reasons"].append("active source references to legacy capabilities remain")
    if db.get("legacy_cycle_evidence") != "verified":
        report["blocking_reasons"].append("complete public-cycle evidence is external or missing")
    if db.get("status") != "ok":
        report["blocking_reasons"].append("candidate database state is unavailable or incomplete")
    drain = db.get("drain", {})
    if drain.get("status") != "drained":
        report["blocking_reasons"].append(
            "candidate task, lease, upload, transcript, purge, or R2 cleanup lifecycle is not drained"
        )
    if drain.get("old_client_query_recovery") != "verified":
        report["blocking_reasons"].append("old-client task query recovery evidence is missing")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--database", type=Path)
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args()
    report = audit(args.root.resolve(), args.database.resolve() if args.database else None)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(payload, encoding="utf-8")
    print(payload, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
