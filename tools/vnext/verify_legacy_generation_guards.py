#!/usr/bin/env python3
"""Verify summary, Q&A, and schedule v1 submissions have cutover guards."""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
from typing import Any


EXPECTED: dict[str, dict[str, tuple[str, ...]]] = {
    "app_meetings.py": {
        "_guard_legacy_generation": (
            "guest-summary",
            "guest-questions",
            "/{meeting_id}/questions",
            "/{meeting_id}/summaries/generate",
        ),
    },
    "router.py": {
        "_guard_legacy_schedule_submit": (
            "/parse",
            "/clarify",
            "/parse-audio",
            "/asr/transcribe",
        ),
    },
    "device_v1.py": {
        "_guard_legacy_generation": (
            "/schedule/parse",
            "/schedule/parse-audio",
            "/schedule/clarify",
            "/meetings/{binding_id}/questions",
        ),
    },
}


def _path_for(node: ast.AsyncFunctionDef) -> str | None:
    for decorator in node.decorator_list:
        if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
            continue
        if not isinstance(decorator.func.value, ast.Name) or decorator.func.value.id != "router":
            continue
        if decorator.func.attr not in {"post", "put", "patch"} or not decorator.args:
            continue
        path = decorator.args[0]
        if isinstance(path, ast.Constant) and isinstance(path.value, str):
            return path.value
    return None


def inspect(root: Path) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for file_name, groups in EXPECTED.items():
        base = "services/laoji-api/app/laoji/" if file_name == "router.py" else "services/laoji-api/app/api/"
        path = root / base / file_name
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for guard, paths in groups.items():
            for expected_path in paths:
                matches = []
                for node in tree.body:
                    if not isinstance(node, ast.AsyncFunctionDef):
                        continue
                    route_path = _path_for(node)
                    expected_route = (
                        f"/{expected_path}"
                        if expected_path in {"guest-summary", "guest-questions"}
                        else expected_path
                    )
                    if route_path != expected_route:
                        continue
                    guarded = any(
                        isinstance(child, ast.Call)
                        and isinstance(child.func, ast.Name)
                        and child.func.id == guard
                        for child in ast.walk(node)
                    )
                    matches.append({"function": node.name, "path": route_path, "guarded": guarded})
                results.append({"file": str(path), "guard": guard, "expected": expected_path, "matches": matches})
    missing = [item for item in results if len(item["matches"]) != 1 or not item["matches"][0]["guarded"]]
    return {
        "schema_version": 1,
        "checks": results,
        "missing_count": len(missing),
        "passed": not missing,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    report = inspect(args.root.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
