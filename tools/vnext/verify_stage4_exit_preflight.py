#!/usr/bin/env python3
"""Fail-closed Stage 4 exit preflight for schedule and projection adoption."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from typing import Any, Mapping

from schedule_holdout_evidence import verify_quality_report


ROOT = Path(__file__).resolve().parents[2]
VOICE_EVIDENCE_CONTRACT = "schedule-voice-performance-v1"
VOICE_MIXED_LOAD_CLASSES = (
    "realtime_asr",
    "upload",
    "import_asr_backlog",
    "schedule_parse",
    "question",
    "summary",
)


def _mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _bool(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _verified_voice_report(root: Path, value: object) -> tuple[Mapping[str, Any], bool]:
    report = _mapping(value)
    evidence_file = report.get("evidence_file")
    if evidence_file is not None:
        expected_file_sha256 = report.get("file_sha256")
        if (
            not isinstance(evidence_file, str)
            or not evidence_file.strip()
            or not isinstance(expected_file_sha256, str)
            or not expected_file_sha256.startswith("sha256:")
        ):
            return report, False
        candidate = (root / evidence_file).resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError:
            return report, False
        try:
            raw = candidate.read_bytes()
            actual_file_sha256 = "sha256:" + hashlib.sha256(raw).hexdigest()
            loaded = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return report, False
        if actual_file_sha256 != expected_file_sha256 or not isinstance(loaded, Mapping):
            return report, False
        report = loaded
    claimed = report.get("report_sha256")
    if report.get("evidence_contract") != VOICE_EVIDENCE_CONTRACT or not isinstance(claimed, str):
        return report, False
    unsigned = dict(report)
    unsigned.pop("report_sha256", None)
    actual = "sha256:" + hashlib.sha256(
        json.dumps(
            unsigned,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return report, claimed == actual


def _gate(gates: list[dict[str, Any]], name: str, passed: bool | None, evidence: object, reason: str) -> None:
    gates.append({
        "name": name,
        "status": "passed" if passed is True else "blocked",
        "evidence": evidence,
        **({} if passed is True else {"reason": reason}),
    })


def _static_gate(root: Path, script: str, marker: str) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            [sys.executable, str(root / "tools/vnext" / script)],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
            timeout=45,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, f"{script}:{type(error).__name__}"
    output = f"{result.stdout}\n{result.stderr}"
    return result.returncode == 0 and marker in output, marker if marker in output else f"{script}:failed"


def inspect(root: Path, envelope: Mapping[str, Any] | None) -> dict[str, Any]:
    data = _mapping(envelope)
    gates: list[dict[str, Any]] = []

    for script, marker, name in (
        ("verify_stage4_migration.py", "stage4_migration_probe=passed", "static_migration"),
        ("verify_projection_checkpoint.py", "projection checkpoint replay: PASS", "static_projection_checkpoint"),
        ("verify_schedule_graph_owner.py", '"passed": true', "static_graph_owner"),
        ("verify_schedule_graph_mobile_owner.py", '"passed": true', "static_mobile_graph_owner"),
        ("verify_schedule_voice_capture_order.py", "schedule_voice_capture_order=passed", "static_voice_capture"),
        ("verify_calendar_edit_action_bridge.py", "calendar_edit_action_bridge=passed", "static_calendar_edit_action_bridge"),
        ("verify_projection_action_fence.py", "projection_action_fence=passed", "static_projection_action_fence"),
    ):
        passed, evidence = _static_gate(root, script, marker)
        _gate(gates, name, passed, evidence, "static_contract_required")

    service = _mapping(data.get("service_ready"))
    _gate(gates, "candidate_api_ready", _bool(service.get("api")), service.get("api"), "candidate_ready_required")
    _gate(gates, "candidate_graph_capability", _bool(service.get("schedule_graph")), service.get("schedule_graph"), "graph_capability_required")

    quality = _mapping(data.get("schedule_quality"))
    quality_verified, quality_reason = verify_quality_report(quality)
    _gate(
        gates,
        "schedule_quality_lineage",
        quality_verified,
        {
            "verified": quality_verified,
            "report_sha256": quality.get("report_sha256"),
            "contract": quality.get("evidence_contract"),
        },
        quality_reason,
    )
    metrics = _mapping(quality.get("metrics")) if quality_verified else {}
    human = _bool(quality.get("independent_human_adjudication")) if quality_verified else None
    eligible = _bool(quality.get("gate_eligible")) if quality_verified else None
    sample_count = _number(quality.get("sample_count"))
    exact = _number(metrics.get("field_exact_accuracy"))
    recall = _number(metrics.get("key_field_recall"))
    save_errors = _number(metrics.get("save_error_count"))
    _gate(gates, "schedule_human_holdout", quality_verified and eligible is True and human is True and sample_count is not None and sample_count >= 30,
          {"human": human, "gate_eligible": eligible, "sample_count": sample_count}, "independent_human_holdout_required")
    _gate(gates, "schedule_field_exact_accuracy", exact is not None and exact >= 0.95, {"value": exact, "minimum": 0.95}, "blueprint_quality_threshold")
    _gate(gates, "schedule_key_field_recall", recall is not None and recall >= 0.98, {"value": recall, "minimum": 0.98}, "blueprint_quality_threshold")
    _gate(gates, "schedule_save_error_free", save_errors == 0, {"save_error_count": save_errors}, "save_error_rate_must_be_zero")

    voice, voice_verified = _verified_voice_report(root, data.get("voice_schedule_performance"))
    _gate(
        gates,
        "voice_performance_lineage",
        voice_verified,
        {
            "contract": voice.get("evidence_contract"),
            "report_sha256": voice.get("report_sha256"),
        },
        "sealed_voice_performance_report_required",
    )
    voice_sample_count = _number(voice.get("sample_count")) if voice_verified else None
    _gate(
        gates,
        "voice_warm_sample_count",
        voice_sample_count is not None and voice_sample_count >= 30,
        {"value": voice_sample_count, "minimum": 30},
        "at_least_30_warm_samples_required",
    )
    voice_draft_success_count = _number(voice.get("draft_success_count")) if voice_verified else None
    _gate(
        gates,
        "voice_draft_success",
        (
            voice_sample_count is not None
            and voice_draft_success_count is not None
            and voice_sample_count >= 30
            and voice_draft_success_count == voice_sample_count
        ),
        {
            "success_count": voice_draft_success_count,
            "sample_count": voice_sample_count,
        },
        "every_warm_sample_must_reach_draft",
    )
    voice_draft_distinct_hash_count = (
        _number(voice.get("draft_distinct_hash_count")) if voice_verified else None
    )
    _gate(
        gates,
        "voice_draft_determinism",
        voice_draft_distinct_hash_count == 1,
        {"distinct_draft_hash_count": voice_draft_distinct_hash_count},
        "one_stable_draft_contract_required",
    )
    mixed_load = _mapping(voice.get("mixed_load")) if voice_verified else {}
    mixed_load_duration = _number(mixed_load.get("duration_seconds"))
    traffic_classes = _mapping(mixed_load.get("traffic_classes"))
    mixed_load_complete = (
        mixed_load_duration is not None
        and mixed_load_duration >= 600
        and all(_bool(traffic_classes.get(name)) is True for name in VOICE_MIXED_LOAD_CLASSES)
    )
    _gate(
        gates,
        "voice_mixed_load_envelope",
        mixed_load_complete,
        {
            "duration_seconds": mixed_load_duration,
            "traffic_classes": {
                name: traffic_classes.get(name) for name in VOICE_MIXED_LOAD_CLASSES
            },
        },
        "ten_minute_blueprint_mixed_load_required",
    )
    for field, limit, name in (
        ("capture_start_p95_ms", 100.0, "voice_capture_start"),
        ("first_text_p95_ms", 1_500.0, "voice_first_text"),
        ("draft_p95_ms", 3_000.0, "voice_draft_ready"),
    ):
        value = _number(voice.get(field)) if voice_verified else None
        _gate(gates, name, value is not None and value <= limit, {"value": value, "limit": limit}, "measured_voice_p95_required")

    projection = _mapping(data.get("projection_runtime"))
    for field in ("global_sqlite_replay", "page_recreate", "stale_action_rejected", "no_status_jump"):
        value = _bool(projection.get(field))
        _gate(gates, f"projection_{field}", value, value, "android_projection_replay_required")

    search = _mapping(data.get("local_features"))
    fts_p95 = _number(search.get("fts_query_p95_ms"))
    _gate(gates, "fts_query_latency", fts_p95 is not None and fts_p95 <= 100, {"value": fts_p95, "limit": 100}, "measured_search_p95_required")
    _gate(gates, "explicit_label_owner", _bool(search.get("explicit_label_owner")), search.get("explicit_label_owner"), "label_owner_contract_required")

    cycle = _mapping(data.get("public_cycle"))
    legacy_count = _number(cycle.get("legacy_submit_count"))
    _gate(gates, "legacy_schedule_zero_public_cycle", _bool(cycle.get("complete")) is True and legacy_count == 0,
          {"complete": cycle.get("complete"), "legacy_submit_count": legacy_count}, "external_public_cycle_record_required")

    return {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "passed": bool(gates) and all(gate["status"] == "passed" for gate in gates),
        "gates": gates,
        "blocking_gates": [gate["name"] for gate in gates if gate["status"] != "passed"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("root", nargs="?", type=Path, default=ROOT)
    args = parser.parse_args()
    envelope = json.loads(args.evidence.read_text(encoding="utf-8")) if args.evidence else None
    report = inspect(args.root.resolve(), envelope)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
