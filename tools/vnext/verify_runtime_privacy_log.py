#!/usr/bin/env python3
"""Fail closed when a LaoJi runtime log contains raw API paths or payload keys."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from typing import Any


_RAW_API_PROTOCOL_RE = re.compile(
    r"(?:WebSocket|(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD))\s+/api/"
)
_TEE_PREFIX_RE = re.compile(r"^\[\d\d:\d\d:\d\d\.\d{3}\]\s+\[#\d+\]\s+")
_FORBIDDEN_KEYS = frozenset({
    "meeting_id",
    "summary_id",
    "speaker_id",
    "speaker_name",
    "speaker_label",
    "session_id",
    "job_id",
    "task_id",
    "trace_id",
    "file_path",
    "filename",
    "meeting_title",
    "title",
    "transcript_text",
    "raw_text",
    "text",
    "name",
    "content",
})


def _forbidden_json_key(value: Any) -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key) in _FORBIDDEN_KEYS:
                return str(key)
            nested = _forbidden_json_key(child)
            if nested:
                return nested
    elif isinstance(value, list):
        for child in value:
            nested = _forbidden_json_key(child)
            if nested:
                return nested
    return None


def scan(path: Path) -> list[dict[str, object]]:
    findings: list[dict[str, object]] = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        line = _TEE_PREFIX_RE.sub("", raw_line.strip())
        if _RAW_API_PROTOCOL_RE.search(line):
            findings.append({"line": line_number, "reason": "raw_api_protocol_path"})
            continue
        if not line.startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        key = _forbidden_json_key(payload)
        if key:
            findings.append({"line": line_number, "reason": f"forbidden_json_key={key}"})
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("log", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    findings = scan(args.log)
    if args.json:
        print(json.dumps(findings, ensure_ascii=True, indent=2))
    else:
        for finding in findings:
            print(f"line={finding['line']} reason={finding['reason']}")
        print(f"runtime_privacy_log_findings={len(findings)}")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
