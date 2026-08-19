from __future__ import annotations

from pathlib import Path

from verify_stage4_exit_preflight import inspect


ROOT = Path(__file__).resolve().parents[2]


def _passing() -> dict:
    return {
        "service_ready": {"api": True, "schedule_graph": True},
        "schedule_quality": {
            "independent_human_adjudication": True,
            "sample_count": 40,
            "field_exact_accuracy": 0.97,
            "key_field_recall": 0.99,
            "save_error_count": 0,
        },
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
    evidence["schedule_quality"]["field_exact_accuracy"] = 0.949
    evidence["public_cycle"]["legacy_submit_count"] = 1
    report = inspect(ROOT, evidence)
    assert report["passed"] is False
    assert "schedule_field_exact_accuracy" in report["blocking_gates"]
    assert "legacy_schedule_zero_public_cycle" in report["blocking_gates"]

