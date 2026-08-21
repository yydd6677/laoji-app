from __future__ import annotations

from pathlib import Path
import shutil

from verify_stage5a_single_active_path import (
    EXPECTED_DISABLED,
    EXPECTED_ENABLED,
    ROOT,
    verify,
)


FILES = (
    "src/config/featureFlags.ts",
    "app.config.js",
    "src/store/MeetingsStore.tsx",
    "src/screens/MeetingLiveScreen.android.tsx",
    "src/services/meetingSummary.ts",
    "src/services/meetingQuestions.ts",
    "src/services/meetingQuestionsQ2.ts",
    "src/services/api.ts",
)


def _config() -> dict:
    flags = {name: True for name in EXPECTED_ENABLED}
    flags.update({name: False for name in EXPECTED_DISABLED})
    return {"extra": {"featureFlags": flags}}


def test_repository_candidate_is_single_active_path() -> None:
    report = verify(ROOT, _config())

    assert report["passed"] is True
    assert report["physical_legacy_deletion_performed"] is False


def test_realtime_silent_fallback_is_rejected(tmp_path: Path) -> None:
    for relative in FILES:
        destination = tmp_path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, destination)
    live = tmp_path / "src/screens/MeetingLiveScreen.android.tsx"
    live.write_text(
        live.read_text(encoding="utf-8").replace(
            "if (realtimeV2Candidate && !realtimeV2?.realtimeAsrV2)",
            "if (false)",
        ),
        encoding="utf-8",
    )

    report = verify(tmp_path, _config())

    assert report["passed"] is False
    assert "realtime_candidate_fails_closed" in report["failed_checks"]


def test_candidate_build_must_disable_legacy_writers() -> None:
    config = _config()
    config["extra"]["featureFlags"]["meetingQuestionsV1"] = True

    report = verify(ROOT, config)

    assert report["passed"] is False
    assert "build_disabled:meetingQuestionsV1" in report["failed_checks"]
