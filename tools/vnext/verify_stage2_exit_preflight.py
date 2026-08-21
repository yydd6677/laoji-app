#!/usr/bin/env python3
"""Fail-closed Stage 2 exit preflight for the isolated vNext candidate.

The probe deliberately separates implementation evidence from adoption:
missing runtime evidence is ``blocked`` rather than inferred from source
tests, and this command never activates a capability barrier, stops a process,
or changes a database.  The input JSON is an externally produced evidence
envelope, not a fixture that this tool generates.

Example envelope shape::

    {
      "device_runtime": {
        "candidate_apk": true,
        "process_death_recovered": true,
        "network_switch_recovered": true,
        "projection_no_duplicate": true,
        "no_speech_success": true
      },
      "performance": {
        "realtime_p95_ms": 1900,
        "import_rtf_p95": 0.48,
        "first_segment_p95_ms": 7600,
        "speaker_overlay_sample_count": 30,
        "speaker_overlay_p95_ms": 29000,
        "api_rss_peak_kib": 1200000,
        "api_rss_delta_mib": 64,
        "total_rss_gib": 7.5,
        "gpu0_free_gib": 1.2,
        "cpu_p95_cores": 12,
        "temp_peak_gib": 2.0
      },
      "media_quality": {
        "evidence_contract": "media-human-quality-v1",
        "gate_eligible": true,
        "metrics": {
          "cer_median": 0.07,
          "cer_p95": 0.17,
          "numeric_time_accuracy": 0.96,
          "registered_attribution_f1": 0.91,
          "unknown_forced_name_rate": 0.0
        }
      },
      "cleanup": {"pending_tasks": 0, "pending_cleanup": 0},
      "public_cycle": {"complete": true, "legacy_submit_count": 0},
      "service_ready": {"api": true, "asr": true}
    }

All numerical values are measured values. The tool does not manufacture
percentiles from a single sample.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from typing import Any, Mapping
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from media_quality_evidence import verify_quality_report
from product_owner_risk_waiver import (
    STAGE2_MEDIA_QUALITY,
    STAGE2_PUBLIC_CYCLE,
    apply_waiver_to_gates,
)


ROOT = Path(__file__).resolve().parents[2]
API_RSS_LIMIT_KIB = 1_200 * 1024
API_UPLOAD_DELTA_LIMIT_MIB = 128
TOTAL_RSS_LIMIT_GIB = 8.0
GPU0_FREE_LIMIT_GIB = 1.0
CPU_P95_LIMIT = 16.0
TEMP_LIMIT_GIB = 4.0
REALTIME_P95_LIMIT_MS = 2_000
IMPORT_RTF_LIMIT = 0.5
FIRST_SEGMENT_P95_LIMIT_MS = 8_000
SPEAKER_OVERLAY_P95_LIMIT_MS = 30_000
SPEAKER_OVERLAY_MINIMUM_SAMPLE_COUNT = 30
CER_MEDIAN_LIMIT = 0.08
CER_P95_LIMIT = 0.18
NUMERIC_TIME_ACCURACY_MINIMUM = 0.95
REGISTERED_ATTRIBUTION_F1_MINIMUM = 0.90
UNKNOWN_FORCED_NAME_RATE_LIMIT = 0.0


def _mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _bool(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _gate(
    gates: list[dict[str, Any]],
    name: str,
    passed: bool | None,
    *,
    evidence: object = None,
    reason: str | None = None,
) -> None:
    status = "passed" if passed is True else "blocked"
    gates.append({
        "name": name,
        "status": status,
        "evidence": evidence,
        **({"reason": reason} if reason else {}),
    })


def _static_contract(root: Path) -> tuple[bool, str]:
    command = [sys.executable, str(root / "tools/vnext/verify_stage2_android_contract.py")]
    try:
        result = subprocess.run(
            command,
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, f"static_contract_probe_{type(error).__name__}"
    output = f"{result.stdout}\n{result.stderr}"
    passed = result.returncode == 0 and "stage2_android_contract=passed" in output
    return passed, "stage2_android_contract=passed" if passed else "stage2_android_contract_failed"


def _probe_loopback(url: str, timeout_seconds: float = 3.0) -> tuple[bool, object]:
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        return False, "health_url_must_be_loopback_http"
    try:
        with urlopen(Request(url, method="GET"), timeout=timeout_seconds) as response:
            payload = json.load(response)
        return bool(isinstance(payload, Mapping) and payload.get("ready") is True), payload
    except Exception as error:  # pragma: no cover - platform/network dependent
        return False, f"health_probe_{type(error).__name__}"


def _database_state(path: Path) -> tuple[bool, dict[str, Any]]:
    if not path.is_file():
        return False, {"status": "missing", "path": str(path)}
    try:
        with sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True) as connection:
            tables = {
                str(row[0])
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            required = {"vnext_tasks", "vnext_object_cleanup_obligations"}
            if not required <= tables:
                return False, {
                    "status": "schema_incomplete",
                    "missing_tables": sorted(required - tables),
                }
            task_columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(vnext_tasks)")}
            cleanup_columns = {
                str(row[1])
                for row in connection.execute("PRAGMA table_info(vnext_object_cleanup_obligations)")
            }
            state_column = "state" if "state" in task_columns else None
            cleanup_state_column = "state" if "state" in cleanup_columns else None
            active_tasks = int(connection.execute(
                "SELECT COUNT(*) FROM vnext_tasks WHERE state IN ('active','running','queued')"
            ).fetchone()[0]) if state_column else -1
            pending_cleanup = int(connection.execute(
                "SELECT COUNT(*) FROM vnext_object_cleanup_obligations WHERE state IN ('pending','running')"
            ).fetchone()[0]) if cleanup_state_column else -1
            integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
            foreign_keys = int(connection.execute(
                "SELECT COUNT(*) FROM pragma_foreign_key_check"
            ).fetchone()[0])
            details = {
                "status": "ok" if integrity == "ok" and foreign_keys == 0 else "integrity_failed",
                "active_tasks": active_tasks,
                "pending_cleanup": pending_cleanup,
                "integrity": integrity,
                "foreign_key_violations": foreign_keys,
            }
            return details["status"] == "ok" and active_tasks == 0 and pending_cleanup == 0, details
    except (OSError, sqlite3.Error) as error:
        return False, {"status": f"database_probe_{type(error).__name__}"}


def inspect(
    root: Path,
    envelope: Mapping[str, Any] | None,
    *,
    candidate_database: Path | None = None,
    api_ready_url: str | None = None,
    asr_ready_url: str | None = None,
    owner_waiver: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    data = _mapping(envelope)
    gates: list[dict[str, Any]] = []

    static_passed, static_reason = _static_contract(root)
    _gate(gates, "android_static_contract", static_passed, evidence=static_reason)

    service = _mapping(data.get("service_ready"))
    if api_ready_url:
        api_ok, api_evidence = _probe_loopback(api_ready_url)
    else:
        api_ok, api_evidence = _bool(service.get("api")), service.get("api")
    if asr_ready_url:
        asr_ok, asr_evidence = _probe_loopback(asr_ready_url)
    else:
        asr_ok, asr_evidence = _bool(service.get("asr")), service.get("asr")
    _gate(gates, "candidate_api_ready", api_ok, evidence=api_evidence, reason="missing_or_not_ready")
    _gate(gates, "candidate_asr_ready", asr_ok, evidence=asr_evidence, reason="missing_or_not_ready")

    device = _mapping(data.get("device_runtime"))
    for field in (
        "candidate_apk",
        "process_death_recovered",
        "network_switch_recovered",
        "projection_no_duplicate",
        "no_speech_success",
    ):
        value = _bool(device.get(field))
        _gate(gates, f"android_{field}", value, evidence=value, reason="android_runtime_evidence_required")

    performance = _mapping(data.get("performance"))
    speaker_overlay_count = _number(performance.get("speaker_overlay_sample_count"))
    _gate(
        gates,
        "performance_speaker_overlay_sample_count",
        speaker_overlay_count is not None
        and speaker_overlay_count >= SPEAKER_OVERLAY_MINIMUM_SAMPLE_COUNT,
        evidence={
            "value": speaker_overlay_count,
            "minimum": SPEAKER_OVERLAY_MINIMUM_SAMPLE_COUNT,
        },
        reason="measured_speaker_overlay_sample_count_required",
    )
    performance_checks = (
        ("realtime_p95_ms", REALTIME_P95_LIMIT_MS, "realtime_p95_ms"),
        ("import_rtf_p95", IMPORT_RTF_LIMIT, "import_rtf_p95"),
        ("first_segment_p95_ms", FIRST_SEGMENT_P95_LIMIT_MS, "first_segment_p95_ms"),
        ("speaker_overlay_p95_ms", SPEAKER_OVERLAY_P95_LIMIT_MS, "speaker_overlay_p95_ms"),
        ("api_rss_peak_kib", API_RSS_LIMIT_KIB, "api_rss_peak_kib"),
        ("api_rss_delta_mib", API_UPLOAD_DELTA_LIMIT_MIB, "api_rss_delta_mib"),
        ("total_rss_gib", TOTAL_RSS_LIMIT_GIB, "total_rss_gib"),
        ("cpu_p95_cores", CPU_P95_LIMIT, "cpu_p95_cores"),
        ("temp_peak_gib", TEMP_LIMIT_GIB, "temp_peak_gib"),
    )
    for field, limit, gate_name in performance_checks:
        value = _number(performance.get(field))
        _gate(
            gates,
            f"performance_{gate_name}",
            value is not None and value <= limit,
            evidence={"value": value, "limit": limit},
            reason="measured_p95_or_peak_required",
        )
    gpu_free = _number(performance.get("gpu0_free_gib"))
    _gate(
        gates,
        "resource_gpu0_safety_margin",
        gpu_free is not None and gpu_free >= GPU0_FREE_LIMIT_GIB,
        evidence={"value": gpu_free, "minimum": GPU0_FREE_LIMIT_GIB},
        reason="measured_gpu_snapshot_required",
    )

    quality = _mapping(data.get("media_quality"))
    quality_verified, quality_reason = verify_quality_report(quality)
    _gate(
        gates,
        "media_quality_lineage",
        quality_verified,
        evidence={
            "verified": quality_verified,
            "contract": quality.get("evidence_contract"),
            "report_sha256": quality.get("report_sha256"),
        },
        reason=quality_reason,
    )
    quality_metrics = _mapping(quality.get("metrics")) if quality_verified else {}
    gate_eligible = _bool(quality.get("gate_eligible")) if quality_verified else None
    asr_count = _number(quality.get("asr_sample_count")) if quality_verified else None
    registered_count = _number(
        quality.get("registered_speaker_sample_count")
    ) if quality_verified else None
    unknown_count = _number(
        quality.get("unknown_speaker_sample_count")
    ) if quality_verified else None
    _gate(
        gates,
        "media_independent_human_holdout",
        (
            gate_eligible is True
            and asr_count is not None and asr_count >= 30
            and registered_count is not None and registered_count >= 10
            and unknown_count is not None and unknown_count >= 10
        ),
        evidence={
            "gate_eligible": gate_eligible,
            "asr_sample_count": asr_count,
            "registered_speaker_sample_count": registered_count,
            "unknown_speaker_sample_count": unknown_count,
        },
        reason="independent_first_party_media_holdout_required",
    )
    for field, limit, comparison, name in (
        ("cer_median", CER_MEDIAN_LIMIT, "maximum", "asr_cer_median"),
        ("cer_p95", CER_P95_LIMIT, "maximum", "asr_cer_p95"),
        (
            "numeric_time_accuracy",
            NUMERIC_TIME_ACCURACY_MINIMUM,
            "minimum",
            "asr_numeric_time_accuracy",
        ),
        (
            "registered_attribution_f1",
            REGISTERED_ATTRIBUTION_F1_MINIMUM,
            "minimum",
            "speaker_registered_attribution_f1",
        ),
        (
            "unknown_forced_name_rate",
            UNKNOWN_FORCED_NAME_RATE_LIMIT,
            "maximum",
            "speaker_unknown_forced_name_rate",
        ),
    ):
        value = _number(quality_metrics.get(field))
        passed_quality = (
            value is not None
            and ((comparison == "maximum" and value <= limit) or (comparison == "minimum" and value >= limit))
        )
        _gate(
            gates,
            name,
            passed_quality,
            evidence={"value": value, comparison: limit},
            reason="verified_media_quality_threshold_required",
        )

    cleanup = _mapping(data.get("cleanup"))
    pending_tasks = _number(cleanup.get("pending_tasks"))
    pending_cleanup = _number(cleanup.get("pending_cleanup"))
    _gate(
        gates,
        "candidate_task_and_cleanup_drained",
        pending_tasks is not None and pending_tasks == 0 and pending_cleanup == 0,
        evidence={"pending_tasks": pending_tasks, "pending_cleanup": pending_cleanup},
        reason="candidate_database_or_replay_evidence_required",
    )
    if candidate_database:
        database_ok, database_evidence = _database_state(candidate_database)
        _gate(gates, "candidate_database_read_only_audit", database_ok, evidence=database_evidence)

    cycle = _mapping(data.get("public_cycle"))
    cycle_complete = _bool(cycle.get("complete"))
    legacy_count = _number(cycle.get("legacy_submit_count"))
    _gate(
        gates,
        "legacy_submit_zero_public_cycle",
        cycle_complete is True and legacy_count == 0,
        evidence={"complete": cycle_complete, "legacy_submit_count": legacy_count},
        reason="external_public_cycle_record_required",
    )

    waiver = apply_waiver_to_gates(
        gates,
        owner_waiver,
        {
            STAGE2_MEDIA_QUALITY: (
                "media_quality_lineage",
                "media_independent_human_holdout",
                "asr_cer_median",
                "asr_cer_p95",
                "asr_numeric_time_accuracy",
                "speaker_registered_attribution_f1",
                "speaker_unknown_forced_name_rate",
            ),
            STAGE2_PUBLIC_CYCLE: ("legacy_submit_zero_public_cycle",),
        },
    )

    passed = bool(gates) and all(item["status"] in {"passed", "waived"} for item in gates)
    return {
        "schema_version": 2,
        "candidate_only": True,
        "production_mutation": False,
        "passed": passed,
        "owner_risk_waiver": waiver,
        "gates": gates,
        "blocking_gates": [item["name"] for item in gates if item["status"] == "blocked"],
        "waived_gates": [item["name"] for item in gates if item["status"] == "waived"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, help="Externally produced JSON evidence envelope")
    parser.add_argument("--candidate-database", type=Path)
    parser.add_argument("--api-ready-url")
    parser.add_argument("--asr-ready-url")
    parser.add_argument("--owner-waiver", type=Path)
    parser.add_argument("root", nargs="?", type=Path, default=ROOT)
    args = parser.parse_args()
    envelope: Mapping[str, Any] | None = None
    if args.evidence:
        envelope = json.loads(args.evidence.read_text(encoding="utf-8"))
    owner_waiver = (
        json.loads(args.owner_waiver.read_text(encoding="utf-8"))
        if args.owner_waiver
        else None
    )
    report = inspect(
        args.root.resolve(),
        envelope,
        candidate_database=args.candidate_database.resolve() if args.candidate_database else None,
        api_ready_url=args.api_ready_url,
        asr_ready_url=args.asr_ready_url,
        owner_waiver=owner_waiver,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
