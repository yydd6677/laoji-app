#!/usr/bin/env python3
"""Verify that a Stage 5A APK selects one vNext owner per capability.

Legacy implementations intentionally remain in the tree for an explicit,
whole-release rollback.  This verifier therefore does not reject legacy source
files; it rejects candidate configuration or routing that can select them after
the corresponding vNext candidate flag has taken ownership.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[2]

EXPECTED_ENABLED = (
    "localMeetingDbV1",
    "localMeetingDbCanonicalReadV1",
    "localMeetingDbCanonicalWriteV1",
    "mediaUploadV2Candidate",
    "scheduleGraphV2Candidate",
    "realtimeAsrV2Candidate",
    "meetingQuestionsQ2Candidate",
    "meetingSummarySourceStreamCandidate",
    "nativeProjectionEnvelopeCandidate",
)

EXPECTED_DISABLED = (
    "localMeetingDbLegacyProjectionWriteV1",
    "localMeetingDbAccountRootWriteV1",
    "localMeetingDbAccountUploadWriteV1",
    "meetingQuestionsV1",
    "meetingTagSyncV1",
    "meetingAttachmentSyncV1",
    "meetingMarkerSyncV1",
    "meetingSummarySyncV1",
)


def _read(root: Path, relative: str) -> str:
    return (root / relative).read_text(encoding="utf-8")


def _ordered(text: str, *needles: str) -> bool:
    position = -1
    for needle in needles:
        position = text.find(needle, position + 1)
        if position < 0:
            return False
    return True


def verify(
    root: Path = ROOT,
    expo_config: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    flags = _read(root, "src/config/featureFlags.ts")
    app_config = _read(root, "app.config.js")
    meetings = _read(root, "src/store/MeetingsStore.tsx")
    realtime = _read(root, "src/screens/MeetingLiveScreen.android.tsx")
    summary = _read(root, "src/services/meetingSummary.ts")
    questions = _read(root, "src/services/meetingQuestions.ts")
    q2 = _read(root, "src/services/meetingQuestionsQ2.ts")
    schedule = _read(root, "src/services/api.ts")

    checks = {
        "media_candidate_flag_declared": (
            "mediaUploadV2Candidate: boolean" in flags
            and "EXPO_PUBLIC_MEDIA_UPLOAD_V2_CANDIDATE" in app_config
        ),
        "media_candidate_owns_capability_probe": _ordered(
            meetings,
            "const mediaUploadV2Candidate = mode === 'guest' && flags.mediaUploadV2Candidate;",
            "if (mediaUploadV2Candidate) {",
            "const remoteCapability = await loadDeviceV2Capabilities()",
        ),
        "media_candidate_fails_closed": _ordered(
            meetings,
            "if (!deviceV2IngressReady) {",
            "reason: 'vnext_media_capability_unavailable'",
            "return;",
            "recordVNextLegacySubmit('media.upload')",
        ),
        "media_legacy_submit_requires_candidate_off": (
            "? mediaUploadV2Candidate\n            ? Promise.reject(new Error('v2 原生上传不可回退到旧入口'))\n            : recordVNextLegacySubmit('media.upload')"
            in meetings
        ),
        "realtime_candidate_fails_closed": _ordered(
            realtime,
            "const realtimeV2Candidate = getFeatureFlags().realtimeAsrV2Candidate;",
            "if (realtimeV2Candidate && !realtimeV2?.realtimeAsrV2)",
            "新版实时转写服务暂时不可用，录音尚未开始",
            "const snapshot = realtimeV2Candidate",
            ": await (async () => {",
        ),
        "summary_candidate_has_single_owner": _ordered(
            summary,
            "if (getFeatureFlags().meetingSummarySourceStreamCandidate) {",
            "return generateDeviceMeetingSummaryV3(options);",
            "const capabilities = await loadDeviceServiceCapabilities()",
        ),
        "q2_candidate_has_single_owner": (
            "if (flags.meetingQuestionsQ2Candidate)" in questions
            and "return prepareQ2MeetingQuestionSession" in questions
            and "await assertQ2Capability();" in q2
            and "if (!capabilities.questionReaderV2)" in q2
        ),
        "schedule_candidate_fails_closed": (
            "if (candidateRequested)" in schedule
            and "throw new ScheduleParseError('parser_unavailable'" in schedule
            and "do not let the\n  // legacy remote parser compete" in schedule
        ),
    }

    build_flags: dict[str, Any] = {}
    if expo_config is not None:
        extra = expo_config.get("extra") if isinstance(expo_config, Mapping) else None
        value = extra.get("featureFlags") if isinstance(extra, Mapping) else None
        build_flags = dict(value) if isinstance(value, Mapping) else {}
    config_checks = {
        f"build_enabled:{name}": build_flags.get(name) is True
        for name in EXPECTED_ENABLED
    }
    config_checks.update({
        f"build_disabled:{name}": build_flags.get(name) is False
        for name in EXPECTED_DISABLED
    })
    if expo_config is None:
        config_checks = {"candidate_expo_config_provided": False}
    checks.update(config_checks)

    failed = sorted(name for name, passed in checks.items() if not passed)
    return {
        "schema_version": 1,
        "candidate_only": True,
        "legacy_source_retained": True,
        "physical_legacy_deletion_performed": False,
        "active_path_policy": "single-owner-no-dual-write-no-silent-fallback",
        "checks": checks,
        "failed_checks": failed,
        "passed": not failed,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--expo-config", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    if args.expo_config:
        config = json.loads(args.expo_config.read_text(encoding="utf-8"))
    else:
        completed = subprocess.run(
            [
                "node",
                "-e",
                "process.stdout.write(JSON.stringify(require('./app.config.js')()))",
            ],
            cwd=root,
            text=True,
            check=True,
            capture_output=True,
        )
        config = json.loads(completed.stdout)
    report = verify(root, config)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
