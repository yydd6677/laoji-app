"""Verify the native schedule recorder starts local capture before realtime connect.

This is a source-contract probe only. It does not start Android, a WebSocket,
or a production service, so it is safe to run on Linux and Windows.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "modules" / "laoji-native-platform" / "android" / "src" / "main" / "java" / "com" / "laoji" / "nativeplatform" / "audio" / "RecorderEngine.kt"


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
    )
    missing = [needle for needle in required if needle not in source]
    if missing:
        raise SystemExit(f"schedule_voice_capture_order=failed missing={missing}")
    print("schedule_voice_capture_order=passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
