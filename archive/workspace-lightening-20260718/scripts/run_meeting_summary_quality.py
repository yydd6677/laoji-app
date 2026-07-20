#!/usr/bin/env python3
"""Run structured meeting-summary quality cases through the public guest flow."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import re
import statistics
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


_THREAD_LOCAL = threading.local()
NEGATED_OUTCOME_OVERVIEW_RE = re.compile(
    r"(?:未|没有|无)(?:形成|产生|确认|达成)[^。；;]{0,16}"
    r"(?:业务结论|结论|决策|行动项|行动安排)|"
    r"(?:所有|全部)[^。；;]{0,12}(?:讨论|内容)[^。；;]{0,12}"
    r"(?:未形成|无)[^。；;]{0,10}(?:结论|决策|行动项)"
)


def direct_opener() -> urllib.request.OpenerDirector:
    opener = getattr(_THREAD_LOCAL, "direct_opener", None)
    if opener is None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        _THREAD_LOCAL.direct_opener = opener
    return opener


def request_json(url: str, *, payload: dict[str, Any] | None = None, timeout: float = 60) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    try:
        with direct_opener().open(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail[:500]}") from exc


def contains_all(value: Any, terms: list[str]) -> bool:
    text = json.dumps(value, ensure_ascii=False).lower()
    return all(term.lower() in text for term in terms)


def contains_any(value: Any, terms: list[str]) -> bool:
    text = json.dumps(value, ensure_ascii=False).lower()
    return any(term.lower() in text for term in terms)


def build_lines(case: dict[str, Any]) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []

    def append_line(speaker: str, text: str) -> None:
        cleaned = re.sub(
            rf"^{re.escape(speaker)}[：:]\s*",
            "",
            str(text).strip(),
        )
        index = len(lines)
        lines.append({
            "speaker_label": speaker,
            "text": cleaned,
            "start_time": float(index * 8),
            "end_time": float(index * 8 + 7),
            "confidence": 0.98,
        })

    def append_generated(block: dict[str, Any]) -> None:
        start_index = int(block.get("start_index", 1))
        speaker_template = block.get("speaker_template", "成员{index}")
        text_template = block.get("text_template", block.get("template", ""))
        for offset in range(int(block["count"])):
            index = start_index + offset
            append_line(
                str(speaker_template).format(index=index),
                str(text_template).format(index=index),
            )

    timeline = case.get("timeline")
    if timeline:
        for entry in timeline:
            if "generated" in entry:
                append_generated(entry["generated"])
            else:
                append_line(entry["speaker"], entry["text"])
        return lines

    generated = case.get("generated_context")
    if generated:
        append_generated(generated)
    for line in case["transcript"]:
        append_line(line["speaker"], line["text"])
    return lines


def transcript_char_count(case: dict[str, Any]) -> int:
    return sum(len(line["text"]) for line in build_lines(case))


def cases_below_minimum_chars(
    cases: list[dict[str, Any]],
    minimum: int,
) -> list[tuple[str, int]]:
    if minimum <= 0:
        return []
    return [
        (str(case["id"]), count)
        for case in cases
        if (count := transcript_char_count(case)) < minimum
    ]


def evaluate(result: dict[str, Any], expected: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    decisions = result.get("key_decisions") or []
    actions = result.get("action_items") or []
    overview = result.get("overview") or result.get("full_text") or ""

    if (decisions or actions) and NEGATED_OUTCOME_OVERVIEW_RE.search(str(overview)):
        issues.append("overview_contradicts_structured_outcomes")

    for group in expected.get("overview_groups", []):
        if not contains_all(overview, group):
            issues.append(f"overview_missing:{'+'.join(group)}")
    for group in expected.get("overview_forbidden_groups", []):
        if contains_all(overview, group):
            issues.append(f"overview_forbidden:{'+'.join(group)}")
    for group in expected.get("decision_groups", []):
        if not contains_all(decisions, group):
            issues.append(f"decision_missing:{'+'.join(group)}")
    for group in expected.get("decision_forbidden_groups", []):
        if contains_all(decisions, group):
            issues.append(f"decision_forbidden:{'+'.join(group)}")
    if len(decisions) < expected.get("min_decisions", 0):
        issues.append(f"too_few_decisions:{len(decisions)}")
    if len(decisions) > expected.get("max_decisions", 10_000):
        issues.append(f"too_many_decisions:{len(decisions)}")
    if len(actions) < expected.get("min_actions", 0):
        issues.append(f"too_few_actions:{len(actions)}")
    if len(actions) > expected.get("max_actions", 10_000):
        issues.append(f"too_many_actions:{len(actions)}")
    for group in expected.get("action_forbidden_groups", []):
        if contains_all(actions, group):
            issues.append(f"action_forbidden:{'+'.join(group)}")

    for requirement in expected.get("actions", []):
        matches = [action for action in actions if contains_all(action.get("content", ""), requirement.get("content_all", []))]
        if not matches:
            issues.append(f"action_missing:{'+'.join(requirement.get('content_all', []))}")
            continue
        match = matches[0]
        if requirement.get("assignee_any") and not contains_any(match.get("assignee"), requirement["assignee_any"]):
            issues.append(f"action_assignee:{'+'.join(requirement['content_all'])}")
        if requirement.get("due_any") and not contains_any(match.get("due_date"), requirement["due_any"]):
            issues.append(f"action_due:{'+'.join(requirement['content_all'])}")
        if requirement.get("assignee_forbidden") and contains_any(match.get("assignee"), requirement["assignee_forbidden"]):
            issues.append(f"action_assignee_forbidden:{'+'.join(requirement['content_all'])}")
        if requirement.get("due_forbidden") and contains_any(match.get("due_date"), requirement["due_forbidden"]):
            issues.append(f"action_due_forbidden:{'+'.join(requirement['content_all'])}")
    return issues


def run_case(
    base_url: str,
    case: dict[str, Any],
    meeting_date: str,
    timeout: float,
    poll_interval: float,
    wait_ms: int = 0,
    force: bool = False,
    run_label: str | None = None,
    require_fresh: bool = False,
) -> dict[str, Any]:
    lines = build_lines(case)
    started = time.perf_counter()
    meeting_id = f"quality-{case['id'].lower()}"
    if run_label:
        meeting_id = f"{meeting_id}-{run_label}"
    submit_started = time.perf_counter()
    submitted = request_json(
        f"{base_url}/api/laoji/meetings/guest-summary",
        payload={
            "meeting_id": meeting_id,
            "title": case["title"],
            "meeting_date": meeting_date,
            "force": force,
            "transcript_lines": lines,
        },
        timeout=timeout,
    )
    submit_duration_ms = round((time.perf_counter() - submit_started) * 1000, 1)
    task_id = submitted["task_id"]
    submitted_reused = submitted.get("reused")
    observed_states: list[str] = []
    poll_requests = 0
    first_started_ms: float | None = None
    while True:
        effective_wait_ms = 0 if wait_ms > 0 and poll_requests == 0 else wait_ms
        status = request_json(
            f"{base_url}/api/laoji/meetings/guest-summary/tasks/{task_id}?wait_ms={effective_wait_ms}",
            timeout=timeout,
        )
        poll_requests += 1
        state = status.get("status")
        if isinstance(state, str) and (not observed_states or observed_states[-1] != state):
            observed_states.append(state)
        if state == "STARTED" and first_started_ms is None:
            first_started_ms = round((time.perf_counter() - started) * 1000, 1)
        if state == "SUCCESS":
            result = status.get("result") or {}
            issues = evaluate(result, case.get("expect", {}))
            if require_fresh and submitted_reused is not False:
                issues.append(
                    "task_reused" if submitted_reused is True else "task_freshness_unconfirmed"
                )
            return {
                "id": case["id"],
                "title": case["title"],
                "tier": case.get("tier", "core"),
                "meeting_id": meeting_id,
                "task_id": task_id,
                "transcript_lines": len(lines),
                "transcript_chars": sum(len(line["text"]) for line in lines),
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "submit_duration_ms": submit_duration_ms,
                "first_started_ms": first_started_ms,
                "poll_requests": poll_requests,
                "observed_states": observed_states,
                "reused": submitted_reused,
                "passed": not issues,
                "issues": issues,
                "result": result,
                "error": None,
            }
        if state == "FAILURE":
            raise RuntimeError(str(status.get("result") or "summary failed"))
        if time.perf_counter() - started > timeout:
            raise TimeoutError(f"summary task exceeded {timeout}s")
        if not (wait_ms > 0 and status.get("long_poll_supported") is True):
            time.sleep(poll_interval)


def percentile(values: list[float | int], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def run_case_safely(
    base_url: str,
    case: dict[str, Any],
    meeting_date: str,
    timeout: float,
    poll_interval: float,
    wait_ms: int,
    force: bool,
    run_label: str,
    require_fresh: bool,
) -> dict[str, Any]:
    try:
        return run_case(
            base_url,
            case,
            meeting_date,
            timeout,
            poll_interval,
            wait_ms,
            force,
            run_label,
            require_fresh,
        )
    except Exception as exc:  # noqa: BLE001 - preserve quality evidence.
        return {
            "id": case["id"],
            "title": case["title"],
            "tier": case.get("tier", "core"),
            "duration_ms": 0,
            "passed": False,
            "issues": ["runtime_error"],
            "result": None,
            "error": repr(exc),
        }


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# LaoJi Meeting Summary Quality",
        "",
        f"- Endpoint: `{report['endpoint']}`",
        f"- Passed: {report['passed']}/{report['total']}",
        f"- Gate passed: `{report['gate_passed']}`",
        f"- Gate issues: `{report['gate_issues']}`",
        f"- Concurrency: `{report['concurrency']}`",
        f"- Repeats: `{report['repeats']}`",
        f"- Duration ms: `{report['duration_ms']}`",
        f"- Wave wall ms: `{report['wave_wall_ms']}`",
        f"- Status requests: `{report['status_requests']}`",
        "",
    ]
    for row in report["rows"]:
        lines.extend([
            f"## Repeat {row.get('repeat', 1)} - {row['id']} {row['title']}",
            f"- Result: {'PASS' if row['passed'] else 'FAIL'}",
            f"- Duration: {row['duration_ms']} ms",
            f"- Submit: {row.get('submit_duration_ms')} ms",
            f"- Transcript chars: {row.get('transcript_chars')}",
            f"- First started: {row.get('first_started_ms')} ms",
            f"- States: `{row.get('observed_states', [])}`",
            f"- Reused: `{row.get('reused')}`",
            f"- Issues: `{row['issues']}`",
            f"- Decisions: `{json.dumps((row.get('result') or {}).get('key_decisions', []), ensure_ascii=False)}`",
            f"- Actions: `{json.dumps((row.get('result') or {}).get('action_items', []), ensure_ascii=False)}`",
            "",
        ])
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("test-assets/meeting-summary-quality/manifest.json"))
    parser.add_argument("--endpoint", default="http://127.0.0.1:18020")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", action="append", dest="case_ids")
    parser.add_argument("--include-extended", action="store_true")
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--poll-interval", type=float, default=0.1)
    parser.add_argument("--wait-ms", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--max-case-ms", type=float, default=0)
    parser.add_argument("--max-p95-ms", type=float, default=0)
    parser.add_argument("--max-wave-ms", type=float, default=0)
    parser.add_argument("--max-status-requests-per-case", type=int, default=0)
    parser.add_argument(
        "--min-transcript-chars",
        type=int,
        default=0,
        help="reject selected cases that do not meet the requested transcript length",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="force a fresh summary task instead of accepting a successful replay",
    )
    parser.add_argument(
        "--require-fresh",
        action="store_true",
        help="fail if the server does not explicitly confirm reused=false",
    )
    args = parser.parse_args()

    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.poll_interval < 0:
        parser.error("--poll-interval must be non-negative")
    if args.wait_ms < 0 or args.wait_ms > 5000:
        parser.error("--wait-ms must be between 0 and 5000")
    if args.concurrency < 1:
        parser.error("--concurrency must be positive")
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    if any(value < 0 for value in (
        args.max_case_ms,
        args.max_p95_ms,
        args.max_wave_ms,
        args.max_status_requests_per_case,
        args.min_transcript_chars,
    )):
        parser.error("latency budgets must be non-negative")
    if args.require_fresh and not args.force:
        parser.error("--require-fresh also requires --force")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    selected = set(args.case_ids or [])
    cases = [
        case for case in manifest["cases"]
        if (not selected or case["id"] in selected)
        and (args.include_extended or case.get("tier", "core") != "extended")
    ]
    if not cases:
        parser.error("no meeting-summary cases selected")
    short_cases = cases_below_minimum_chars(cases, args.min_transcript_chars)
    if short_cases:
        details = ", ".join(f"{case_id}={count}" for case_id, count in short_cases)
        parser.error(
            f"selected cases below --min-transcript-chars={args.min_transcript_chars}: "
            f"{details}"
        )

    run_id = uuid.uuid4().hex[:10]
    rows = []
    wave_durations = []
    gate_issues: list[str] = []
    for repeat in range(1, args.repeats + 1):
        wave_started = time.perf_counter()
        indexed_rows: list[tuple[int, dict[str, Any]]] = []
        with ThreadPoolExecutor(
            max_workers=min(args.concurrency, len(cases)),
            thread_name_prefix="summary-quality",
        ) as executor:
            futures = {
                executor.submit(
                    run_case_safely,
                    args.endpoint.rstrip("/"),
                    case,
                    manifest["meeting_date"],
                    args.timeout,
                    args.poll_interval,
                    args.wait_ms,
                    args.force,
                    f"{run_id}-r{repeat}-c{index}",
                    args.require_fresh,
                ): (index, case)
                for index, case in enumerate(cases, 1)
            }
            for future in as_completed(futures):
                index, case = futures[future]
                row = future.result()
                row["repeat"] = repeat
                row["case_index"] = index
                row["concurrency"] = args.concurrency
                if args.max_case_ms > 0 and row["duration_ms"] > args.max_case_ms:
                    row["issues"].append(
                        f"duration_ms:{row['duration_ms']}>{args.max_case_ms:g}"
                    )
                    row["passed"] = False
                if (
                    args.max_status_requests_per_case > 0
                    and row.get("poll_requests", 0) > args.max_status_requests_per_case
                ):
                    row["issues"].append(
                        "status_requests:"
                        f"{row.get('poll_requests', 0)}>{args.max_status_requests_per_case}"
                    )
                    row["passed"] = False
                indexed_rows.append((index, row))
                print(
                    json.dumps(
                        {
                            "repeat": repeat,
                            "index": index,
                            "id": case["id"],
                            "passed": row["passed"],
                            "duration_ms": row["duration_ms"],
                            "first_started_ms": row.get("first_started_ms"),
                            "issues": row["issues"],
                            "error": row.get("error"),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
        rows.extend(row for _, row in sorted(indexed_rows, key=lambda item: item[0]))
        wave_duration = round((time.perf_counter() - wave_started) * 1000)
        wave_durations.append(wave_duration)
        print(
            json.dumps(
                {"repeat": repeat, "wave_duration_ms": wave_duration},
                ensure_ascii=False,
            ),
            flush=True,
        )
        if args.max_wave_ms > 0 and wave_duration > args.max_wave_ms:
            gate_issues.append(
                f"repeat_{repeat}_wave_ms:{wave_duration}>{args.max_wave_ms:g}"
            )

    durations = [row["duration_ms"] for row in rows if row["duration_ms"] > 0]
    status_requests = [row["poll_requests"] for row in rows if "poll_requests" in row]
    duration_p95 = percentile(durations, 0.95)
    if args.max_p95_ms > 0 and duration_p95 is not None and duration_p95 > args.max_p95_ms:
        gate_issues.append(f"p95_ms:{duration_p95:.1f}>{args.max_p95_ms:g}")
    passed_count = sum(row["passed"] for row in rows)
    gate_passed = passed_count == len(rows) and not gate_issues
    total_wave_ms = sum(wave_durations)
    report = {
        "endpoint": args.endpoint,
        "manifest": str(args.manifest),
        "run_id": run_id,
        "force": args.force,
        "require_fresh": args.require_fresh,
        "poll_interval_ms": round(args.poll_interval * 1000, 3),
        "wait_ms": args.wait_ms,
        "concurrency": args.concurrency,
        "repeats": args.repeats,
        "budgets": {
            "max_case_ms": args.max_case_ms or None,
            "max_p95_ms": args.max_p95_ms or None,
            "max_wave_ms": args.max_wave_ms or None,
            "max_status_requests_per_case": args.max_status_requests_per_case or None,
            "min_transcript_chars": args.min_transcript_chars or None,
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
            "total": total_wave_ms,
        },
        "status_requests": {
            "min": min(status_requests) if status_requests else 0,
            "mean": round(statistics.mean(status_requests), 2) if status_requests else 0,
            "median": statistics.median(status_requests) if status_requests else 0,
            "p95": round(percentile(status_requests, 0.95) or 0, 2),
            "max": max(status_requests) if status_requests else 0,
            "total": sum(status_requests),
        },
        "throughput_per_second": (
            round(len(rows) / (total_wave_ms / 1000), 3) if total_wave_ms > 0 else 0
        ),
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(report, args.output.with_suffix(".md"))
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
                    "status_requests",
                    "throughput_per_second",
                )
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
