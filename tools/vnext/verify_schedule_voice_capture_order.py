"""Verify the native schedule recorder starts local capture before realtime connect.

This is a source-contract probe only. It does not start Android, a WebSocket,
or a production service, so it is safe to run on Linux and Windows.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "modules" / "laoji-native-platform" / "android" / "src" / "main" / "java" / "com" / "laoji" / "nativeplatform" / "audio" / "RecorderEngine.kt"
VOICE_UI = ROOT / "src" / "components" / "VoiceInputModal.android.tsx"


def main() -> int:
    source = ENGINE.read_text(encoding="utf-8")
    capture = source.index("startRecordingThread(recorder)")
    connect = source.index("startRealtimeAsrConnection().also(::observeRealtimeAsrConnection)")
    if capture >= connect:
        raise SystemExit("schedule_voice_capture_order=failed")
    required = (
        "Local capture is the critical path.",
        "sendOrQueueAsrFrame()",
        "markAsrUnavailable(",
        "fileSession?.updateState(JournalState.RECORDING, currentJournalAsrState())",
        "captureStartedAtMs = System.currentTimeMillis()",
    )
    missing = [needle for needle in required if needle not in source]
    if missing:
        raise SystemExit(f"schedule_voice_capture_order=failed missing={missing}")
    ui_source = VOICE_UI.read_text(encoding="utf-8")
    if "if (event.state === 'preparing') setPhase('preparing')" in ui_source:
        raise SystemExit("schedule_voice_capture_order=failed user-visible-preparing-regression")
    ui_required = (
        "setPhase('recording');",
        "createWarmScheduleConnection();",
        "AppState.currentState === 'active'",
        "startedSnapshot.captureStartedAtMs",
        "measurement: nativeLatency == null ? 'bridge_completion' : 'native_capture'",
    )
    ui_missing = [needle for needle in ui_required if needle not in ui_source]
    if ui_missing:
        raise SystemExit(f"schedule_voice_capture_order=failed ui-missing={ui_missing}")
    print("schedule_voice_capture_order=passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
