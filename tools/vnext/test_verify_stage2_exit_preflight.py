from __future__ import annotations

from pathlib import Path

from media_quality_evidence import EVIDENCE_CONTRACT, seal_report
from verify_stage2_exit_preflight import inspect


ROOT = Path(__file__).resolve().parents[2]


def _passing_envelope() -> dict:
    quality = seal_report({
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "source_policy": "first_party_human_reference",
        "source_promotion_eligible": True,
        "gate_eligible": True,
        "independent_human_adjudication": True,
        "blind_reviewer_count": 2,
        "predictions_generated_after_reference_freeze": True,
        "asr_sample_count": 30,
        "registered_speaker_sample_count": 10,
        "unknown_speaker_sample_count": 10,
        "speaker_duration_weighted": True,
        "metrics": {
            "cer_median": 0.07,
            "cer_p95": 0.17,
            "numeric_time_accuracy": 0.96,
            "registered_attribution_f1": 0.91,
            "unknown_forced_name_rate": 0.0,
        },
        "lineage": {
            key: "sha256:" + character * 64
            for key, character in (
                ("source_manifest_sha256", "1"),
                ("review_a_sha256", "2"),
                ("review_b_sha256", "3"),
                ("adjudication_sha256", "4"),
                ("predictions_sha256", "5"),
                ("development_manifest_sha256", "6"),
            )
        },
    })
    return {
        "service_ready": {"api": True, "asr": True},
        "device_runtime": {
            "candidate_apk": True,
            "process_death_recovered": True,
            "network_switch_recovered": True,
            "projection_no_duplicate": True,
            "no_speech_success": True,
        },
        "performance": {
            "realtime_p95_ms": 1_900,
            "import_rtf_p95": 0.48,
            "first_segment_p95_ms": 7_600,
            "speaker_overlay_sample_count": 30,
            "speaker_overlay_p95_ms": 29_000,
            "api_rss_peak_kib": 1_200_000,
            "api_rss_delta_mib": 64,
            "total_rss_gib": 7.5,
            "gpu0_free_gib": 1.2,
            "cpu_p95_cores": 12,
            "temp_peak_gib": 2,
        },
        "cleanup": {"pending_tasks": 0, "pending_cleanup": 0},
        "media_quality": quality,
        "public_cycle": {"complete": True, "legacy_submit_count": 0},
    }


def test_missing_evidence_fails_closed() -> None:
    report = inspect(ROOT, {})
    assert report["passed"] is False
    assert "android_process_death_recovered" in report["blocking_gates"]
    assert "legacy_submit_zero_public_cycle" in report["blocking_gates"]


def test_thresholds_and_runtime_evidence_can_pass() -> None:
    report = inspect(ROOT, _passing_envelope())
    assert report["passed"] is True
    assert report["blocking_gates"] == []


def test_slow_realtime_and_nonzero_legacy_cycle_block() -> None:
    evidence = _passing_envelope()
    evidence["performance"]["realtime_p95_ms"] = 2_001
    evidence["public_cycle"]["legacy_submit_count"] = 1
    report = inspect(ROOT, evidence)
    assert report["passed"] is False
    assert "performance_realtime_p95_ms" in report["blocking_gates"]
    assert "legacy_submit_zero_public_cycle" in report["blocking_gates"]


def test_speaker_overlay_latency_requires_at_least_30_samples() -> None:
    evidence = _passing_envelope()
    evidence["performance"]["speaker_overlay_sample_count"] = 1
    evidence["performance"]["speaker_overlay_p95_ms"] = 100

    report = inspect(ROOT, evidence)

    assert report["passed"] is False
    assert "performance_speaker_overlay_sample_count" in report["blocking_gates"]


def test_weak_subtitle_metrics_cannot_close_human_quality_gate() -> None:
    evidence = _passing_envelope()
    quality = dict(evidence["media_quality"])
    quality.pop("report_sha256")
    quality["source_policy"] = "weak_subtitle_diagnostic"
    quality["source_promotion_eligible"] = False
    quality["gate_eligible"] = False
    evidence["media_quality"] = seal_report(quality)

    report = inspect(ROOT, evidence)

    assert report["passed"] is False
    assert "media_independent_human_holdout" in report["blocking_gates"]
