#!/usr/bin/env python3
"""Static owner guard for the isolated Stage 4 MentionGraph candidate.

The candidate must have one explicit parser/model observation per request. This
probe catches accidental reintroduction of the legacy parser, intent
classifier, or clarification fallback into the Graph owner. It is a source
contract check only; it does not enable the capability or contact production.
"""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
from typing import Any


FORBIDDEN_GRAPH_NAMES = {
    "classify_schedule_intent",
    "parse_schedule_text_sync",
    "apply_schedule_clarification",
}


def _calls(node: ast.AST) -> list[ast.Call]:
    return [item for item in ast.walk(node) if isinstance(item, ast.Call)]


def _has_keyword(call: ast.Call, name: str, value: object) -> bool:
    return any(
        keyword.arg == name
        and isinstance(keyword.value, ast.Constant)
        and keyword.value.value == value
        for keyword in call.keywords
    )


def inspect(root: Path) -> dict[str, Any]:
    graph_path = root / "services/laoji-api/app/services/schedule_graph_service.py"
    schema_path = root / "services/laoji-api/app/schemas/vnext_contracts.py"
    legacy_route = root / "services/laoji-api/app/laoji/router.py"
    device_route = root / "services/laoji-api/app/api/device_v2.py"
    mobile = root / "src/services/scheduleGraphV2.ts"

    graph_tree = ast.parse(graph_path.read_text(encoding="utf-8"), filename=str(graph_path))
    graph_forbidden = sorted(
        name for node in ast.walk(graph_tree)
        for name in FORBIDDEN_GRAPH_NAMES
        if isinstance(node, ast.Name) and node.id == name
    )
    producer = next(
        (node for node in graph_tree.body if isinstance(node, ast.FunctionDef) and node.name == "produce_schedule_graph"),
        None,
    )
    producer_requires_observation = bool(
        producer and any(
            isinstance(node, ast.Compare)
            and any(isinstance(op, ast.Is) for op in node.ops)
            and isinstance(node.left, ast.Name)
            and node.left.id == "parsed"
            for node in ast.walk(producer)
        )
    )

    route_checks: list[dict[str, Any]] = []
    for path, names in (
        (legacy_route, ("parse_schedule_graph_v2", "clarify_schedule_graph_v2")),
        (device_route, ("create_schedule_graph", "clarify_schedule_graph")),
    ):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for function_name in names:
            function = next(
                (node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == function_name),
                None,
            )
            calls = _calls(function) if function else []
            model_only_calls = [call for call in calls if _has_keyword(call, "model_only", True)]
            route_checks.append({
                "file": str(path),
                "function": function_name,
                "found": function is not None,
                "model_only_calls": len(model_only_calls),
            })

    schema_source = schema_path.read_text(encoding="utf-8")
    mobile_source = mobile.read_text(encoding="utf-8")
    checks = {
        "graph_forbidden_legacy_names": graph_forbidden,
        "producer_requires_explicit_observation": producer_requires_observation,
        "route_checks": route_checks,
        "schema_has_client_intent": "client_intent:" in schema_source,
        "mobile_sends_client_intent": "client_intent:" in mobile_source,
    }
    route_ok = all(item["found"] and item["model_only_calls"] >= 1 for item in route_checks)
    passed = (
        not graph_forbidden
        and producer_requires_observation
        and route_ok
        and checks["schema_has_client_intent"]
        and checks["mobile_sends_client_intent"]
    )
    return {"schema_version": 1, "candidate_only": True, "checks": checks, "passed": passed}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    report = inspect(args.root.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
