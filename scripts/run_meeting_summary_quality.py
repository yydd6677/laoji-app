#!/usr/bin/env python3
"""Run structured meeting-summary quality cases through the public guest flow."""

from __future__ import annotations

import argparse
import json
import re
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
NEGATED_OUTCOME_OVERVIEW_RE = re.compile(
    r"(?:未|没有|无)(?:形成|产生|确认|达成)[^。；;]{0,16}"
    r"(?:业务结论|结论|决策|行动项|行动安排)|"
    r"(?:所有|全部)[^。；;]{0,12}(?:讨论|内容)[^。；;]{0,12}"
    r"(?:未形成|无)[^。；;]{0,10}(?:结论|决策|行动项)"
)


def request_json(url: str, *, payload: dict[str, Any] | None = None, timeout: float = 60) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    try:
        with DIRECT_OPENER.open(request, timeout=timeout) as response:
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
) -> dict[str, Any]:
    lines = build_lines(case)
    started = time.perf_counter()
    submitted = request_json(
        f"{base_url}/api/laoji/meetings/guest-summary",
        payload={
            "meeting_id": f"quality-{case['id'].lower()}",
            "title": case["title"],
            "meeting_date": meeting_date,
            "transcript_lines": lines,
        },
        timeout=timeout,
    )
    task_id = submitted["task_id"]
    while True:
        status = request_json(f"{base_url}/api/laoji/meetings/guest-summary/tasks/{task_id}", timeout=timeout)
        state = status.get("status")
        if state == "SUCCESS":
            result = status.get("result") or {}
            issues = evaluate(result, case.get("expect", {}))
            return {
                "id": case["id"],
                "title": case["title"],
                "tier": case.get("tier", "core"),
                "transcript_lines": len(lines),
                "transcript_chars": sum(len(line["text"]) for line in lines),
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "passed": not issues,
                "issues": issues,
                "result": result,
                "error": None,
            }
        if state == "FAILURE":
            raise RuntimeError(str(status.get("result") or "summary failed"))
        if time.perf_counter() - started > timeout:
            raise TimeoutError(f"summary task exceeded {timeout}s")
        time.sleep(poll_interval)


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# LaoJi Meeting Summary Quality",
        "",
        f"- Endpoint: `{report['endpoint']}`",
        f"- Passed: {report['passed']}/{report['total']}",
        f"- Duration ms: `{report['duration_ms']}`",
        "",
    ]
    for row in report["rows"]:
        lines.extend([
            f"## {row['id']} {row['title']}",
            f"- Result: {'PASS' if row['passed'] else 'FAIL'}",
            f"- Duration: {row['duration_ms']} ms",
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
    parser.add_argument("--poll-interval", type=float, default=1)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    selected = set(args.case_ids or [])
    cases = [
        case for case in manifest["cases"]
        if (not selected or case["id"] in selected)
        and (args.include_extended or case.get("tier", "core") != "extended")
    ]
    rows = []
    for index, case in enumerate(cases, 1):
        print(f"[{index}/{len(cases)}] {case['id']} {case['title']}", flush=True)
        try:
            row = run_case(
                args.endpoint.rstrip("/"),
                case,
                manifest["meeting_date"],
                args.timeout,
                args.poll_interval,
            )
        except Exception as exc:  # noqa: BLE001 - preserve quality evidence.
            row = {
                "id": case["id"], "title": case["title"], "tier": case.get("tier", "core"),
                "duration_ms": 0, "passed": False, "issues": ["runtime_error"],
                "result": None, "error": repr(exc),
            }
        print(json.dumps({key: row[key] for key in ("id", "passed", "duration_ms", "issues", "error")}, ensure_ascii=False), flush=True)
        rows.append(row)

    durations = [row["duration_ms"] for row in rows if row["duration_ms"] > 0]
    report = {
        "endpoint": args.endpoint,
        "manifest": str(args.manifest),
        "total": len(rows),
        "passed": sum(row["passed"] for row in rows),
        "duration_ms": {
            "min": min(durations) if durations else 0,
            "median": statistics.median(durations) if durations else 0,
            "max": max(durations) if durations else 0,
            "total": sum(durations),
        },
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(report, args.output.with_suffix(".md"))
    print(json.dumps({key: report[key] for key in ("total", "passed", "duration_ms")}, ensure_ascii=False, indent=2))
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
