"""Evaluate Q2 against complete real subtitle sources through device-v2.

The authored questions and expected anchors come from the existing holdout,
but every request uploads the complete SRT as an encrypted source stream. The
report stores only IDs, hashes, counts, timing and error codes; it never stores
subtitle, answer, quote, key or token content.
"""

from __future__ import annotations

import argparse
from dataclasses import replace
import json
from pathlib import Path
import statistics
import time
import uuid
from typing import Any

from evaluate_q2_real_holdout import CASES, _payload as holdout_payload
from probe_device_v2_upload import json_request, require_success
from probe_stage3_vertical import (
    build_items,
    create_source_stream,
    digest_json,
    persistent_device,
    register_binding,
    validate_q2_grounding,
)
from probe_device_v2_realtime import refresh_auth


class HoldoutApiError(RuntimeError):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(message or code)
        self.code = code
        self.safe_message = message


FULL_SOURCE_QUESTION_OVERRIDES = {
    # The complete meeting later calls the boss the "root problem". Anchor the
    # earlier operating-metric discussion so this evaluation question has one
    # intended referent instead of inheriting a window-only ambiguity.
    "finance-cost": "会上如何评价公司的成本控制情况？",
}

FULL_SOURCE_EXPECTATION_OVERRIDES = {
    # The old narrow window stopped at the outline sentence and therefore
    # treated this as absent.  The complete report explicitly enumerates
    # sample quality, oxygen content, short-range order and layer competition.
    "science-question": {
        "expected": "answer",
        "required_any": ("样品", "氧含量", "短程序", "结构"),
        "citation_any": ("样品", "氧含量", "短程序", "双层"),
    },
}

FULL_SOURCE_REQUIRED_GROUPS = {
    "paper-method": (("模拟退火",), ("李亚普诺夫", "路径构造")),
    "report-three-parts": (("工作总结",), ("个人不足",), ("工作计划",)),
    "un-areas": (("水循环",), ("食物链",)),
    "equity-split": (("65",), ("35",)),
    "energy-ui-plan": (("文件", "txt", "导入"), ("excel", "输出", "导出")),
}

