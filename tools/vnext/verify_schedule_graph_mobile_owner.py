#!/usr/bin/env python3
"""Static contract check for the mobile MentionGraph admission boundary.

This deliberately does not import the React Native graph client. It verifies
the source-level ordering that prevents a complex candidate request from
falling through to the legacy parser, while keeping the stable build and
operation intents untouched.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def inspect(root: Path) -> dict[str, Any]:
    api = (root / "src/services/api.ts").read_text(encoding="utf-8")
    routing = (root / "src/services/scheduleGraphRouting.ts").read_text(encoding="utf-8")

    parse_start = api.index("export async function parseText(")
    parse_end = api.index("// ── Clarify", parse_start)
    parse_source = api[parse_start:parse_end]
    graph_admission = parse_source.index("const candidateRequested")
    local_return = parse_source.index("if ((decision.route === 'local_safe'", graph_admission)
    legacy_remote = parse_source.index("parseScheduleRemotely(", local_return)
    candidate_block = parse_source[graph_admission:local_return]

    clarify_start = api.index("export async function clarifyText(")
    clarify_end = api.index("// ── Save event", clarify_start)
    clarify_source = api[clarify_start:clarify_end]
    graph_draft = clarify_source.index("if (draft.schedule_graph)")
    graph_guard = clarify_source.index("SCHEDULE_ERROR_MESSAGES.parser_unavailable", graph_draft)
    legacy_clarify = clarify_source.index("clarifyScheduleRemotely(", graph_guard)

    checks = {
        "routing_requires_feature_capability": (
            "input.featureEnabled" in routing
            and "input.capabilityEnabled" in routing
            and "input.intent !== 'create'" in routing
            and "input.route === 'server_required'" in routing
        ),
        "candidate_admission_precedes_local_return": graph_admission < local_return,
        "candidate_calls_graph": "parseScheduleGraphV2(" in candidate_block,
        "candidate_fails_closed": "SCHEDULE_ERROR_MESSAGES.parser_unavailable" in candidate_block,
        "legacy_parser_is_after_candidate": legacy_remote > local_return,
        "graph_draft_checks_capability_before_legacy_clarify": graph_guard < legacy_clarify,
        "clarification_calls_graph": "clarifyScheduleGraphV2(" in clarify_source,
        "query_delete_excluded": (
            "input.intent !== 'create' && input.intent !== 'clarify'" in routing
        ),
    }
    return {
        "schema_version": 1,
        "candidate_only": True,
        "checks": checks,
        "passed": all(checks.values()),
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

