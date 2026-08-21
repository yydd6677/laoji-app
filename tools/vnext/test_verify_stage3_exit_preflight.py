from __future__ import annotations

from pathlib import Path

from stage3_human_quality_evidence import DOMAIN_FACTS, DOMAIN_Q2, _seal
from verify_stage3_exit_preflight import inspect


ROOT = Path(__file__).resolve().parents[2]
DIGEST = "sha256:" + "1" * 64


def _quality(domain: str) -> dict:
    if domain == DOMAIN_FACTS:
        metrics = {
            "meeting_count": 10,
            "fact_count": 104,
            "action_count": 4,
            "overview_accuracy": 1.0,
            "fact_support_rate": 0.96,
            "fact_accuracy_rate": 0.96,
            "fact_certainty_rate": 0.96,
            "conflict_preservation_rate": 1.0,
            "important_omission_rate": 0.0,
            "critical_error_rate": 0.0,
            "action_real_commitment_rate": 1.0,
            "action_specific_useful_rate": 1.0,
            "action_owner_support_rate": 1.0,
            "action_due_support_rate": 1.0,
            "action_schedule_fit_rate": 1.0,
            "duplicate_action_count": 0,
        }
        source_count = 10
    else:
        metrics = {
            "question_count": 27,
            "answer_correct_rate": 0.96,
            "answer_complete_rate": 0.96,
            "citation_relevance_rate": 0.96,
            "refusal_appropriateness_rate": 1.0,
            "critical_error_rate": 0.0,
        }
        source_count = 27
    return _seal({
        "schema_version": 1,
        "evidence_contract": "stage3-human-quality-v1",
        "domain": domain,
        "independent_human_adjudication": True,
        "blind_reviewer_count": 2,
        "source_row_count": source_count,
        "adjudicated_conflict_count": 1,
        "quality_passed": True,
        "metrics": metrics,
        "lineage": {
            "source_pack_sha256": DIGEST,
            "review_a_sha256": DIGEST,
            "review_b_sha256": DIGEST,
            "adjudication_sha256": DIGEST,
        },
    })


def _passing() -> dict:
    return {
        "service_ready": {
            "api": True,
            "source_stream_v2": True,
            "question_reader_v2": True,
            "summary_revisions": {
                "handler": "summary-handler-test",
                "prompt": "summary-prompt-test",
                "model": "summary-model-test",
            },
        },
        "automated_quality": {
            "facts_schema_valid_rate": 1.0,
            "facts_display_citation_match_rate": 1.0,
            "q2_display_citation_match_rate": 1.0,
            "duplicate_action_count": 0,
            "summary_normal_model_call_max": 1,
            "summary_repair_model_call_max": 2,
        },
        "facts_actions_human_quality": _quality(DOMAIN_FACTS),
        "q2_human_quality": _quality(DOMAIN_Q2),
        "performance": {
            "summary_single_p50_ms": 15_368,
            "summary_single_p95_ms": 35_498,
            "summary_long_p95_ms": 60_483,
            "q2_warm_p95_ms": 11_529,
        },
        "runtime_recovery": {
            "summary_generation_resume": True,
            "summary_commit_deduplicated": True,
            "summary_stale_source_rejected": True,
            "q2_generation_resume": True,
            "q2_stale_source_rejected": True,
            "legacy_upgrade_recovered": True,
            "one_current_summary_version": True,
            "template_switch_local_only": True,
        },
        "cleanup_privacy": {
            "task_cleanup_confirmed": True,
            "binding_purge_confirmed": True,
            "temporary_payload_deleted": True,
            "body_log_hit_count": 0,
        },
        "public_cycle": {
            "complete": True,
            "summary_v2_submit_count": 0,
            "q0_submit_count": 0,
        },
    }


def test_missing_stage3_evidence_fails_closed() -> None:
    report = inspect(ROOT, {})

    assert report["passed"] is False
    assert "facts_actions_independent_human_quality" in report["blocking_gates"]
    assert "legacy_summary_q0_zero_public_cycle" in report["blocking_gates"]


def test_complete_stage3_envelope_passes() -> None:
    report = inspect(ROOT, _passing())

    assert report["passed"] is True
    assert report["blocking_gates"] == []


def test_human_quality_regression_blocks() -> None:
    envelope = _passing()
    report = dict(envelope["q2_human_quality"])
    report.pop("report_sha256")
    report["metrics"] = {**report["metrics"], "answer_correct_rate": 0.94}
    report["quality_passed"] = False
    envelope["q2_human_quality"] = _seal(report)

    inspected = inspect(ROOT, envelope)

    assert inspected["passed"] is False
    assert "q2_independent_human_quality" in inspected["blocking_gates"]
    assert "q2_human_correctness" in inspected["blocking_gates"]


def test_public_cycle_and_recovery_cannot_be_inferred() -> None:
    envelope = _passing()
    envelope["public_cycle"] = {
        "complete": False,
        "summary_v2_submit_count": 0,
        "q0_submit_count": 0,
    }
    envelope["runtime_recovery"]["q2_stale_source_rejected"] = False

    report = inspect(ROOT, envelope)

    assert report["passed"] is False
    assert "legacy_summary_q0_zero_public_cycle" in report["blocking_gates"]
    assert "runtime_q2_stale_source_rejected" in report["blocking_gates"]
