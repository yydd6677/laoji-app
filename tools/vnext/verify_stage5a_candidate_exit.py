#!/usr/bin/env python3
"""Aggregate the non-destructive Stage 5A candidate exit contract.

The report proves candidate readiness only.  It explicitly fails if any input
claims legacy deletion or production release, and it never turns owner-waived
human/public gates into measured passes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
from typing import Any, Mapping

from product_owner_risk_waiver import verify_waiver


def _load(path: Path) -> Mapping[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, Mapping):
        raise ValueError(f"not_json_object:{path.name}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _apk_identity(apk: Path, aapt: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [str(aapt), "dump", "badging", str(apk)],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    first = completed.stdout.splitlines()[0] if completed.stdout.splitlines() else ""
    match = re.search(
        r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'",
        first,
    )
    return {
        "command_succeeded": completed.returncode == 0,
        "application_id": match.group(1) if match else None,
        "version_code": int(match.group(2)) if match and match.group(2).isdigit() else None,
        "version_name": match.group(3) if match else None,
    }


def _apk_signature(apk: Path, apksigner: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [str(apksigner), "verify", "--verbose", "--print-certs", str(apk)],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    output = completed.stdout + completed.stderr
    schemes: dict[str, bool | None] = {}
    for version in (1, 2, 3, 4):
        match = re.search(
            rf"Verified using v{version} scheme[^:]*:\s*(true|false)",
            output,
            flags=re.IGNORECASE,
        )
        schemes[f"v{version}"] = match.group(1).lower() == "true" if match else None
    return {
        "command_succeeded": completed.returncode == 0,
        "schemes": schemes,
        "signer_count": len(re.findall(r"Signer #\d+ certificate DN:", output)),
    }


def _server_package(package: Path) -> dict[str, Any]:
    forbidden_names: list[str] = []
    member_count = 0
    with tarfile.open(package, mode="r:gz") as archive:
        for member in archive.getmembers():
            member_count += 1
            lowered = member.name.lower()
            name = Path(lowered).name
            if (
                name == ".env"
                or name.endswith((".db", ".sqlite", ".sqlite3", ".pem", ".key"))
                or "credential" in name
                or "secret" in name
            ):
                forbidden_names.append(member.name)
    return {
        "member_count": member_count,
        "forbidden_member_names": forbidden_names,
        "passed": member_count > 0 and not forbidden_names,
    }


def verify(
    *,
    owner_waiver: Mapping[str, Any],
    stage_reports: Mapping[str, Mapping[str, Any]],
    single_path_report: Mapping[str, Any],
    database_audit: Mapping[str, Any],
    apk: Path,
    apk_metadata: Mapping[str, Any],
    stable_apk: Path,
    server_package: Path,
    aapt: Path,
    apksigner: Path,
) -> dict[str, Any]:
    waiver_valid, waiver_reason, _scopes = verify_waiver(owner_waiver)
    stage_state = {
        name: {
            "passed": report.get("passed") is True,
            "blocked_gate_count": len(report.get("blocking_gates") or []),
            "waived_gate_count": len(report.get("waived_gates") or []),
            "production_mutation": report.get("production_mutation"),
        }
        for name, report in stage_reports.items()
    }
    metadata_elements = apk_metadata.get("elements")
    element = metadata_elements[0] if isinstance(metadata_elements, list) and metadata_elements else {}
    identity = _apk_identity(apk, aapt) if apk.is_file() and aapt.is_file() else {}
    signature = _apk_signature(apk, apksigner) if apk.is_file() and apksigner.is_file() else {}
    package_audit = _server_package(server_package) if server_package.is_file() else {}

    checks = {
        "owner_waiver_valid": waiver_valid,
        "owner_waiver_does_not_authorize_production_release": (
            owner_waiver.get("production_release_authorized") is False
        ),
        "owner_waiver_does_not_authorize_legacy_deletion": (
            owner_waiver.get("physical_legacy_deletion_authorized") is False
        ),
        "all_stage_preflights_closed_or_waived": all(
            state["passed"]
            and state["blocked_gate_count"] == 0
            and state["production_mutation"] is False
            for state in stage_state.values()
        ) and set(stage_state) == {"stage2", "stage3", "stage4"},
        "single_active_path_verified": (
            single_path_report.get("passed") is True
            and single_path_report.get("legacy_source_retained") is True
            and single_path_report.get("physical_legacy_deletion_performed") is False
        ),
        "candidate_database_adopted_and_drained": (
            database_audit.get("passed") is True
            and database_audit.get("production_mutation") is False
            and database_audit.get("safe_to_delete") is False
            and database_audit.get("physical_legacy_deletion_performed") is False
        ),
        "candidate_apk_exists": apk.is_file() and apk.stat().st_size > 0,
        "candidate_apk_metadata_matches": (
            apk_metadata.get("applicationId") == "com.laoji.app"
            and element.get("versionCode") == 163
            and element.get("versionName") == "1.1.55"
            and identity.get("application_id") == "com.laoji.app"
            and identity.get("version_code") == 163
            and identity.get("version_name") == "1.1.55"
        ),
        "candidate_apk_signature_valid": (
            signature.get("command_succeeded") is True
            and (signature.get("schemes") or {}).get("v2") is True
            and signature.get("signer_count") == 1
        ),
        "stable_rollback_apk_exists": stable_apk.is_file() and stable_apk.stat().st_size > 0,
        "server_candidate_package_is_sanitized": package_audit.get("passed") is True,
    }
    failed = sorted(name for name, passed in checks.items() if not passed)
    return {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "production_release_performed": False,
        "public_traffic_switched": False,
        "physical_legacy_deletion_performed": False,
        "legacy_source_retained": True,
        "safe_to_delete": False,
        "stage5a_ready": not failed,
        "stage5b_deletion_deferred": True,
        "owner_waiver": {
            "verified": waiver_valid,
            "reason": waiver_reason,
            "report_sha256": owner_waiver.get("report_sha256"),
        },
        "stage_preflights": stage_state,
        "checks": checks,
        "failed_checks": failed,
        "artifacts": {
            "candidate_apk": {
                "file": apk.name,
                "bytes": apk.stat().st_size if apk.is_file() else None,
                "sha256": _sha256(apk) if apk.is_file() else None,
                "identity": identity,
                "signature": signature,
            },
            "stable_rollback_apk": {
                "file": stable_apk.name,
                "bytes": stable_apk.stat().st_size if stable_apk.is_file() else None,
                "sha256": _sha256(stable_apk) if stable_apk.is_file() else None,
            },
            "server_candidate_package": {
                "file": server_package.name,
                "bytes": server_package.stat().st_size if server_package.is_file() else None,
                "sha256": _sha256(server_package) if server_package.is_file() else None,
                "audit": package_audit,
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner-waiver", type=Path, required=True)
    parser.add_argument("--stage2", type=Path, required=True)
    parser.add_argument("--stage3", type=Path, required=True)
    parser.add_argument("--stage4", type=Path, required=True)
    parser.add_argument("--single-path", type=Path, required=True)
    parser.add_argument("--database-audit", type=Path, required=True)
    parser.add_argument("--apk", type=Path, required=True)
    parser.add_argument("--apk-metadata", type=Path, required=True)
    parser.add_argument("--stable-apk", type=Path, required=True)
    parser.add_argument("--server-package", type=Path, required=True)
    parser.add_argument("--aapt", type=Path, required=True)
    parser.add_argument("--apksigner", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = verify(
        owner_waiver=_load(args.owner_waiver),
        stage_reports={
            "stage2": _load(args.stage2),
            "stage3": _load(args.stage3),
            "stage4": _load(args.stage4),
        },
        single_path_report=_load(args.single_path),
        database_audit=_load(args.database_audit),
        apk=args.apk.resolve(),
        apk_metadata=_load(args.apk_metadata),
        stable_apk=args.stable_apk.resolve(),
        server_package=args.server_package.resolve(),
        aapt=args.aapt.resolve(),
        apksigner=args.apksigner.resolve(),
    )
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if report["stage5a_ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
