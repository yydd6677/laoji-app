#!/usr/bin/env python3
"""Static adoption guard for the Stage 4 native projection action fence."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

SCREENS = {
    "calendar": ROOT / "src/screens/ScheduleScreen.android.tsx",
    "recording": ROOT / "src/screens/MeetingLiveScreen.android.tsx",
    "transcript": ROOT / "src/screens/TranscriptionScreen.android.tsx",
}


def inspect(root: Path = ROOT) -> dict[str, object]:
    helper = (root / "src/native/projectionActionFence.ts").read_text(encoding="utf-8")
    coordinator = (root / "src/native/useNativeProjection.ts").read_text(encoding="utf-8")
    identity_fields = (
        "deviceEpoch",
        "entityId",
        "entityRevision",
        "viewRevision",
        "surfaceInstanceId",
        "payloadSha256",
    )
    checks: dict[str, object] = {
        "helper_checks_full_identity": all(
            f"left.{field} === right.{field}" in helper
            for field in identity_fields
        ),
        "candidate_fails_closed_pending": "reason: 'projection_pending'" in helper,
        "candidate_fails_closed_missing": "reason: 'projection_missing'" in helper,
        "candidate_rejects_stale": "reason: 'projection_stale'" in helper,
        "stable_path_unchanged": "reason: 'candidate_disabled'" in helper,
        "projection_generation_uses_stable_payload": (
            "const payloadSnapshot = snapshotRef.current" in coordinator
            and "projectionPayloadSha256(payloadSnapshot)" in coordinator
            and "payloadSnapshot," in coordinator
        ),
    }
    screen_checks: dict[str, dict[str, bool]] = {}
    for surface, relative in SCREENS.items():
        path = root / relative.relative_to(ROOT)
        source = path.read_text(encoding="utf-8")
        fence_index = source.find("fenceNativeProjectionAction(")
        if surface == "calendar":
            action_index = source.find("const targetRef", fence_index)
        else:
            action_index = source.find("switch (action.type)", fence_index)
        screen_checks[surface] = {
            "imports_fence": "from '../native/projectionActionFence'" in source,
            "uses_candidate_flag": "projectionCandidateEnabled" in source,
            "tracks_current_projection": "currentProjectionRef.current = snapshot.projection ?? null" in source,
            "passes_action_projection": "action.projection" in source if surface != "calendar" else "mutation.projection" in source,
            "fences_before_action": fence_index >= 0 and action_index > fence_index,
            "audits_rejection": "native_projection_action_rejected" in source,
        }
    checks["screens"] = screen_checks
    passed = all(value is True for key, value in checks.items() if key != "screens") and all(
        all(values.values())
        for values in screen_checks.values()
    )
    return {
        "schema_version": 1,
        "candidate_only": True,
        "passed": passed,
        "checks": checks,
    }


def main() -> int:
    report = inspect()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report["passed"]:
        print("projection_action_fence=passed")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
