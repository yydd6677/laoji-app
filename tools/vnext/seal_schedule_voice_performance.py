#!/usr/bin/env python3
"""Seal replay and mixed-load results into the Stage 4 voice evidence contract."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping


EVIDENCE_CONTRACT = "schedule-voice-performance-v1"
TRAFFIC_LANES = {
    "realtime_asr": "realtime",
    "upload": "held_upload",
    "import_asr_backlog": "import_asr",
    "schedule_parse": "schedule",
    "question": "q2",
    "summary": "summary",
}


def _mapping(value: object, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name}_mapping_required")
    return value


def _integer(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name}_integer_required")
    return value


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name}_number_required")
    return float(value)


def _sha256_bytes(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _file_sha256(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _object_sha256(value: Mapping[str, Any]) -> str:
    return _sha256_bytes(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )


def _lane_passed(lanes: Mapping[str, Any], lane_name: str) -> bool:
    lane = _mapping(lanes.get(lane_name), f"mixed_load_lane_{lane_name}")
    completed = _integer(lane.get("completed"), f"mixed_load_lane_{lane_name}_completed")
    failed = _integer(lane.get("failed"), f"mixed_load_lane_{lane_name}_failed")
    return completed >= 1 and failed == 0


def build_report(
    replay: Mapping[str, Any],
    mixed_load: Mapping[str, Any],
    *,
    replay_sha256: str,
    mixed_load_sha256: str,
) -> dict[str, Any]:
    if replay.get("candidate_only") is not True:
        raise ValueError("candidate_replay_required")
    runs = replay.get("runs")
    if not isinstance(runs, list):
        raise ValueError("replay_runs_required")
    metrics = _mapping(replay.get("metrics"), "replay_metrics")
    sample_count = _integer(metrics.get("run_count"), "replay_run_count")
    if sample_count != len(runs):
        raise ValueError("replay_run_count_mismatch")
    raw_warmup_runs = replay.get("warmup_runs", [])
    if not isinstance(raw_warmup_runs, list):
        raise ValueError("replay_warmup_runs_required")
    warmup_run_count = _integer(
        replay.get("warmup_run_count", len(raw_warmup_runs)),
        "replay_warmup_run_count",
    )
    if warmup_run_count != len(raw_warmup_runs):
        raise ValueError("replay_warmup_run_count_mismatch")

    draft_success_count = _integer(
        metrics.get("draft_success_count"),
        "replay_draft_success_count",
    )
    draft_distinct_hash_count = _integer(
        metrics.get("draft_distinct_hash_count"),
        "replay_draft_distinct_hash_count",
    )
    transcript_distinct_hash_count = _integer(
        metrics.get("transcript_distinct_hash_count"),
        "replay_transcript_distinct_hash_count",
    )
    capture_start_p95_ms = _number(
        metrics.get("capture_start_p95_ms"),
        "replay_capture_start_p95_ms",
    )
    first_text_p95_ms = _number(
        metrics.get("first_text_p95_ms"),
        "replay_first_text_p95_ms",
    )
    draft_p95_ms = _number(metrics.get("draft_p95_ms"), "replay_draft_p95_ms")
    def seal_runs(raw_runs: list[object], name: str) -> list[dict[str, Any]]:
        sealed: list[dict[str, Any]] = []
        for index, raw_run in enumerate(raw_runs, start=1):
            run = _mapping(raw_run, f"{name}_{index}")
            sealed.append({
                "run": _integer(run.get("run"), f"{name}_{index}_ordinal"),
                "terminal": run.get("terminal"),
                "capture_start_ms": run.get("capture_start_ms"),
                "first_text_ms": run.get("first_text_ms"),
                "draft_ms": run.get("draft_ms"),
                "audio_duration_ms": run.get("audio_duration_ms"),
                "transcript_sha256": run.get("transcript_sha256"),
                "draft_sha256": run.get("draft_sha256"),
                "error_code": run.get("error_code"),
            })
        return sealed

    sealed_runs = seal_runs(runs, "replay_run")
    sealed_warmup_runs = seal_runs(raw_warmup_runs, "replay_warmup_run")
    measured_draft_success = sum(run["terminal"] == "draft" for run in sealed_runs)
    measured_draft_hashes = {
        run["draft_sha256"]
        for run in sealed_runs
        if isinstance(run["draft_sha256"], str)
    }
    if measured_draft_success != draft_success_count:
        raise ValueError("replay_draft_success_count_mismatch")
    if len(measured_draft_hashes) != draft_distinct_hash_count:
        raise ValueError("replay_draft_hash_count_mismatch")

    if mixed_load.get("candidate_only") is not True or mixed_load.get("passed") is not True:
        raise ValueError("passing_candidate_mixed_load_required")
    duration_seconds = _number(
        mixed_load.get("requested_duration_seconds"),
        "mixed_load_requested_duration_seconds",
    )
    lanes = _mapping(mixed_load.get("lanes"), "mixed_load_lanes")
    traffic_classes = {
        traffic_class: _lane_passed(lanes, lane_name)
        for traffic_class, lane_name in TRAFFIC_LANES.items()
    }

    gate = {
        "sample_count": sample_count >= 30,
        "draft_success": draft_success_count == sample_count,
        "draft_deterministic": draft_distinct_hash_count == 1,
        "capture_start_p95": capture_start_p95_ms <= 100,
        "first_text_p95": first_text_p95_ms <= 1_500,
        "draft_p95": draft_p95_ms <= 3_000,
        "mixed_load": duration_seconds >= 600 and all(traffic_classes.values()),
    }
    report: dict[str, Any] = {
        "schema_version": 1,
        "evidence_contract": EVIDENCE_CONTRACT,
        "candidate_only": True,
        "producer_revision": "schedule-voice-sealer-v2",
        "source_report_sha256": replay_sha256,
        "mixed_load_report_sha256": mixed_load_sha256,
        "sample_count": sample_count,
        "warmup_run_count": warmup_run_count,
        "warmup_runs": sealed_warmup_runs,
        "draft_success_count": draft_success_count,
        "draft_distinct_hash_count": draft_distinct_hash_count,
        "transcript_distinct_hash_count": transcript_distinct_hash_count,
        "runs": sealed_runs,
        "capture_start_p95_ms": capture_start_p95_ms,
        "first_text_p95_ms": first_text_p95_ms,
        "draft_p95_ms": draft_p95_ms,
        "mixed_load": {
            "duration_seconds": duration_seconds,
            "traffic_classes": traffic_classes,
        },
        "gate": gate,
        "passed": all(gate.values()),
    }
    report["report_sha256"] = _object_sha256(report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay", type=Path, required=True)
    parser.add_argument("--mixed-load", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    replay = json.loads(args.replay.read_text(encoding="utf-8"))
    mixed_load = json.loads(args.mixed_load.read_text(encoding="utf-8"))
    report = build_report(
        _mapping(replay, "replay"),
        _mapping(mixed_load, "mixed_load"),
        replay_sha256=_file_sha256(args.replay),
        mixed_load_sha256=_file_sha256(args.mixed_load),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
