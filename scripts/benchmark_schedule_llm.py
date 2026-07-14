#!/usr/bin/env python3
"""Benchmark the model-only LaoJi schedule parser against Ollama."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import statistics
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from run_schedule_review_samples import duration_summary, load_samples, stratified_sample


_THREAD_LOCAL = threading.local()
_CODE_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)
_CATEGORIES = {"工作", "学习", "健康", "生活", "社交", "出行", "财务", "重要", "其他"}
_REQUIRED_FIELDS = {
    "title",
    "event_type",
    "start_date",
    "end_date",
    "color",
    "spanning",
    "start_time",
    "end_time",
    "is_all_day",
    "description",
    "location",
    "category",
    "detail",
    "status",
    "reminder_minutes",
    "confidence",
    "needs_clarification",
    "clarification_question",
}
_COMPACT_REQUIRED_FIELDS = {
    "title",
    "event_type",
    "start_date",
    "category",
    "needs_clarification",
}


def direct_opener() -> urllib.request.OpenerDirector:
    opener = getattr(_THREAD_LOCAL, "direct_opener", None)
    if opener is None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        _THREAD_LOCAL.direct_opener = opener
    return opener


def schedule_schema() -> dict[str, Any]:
    nullable_string = {"type": ["string", "null"]}
    return {
        "anyOf": [
            {"type": "null"},
            {
                "type": "object",
                "additionalProperties": False,
                "required": sorted(_REQUIRED_FIELDS),
                "properties": {
                    "title": {"type": "string"},
                    "event_type": {"type": "string", "enum": ["once", "daily", "weekly", "monthly", "yearly"]},
                    "start_date": {"type": "string"},
                    "end_date": nullable_string,
                    "color": nullable_string,
                    "spanning": {"type": "boolean"},
                    "start_time": nullable_string,
                    "end_time": nullable_string,
                    "is_all_day": {"type": "boolean"},
                    "description": nullable_string,
                    "location": nullable_string,
                    "category": {"type": "string", "enum": sorted(_CATEGORIES)},
                    "detail": nullable_string,
                    "status": nullable_string,
                    "reminder_minutes": {"type": ["integer", "null"]},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "needs_clarification": {"type": "boolean"},
                    "clarification_question": nullable_string,
                },
            },
        ]
    }


def build_payload(
    *,
    model: str,
    prompt: str,
    text: str,
    num_ctx: int,
    max_tokens: int,
    keep_alive: str,
    format_mode: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": "/no_think\n" + prompt},
            {"role": "user", "content": text},
        ],
        "stream": False,
        "think": False,
        "keep_alive": keep_alive,
        "options": {
            "temperature": 0.1,
            "num_ctx": num_ctx,
            "num_predict": max_tokens,
        },
    }
    if format_mode == "json":
        payload["format"] = "json"
    elif format_mode == "schema":
        payload["format"] = schedule_schema()
    return payload


def extract_json(content: str) -> Any:
    stripped = content.strip()
    candidates = [stripped]
    block = _CODE_BLOCK_RE.search(stripped)
    if block:
        candidates.append(block.group(1).strip())
    brace_start = stripped.find("{")
    brace_end = stripped.rfind("}")
    if brace_start >= 0 and brace_end > brace_start:
        candidates.append(stripped[brace_start:brace_end + 1])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise ValueError("model response does not contain valid JSON")


def shape_issues(value: Any, contract: str = "full") -> list[str]:
    if value is None:
        return []
    if not isinstance(value, dict):
        return ["root_not_object_or_null"]
    issues = []
    required = _REQUIRED_FIELDS if contract == "full" else _COMPACT_REQUIRED_FIELDS
    missing = sorted(required - set(value))
    if missing:
        issues.append("missing_fields:" + ",".join(missing))
    if value.get("event_type") not in {"once", "daily", "weekly", "monthly", "yearly"}:
        issues.append("invalid_event_type")
    if value.get("category") not in _CATEGORIES:
        issues.append("invalid_category")
    for field in ("spanning", "is_all_day", "needs_clarification"):
        if field in value and not isinstance(value[field], bool):
            issues.append(f"invalid_boolean:{field}")
    confidence = value.get("confidence")
    if confidence is not None and (
        not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1
    ):
        issues.append("invalid_confidence")
    return issues


def run_one(
    endpoint: str,
    sample: dict[str, str],
    prompt: str,
    model: str,
    num_ctx: int,
    max_tokens: int,
    keep_alive: str,
    format_mode: str,
    contract: str,
    timeout: float,
) -> dict[str, Any]:
    payload = build_payload(
        model=model,
        prompt=prompt,
        text=sample["text"],
        num_ctx=num_ctx,
        max_tokens=max_tokens,
        keep_alive=keep_alive,
        format_mode=format_mode,
    )
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/api/chat",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with direct_opener().open(request, timeout=timeout) as response:
        envelope = json.loads(response.read().decode("utf-8"))
    duration_ms = round((time.perf_counter() - started) * 1000)
    content = str((envelope.get("message") or {}).get("content") or "")
    try:
        parsed = extract_json(content)
        issues = shape_issues(parsed, contract)
        parse_error = None
    except Exception as exc:  # noqa: BLE001 - retain malformed output evidence.
        parsed = None
        issues = ["invalid_json"]
        parse_error = repr(exc)
    eval_count = int(envelope.get("eval_count") or 0)
    eval_duration = int(envelope.get("eval_duration") or 0)
    return {
        "id": sample["id"],
        "group": sample["group"],
        "text": sample["text"],
        "duration_ms": duration_ms,
        "passed": not issues,
        "issues": issues,
        "parse_error": parse_error,
        "result": parsed,
        "raw_content": content,
        "metrics": {
            "load_ms": round(int(envelope.get("load_duration") or 0) / 1_000_000, 3),
            "prompt_tokens": int(envelope.get("prompt_eval_count") or 0),
            "prompt_eval_ms": round(int(envelope.get("prompt_eval_duration") or 0) / 1_000_000, 3),
            "output_tokens": eval_count,
            "output_eval_ms": round(eval_duration / 1_000_000, 3),
            "output_tokens_per_second": round(eval_count / (eval_duration / 1_000_000_000), 2)
            if eval_count and eval_duration else 0,
        },
        "error": None,
    }


def failed_row(sample: dict[str, str], exc: Exception) -> dict[str, Any]:
    return {
        "id": sample["id"],
        "group": sample["group"],
        "text": sample["text"],
        "duration_ms": 0,
        "passed": False,
        "issues": ["request_error"],
        "parse_error": None,
        "result": None,
        "raw_content": "",
        "metrics": {},
        "error": repr(exc),
    }


def source_ids(path: Path, parse_source: str) -> set[str]:
    report = json.loads(path.read_text(encoding="utf-8"))
    return {
        str(row["id"])
        for row in report.get("rows", [])
        if row.get("parse_source") == parse_source
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--source-report", type=Path, required=True)
    parser.add_argument("--parse-source", default="local_llm")
    parser.add_argument("--prompt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:21434")
    parser.add_argument("--model", default="qwen3:8b")
    parser.add_argument("--num-ctx", type=int, default=8192)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--keep-alive", default="15m")
    parser.add_argument("--format", choices=("none", "json", "schema"), default="none", dest="format_mode")
    parser.add_argument("--contract", choices=("full", "compact"), default="full")
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--samples-per-group", type=int, default=3)
    parser.add_argument("--sample-seed", type=int, default=20260714)
    parser.add_argument("--case", action="append", dest="case_ids")
    args = parser.parse_args()

    if args.concurrency < 1 or args.repeats < 1 or args.samples_per_group < 1:
        parser.error("concurrency, repeats, and samples-per-group must be positive")
    if args.timeout <= 0 or args.num_ctx < 1024 or args.max_tokens < 1:
        parser.error("timeout, context, and token limits must be positive")

    allowed_ids = source_ids(args.source_report, args.parse_source)
    selected_ids = set(args.case_ids or [])
    samples = [
        sample for sample in load_samples(args.input)
        if sample["id"] in allowed_ids and (not selected_ids or sample["id"] in selected_ids)
    ]
    samples = stratified_sample(samples, args.samples_per_group, args.sample_seed)
    if not samples:
        parser.error("no model-path schedule samples selected")

    prompt = args.prompt.read_text(encoding="utf-8")
    rows = []
    wave_durations = []
    for repeat in range(1, args.repeats + 1):
        wave_started = time.perf_counter()
        indexed_rows = []
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(args.concurrency, len(samples)),
            thread_name_prefix="schedule-llm-benchmark",
        ) as executor:
            futures = {
                executor.submit(
                    run_one,
                    args.endpoint,
                    sample,
                    prompt,
                    args.model,
                    args.num_ctx,
                    args.max_tokens,
                    args.keep_alive,
                    args.format_mode,
                    args.contract,
                    args.timeout,
                ): (index, sample)
                for index, sample in enumerate(samples, 1)
            }
            for future in concurrent.futures.as_completed(futures):
                index, sample = futures[future]
                try:
                    row = future.result()
                except Exception as exc:  # noqa: BLE001 - preserve benchmark evidence.
                    row = failed_row(sample, exc)
                row.update({"repeat": repeat, "case_index": index, "concurrency": args.concurrency})
                indexed_rows.append((index, row))
                print(
                    json.dumps(
                        {key: row.get(key) for key in ("repeat", "id", "passed", "duration_ms", "issues", "metrics", "error")},
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
        rows.extend(row for _, row in sorted(indexed_rows, key=lambda item: item[0]))
        wave_durations.append(round((time.perf_counter() - wave_started) * 1000))

    durations = [row["duration_ms"] for row in rows if row["duration_ms"] > 0]
    output_tokens = [row.get("metrics", {}).get("output_tokens", 0) for row in rows]
    output_rates = [row.get("metrics", {}).get("output_tokens_per_second", 0) for row in rows]
    passed = sum(row["passed"] for row in rows)
    report = {
        "endpoint": args.endpoint,
        "model": args.model,
        "format": args.format_mode,
        "contract": args.contract,
        "num_ctx": args.num_ctx,
        "max_tokens": args.max_tokens,
        "keep_alive": args.keep_alive,
        "input": str(args.input),
        "source_report": str(args.source_report),
        "parse_source": args.parse_source,
        "sample_seed": args.sample_seed,
        "samples_per_group": args.samples_per_group,
        "sample_ids": [sample["id"] for sample in samples],
        "concurrency": args.concurrency,
        "repeats": args.repeats,
        "total": len(rows),
        "passed": passed,
        "duration_ms": duration_summary(durations),
        "wave_wall_ms": duration_summary(wave_durations),
        "throughput_per_second": round(len(rows) / (sum(wave_durations) / 1000), 3),
        "output_tokens": duration_summary(output_tokens),
        "output_tokens_per_second": {
            "min": min(output_rates) if output_rates else 0,
            "median": statistics.median(output_rates) if output_rates else 0,
            "max": max(output_rates) if output_rates else 0,
        },
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {key: report[key] for key in ("total", "passed", "duration_ms", "wave_wall_ms", "throughput_per_second", "output_tokens")},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if passed == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
