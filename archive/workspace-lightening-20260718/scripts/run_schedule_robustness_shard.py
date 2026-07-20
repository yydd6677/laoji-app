#!/usr/bin/env python3
"""Run one LaoJi schedule robustness sample shard against a parse endpoint."""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


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
    "location",
    "parse_source",
    "confidence",
]


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
    except Exception as exc:  # noqa: BLE001 - diagnostics script should capture all failures
        return None, repr(exc)


def compare_expected(parsed: dict[str, Any] | None, expected: dict[str, Any]) -> dict[str, Any]:
    mismatches: dict[str, Any] = {}
    if parsed is None:
        return {"__parse__": {"expected": "object", "actual": None}}
    for field, expected_value in expected.items():
        if field == "location_contains":
            actual = parsed.get("location")
            if expected_value not in str(actual or ""):
                mismatches[field] = {"expected_contains": expected_value, "actual": actual}
            continue
        actual = parsed.get(field)
        if actual != expected_value:
            mismatches[field] = {"expected": expected_value, "actual": actual}
    return mismatches


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--endpoint", default="http://127.0.0.1:18035/api/laoji/parse")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--pause-ms", type=int, default=0)
    args = parser.parse_args()

    data = json.loads(args.input.read_text(encoding="utf-8"))
    samples = data["samples"]
    rows: list[dict[str, Any]] = []

    started = time.time()
    for sample in samples:
        t0 = time.time()
        parsed, error = post_parse(args.endpoint, sample["text"], args.timeout)
        duration_ms = round((time.time() - t0) * 1000)
        core = {field: parsed.get(field) for field in CORE_FIELDS if parsed is not None}
        mismatches = compare_expected(parsed, sample.get("expected", {})) if not error else {}
        rows.append(
            {
                "id": sample["id"],
                "group": sample.get("group"),
                "text": sample["text"],
                "tags": sample.get("tags", []),
                "expected": sample.get("expected", {}),
                "duration_ms": duration_ms,
                "parse_source": parsed.get("parse_source") if parsed else None,
                "ok": not error and not mismatches,
                "mismatches": mismatches,
                "error": error,
                "parsed": core,
            }
        )
        if args.pause_ms > 0:
            time.sleep(args.pause_ms / 1000)

    elapsed_ms = round((time.time() - started) * 1000)
    failures = [row for row in rows if not row["ok"]]
    by_source: dict[str, int] = {}
    by_group: dict[str, dict[str, int]] = {}
    for row in rows:
        source = str(row.get("parse_source"))
        by_source[source] = by_source.get(source, 0) + 1
        group = str(row.get("group"))
        group_stats = by_group.setdefault(group, {"total": 0, "ok": 0, "failed": 0})
        group_stats["total"] += 1
        group_stats["ok" if row["ok"] else "failed"] += 1

    report = {
        "input": str(args.input),
        "endpoint": args.endpoint,
        "total": len(rows),
        "ok": len(rows) - len(failures),
        "failed": len(failures),
        "elapsed_ms": elapsed_ms,
        "parse_source_counts": by_source,
        "group_counts": by_group,
        "failures": failures,
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ["total", "ok", "failed", "elapsed_ms", "parse_source_counts"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
