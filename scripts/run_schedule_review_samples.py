#!/usr/bin/env python3
"""Run LaoJi review samples against a parse endpoint and flag likely issues."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import statistics
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


CATEGORY_HINTS = {
    "work": "工作",
    "study": "学习",
    "health": "健康",
    "life": "生活",
    "social": "社交",
    "travel": "出行",
    "finance": "财务",
    "important": "重要",
}

CORE_FIELDS = [
    "title",
    "event_type",
    "start_date",
    "end_date",
    "start_time",
    "end_time",
    "is_all_day",
    "category",
    "reminder_minutes",
    "needs_clarification",
    "clarification_question",
    "location",
    "parse_source",
]

COMPLEX_SIGNAL_RE = re.compile(
    r"(不是|不对|说错|改成|最终|最后|更正|纠正|别弄错|以后面的为准|后面的为准|"
    r"不要保存|不要真的|只是测试|只是举例|不是日程|先别自动|晚点补|还没定|没想好|如果冲突)"
)
TIME_RE = re.compile(
    r"([01]?\d|2[0-3])[:：][0-5]\d|"
    r"(凌晨|早上|上午|中午|下午|晚上|晚间)?[0-9一二两三四五六七八九十]{1,3}点"
)


def load_samples(path: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t", 5)
        if len(parts) != 6:
            raise ValueError(f"bad sample row: {line}")
        rows.append(
            {
                "id": parts[0],
                "group": parts[1],
                "category_hint": parts[2],
                "oral": parts[3],
                "noise": parts[4],
                "text": parts[5],
            }
        )
    return rows


def post_parse(endpoint: str, text: str, timeout: float) -> tuple[dict[str, Any] | None, str | None]:
    body = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8")
        return json.loads(payload), None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return None, f"HTTP {exc.code}: {detail[:300]}"
    except Exception as exc:  # noqa: BLE001 - diagnostics must keep going.
        return None, repr(exc)


def reminder_expected(text: str) -> int | None | str:
    if re.search(r"(不用提醒|不要提醒|无需提醒|不提醒)", text):
        return "none"
    if re.search(r"(开始时|到点|准时)提醒", text):
        return 0
    if "提前半小时提醒" in text:
        return 30
    exact = {
        "十": 10,
        "十五": 15,
        "二十": 20,
        "三十": 30,
        "两": 2,
        "二": 2,
        "一": 1,
    }
    match = re.search(r"提前([一二两三四五六七八九十十五二十三十0-9]{1,3})(分钟|小时|天)提醒", text)
    if not match:
        return None
    raw, unit = match.groups()
    value = int(raw) if raw.isdigit() else exact.get(raw)
    if value is None:
        return None
    if unit == "小时":
        value *= 60
    elif unit == "天":
        value *= 24 * 60
    return value


def issue_flags(sample: dict[str, str], parsed: dict[str, Any] | None, error: str | None, duration_ms: int) -> list[str]:
    flags: list[str] = []
    text = sample["text"]
    group = sample["group"]
    hint = sample["category_hint"]

    if error:
        flags.append("parse_error")
        return flags
    if parsed is None:
        flags.append("parse_null")
        return flags

    source = parsed.get("parse_source")
    needs_clarification = bool(parsed.get("needs_clarification"))
    category = parsed.get("category")
    event_type = parsed.get("event_type")
    reminder_minutes = parsed.get("reminder_minutes")

    expected_category = CATEGORY_HINTS.get(hint)
    if expected_category and category != expected_category:
        flags.append("category_mismatch")

    if group == "negative_or_control" and not needs_clarification:
        flags.append("negative_false_positive")

    if group == "ambiguous" and not needs_clarification:
        flags.append("ambiguous_no_clarification")

    if group == "date_range" and not parsed.get("end_date"):
        flags.append("date_range_missing_end_date")

    if group == "recurring" and event_type == "once":
        flags.append("recurring_as_once")

    if group == "deadline" and TIME_RE.search(text) and not parsed.get("start_time"):
        flags.append("deadline_time_missing")

    if COMPLEX_SIGNAL_RE.search(text) and source == "rules":
        flags.append("complex_swallowed_by_rules")

    expected_reminder = reminder_expected(text)
    if expected_reminder == "none" and reminder_minutes is not None:
        flags.append("no_reminder_not_respected")
    elif isinstance(expected_reminder, int) and reminder_minutes != expected_reminder:
        flags.append("reminder_mismatch")

    if duration_ms >= 3000:
        flags.append("slow_call")

    return flags


def run_one(sample: dict[str, str], endpoint: str, timeout: float) -> dict[str, Any]:
    started = time.perf_counter()
    parsed, error = post_parse(endpoint, sample["text"], timeout)
    duration_ms = round((time.perf_counter() - started) * 1000)
    core = {field: parsed.get(field) for field in CORE_FIELDS if parsed is not None}
    flags = issue_flags(sample, parsed, error, duration_ms)
    return {
        **sample,
        "duration_ms": duration_ms,
        "parse_source": parsed.get("parse_source") if parsed else None,
        "issues": flags,
        "error": error,
        "parsed": core,
    }


def write_markdown(report: dict[str, Any], output: Path) -> None:
    rows = report["rows"]
    issue_counts = Counter(issue for row in rows for issue in row["issues"])
    lines = [
        "# LaoJi Schedule Review Diagnostics v2",
        "",
        f"- Input: `{report['input']}`",
        f"- Endpoint: `{report['endpoint']}`",
        f"- Total: {report['total']}",
        f"- Rows with issues: {report['rows_with_issues']}",
        f"- Elapsed: {report['elapsed_ms']} ms",
        f"- Parse sources: `{report['parse_source_counts']}`",
        f"- Duration ms: `{report['duration_ms']}`",
        "",
        "## Issue Counts",
    ]
    for key, value in issue_counts.most_common():
        lines.append(f"- {key}: {value}")

    lines.extend(["", "## Group Issue Rates"])
    for group, stats in sorted(report["group_counts"].items()):
        rate = stats["issues"] / stats["total"] if stats["total"] else 0
        lines.append(f"- {group}: {stats['issues']}/{stats['total']} ({rate:.1%})")

    lines.extend(["", "## First 80 Issue Rows"])
    for row in [row for row in rows if row["issues"]][:80]:
        lines.extend(
            [
                f"### {row['id']} {row['group']}",
                f"- text: {row['text']}",
                f"- issues: `{row['issues']}`",
                f"- source: `{row['parse_source']}`, duration: `{row['duration_ms']} ms`",
                f"- parsed: `{json.dumps(row['parsed'], ensure_ascii=False)}`",
            ]
        )
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--endpoint", default="http://183.36.243.124:18035/api/laoji/parse")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    samples = load_samples(args.input)
    started = time.perf_counter()
    rows: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(run_one, sample, args.endpoint, args.timeout) for sample in samples]
        for future in concurrent.futures.as_completed(futures):
            rows.append(future.result())
    rows.sort(key=lambda item: item["id"])
    elapsed_ms = round((time.perf_counter() - started) * 1000)

    durations = [row["duration_ms"] for row in rows]
    group_counts: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "issues": 0})
    for row in rows:
        group_counts[row["group"]]["total"] += 1
        if row["issues"]:
            group_counts[row["group"]]["issues"] += 1

    report = {
        "input": str(args.input),
        "endpoint": args.endpoint,
        "total": len(rows),
        "rows_with_issues": sum(1 for row in rows if row["issues"]),
        "elapsed_ms": elapsed_ms,
        "parse_source_counts": dict(Counter(str(row["parse_source"]) for row in rows)),
        "issue_counts": dict(Counter(issue for row in rows for issue in row["issues"])),
        "group_counts": dict(group_counts),
        "duration_ms": {
            "min": min(durations),
            "median": statistics.median(durations),
            "mean": round(statistics.mean(durations), 2),
            "p90": sorted(durations)[int(len(durations) * 0.9) - 1],
            "max": max(durations),
        },
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(report, args.output.with_suffix(".md"))
    print(json.dumps({k: report[k] for k in ["total", "rows_with_issues", "elapsed_ms", "parse_source_counts", "issue_counts", "duration_ms"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
