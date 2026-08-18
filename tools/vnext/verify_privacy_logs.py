#!/usr/bin/env python3
"""Static privacy gate for LaoJi runtime logging.

The checker is intentionally conservative and read-only.  It inspects Python
calls that write runtime logs and rejects interpolation of meeting text,
names, filenames, or raw opaque entity IDs.  It can run on Linux and Windows.
"""

from __future__ import annotations

import argparse
import ast
from pathlib import Path
import sys


DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "services" / "laoji-api" / "app"
LOG_CALLS = {"print", "print_exc", "debug", "info", "warning", "error", "exception", "critical"}
FORBIDDEN = {
    "meeting_id", "summary_id", "speaker_id", "speaker_name", "speaker_label",
    "session_id", "job_id", "task_id", "trace_id", "file_path", "filename",
    "meeting_title", "title", "transcript_text", "raw_text", "text", "name",
}


def _is_log_call(node: ast.Call) -> bool:
    if isinstance(node.func, ast.Name):
        return node.func.id in LOG_CALLS
    if isinstance(node.func, ast.Attribute):
        return node.func.attr in LOG_CALLS
    return False


def _names(node: ast.AST) -> set[str]:
    return {item.id for item in ast.walk(node) if isinstance(item, ast.Name)}


def scan(root: Path) -> list[dict[str, object]]:
    findings: list[dict[str, object]] = []
    for path in sorted(root.rglob("*.py")):
        if any(part in {"__pycache__", "tests"} for part in path.parts):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError) as exc:
            findings.append({"path": str(path), "line": 0, "reason": f"parse:{type(exc).__name__}"})
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not _is_log_call(node):
                continue
            # A logger call's arguments are the message payload.  Ignore the
            # logging keyword options themselves.
            payload_nodes = list(node.args)
            if isinstance(node.func, ast.Name) and node.func.id == "print":
                payload_nodes = node.args
            used = set().union(*(_names(item) for item in payload_nodes)) if payload_nodes else set()
            bad = sorted(used & FORBIDDEN)
            if bad:
                findings.append({
                    "path": str(path.relative_to(root)),
                    "line": int(getattr(node, "lineno", 0)),
                    "reason": "forbidden_names=" + ",".join(bad),
                })
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    findings = scan(args.root)
    if args.json:
        import json
        print(json.dumps(findings, ensure_ascii=True, indent=2))
    else:
        for finding in findings:
            print(f"{finding['path']}:{finding['line']}: {finding['reason']}")
        print(f"privacy_log_findings={len(findings)}")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
