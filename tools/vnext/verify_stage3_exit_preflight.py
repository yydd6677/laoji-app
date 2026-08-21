#!/usr/bin/env python3
"""Fail-closed Stage 3 exit preflight for Facts V3, actions, and Q2."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
from typing import Any, Mapping

from stage3_human_quality_evidence import (
    DOMAIN_FACTS,
    DOMAIN_Q2,
    verify_report as verify_human_quality_report,
)


ROOT = Path(__file__).resolve().parents[2]


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
    evidence: object,
    reason: str,
) -> None:
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
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, f"{script}:{type(error).__name__}"
    output = f"{result.stdout}\n{result.stderr}"
    return result.returncode == 0 and marker in output, (
        marker if marker in output else f"{script}:failed"
    )


def _quality_gates(
    gates: list[dict[str, Any]],
    *,
    name: str,
    expected_domain: str,
    value: object,
) -> Mapping[str, Any]:
    report = _mapping(value)
    verified, reason = verify_human_quality_report(report)
    domain_matches = report.get("domain") == expected_domain
    _gate(
        gates,
        f"{name}_quality_lineage",
        verified and domain_matches,
        {
            "verified": verified,
            "domain": report.get("domain"),
            "report_sha256": report.get("report_sha256"),
        },
        reason if not verified else "quality_domain_mismatch",
    )
    quality_passed = _bool(report.get("quality_passed")) if verified else None
    _gate(
        gates,
        f"{name}_independent_human_quality",
        verified and domain_matches and quality_passed is True,
        {
            "quality_passed": quality_passed,
            "blind_reviewer_count": report.get("blind_reviewer_count"),
            "source_row_count": report.get("source_row_count"),
        },
        "two_human_reviews_and_adjudication_threshold_required",
    )
    return _mapping(report.get("metrics")) if verified and domain_matches else {}


def inspect(root: Path, envelope: Mapping[str, Any] | None) -> dict[str, Any]:
    data = _mapping(envelope)
    gates: list[dict[str, Any]] = []

    for script, marker, name in (
        (
            "verify_stage3_source_stream_contract.py",
            "stage3_source_stream_contract=passed",
            "static_source_stream_contract",
        ),
        (
            "verify_stage3_q2_android_contract.py",
            "stage3_q2_android_contract=passed",
            "static_q2_android_contract",
        ),
    ):
        passed, evidence = _static_gate(root, script, marker)
        _gate(gates, name, passed, evidence, "static_contract_required")

    service = _mapping(data.get("service_ready"))
    for field in ("api", "source_stream_v2", "question_reader_v2"):
        value = _bool(service.get(field))
        _gate(
            gates,
            f"candidate_{field}_ready",
            value,
            value,
            "candidate_capability_required",
        )
    revisions = _mapping(service.get("summary_revisions"))
    revision_ready = all(
        isinstance(revisions.get(field), str) and bool(str(revisions[field]).strip())
        for field in ("handler", "prompt", "model")
    )
    _gate(
        gates,
        "candidate_summary_revisions_ready",
        revision_ready,
        {field: revisions.get(field) for field in ("handler", "prompt", "model")},
        "frozen_summary_runtime_revisions_required",
    )

    automated = _mapping(data.get("automated_quality"))
    for field, minimum, name in (
        ("facts_schema_valid_rate", 0.98, "facts_schema_validity"),
        ("facts_display_citation_match_rate", 1.0, "facts_citation_exactness"),
        ("q2_display_citation_match_rate", 1.0, "q2_citation_exactness"),
    ):
        value = _number(automated.get(field))
        _gate(
            gates,
            name,
            value is not None and value >= minimum,
            {"value": value, "minimum": minimum},
            "measured_automated_quality_required",
        )
    duplicate_actions = _number(automated.get("duplicate_action_count"))
    _gate(
        gates,
        "automated_duplicate_action_free",
        duplicate_actions == 0,
        {"duplicate_action_count": duplicate_actions},
        "duplicate_actions_must_be_zero",
    )
    normal_calls = _number(automated.get("summary_normal_model_call_max"))
    repair_calls = _number(automated.get("summary_repair_model_call_max"))
    _gate(
        gates,
        "summary_single_generation_call",
        normal_calls == 1 and repair_calls is not None and repair_calls <= 2,
        {"normal_max": normal_calls, "repair_max": repair_calls},
        "one_normal_call_and_one_optional_repair_required",
    )

    facts_metrics = _quality_gates(
        gates,
        name="facts_actions",
        expected_domain=DOMAIN_FACTS,
        value=data.get("facts_actions_human_quality"),
    )
    q2_metrics = _quality_gates(
        gates,
        name="q2",
        expected_domain=DOMAIN_Q2,
        value=data.get("q2_human_quality"),
    )
    for metrics, field, minimum, name in (
        (facts_metrics, "fact_support_rate", 0.95, "facts_human_support"),
        (facts_metrics, "fact_accuracy_rate", 0.95, "facts_human_accuracy"),
        (
            facts_metrics,
            "action_real_commitment_rate",
            0.95,
            "actions_human_commitment",
        ),
        (facts_metrics, "action_schedule_fit_rate", 0.95, "actions_human_schedule_fit"),
        (q2_metrics, "answer_correct_rate", 0.95, "q2_human_correctness"),
        (q2_metrics, "answer_complete_rate", 0.95, "q2_human_completeness"),
        (q2_metrics, "citation_relevance_rate", 0.95, "q2_human_citation_relevance"),
    ):
        value = _number(metrics.get(field))
        _gate(
            gates,
            name,
            value is not None and value >= minimum,
            {"value": value, "minimum": minimum},
            "independent_human_quality_threshold",
        )

    performance = _mapping(data.get("performance"))
    for field, limit, name in (
        ("summary_single_p50_ms", 20_000.0, "summary_single_p50"),
        ("summary_single_p95_ms", 45_000.0, "summary_single_p95"),
        ("summary_long_p95_ms", 90_000.0, "summary_long_p95"),
        ("q2_warm_p95_ms", 15_000.0, "q2_warm_p95"),
    ):
        value = _number(performance.get(field))
        _gate(
            gates,
            name,
            value is not None and value <= limit,
            {"value": value, "limit": limit},
            "measured_latency_budget_required",
        )

    runtime = _mapping(data.get("runtime_recovery"))
    for field in (
        "summary_generation_resume",
        "summary_commit_deduplicated",
        "summary_stale_source_rejected",
        "q2_generation_resume",
        "q2_stale_source_rejected",
        "legacy_upgrade_recovered",
        "one_current_summary_version",
        "template_switch_local_only",
    ):
        value = _bool(runtime.get(field))
        _gate(
            gates,
            f"runtime_{field}",
            value,
            value,
            "android_and_server_recovery_evidence_required",
        )

    cleanup = _mapping(data.get("cleanup_privacy"))
    for field in ("task_cleanup_confirmed", "binding_purge_confirmed", "temporary_payload_deleted"):
        value = _bool(cleanup.get(field))
        _gate(gates, f"cleanup_{field}", value, value, "cleanup_evidence_required")
    body_log_hits = _number(cleanup.get("body_log_hit_count"))
    _gate(
        gates,
        "privacy_body_log_free",
        body_log_hits == 0,
        {"body_log_hit_count": body_log_hits},
        "content_log_hits_must_be_zero",
    )

    public_cycle = _mapping(data.get("public_cycle"))
    summary_v2_count = _number(public_cycle.get("summary_v2_submit_count"))
    q0_count = _number(public_cycle.get("q0_submit_count"))
    _gate(
        gates,
        "legacy_summary_q0_zero_public_cycle",
        (
            _bool(public_cycle.get("complete")) is True
            and summary_v2_count == 0
            and q0_count == 0
        ),
        {
            "complete": public_cycle.get("complete"),
            "summary_v2_submit_count": summary_v2_count,
            "q0_submit_count": q0_count,
        },
        "external_public_zero_legacy_cycle_required",
    )

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
    envelope = _mapping(
        json.loads(args.evidence.read_text(encoding="utf-8"))
        if args.evidence
        else None
    )
    report = inspect(args.root.resolve(), envelope)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
