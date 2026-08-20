#!/usr/bin/env python3
"""Measure Stage 3 full-source latency without persisting meeting content.

Each run uses the device-v2 vertical probe, a fresh meeting binding and the
real encrypted source-stream/task/artifact/purge contracts. The aggregate
report retains only sample names, hashes, counts, durations and latency; the
temporary per-run reports are removed automatically.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "tools" / "vnext" / "probe_stage3_vertical.py"


def percentile(values: list[int], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return float(ordered[low])
    weight = position - low
    return ordered[low] + (ordered[high] - ordered[low]) * weight


def distribution(values: list[int]) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        "p50_ms": round(percentile(values, 0.50) or 0, 1) if values else None,
        "p95_ms": round(percentile(values, 0.95) or 0, 1) if values else None,
        "max_ms": max(values) if values else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=Path, default=Path("/home/yydd/下载/会议视频样本"))
    parser.add_argument("--api", default="http://127.0.0.1:28023/api/device/v2")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--chapter-bytes", type=int, default=48 * 1024)
    parser.add_argument(
        "--include-question",
        action="store_true",
        help="also run Q2; summary latency evidence is summary-only by default",
    )
    parser.add_argument(
        "--chapter-seconds",
        type=int,
        default=0,
        help="diagnostic time boundary; zero matches Android byte-only packing",
    )
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument(
        "--auth-state",
        type=Path,
        default=Path.home() / ".cache" / "laoji-vnext" / "stage3-probe-device.json",
    )
    args = parser.parse_args()
    if args.runs < 1:
        raise SystemExit("runs must be positive")
    selected = set(args.id)
    samples = [
        path for path in sorted(args.samples.glob("*.srt"))
        if not selected or path.stem in selected or path.name in selected
    ]
    if not samples:
        raise SystemExit("no matching SRT samples")

    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []

    def write_checkpoint() -> None:
        checkpoint = {
            "schema_version": 1,
            "candidate_only": True,
            "in_progress": True,
            "updated_at_epoch_ms": round(time.time() * 1000),
            "sample_count": len(samples),
            "requested_runs": args.runs,
            "completed": len(results),
            "failed": len(failures),
            "results": results,
            "failures": failures,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary_output.write_text(
            json.dumps(checkpoint, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_output.replace(args.output)

    with tempfile.TemporaryDirectory(prefix="laoji-stage3-latency-") as temporary:
        temporary_root = Path(temporary)
        for run in range(1, args.runs + 1):
            for sample in samples:
                output = temporary_root / f"run-{run}-{sample.stem}.json"
                command = [
                    sys.executable,
                    str(PROBE),
                    str(sample),
                    "--api", args.api,
                    "--output", str(output),
                    "--timeout-seconds", str(args.timeout_seconds),
                    "--chapter-bytes", str(args.chapter_bytes),
                    "--chapter-seconds", str(args.chapter_seconds),
                    "--auth-state", str(args.auth_state.expanduser()),
                ]
                if not args.include_question:
                    command.append("--skip-question")
                completed = subprocess.run(
                    command,
                    cwd=ROOT,
                    env={**os.environ},
                    capture_output=True,
                    text=True,
                    timeout=args.timeout_seconds * 2,
                    check=False,
                )
                if completed.returncode != 0 or not output.is_file():
                    failures.append({
                        "sample": sample.name,
                        "run": run,
                        "return_code": completed.returncode,
                        "error_tail": (completed.stderr or completed.stdout)[-300:],
                    })
                    write_checkpoint()
                    print(f"FAIL run={run} sample={sample.name}", flush=True)
                    continue
                report = json.loads(output.read_text(encoding="utf-8"))
                summary = report["summary"]
                question = report.get("question")
                result = {
                    "sample": sample.name,
                    "run": run,
                    "sample_sha256": report["sample_sha256"],
                    "duration_ms": report["input"]["duration_ms"],
                    "chapter_count": report["input"]["chapter_count"],
                    "item_count": report["input"]["item_count"],
                    "summary_end_to_end_elapsed_ms": summary["end_to_end_elapsed_ms"],
                    "summary_poll_elapsed_ms": summary["elapsed_ms"],
                    "summary_attempt": summary["final_attempt_number"],
                    "facts_count": summary["facts_count"],
                    "actions_count": summary["action_candidate_count"],
                    "facts_citations": summary["citation_count"],
                    "facts_citations_exact": summary["citation_exact_match_count"],
                    "question_elapsed_ms": question["elapsed_ms"] if question else None,
                    "question_replay_elapsed_ms": question["replay_elapsed_ms"] if question else None,
                    "question_replay_identical": question["replay_identical"] if question else None,
                    "question_citations": question["citation_count"] if question else None,
                    "question_citations_exact": question["citation_exact_match_count"] if question else None,
                    "cleanup_state": report["cleanup"]["state"],
                    "runtime_revisions": {
                        name: report["capabilities"].get(name)
                        for name in (
                            "summary_handler_revision",
                            "summary_prompt_revision",
                            "summary_model_revision",
                        )
                    },
                }
                results.append(result)
                write_checkpoint()
                print(
                    f"PASS run={run} sample={sample.name} "
                    f"summary={result['summary_end_to_end_elapsed_ms']}ms "
                    + (
                        f"q2={result['question_elapsed_ms']}ms"
                        if question else "q2=skipped"
                    ),
                    flush=True,
                )

    under_hour = [item for item in results if item["duration_ms"] <= 3_600_000]
    single_pack = [item for item in results if item["chapter_count"] == 1]
    question_results = [item for item in results if item["question_elapsed_ms"] is not None]
    runtime_revisions = sorted({
        json.dumps(item["runtime_revisions"], ensure_ascii=False, sort_keys=True)
        for item in results
    })
    runtime_revision_values = [json.loads(value) for value in runtime_revisions]
    runtime_revision_consistent = bool(results) and len(runtime_revision_values) == 1 and all(
        runtime_revision_values[0].get(name)
        for name in (
            "summary_handler_revision",
            "summary_prompt_revision",
            "summary_model_revision",
        )
    )
    report = {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "api": args.api,
        "chapter_bytes": args.chapter_bytes,
        "chapter_seconds": args.chapter_seconds,
        "include_question": args.include_question,
        "sample_count": len(samples),
        "requested_runs": args.runs,
        "completed": len(results),
        "failed": len(failures),
        "summary_all": distribution([
            item["summary_end_to_end_elapsed_ms"] for item in results
        ]),
        "summary_single_pack": distribution([
            item["summary_end_to_end_elapsed_ms"] for item in single_pack
        ]),
        "summary_under_one_hour": distribution([
            item["summary_end_to_end_elapsed_ms"] for item in under_hour
        ]),
        "runtime_revisions": runtime_revision_values,
        "runtime_revision_consistent": runtime_revision_consistent,
        "question": distribution([item["question_elapsed_ms"] for item in question_results]),
        "exact_grounding": {
            "facts": all(
                item["facts_citations"] == item["facts_citations_exact"] for item in results
            ),
            "questions": all(
                item["question_citations"] == item["question_citations_exact"] for item in results
            ) if question_results else None,
        },
        "idempotent_question_replays": all(
            item["question_replay_identical"] for item in results
        ) if question_results else None,
        "cleanup_complete": all(
            item["cleanup_state"] in {"completed", "confirmed"}
            for item in results
        ),
        "results": results,
        "failures": failures,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "completed": report["completed"],
        "failed": report["failed"],
        "summary_under_one_hour": report["summary_under_one_hour"],
        "question": report["question"],
    }, ensure_ascii=False), flush=True)
    return 0 if not failures and runtime_revision_consistent else 1


if __name__ == "__main__":
    raise SystemExit(main())
