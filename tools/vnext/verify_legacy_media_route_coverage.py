#!/usr/bin/env python3
"""Check all account/device-compatible media write routes have upload guards."""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
from typing import Any


EXPECTED = {
    "services/laoji-api/app/api/app_meetings.py": (
        "/{meeting_id}/audio",
        "/{meeting_id}/upload",
    ),
    "services/laoji-api/app/api/app_recording_v2.py": (
        "/v2/meeting-notes/{meeting_id}/recording-assets",
        "/v2/recording-assets/{asset_id}/content",
        "/v2/recording-assets/{asset_id}/transcriptions",
        "/v2/processing-jobs/{job_id}/retry",
    ),
}


def _route(node: ast.AsyncFunctionDef) -> str | None:
    for decorator in node.decorator_list:
        if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
            continue
        if not isinstance(decorator.func.value, ast.Name) or decorator.func.value.id != "router":
            continue
        if decorator.func.attr not in {"post", "put", "patch"} or not decorator.args:
            continue
        value = decorator.args[0]
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            return value.value
    return None


def inspect(root: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    for relative, expected_paths in EXPECTED.items():
        path = root / relative
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        routes = {
            route: node
            for node in tree.body
            if isinstance(node, ast.AsyncFunctionDef)
            and (route := _route(node)) is not None
        }
        for route in expected_paths:
            node = routes.get(route)
            guarded = bool(
                node
                and any(
                    isinstance(child, ast.Call)
                    and isinstance(child.func, ast.Name)
                    and child.func.id == "_guard_legacy_media_submit"
                    for child in ast.walk(node)
                )
            )
            checks.append({"file": str(path), "path": route, "found": node is not None, "guarded": guarded})
    missing = [item for item in checks if not item["found"] or not item["guarded"]]
    return {"schema_version": 1, "checks": checks, "missing_count": len(missing), "passed": not missing}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    report = inspect(args.root.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
