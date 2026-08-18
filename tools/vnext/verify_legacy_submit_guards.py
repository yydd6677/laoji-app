#!/usr/bin/env python3
"""Verify that every legacy device media write is behind the cutover guard.

This is a source contract, not proof that a barrier is activated.  It catches
an easy-to-miss regression where a new v1 upload/transcription route writes
before ``guard_legacy_media_submit`` has had a chance to reject old clients.
"""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
from typing import Any


WRITE_METHODS = {"post", "put", "patch"}


def _route(node: ast.AsyncFunctionDef) -> tuple[str, str] | None:
    for decorator in node.decorator_list:
        if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
            continue
        if not isinstance(decorator.func.value, ast.Name) or decorator.func.value.id != "router":
            continue
        if decorator.func.attr not in WRITE_METHODS or not decorator.args:
            continue
        path = decorator.args[0]
        if isinstance(path, ast.Constant) and isinstance(path.value, str):
            return decorator.func.attr.upper(), path.value
    return None


def _has_guard(node: ast.AsyncFunctionDef) -> bool:
    return any(
        isinstance(child, ast.Call)
        and isinstance(child.func, ast.Name)
        and child.func.id == "_guard_legacy_media_submit"
        for child in ast.walk(node)
    )


def inspect(path: Path) -> dict[str, Any]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    routes: list[dict[str, Any]] = []
    for node in tree.body:
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        route = _route(node)
        if route is None:
            continue
        method, route_path = route
        if "/assets" not in route_path:
            continue
        routes.append(
            {
                "method": method,
                "path": route_path,
                "function": node.name,
                "guarded": _has_guard(node),
            }
        )
    unguarded = [route for route in routes if not route["guarded"]]
    return {
        "schema_version": 1,
        "source": str(path),
        "write_route_count": len(routes),
        "unguarded_count": len(unguarded),
        "routes": routes,
        "passed": bool(routes) and not unguarded,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "services/laoji-api/app/api/device_v1.py",
    )
    args = parser.parse_args()
    report = inspect(args.path.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
