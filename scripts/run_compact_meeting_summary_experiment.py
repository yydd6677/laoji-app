#!/usr/bin/env python3
"""Benchmark the compact App summary contract directly against Ollama."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import re
import statistics
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from run_meeting_summary_quality import build_lines, evaluate, percentile


_THREAD_LOCAL = threading.local()
NEGATED_ACTION_RE = re.compile(
    r"(不再执行|无需执行|不需要执行|不用执行|不再负责|不予执行|"
    r"不建立行动项|没有新的行动项|无新的行动项)"
)
RECURRING_DUE_RE = re.compile(
    r"((?:从[^，。；;]{0,10}开始[，,]?)?"
    r"(?:每(?:周|星期|礼拜)[一二三四五六日天1-7]|每天|每日)"
    r"(?:[^，。；;]{0,10}?(?:前|之前))?)"
)
MISSING_VALUES = {"", "n/a", "na", "none", "null", "tbd", "待定", "未定"}
STRONG_DECISION_RE = re.compile(r"(最终决定|最终以|最终就按|先保留现状|就这样)")
NEGATED_DECISION_RE = re.compile(
    r"(不决定|暂不决定|没有决策|无决策|未形成(?:新)?决策|不是[^。；;]{0,12}决策)"
)


def direct_opener() -> urllib.request.OpenerDirector:
    opener = getattr(_THREAD_LOCAL, "direct_opener", None)
    if opener is None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        _THREAD_LOCAL.direct_opener = opener
    return opener


def build_input(case: dict[str, Any], meeting_date: str) -> str:
    transcript = "\n".join(
        f"{line['speaker_label']}：{line['text']}" for line in build_lines(case)
    )
    return (
        f"【会议上下文】\n会议标题：{case['title']}\n"
        f"会议日期：{meeting_date}。相对日期以该日期为准。\n\n"
        f"【会议转写】\n{transcript}"
    )


def fallback_decisions(transcript_text: str) -> list[str]:
    for line in transcript_text.splitlines():
        if (
            not line.strip()
            or line.startswith("【")
            or line.startswith("会议标题：")
            or line.startswith("会议日期：")
        ):
            continue
        for sentence in re.split(r"[。！？!?]", line):
            cleaned = re.sub(r"^[^：:]{1,24}[：:]", "", sentence).strip()
            marker = STRONG_DECISION_RE.search(cleaned)
            if not marker:
                continue
            if NEGATED_DECISION_RE.search(cleaned) and marker.group(1) != "先保留现状":
                continue
            if marker.group(1) == "先保留现状":
                cleaned = cleaned[marker.start():]
            return [cleaned] if cleaned else []
    return []


def normalize_result(raw: dict[str, Any], transcript_text: str) -> dict[str, Any]:
    decisions = raw.get("key_decisions") or []
    if not decisions:
        decisions = fallback_decisions(transcript_text)

    actions = []
    for action in raw.get("action_items") or []:
        content = str(action.get("content") or action.get("task") or "").strip()
        if not content or NEGATED_ACTION_RE.search(content):
            continue
        assignee = action.get("assignee")
        due = action.get("due_date") or action.get("due") or action.get("deadline")
        recurring = RECURRING_DUE_RE.search(content)
        if recurring:
            due = recurring.group(1)
        placeholder = (
            re.search(r"确定.*负责人", content)
            and str(assignee).strip().lower() in MISSING_VALUES
            and str(due).strip().lower() in MISSING_VALUES
            and (
                re.search(r"负责人[^。；;]{0,12}(?:稍后|以后|后续)再定", transcript_text)
                or re.search(r"只形成[^。；;]{0,16}决策", transcript_text)
            )
        )
        if placeholder:
            continue
        actions.append({"content": content, "assignee": assignee, "due_date": due})

    return {
        "overview": str(raw.get("overview") or "").strip(),
        "key_decisions": [str(item).strip() for item in decisions if str(item).strip()],
        "action_items": actions,
    }


def select_cases(
    manifest: dict[str, Any],
    selected: set[str],
    include_extended: bool,
) -> list[dict[str, Any]]:
    return [
        case for case in manifest["cases"]
        if (include_extended or case.get("tier", "core") != "extended")
        and (not selected or case["id"] in selected)
    ]


def summarize_metric(
    rows: list[dict[str, Any]],
    key: str,
    *,
    divisor: float = 1.0,
) -> dict[str, float | int]:
    values = [
        float(row.get("metrics", {}).get(key)) / divisor
        for row in rows
        if isinstance(row.get("metrics", {}).get(key), (int, float))
        and not isinstance(row.get("metrics", {}).get(key), bool)
    ]
    if not values:
        return {"samples": 0, "total": 0, "mean": 0, "median": 0, "p95": 0, "max": 0}
    p95 = percentile(values, 0.95)
    return {
        "samples": len(values),
        "total": round(sum(values), 3),
        "mean": round(statistics.mean(values), 3),
        "median": round(statistics.median(values), 3),
        "p95": round(p95, 3) if p95 is not None else 0,
        "max": round(max(values), 3),
    }


def run_case(
    endpoint: str,
    prompt: str,
    case: dict[str, Any],
    meeting_date: str,
    model: str,
    num_ctx: int,
    max_tokens: int,
    keep_alive: str,
) -> dict[str, Any]:
    transcript_text = build_input(case, meeting_date)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "/no_think\n" + prompt},
            {"role": "user", "content": transcript_text},
        ],
        "stream": False,
        "think": False,
        "format": "json",
        "keep_alive": keep_alive,
        "options": {
            "temperature": 0.1,
            "num_ctx": num_ctx,
            "num_predict": max_tokens,
        },
    }
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/api/chat",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with direct_opener().open(request, timeout=120) as response:
        envelope = json.loads(response.read().decode("utf-8"))
    duration_ms = round((time.perf_counter() - started) * 1000)
    raw = json.loads(envelope["message"]["content"])
    result = normalize_result(raw, transcript_text)
    issues = evaluate(result, case.get("expect", {}))
    return {
        "id": case["id"],
        "title": case["title"],
        "passed": not issues,
        "issues": issues,
        "duration_ms": duration_ms,
        "transcript_chars": len(transcript_text),
        "metrics": {
            key: envelope.get(key)
            for key in (
                "load_duration",
                "prompt_eval_count",
                "prompt_eval_duration",
                "eval_count",
                "eval_duration",
            )
        },
        "raw": raw,
        "result": result,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--prompt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:21434")
    parser.add_argument("--model", default="qwen3:8b")
    parser.add_argument("--num-ctx", type=int, default=2048)
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--keep-alive", default="60s")
    parser.add_argument("--case", action="append", dest="case_ids")
    parser.add_argument("--include-extended", action="store_true")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--max-case-ms", type=float, default=0)
    parser.add_argument("--max-p95-ms", type=float, default=0)
    parser.add_argument("--max-wave-ms", type=float, default=0)
    args = parser.parse_args()

    if args.concurrency < 1:
        parser.error("--concurrency must be positive")
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    if args.max_case_ms < 0 or args.max_p95_ms < 0 or args.max_wave_ms < 0:
        parser.error("latency budgets must be non-negative")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    prompt = args.prompt.read_text(encoding="utf-8")
    selected = set(args.case_ids or [])
    cases = select_cases(manifest, selected, args.include_extended)
    if not cases:
        parser.error("no meeting-summary cases selected")
    rows = []
    wave_durations = []
    for repeat in range(1, args.repeats + 1):
        wave_started = time.perf_counter()
        indexed_rows = []
        with ThreadPoolExecutor(
            max_workers=min(args.concurrency, len(cases)),
            thread_name_prefix="compact-summary-experiment",
        ) as executor:
            futures = {
                executor.submit(
                    run_case,
                    args.endpoint,
                    prompt,
                    case,
                    manifest["meeting_date"],
                    args.model,
                    args.num_ctx,
                    args.max_tokens,
                    args.keep_alive,
                ): (index, case)
                for index, case in enumerate(cases, 1)
            }
            for future in as_completed(futures):
                index, case = futures[future]
                try:
                    row = future.result()
                except Exception as exc:  # noqa: BLE001 - preserve experiment evidence.
                    row = {
                        "id": case["id"],
                        "title": case["title"],
                        "passed": False,
                        "issues": ["runtime_error"],
                        "duration_ms": 0,
                        "error": repr(exc),
                        "metrics": {},
                        "result": None,
                    }
                row["repeat"] = repeat
                row["case_index"] = index
                row["concurrency"] = args.concurrency
                if args.max_case_ms > 0 and row["duration_ms"] > args.max_case_ms:
                    row["issues"].append(
                        f"duration_ms:{row['duration_ms']}>{args.max_case_ms:g}"
                    )
                    row["passed"] = False
                indexed_rows.append((index, row))
                print(
                    json.dumps(
                        {
                            "repeat": repeat,
                            "index": index,
                            "id": row["id"],
                            "passed": row["passed"],
                            "issues": row["issues"],
                            "duration_ms": row["duration_ms"],
                            "metrics": row.get("metrics", {}),
                            "error": row.get("error"),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
        rows.extend(row for _, row in sorted(indexed_rows, key=lambda item: item[0]))
        wave_durations.append(round((time.perf_counter() - wave_started) * 1000))

    durations = [row["duration_ms"] for row in rows if row["duration_ms"] > 0]
    duration_p95 = percentile(durations, 0.95)
    gate_issues = [
        f"repeat_{index}_wave_ms:{duration}>{args.max_wave_ms:g}"
        for index, duration in enumerate(wave_durations, 1)
        if args.max_wave_ms > 0 and duration > args.max_wave_ms
    ]
    if args.max_p95_ms > 0 and duration_p95 is not None and duration_p95 > args.max_p95_ms:
        gate_issues.append(f"p95_ms:{duration_p95:.1f}>{args.max_p95_ms:g}")
    passed_count = sum(row["passed"] for row in rows)
    gate_passed = passed_count == len(rows) and not gate_issues
    report = {
        "endpoint": args.endpoint,
        "model": args.model,
        "num_ctx": args.num_ctx,
        "max_tokens": args.max_tokens,
        "keep_alive": args.keep_alive,
        "concurrency": args.concurrency,
        "repeats": args.repeats,
        "budgets": {
            "max_case_ms": args.max_case_ms or None,
            "max_p95_ms": args.max_p95_ms or None,
            "max_wave_ms": args.max_wave_ms or None,
        },
        "total": len(rows),
        "passed": passed_count,
        "gate_passed": gate_passed,
        "gate_issues": gate_issues,
        "duration_ms": {
            "min": min(durations) if durations else 0,
            "mean": round(statistics.mean(durations), 1) if durations else 0,
            "median": statistics.median(durations) if durations else 0,
            "p95": round(duration_p95, 1) if duration_p95 is not None else 0,
            "max": max(durations) if durations else 0,
            "total": sum(durations),
        },
        "wave_wall_ms": {
            "min": min(wave_durations),
            "median": statistics.median(wave_durations),
            "max": max(wave_durations),
            "total": sum(wave_durations),
        },
        "throughput_per_second": round(
            len(rows) / (sum(wave_durations) / 1000), 3
        ) if sum(wave_durations) > 0 else 0,
        "model_metrics": {
            "prompt_tokens": summarize_metric(rows, "prompt_eval_count"),
            "output_tokens": summarize_metric(rows, "eval_count"),
            "load_ms": summarize_metric(rows, "load_duration", divisor=1_000_000),
            "prompt_eval_ms": summarize_metric(
                rows, "prompt_eval_duration", divisor=1_000_000
            ),
            "decode_ms": summarize_metric(rows, "eval_duration", divisor=1_000_000),
            "wall_output_tokens_per_second": round(
                sum(
                    float(row.get("metrics", {}).get("eval_count", 0))
                    for row in rows
                    if isinstance(row.get("metrics", {}).get("eval_count"), (int, float))
                )
                / (sum(wave_durations) / 1000),
                3,
            ) if sum(wave_durations) > 0 else 0,
        },
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                key: report[key]
                for key in (
                    "total",
                    "passed",
                    "gate_passed",
                    "gate_issues",
                    "duration_ms",
                    "wave_wall_ms",
                    "throughput_per_second",
                    "model_metrics",
                )
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
