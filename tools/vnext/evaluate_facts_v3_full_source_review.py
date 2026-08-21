#!/usr/bin/env python3
"""Build a resumable, private blind review packet for full-source Facts V3.

The public report is content-free. Transcript text and generated documents are
written only to an explicitly selected chmod-0600 path outside the Git tree.
"""

from __future__ import annotations

import argparse
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import random
import statistics
import time
from typing import Any

from probe_device_v2_realtime import refresh_auth
from probe_device_v2_upload import execute_purge_and_wait, json_request, require_success
from probe_stage3_vertical import (
    DEFAULT_CHAPTER_BYTES,
    build_items,
    create_source_stream,
    digest_json,
    persistent_device,
    register_binding,
    task_attempt_number,
    validate_facts_grounding,
    wait_task,
)


WORKTREE_ROOT = Path(__file__).resolve().parents[2]
HUMAN_REVIEW_CONTRACT = "stage3-facts-actions-human-review-v1"


def percentile(values: list[int], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def distribution(values: list[int]) -> dict[str, Any]:
    return {
        "count": len(values),
        "p50_ms": round(statistics.median(values), 1) if values else None,
        "p95_ms": round(percentile(values, 0.95) or 0, 1) if values else None,
        "max_ms": max(values) if values else None,
    }


def resolve_private_review_path(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if resolved.is_relative_to(WORKTREE_ROOT):
        raise ValueError("--human-review-out must be outside the Git worktree")
    return resolved


def write_json_atomic(path: Path, payload: dict[str, Any], *, mode: int | None = None) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(body)
    if mode is not None:
        os.chmod(temporary, mode)
    temporary.replace(path)
    return body


def review_id(sample_sha256: str) -> str:
    material = f"{HUMAN_REVIEW_CONTRACT}:{sample_sha256}".encode("utf-8")
    return "facts-" + hashlib.sha256(material).hexdigest()


def _review_key(value: Any, prefix: str, index: int) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return f"{prefix}-{index + 1}"


def build_review_row(
    *,
    sample_sha256: str,
    items: list[dict[str, Any]],
    document: dict[str, Any],
) -> dict[str, Any]:
    facts = list(document.get("facts") or [])
    actions = list(document.get("action_candidates") or [])
    return {
        "review_id": review_id(sample_sha256),
        "source_context": [{
            "ordinal": index,
            "start_ms": item.get("start_ms"),
            "end_ms": item.get("end_ms"),
            "speaker": item.get("speaker"),
            "text": item.get("content"),
        } for index, item in enumerate(items)],
        "facts_document": document,
        "review": {
            "overview_accurate": None,
            "important_fact_omitted": None,
            "omission_notes": "",
            "conflicts_preserved": None,
            "critical_error": None,
            "notes": "",
            "facts": [{
                "fact_id": _review_key(fact.get("fact_id"), "fact", index),
                "supported": None,
                "materially_accurate": None,
                "certainty_correct": None,
                "important": None,
                "notes": "",
            } for index, fact in enumerate(facts)],
            "actions": [{
                "action_id": _review_key(
                    action.get("action_id") or action.get("candidate_id"),
                    "action",
                    index,
                ),
                "is_real_commitment": None,
                "specific_and_useful": None,
                "owner_supported": None,
                "due_supported": None,
                "schedule_fit_appropriate": None,
                "duplicate_of": "",
                "notes": "",
            } for index, action in enumerate(actions)],
        },
    }


def human_review_packet(
    rows: list[dict[str, Any]],
    *,
    in_progress: bool,
    sample_count: int,
    reviewer: dict[str, str] | None = None,
) -> dict[str, Any]:
    blinded_rows = list(rows)
    random.SystemRandom().shuffle(blinded_rows)
    return {
        "schema_version": 1,
        "contract": HUMAN_REVIEW_CONTRACT,
        "blind": True,
        "in_progress": in_progress,
        "independent_human_review_required": True,
        "sample_count": sample_count,
        "instructions": [
            "Review only the source context and generated Facts V3 document in each row.",
            "Mark every unsupported or materially wrong fact; exact quotation alone is not enough.",
            "Mark important omissions at meeting level after reading the complete source context.",
            "Treat an action as valid only when it is a concrete prospective commitment.",
            "Do not infer sample identity, expected output or automated pass state.",
        ],
        "reviewer": reviewer or {"reviewer_id": "", "completed_at": ""},
        "rows": blinded_rows,
    }


def load_resume_state(
    report_path: Path,
    review_path: Path,
    *,
    sample_names: tuple[str, ...],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, str], int]:
    if not report_path.exists():
        raise ValueError("--resume requires an existing --json-out checkpoint")
    if not review_path.exists():
        raise ValueError("resume checkpoint has no private review packet")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if tuple(report.get("selected_samples") or ()) != sample_names:
        raise ValueError("resume checkpoint sample selection mismatch")
    results = list(report.get("results") or [])
    completed = [str(item.get("sample") or "") for item in results]
    if not all(completed) or len(completed) != len(set(completed)):
        raise ValueError("resume checkpoint contains missing or duplicate samples")

    packet = json.loads(review_path.read_text(encoding="utf-8"))
    if packet.get("contract") != HUMAN_REVIEW_CONTRACT:
        raise ValueError("resume private review contract mismatch")
    if packet.get("sample_count") != len(sample_names):
        raise ValueError("resume private review sample count mismatch")
    rows = list(packet.get("rows") or [])
    row_ids = [str(row.get("review_id") or "") for row in rows]
    if not all(row_ids) or len(row_ids) != len(set(row_ids)):
        raise ValueError("resume private review packet has missing or duplicate review IDs")
    expected_ids = {
        str(item["review_id"])
        for item in results
        if item.get("review_id")
    }
    if not expected_ids.issubset(set(row_ids)):
        raise ValueError("resume private review packet is behind the public checkpoint")
    reviewer_wire = packet.get("reviewer")
    reviewer = {
        "reviewer_id": str((reviewer_wire or {}).get("reviewer_id") or ""),
        "completed_at": str((reviewer_wire or {}).get("completed_at") or ""),
    }
    if reviewer["completed_at"]:
        raise ValueError("cannot resume a human review packet after review completion")
    return results, rows, reviewer, int(report.get("auth_refresh_count") or 0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=Path, default=Path("/home/yydd/下载/会议视频样本"))
    parser.add_argument("--api", default="http://127.0.0.1:28030/api/device/v2")
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--human-review-out", type=Path, required=True)
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--chapter-bytes", type=int, default=DEFAULT_CHAPTER_BYTES)
    parser.add_argument("--chapter-seconds", type=int, default=0)
    parser.add_argument(
        "--auth-state",
        type=Path,
        default=Path.home() / ".cache" / "laoji-vnext" / "stage3-probe-device.json",
    )
    args = parser.parse_args()
    if args.retry_failed and not args.resume:
        raise SystemExit("--retry-failed requires --resume")
    try:
        review_path = resolve_private_review_path(args.human_review_out)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    selected = set(args.id)
    samples = tuple(
        path for path in sorted(args.samples.glob("*.srt"))
        if not selected or path.name in selected or path.stem in selected
    )
    if not samples:
        raise SystemExit("no matching SRT samples")
    sample_names = tuple(path.name for path in samples)

    results: list[dict[str, Any]] = []
    review_rows: list[dict[str, Any]] = []
    reviewer = {"reviewer_id": "", "completed_at": ""}
    auth_refresh_count = 0
    if args.resume:
        try:
            results, review_rows, reviewer, auth_refresh_count = load_resume_state(
                args.json_out,
                review_path,
                sample_names=sample_names,
            )
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise SystemExit(str(error)) from error
        if args.retry_failed:
            failed_ids = {
                str(item["review_id"])
                for item in results
                if not item.get("passed") and item.get("review_id")
            }
            results = [item for item in results if item.get("passed")]
            review_rows = [
                row for row in review_rows
                if str(row.get("review_id") or "") not in failed_ids
            ]

    completed_samples = {str(item["sample"]) for item in results}
    auth_path = args.auth_state.expanduser().resolve()
    state = persistent_device(args.api, auth_path)
    auth_refreshed_at = time.monotonic()
    status, capability_wire = json_request(f"{args.api}/capabilities", headers=state.auth)
    capabilities = require_success(status, capability_wire, "read capabilities")
    if not capabilities.get("source_stream_v2"):
        raise RuntimeError("candidate Summary source stream is not enabled")
    summary_revisions = {
        name: str(capabilities.get(name) or "")
        for name in (
            "summary_handler_revision",
            "summary_prompt_revision",
            "summary_model_revision",
        )
    }
    if any(not value for value in summary_revisions.values()):
        raise RuntimeError("candidate Summary runtime revisions are missing")

    def checkpoint(in_progress: bool) -> None:
        packet = human_review_packet(
            review_rows,
            in_progress=in_progress,
            sample_count=len(samples),
            reviewer=reviewer,
        )
        review_body = write_json_atomic(review_path, packet, mode=0o600)
        report = {
            "schema_version": 1,
            "candidate_only": True,
            "production_mutation": False,
            "in_progress": in_progress,
            "source_policy": "complete real subtitle source stream; weak reference only",
            "selected_samples": list(sample_names),
            "auth_refresh_count": auth_refresh_count,
            "runtime_revisions": summary_revisions,
            "human_review": {
                "contract": HUMAN_REVIEW_CONTRACT,
                "row_count": len(review_rows),
                "sha256": "sha256:" + hashlib.sha256(review_body).hexdigest(),
            },
            "results": results,
        }
        write_json_atomic(args.json_out, report)

    for ordinal, sample in enumerate(samples, start=1):
        if sample.name in completed_samples:
            continue
        if time.monotonic() - auth_refreshed_at >= 7 * 60:
            state = replace(state, auth=refresh_auth(args.api, state))
            auth_refreshed_at = time.monotonic()
            auth_refresh_count += 1
        binding: tuple[str, str, str, str] | None = None
        started = time.perf_counter()
        try:
            chapters, sample_sha256 = build_items(
                sample,
                args.chapter_seconds,
                args.chapter_bytes,
            )
            items = [item for chapter in chapters for item in chapter]
            source_texts = [str(item["content"]) for item in items]
            source_fingerprint = digest_json([{
                "content_sha256": item["content_sha256"],
                "source_start_utf8": item["source_start_utf8"],
                "source_end_utf8": item["source_end_utf8"],
            } for item in items])
            binding = register_binding(args.api, state.auth, auth_path)
            binding_id, binding_generation, _purge_id, _purge_secret = binding
            _stream_id, task_id, groups = create_source_stream(
                api=args.api,
                auth=state.auth,
                binding_id=binding_id,
                binding_generation=binding_generation,
                chapters=chapters,
                capability="summary",
                input_sha256=source_fingerprint,
                timeout_seconds=args.timeout_seconds,
                summary_revisions=summary_revisions,
            )
            task, _poll_elapsed_ms = wait_task(
                args.api,
                state.auth,
                task_id,
                args.timeout_seconds,
            )
            if task.get("state") != "success":
                raise RuntimeError(f"summary task failed: {task.get('error_code')}")
            status, artifact_wire = json_request(
                f"{args.api}/tasks/{task_id}/artifact",
                headers=state.auth,
            )
            artifact = require_success(status, artifact_wire, "read Facts V3 artifact")["artifact"]
            output = dict(artifact.get("output") or {})
            document = dict(output.get("facts_document") or {})
            checked, matched = validate_facts_grounding(document, source_texts)
            errors = []
            if document.get("schema_version") != 3:
                errors.append("facts_schema_version_invalid")
            if checked != matched:
                errors.append("citation_not_exact")
            if not document.get("facts"):
                errors.append("no_facts")
            row_id = review_id(sample_sha256)
            result = {
                "sample": sample.name,
                "sample_sha256": sample_sha256,
                "review_id": row_id,
                "duration_ms": max(int(item.get("end_ms") or 0) for item in items),
                "chapter_count": len(chapters),
                "source_segments": len(items),
                "source_fingerprint": source_fingerprint,
                "task_attempt": task_attempt_number(task),
                "group_terminal_states": sorted({str(group.get("state")) for group in groups}),
                "handler_revision": output.get("handler_revision"),
                "prompt_revision": output.get("prompt_revision"),
                "model_revision": output.get("model_revision"),
                "facts_schema_version": document.get("schema_version"),
                "facts": len(document.get("facts") or []),
                "relations": len(document.get("relations") or []),
                "actions": len(document.get("action_candidates") or []),
                "citations": checked,
                "exact_citations": matched,
                "document_sha256": digest_json(document),
                "elapsed_ms": round((time.perf_counter() - started) * 1000),
                "passed": not errors,
                "errors": errors,
            }
            review_rows[:] = [row for row in review_rows if row.get("review_id") != row_id]
            review_rows.append(build_review_row(
                sample_sha256=sample_sha256,
                items=items,
                document=document,
            ))
        except Exception as error:
            result = {
                "sample": sample.name,
                "elapsed_ms": round((time.perf_counter() - started) * 1000),
                "passed": False,
                "error_type": type(error).__name__,
                "error_code": getattr(error, "code", None),
                "error_message": getattr(error, "safe_message", None),
            }
        finally:
            if binding is not None:
                _binding_id, _generation, purge_id, purge_secret = binding
                try:
                    purge = execute_purge_and_wait(
                        args.api,
                        purge_id,
                        purge_secret,
                        request_prefix="facts-review-cleanup",
                        timeout_seconds=60,
                    )
                    result["cleanup_state"] = purge.get("state")
                except Exception:
                    result["cleanup_state"] = "failed"
                    result["passed"] = False
            results.append(result)
            checkpoint(True)
            print(
                f"[{ordinal}/{len(samples)}] {'PASS' if result.get('passed') else 'FAIL'} "
                f"{sample.name} {result['elapsed_ms']}ms",
                flush=True,
            )

    latencies = [int(item["elapsed_ms"]) for item in results if item.get("passed")]
    single_chapter_latencies = [
        int(item["elapsed_ms"])
        for item in results
        if item.get("passed") and item.get("chapter_count") == 1
    ]
    multi_chapter_latencies = [
        int(item["elapsed_ms"])
        for item in results
        if item.get("passed") and int(item.get("chapter_count") or 0) > 1
    ]
    passed = sum(1 for item in results if item.get("passed"))
    checkpoint(False)
    report = json.loads(args.json_out.read_text(encoding="utf-8"))
    report.update({
        "total": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "latency": distribution(latencies),
        "single_chapter_latency": distribution(single_chapter_latencies),
        "multi_chapter_latency": distribution(multi_chapter_latencies),
        "all_exact_citations": all(
            item.get("citations") == item.get("exact_citations")
            for item in results if item.get("citations") is not None
        ),
        "cleanup_complete": all(
            item.get("cleanup_state") in {"completed", "confirmed"}
            for item in results
        ),
        "remaining": [
            "independent human fact support, omission and action usefulness review",
            "capability barrier",
        ],
    })
    write_json_atomic(args.json_out, report)
    print(json.dumps({
        "total": report["total"],
        "passed": report["passed"],
        "failed": report["failed"],
        "latency": report["latency"],
        "human_review_rows": report["human_review"]["row_count"],
    }, ensure_ascii=False), flush=True)
    return 0 if report["failed"] == 0 and report["cleanup_complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
