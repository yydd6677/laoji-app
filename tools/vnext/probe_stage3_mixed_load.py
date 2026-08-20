#!/usr/bin/env python3
"""Replay concurrent Summary V3 and Q2 flows against an isolated candidate.

Two independent device-v2 vertical probes start together in each pair. The
single Summary worker normally advances the second Summary while the first
probe asks Q2, producing an application-level mixed-load window without
touching production traffic. Reports retain only hashes, counts, timings and
contract outcomes; source text, questions, answers, citations and credentials
are never copied into the aggregate artifact.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
VERTICAL_PROBE = ROOT / "tools" / "vnext" / "probe_stage3_vertical.py"


def percentile(values: list[int], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return float(ordered[low])
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def distribution(values: list[int]) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        "p50_ms": round(percentile(values, 0.50) or 0, 1) if values else None,
        "p95_ms": round(percentile(values, 0.95) or 0, 1) if values else None,
        "max_ms": max(values) if values else None,
    }


def interval_overlap_ms(
    first_start: int | None,
    first_end: int | None,
    second_start: int | None,
    second_end: int | None,
) -> int:
    values = (first_start, first_end, second_start, second_end)
    if any(value is None for value in values):
        return 0
    assert first_start is not None and first_end is not None
    assert second_start is not None and second_end is not None
    return max(0, min(first_end, second_end) - max(first_start, second_start))


def safe_error_digest(value: str) -> dict[str, Any]:
    encoded = value.encode("utf-8", errors="replace")
    return {
        "bytes": len(encoded),
        "sha256": "sha256:" + hashlib.sha256(encoded).hexdigest(),
    }


def safe_failure_details(value: str) -> dict[str, Any]:
    """Retain only protocol/error identifiers, never response bodies."""
    http_statuses = sorted({int(item) for item in re.findall(r"HTTP\s+(\d{3})", value)})
    reason_codes = sorted({
        item
        for item in re.findall(r"[\"']code[\"']\s*:\s*[\"']([A-Z][A-Z0-9_]{2,80})[\"']", value)
    })
    exception_types = sorted({
        item
        for item in re.findall(
            r"^(?:[\w.]+\.)?([A-Z][A-Za-z0-9_]*(?:Error|Exception)):",
            value,
            flags=re.MULTILINE,
        )
    })
    return {
        "http_statuses": http_statuses,
        "reason_codes": reason_codes,
        "exception_types": exception_types,
    }


def write_auth_state(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def reserve_lane_auth_states(
    base_path: Path,
    lane_paths: dict[str, Path],
    api: str,
) -> None:
    payload = json.loads(base_path.read_text(encoding="utf-8"))
    if payload.get("api") != api:
        raise RuntimeError("candidate auth state belongs to another API")
    # A prior interrupted lane can have completed its server registration and
    # persisted the next sequence before the aggregate runner commits it back
    # to the base file. Such a lane is authoritative because the vertical
    # probe advances it only after a successful registration response.
    reserved_sequences = [max(1, int(payload.get("next_binding_epoch_seq") or 1))]
    for path in lane_paths.values():
        if path.is_file():
            lane_payload = json.loads(path.read_text(encoding="utf-8"))
            if lane_payload.get("api") == api:
                reserved_sequences.append(
                    max(1, int(lane_payload.get("next_binding_epoch_seq") or 1))
                )
    next_sequence = max(reserved_sequences)
    for offset, lane in enumerate(("a", "b")):
        lane_payload = dict(payload)
        lane_payload["next_binding_epoch_seq"] = next_sequence + offset
        write_auth_state(lane_paths[lane], lane_payload)


def commit_reserved_sequences(base_path: Path, lane_paths: dict[str, Path]) -> None:
    base = json.loads(base_path.read_text(encoding="utf-8"))
    sequences = [max(1, int(base.get("next_binding_epoch_seq") or 1))]
    for path in lane_paths.values():
        if path.is_file():
            lane = json.loads(path.read_text(encoding="utf-8"))
            sequences.append(max(1, int(lane.get("next_binding_epoch_seq") or 1)))
    base["next_binding_epoch_seq"] = max(sequences)
    write_auth_state(base_path, base)


def run_probe(
    *,
    sample: Path,
    lane: str,
    pair_index: int,
    api: str,
    auth_state: Path,
    output: Path,
    timeout_seconds: int,
) -> dict[str, Any]:
    completed = subprocess.run(
        [
            sys.executable,
            str(VERTICAL_PROBE),
            str(sample),
            "--api", api,
            "--output", str(output),
            "--timeout-seconds", str(timeout_seconds),
            "--auth-state", str(auth_state),
        ],
        cwd=ROOT,
        env={**os.environ},
        capture_output=True,
        text=True,
        timeout=timeout_seconds * 2,
        check=False,
    )
    if completed.returncode != 0 or not output.is_file():
        failure = safe_failure_details(completed.stderr)
        return {
            "pair": pair_index,
            "lane": lane,
            "sample": sample.name,
            "success": False,
            "return_code": completed.returncode,
            "stdout": safe_error_digest(completed.stdout),
            "stderr": safe_error_digest(completed.stderr),
            "failure": failure,
        }
    payload = json.loads(output.read_text(encoding="utf-8"))
    summary = dict(payload.get("summary") or {})
    question = dict(payload.get("question") or {})
    cleanup = dict(payload.get("cleanup") or {})
    return {
        "pair": pair_index,
        "lane": lane,
        "sample": sample.name,
        "sample_sha256": payload.get("sample_sha256"),
        "success": summary.get("state") == "success" and bool(question),
        "duration_ms": (payload.get("input") or {}).get("duration_ms"),
        "chapter_count": (payload.get("input") or {}).get("chapter_count"),
        "summary": {
            "started_at_epoch_ms": summary.get("started_at_epoch_ms"),
            "completed_at_epoch_ms": summary.get("completed_at_epoch_ms"),
            "end_to_end_elapsed_ms": summary.get("end_to_end_elapsed_ms"),
            "attempt": summary.get("final_attempt_number"),
            "citations": summary.get("citation_count"),
            "citations_exact": summary.get("citation_exact_match_count"),
        },
        "question": {
            "started_at_epoch_ms": question.get("started_at_epoch_ms"),
            "completed_at_epoch_ms": question.get("completed_at_epoch_ms"),
            "elapsed_ms": question.get("elapsed_ms"),
            "replay_elapsed_ms": question.get("replay_elapsed_ms"),
            "replay_identical": question.get("replay_identical"),
            "answer_kind": question.get("answer_kind"),
            "citations": question.get("citation_count"),
            "citations_exact": question.get("citation_exact_match_count"),
        },
        "cleanup_state": cleanup.get("state"),
        "runtime_revisions": payload.get("capabilities"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=Path, default=Path("/home/yydd/下载/会议视频样本"))
    parser.add_argument("--api", default="http://127.0.0.1:28023/api/device/v2")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--q2-p95-target-ms", type=int, default=15_000)
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument(
        "--auth-state-prefix",
        type=Path,
        default=Path.home() / ".cache" / "laoji-vnext" / "stage3-mixed",
    )
    parser.add_argument(
        "--auth-state-base",
        type=Path,
        default=Path.home() / ".cache" / "laoji-vnext" / "stage3-probe-device.json",
        help="existing chmod-0600 candidate identity; only its binding sequence advances",
    )
    args = parser.parse_args()
    if args.pairs < 1:
        raise SystemExit("pairs must be positive")
    selected = set(args.id)
    samples = [
        path for path in sorted(args.samples.glob("*.srt"))
        if not selected or path.stem in selected or path.name in selected
    ]
    if len(samples) < 2:
        raise SystemExit("at least two matching SRT samples are required")

    auth_state_base = args.auth_state_base.expanduser().resolve()
    if not auth_state_base.is_file():
        raise SystemExit("base candidate auth state is missing")
    args.auth_state_prefix.parent.mkdir(parents=True, exist_ok=True)
    lane_auth = {
        lane: args.auth_state_prefix.with_name(f"{args.auth_state_prefix.name}-{lane}.json")
        for lane in ("a", "b")
    }
    results: list[dict[str, Any]] = []
    pair_evidence: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="laoji-stage3-mixed-") as temporary:
        temporary_root = Path(temporary)
        for pair_index in range(1, args.pairs + 1):
            reserve_lane_auth_states(auth_state_base, lane_auth, args.api)
            pair_samples = {
                "a": samples[((pair_index - 1) * 2) % len(samples)],
                "b": samples[(((pair_index - 1) * 2) + 1) % len(samples)],
            }
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = {
                    lane: executor.submit(
                        run_probe,
                        sample=sample,
                        lane=lane,
                        pair_index=pair_index,
                        api=args.api,
                        auth_state=lane_auth[lane],
                        output=temporary_root / f"pair-{pair_index}-{lane}.json",
                        timeout_seconds=args.timeout_seconds,
                    )
                    for lane, sample in pair_samples.items()
                }
                pair_results = {lane: future.result() for lane, future in futures.items()}
            commit_reserved_sequences(auth_state_base, lane_auth)
            results.extend(pair_results.values())
            a = pair_results["a"]
            b = pair_results["b"]
            overlap_a_question_b_summary = interval_overlap_ms(
                (a.get("question") or {}).get("started_at_epoch_ms"),
                (a.get("question") or {}).get("completed_at_epoch_ms"),
                (b.get("summary") or {}).get("started_at_epoch_ms"),
                (b.get("summary") or {}).get("completed_at_epoch_ms"),
            )
            overlap_b_question_a_summary = interval_overlap_ms(
                (b.get("question") or {}).get("started_at_epoch_ms"),
                (b.get("question") or {}).get("completed_at_epoch_ms"),
                (a.get("summary") or {}).get("started_at_epoch_ms"),
                (a.get("summary") or {}).get("completed_at_epoch_ms"),
            )
            overlap = max(overlap_a_question_b_summary, overlap_b_question_a_summary)
            overlap_by_lane = {
                "a": overlap_a_question_b_summary,
                "b": overlap_b_question_a_summary,
            }
            pair_evidence.append({
                "pair": pair_index,
                "question_summary_overlap_ms": overlap,
                "question_overlap_ms_by_lane": overlap_by_lane,
                "overlapping_question_lanes": [
                    lane for lane, duration in overlap_by_lane.items() if duration > 0
                ],
                "overlap_direction": (
                    "a_question_b_summary"
                    if overlap_a_question_b_summary >= overlap_b_question_a_summary
                    else "b_question_a_summary"
                ) if overlap > 0 else None,
            })
            print(
                f"pair={pair_index} success={a.get('success') and b.get('success')} "
                f"overlap_ms={overlap}",
                flush=True,
            )

    successful = [item for item in results if item.get("success")]
    overlapping_questions = {
        (item["pair"], lane)
        for item in pair_evidence
        for lane in item["overlapping_question_lanes"]
    }
    mixed_questions = [
        int((item.get("question") or {}).get("elapsed_ms"))
        for item in successful
        if (item["pair"], item["lane"]) in overlapping_questions
        and isinstance((item.get("question") or {}).get("elapsed_ms"), int)
    ]
    all_questions = [
        int((item.get("question") or {}).get("elapsed_ms"))
        for item in successful
        if isinstance((item.get("question") or {}).get("elapsed_ms"), int)
    ]
    all_summaries = [
        int((item.get("summary") or {}).get("end_to_end_elapsed_ms"))
        for item in successful
        if isinstance((item.get("summary") or {}).get("end_to_end_elapsed_ms"), int)
    ]
    mixed_distribution = distribution(mixed_questions)
    report = {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "api": args.api,
        "requested_pairs": args.pairs,
        "completed_flows": len(successful),
        "failed_flows": len(results) - len(successful),
        "overlapping_pairs": sum(
            1 for item in pair_evidence if item["question_summary_overlap_ms"] > 0
        ),
        "summary": distribution(all_summaries),
        "question_all": distribution(all_questions),
        "question_during_summary": mixed_distribution,
        "q2_p95_target_ms": args.q2_p95_target_ms,
        "q2_mixed_p95_pass": bool(mixed_questions)
        and float(mixed_distribution["p95_ms"] or 0) <= args.q2_p95_target_ms,
        "exact_grounding": all(
            (item.get("summary") or {}).get("citations")
            == (item.get("summary") or {}).get("citations_exact")
            and (item.get("question") or {}).get("citations")
            == (item.get("question") or {}).get("citations_exact")
            for item in successful
        ),
        "idempotent_question_replays": all(
            (item.get("question") or {}).get("replay_identical") is True
            for item in successful
        ),
        "cleanup_complete": all(
            item.get("cleanup_state") in {"completed", "confirmed"}
            for item in successful
        ),
        "pairs": pair_evidence,
        "results": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary_output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_output.replace(args.output)
    print(json.dumps({
        "completed_flows": report["completed_flows"],
        "failed_flows": report["failed_flows"],
        "overlapping_pairs": report["overlapping_pairs"],
        "question_during_summary": report["question_during_summary"],
        "q2_mixed_p95_pass": report["q2_mixed_p95_pass"],
    }, ensure_ascii=False), flush=True)
    return 0 if (
        report["failed_flows"] == 0
        and report["overlapping_pairs"] == args.pairs
        and report["exact_grounding"]
        and report["idempotent_question_replays"]
        and report["cleanup_complete"]
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
