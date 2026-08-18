from __future__ import annotations

from pathlib import Path

from verify_stage2_exit_preflight import inspect


ROOT = Path(__file__).resolve().parents[2]


def _passing_envelope() -> dict:
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
            "api_rss_peak_kib": 1_200_000,
            "api_rss_delta_mib": 64,
            "total_rss_gib": 7.5,
            "gpu0_free_gib": 1.2,
            "cpu_p95_cores": 12,
            "temp_peak_gib": 2,
        },
        "cleanup": {"pending_tasks": 0, "pending_cleanup": 0},
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

