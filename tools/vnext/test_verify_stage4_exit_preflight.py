from __future__ import annotations

from pathlib import Path

from schedule_holdout_evidence import EVIDENCE_CONTRACT, _seal_report
from verify_stage4_exit_preflight import inspect


ROOT = Path(__file__).resolve().parents[2]


def _quality_report() -> dict:
    digest = "sha256:" + "1" * 64
    return _seal_report({
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "holdout_id": "test-holdout",
        "source_policy": "first_party_opt_in",
        "source_promotion_eligible": True,
        "gate_eligible": True,
        "independent_human_adjudication": True,
        "blind_reviewer_count": 2,
        "source_row_count": 40,
        "sample_count": 40,
        "excluded_count": 0,
        "adjudicated_conflict_count": 1,
        "metrics": {
            "field_exact_accuracy": 0.97,
            "key_field_recall": 0.99,
            "save_error_count": 0,
        },
        "development_overlap": {
            "development_manifest_sha256": digest,
            "source_text_overlap_count": 0,
            "speaker_group_overlap_count": 0,
            "semantic_event_group_overlap_count": 0,
        },
        "lineage": {
            "source_manifest_sha256": digest,
            "review_a_sha256": digest,
            "review_b_sha256": digest,
            "adjudication_sha256": digest,
            "predictions_sha256": digest,
            "development_manifest_sha256": digest,
        },
        "producer_revision": "test-producer",
        "promotion_blockers": [],
    })


def _passing() -> dict:
    return {
        "service_ready": {"api": True, "schedule_graph": True},
        "schedule_quality": _quality_report(),
        "voice_schedule_performance": {
            "capture_start_p95_ms": 80,
            "first_text_p95_ms": 1200,
            "draft_p95_ms": 2500,
        },
        "projection_runtime": {
            "global_sqlite_replay": True,
            "page_recreate": True,
            "stale_action_rejected": True,
            "no_status_jump": True,
        },
        "local_features": {"fts_query_p95_ms": 40, "explicit_label_owner": True},
        "public_cycle": {"complete": True, "legacy_submit_count": 0},
    }


def test_missing_stage4_evidence_fails_closed() -> None:
    report = inspect(ROOT, {})
    assert report["passed"] is False
    assert "schedule_human_holdout" in report["blocking_gates"]
    assert "projection_page_recreate" in report["blocking_gates"]


def test_complete_stage4_envelope_passes() -> None:
    report = inspect(ROOT, _passing())
    assert report["passed"] is True
    assert report["blocking_gates"] == []


def test_quality_regression_blocks() -> None:
    evidence = _passing()
    quality = dict(evidence["schedule_quality"])
    quality.pop("report_sha256")
    quality["metrics"] = {**quality["metrics"], "field_exact_accuracy": 0.949}
    evidence["schedule_quality"] = _seal_report(quality)
    evidence["public_cycle"]["legacy_submit_count"] = 1
    report = inspect(ROOT, evidence)
    assert report["passed"] is False
    assert "schedule_field_exact_accuracy" in report["blocking_gates"]
    assert "legacy_schedule_zero_public_cycle" in report["blocking_gates"]


def test_legacy_boolean_quality_claim_is_rejected() -> None:
    evidence = _passing()
    evidence["schedule_quality"] = {
        "independent_human_adjudication": True,
        "sample_count": 40,
        "field_exact_accuracy": 1.0,
        "key_field_recall": 1.0,
        "save_error_count": 0,
    }
    report = inspect(ROOT, evidence)
    assert report["passed"] is False
    assert "schedule_quality_lineage" in report["blocking_gates"]
    assert "schedule_human_holdout" in report["blocking_gates"]