FULL_SOURCE_CITATION_GROUPS = {
    "report-three-parts": (("工作总结",), ("工作计划",)),
    "un-areas": (("水循环",), ("食物",)),
    "equity-split": (("65",), ("35",)),
    "energy-ui-plan": (("文件", "txt"), ("excel", "输出")),
}


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=Path, default=Path("/home/yydd/下载/会议视频样本"))
    parser.add_argument("--api", default="http://127.0.0.1:28023/api/device/v2")
    parser.add_argument("--json-out", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument("--start-at", help="Diagnostic subset beginning at this case ID.")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument(
        "--keep-failed-binding",
        action="store_true",
        help="Diagnostic only: retain an isolated failed binding for snapshot inspection.",
    )
    parser.add_argument(
        "--auth-state",
        type=Path,
        default=Path.home() / ".cache" / "laoji-vnext" / "stage3-probe-device.json",
    )
    args = parser.parse_args()
    if args.runs < 1:
        raise SystemExit("runs must be positive")
    available_cases = tuple(CASES)
    if args.start_at:
        try:
            start_index = next(
                index for index, case in enumerate(available_cases)
                if case.case_id == args.start_at
            )
        except StopIteration as error:
            raise SystemExit(f"unknown start case: {args.start_at}") from error
        available_cases = available_cases[start_index:]
    selected_ids = set(args.id)
    cases = tuple(
        case for case in available_cases
        if not selected_ids or case.case_id in selected_ids
    )
    if not cases:
        raise SystemExit("no matching cases")

    auth_path = args.auth_state.expanduser().resolve()
    state = persistent_device(args.api, auth_path)
    auth_refreshed_at = time.monotonic()
    auth_refresh_count = 0
    status, capability_wire = json_request(f"{args.api}/capabilities", headers=state.auth)
    capabilities = require_success(status, capability_wire, "read capabilities")
    if not capabilities.get("source_stream_v2") or not capabilities.get("question_reader_v2"):
        raise RuntimeError("candidate Q2 capabilities are not enabled")

    source_cache: dict[str, tuple[list[list[dict[str, Any]]], str, list[str], dict[str, str]]] = {}
    seen_samples: set[str] = set()
    results: list[dict[str, Any]] = []

    def checkpoint(in_progress: bool) -> None:
        report = {
            "schema_version": 1,
            "candidate_only": True,
            "production_mutation": False,
            "in_progress": in_progress,
            "source_policy": "complete real subtitle source stream; weak reference only",
            "requested_runs": args.runs,
            "case_count": len(cases),
            "auth_refresh_count": auth_refresh_count,
            "results": results,
        }
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.json_out.with_suffix(args.json_out.suffix + ".tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(args.json_out)

    for run in range(1, args.runs + 1):
        for case in cases:
            if time.monotonic() - auth_refreshed_at >= 7 * 60:
                state = replace(state, auth=refresh_auth(args.api, state))
                auth_refreshed_at = time.monotonic()
                auth_refresh_count += 1
            binding: tuple[str, str, str, str] | None = None
            stream_id: str | None = None
            task_id: str | None = None
            sample_path = args.samples / case.sample
            try:
                source_cache_key = (
                    f"{case.sample}:{case.case_id}"
                    if case.include_conflicting_note
                    else case.sample
                )
                if source_cache_key not in source_cache:
                    chapters, sample_sha256 = build_items(sample_path, 600)
                    chapters = [list(chapter) for chapter in chapters]
                    if case.include_conflicting_note:
                        holdout, _source_text = holdout_payload(case, args.samples)
                        extras = [
                            source
                            for source in holdout["sources"]
                            if source["source_type"] == "manual_note"
                            or str(source["source_id"]).startswith("conflict-transcript:")
                        ]
                        extra_items = [{
                            "item_id": "full-holdout-extra-" + uuid.uuid4().hex,
                            **source,
                            "content": source["text"],
                            "source_start_utf8": 0,
                            "source_end_utf8": len(source["text"].encode("utf-8")),
                            "start_ms": None,
                            "end_ms": None,
                            "speaker": None,
                        } for source in extras]
                        for item in extra_items:
                            item.pop("text", None)
                        chapters.append(extra_items)
                    all_items = [item for chapter in chapters for item in chapter]
                    source_texts = [str(item["content"]) for item in all_items]
                    source_by_hash = {
                        str(item["content_sha256"]): str(item["content"])
                        for item in all_items
                    }
                    source_cache[source_cache_key] = (
                        chapters,
                        sample_sha256,
                        source_texts,
                        source_by_hash,
                    )
                chapters, sample_sha256, source_texts, source_by_hash = source_cache[source_cache_key]
                source_fingerprint = digest_json([{
                    "content_sha256": item["content_sha256"],
                    "source_start_utf8": item["source_start_utf8"],
                    "source_end_utf8": item["source_end_utf8"],
                } for chapter in chapters for item in chapter])
                binding = register_binding(args.api, state.auth, auth_path)
                binding_id, binding_generation, _purge_id, _purge_secret = binding
                stream_id, task_id, groups = create_source_stream(
                    api=args.api,
                    auth=state.auth,
                    binding_id=binding_id,
                    binding_generation=binding_generation,
                    chapters=chapters,
                    capability="question",
                    input_sha256=source_fingerprint,
                    timeout_seconds=args.timeout_seconds,
                )
                question = FULL_SOURCE_QUESTION_OVERRIDES.get(case.case_id, case.question)
                expectation = FULL_SOURCE_EXPECTATION_OVERRIDES.get(case.case_id, {})
                expected_kind = str(expectation.get("expected", case.expected))
                required_any = tuple(expectation.get("required_any", case.required_any))
                citation_any = tuple(expectation.get("citation_any", case.citation_any))
                required_groups = FULL_SOURCE_REQUIRED_GROUPS.get(case.case_id, ())
                citation_groups = FULL_SOURCE_CITATION_GROUPS.get(case.case_id, ())
                payload = {
                    "schema_version": 2,
                    "contract_revision": "question.reader.v2",
                    "provider_revision": "q2-reader-v1",
                    "snapshot_id": "full-source-holdout-" + uuid.uuid4().hex,
                    "source_fingerprint": source_fingerprint,
                    "question": question,
                    "binding_generation": binding_generation,
                    "binding_revision": 1,
                    "cancel_revision": 0,
                    "task_id": task_id,
                    "source_stream_id": stream_id,
                    "source_stream_verified": False,
                    "sources": [],
                }
                conditioning = sample_sha256 not in seen_samples
                seen_samples.add(sample_sha256)
                started = time.perf_counter()
                status, response_wire = json_request(
                    f"{args.api}/meetings/{binding_id}/questions-v2",
                    method="POST",
                    headers=state.auth,
                    payload=payload,
                )
                if not 200 <= status < 300:
                    detail = response_wire.get("detail") if isinstance(response_wire, dict) else None
                    code = detail.get("code") if isinstance(detail, dict) else None
                    message = detail.get("message") if isinstance(detail, dict) else None
                    raise HoldoutApiError(
                        str(code or f"HTTP_{status}"),
                        str(message) if isinstance(message, str) else None,
                    )
                response = response_wire
                elapsed_ms = round((time.perf_counter() - started) * 1000)
                checked, matched = validate_q2_grounding(response, source_texts)
                answer = str(response.get("answer") or "")
                citations = [
                    citation
                    for clause in response.get("clauses") or []
                    for citation in clause.get("citations") or []
                ]
                errors: list[str] = []
                allowed_answer_kinds = {expected_kind}
                if expected_kind == "not_stated":
                    # A verified long source stream can still be narrowed for
                    # the one-call reader.  In that case the service must turn
                    # a model-level absence claim into the safer
                    # `cannot_confirm` result instead of pretending selected
                    # evidence proves absence from the complete meeting.
                    allowed_answer_kinds.add("cannot_confirm")
                if response.get("answer_kind") not in allowed_answer_kinds:
                    errors.append("answer_kind_mismatch")
                if required_any and not any(
                    token.lower() in answer.lower()
                    for token in required_any
                ):
                    errors.append("answer_anchor_missing")
                if any(
                    not any(token.lower() in answer.lower() for token in group)
                    for group in required_groups
                ):
                    errors.append("answer_group_missing")
                if expected_kind == "answer" and not citations:
                    errors.append("citation_missing")
                if expected_kind != "answer" and citations:
                    errors.append("refusal_has_citation")
                if citation_any and not any(
                    token in str(citation.get("quote") or "")
                    or token in source_by_hash.get(str(citation.get("content_sha256") or ""), "")
                    for token in citation_any
                    for citation in citations
                ):
                    errors.append("citation_anchor_missing")
                citation_texts = [
                    str(citation.get("quote") or "")
                    + source_by_hash.get(str(citation.get("content_sha256") or ""), "")
                    for citation in citations
                ]
                if any(
                    not any(token in text for token in group for text in citation_texts)
                    for group in citation_groups
                ):
                    errors.append("citation_group_missing")
                results.append({
                    "run": run,
                    "case_id": case.case_id,
                    "sample": case.sample,
                    "sample_sha256": sample_sha256,
                    "question_sha256": digest_json(question),
                    "question_overridden_for_full_source": case.case_id in FULL_SOURCE_QUESTION_OVERRIDES,
                    "expectation_overridden_for_full_source": case.case_id in FULL_SOURCE_EXPECTATION_OVERRIDES,
                    "allowed_answer_kinds": sorted(allowed_answer_kinds),
                    "conditioning": conditioning,
                    "model_backed": not case.include_conflicting_note,
                    "elapsed_ms": elapsed_ms,
                    "answer_kind": response.get("answer_kind"),
                    "answer_sha256": digest_json(answer),
                    "citation_count": checked,
                    "citation_exact_count": matched,
                    "group_terminal_states": sorted({str(group.get("state")) for group in groups}),
                    "passed": not errors and checked == matched,
                    "errors": errors,
                })
                print(
                    f"{'PASS' if results[-1]['passed'] else 'FAIL'} run={run} "
                    f"case={case.case_id} q2={elapsed_ms}ms conditioning={conditioning}",
                    flush=True,
                )
            except Exception as error:
                results.append({
                    "run": run,
                    "case_id": case.case_id,
                    "sample": case.sample,
                    "passed": False,
                    "error_type": type(error).__name__,
                    "error_code": getattr(error, "code", None),
                    "error_message": getattr(error, "safe_message", None),
                })
                print(f"FAIL run={run} case={case.case_id}", flush=True)
            finally:
                if binding is not None:
                    _binding_id, _generation, purge_id, purge_secret = binding
                    keep_failed = args.keep_failed_binding and not results[-1].get("passed")
                    if keep_failed:
                        results[-1]["diagnostic_binding_id"] = _binding_id
                        results[-1]["diagnostic_stream_id"] = stream_id
                        results[-1]["diagnostic_task_id"] = task_id
                    else:
                        purge_status, _purge_wire = json_request(
                            f"{args.api}/purge-capabilities/{purge_id}/execute",
                            method="POST",
                            headers={
                                "Authorization": f"LaojiPurge {purge_secret}",
                                "X-Laoji-Purge-Request-Id": "full-q2-cleanup-" + uuid.uuid4().hex,
                            },
                        )
                        if not 200 <= purge_status < 300:
                            results[-1]["cleanup_failed"] = True
                checkpoint(True)

    warm_latencies = [
        int(item["elapsed_ms"])
        for item in results
        if item.get("passed")
        and item.get("model_backed")
        and not item.get("conditioning")
        and isinstance(item.get("elapsed_ms"), int)
    ]
    passed = sum(1 for item in results if item.get("passed"))
    report = {
        "schema_version": 1,
        "candidate_only": True,
        "production_mutation": False,
        "in_progress": False,
        "source_policy": "complete real subtitle source stream; weak reference only",
        "requested_runs": args.runs,
        "case_count": len(cases),
        "auth_refresh_count": auth_refresh_count,
        "total": len(results),
        "passed": passed,
        "failed": len(results) - passed,
        "warm_model_backed": distribution(warm_latencies),
        "all_exact_citations": all(
            item.get("citation_count") == item.get("citation_exact_count")
            for item in results
            if item.get("passed")
        ),
        "results": results,
        "remaining": [
            "independent human answer and citation relevance review",
            "mixed-load p95",
            "capability barrier",
        ],
    }
    temporary = args.json_out.with_suffix(args.json_out.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.json_out)
    print(json.dumps({
        "total": report["total"],
        "passed": report["passed"],
        "failed": report["failed"],
        "warm_model_backed": report["warm_model_backed"],
    }, ensure_ascii=False), flush=True)
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
