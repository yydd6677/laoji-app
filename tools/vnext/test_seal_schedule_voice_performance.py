from __future__ import annotations

from seal_schedule_voice_performance import build_report


SHA = "sha256:" + "1" * 64


def _replay(*, capture_p95: int = 80) -> dict:
    return {
        "candidate_only": True,
        "warmup_run_count": 1,
        "warmup_runs": [
            {
                "run": 1,
                "terminal": "draft",
                "capture_start_ms": 120,
                "first_text_ms": 1_600,
                "draft_ms": 2_500,
                "draft_sha256": SHA,
            }
        ],
        "runs": [
            {
                "run": index + 1,
                "terminal": "draft",
                "draft_sha256": SHA,
            }
            for index in range(30)
        ],
        "metrics": {
            "run_count": 30,
            "draft_success_count": 30,
            "draft_distinct_hash_count": 1,
            "transcript_distinct_hash_count": 1,
            "capture_start_p95_ms": capture_p95,
            "first_text_p95_ms": 1_300,
            "draft_p95_ms": 2_400,
        },
    }


def _mixed_load() -> dict:
    return {
        "candidate_only": True,
        "passed": True,
        "requested_duration_seconds": 600,
        "lanes": {
            name: {"completed": 1, "failed": 0}
            for name in ("realtime", "held_upload", "import_asr", "schedule", "q2", "summary")
        },
    }


def test_passing_report_is_sealed() -> None:
    report = build_report(
        _replay(),
        _mixed_load(),
        replay_sha256=SHA,
        mixed_load_sha256=SHA,
    )

    assert report["passed"] is True
    assert report["draft_success_count"] == 30
    assert report["draft_distinct_hash_count"] == 1
    assert report["warmup_run_count"] == 1
    assert report["warmup_runs"][0]["capture_start_ms"] == 120
    assert report["mixed_load"]["traffic_classes"] == {
        "realtime_asr": True,
        "upload": True,
        "import_asr_backlog": True,
        "schedule_parse": True,
        "question": True,
        "summary": True,
    }
    assert report["report_sha256"].startswith("sha256:")


def test_latency_failure_is_preserved_in_sealed_report() -> None:
    report = build_report(
        _replay(capture_p95=104),
        _mixed_load(),
        replay_sha256=SHA,
        mixed_load_sha256=SHA,
    )

    assert report["passed"] is False
    assert report["gate"]["capture_start_p95"] is False
    assert report["gate"]["draft_success"] is True
