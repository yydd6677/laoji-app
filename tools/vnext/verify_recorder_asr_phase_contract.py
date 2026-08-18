"""Verify the recorder's explicit ASR phase contract without Android runtime.

The probe is intentionally source-only and safe on Linux and Windows.  It
guards the cross-bridge field and the precedence rules that keep a slow ASR
handshake separate from a recoverable failure.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
AUDIO_CONTRACTS = ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/AudioContracts.kt"
ENGINE = ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/RecorderEngine.kt"
TS_AUDIO = ROOT / "modules/laoji-native-platform/src/audio.ts"


def main() -> int:
    contracts = AUDIO_CONTRACTS.read_text(encoding="utf-8")
    engine = ENGINE.read_text(encoding="utf-8")
    ts_audio = TS_AUDIO.read_text(encoding="utf-8")

    required_phases = (
        'NOT_REQUIRED("notRequired")',
        'CONNECTING("connecting")',
        'CONNECTED("connected")',
        'RECOVERY_REQUIRED("recoveryRequired")',
        'COMPLETED("completed")',
    )
    missing = [needle for needle in required_phases if needle not in contracts]
    if missing:
        raise SystemExit(f"recorder_asr_phase=failed missing_phases={missing}")

    for needle in (
        "val asrPhase: RecorderAsrPhase",
        '"asrPhase" to asrPhase.wireValue',
        '"asrConnectLatencyMs" to asrConnectLatencyMs?.toDouble()',
        '"firstTranscriptLatencyMs" to firstTranscriptLatencyMs?.toDouble()',
        "asrPhase = currentAsrPhase()",
        "private fun currentAsrPhase(): RecorderAsrPhase",
        "state == RecorderState.LOCAL_SAVED && readyToStop && !transcriptRecoveryRequired",
        "transcriptRecoveryRequired || errorCode != null -> RecorderAsrPhase.RECOVERY_REQUIRED",
        "if (firstPcmElapsedMs == null) firstPcmElapsedMs = SystemClock.elapsedRealtime()",
        "if (asrConnectedElapsedMs == null) asrConnectedElapsedMs = SystemClock.elapsedRealtime()",
        "if (firstTranscriptElapsedMs == null) firstTranscriptElapsedMs = SystemClock.elapsedRealtime()",
    ):
        if needle not in contracts + engine:
            raise SystemExit(f"recorder_asr_phase=failed missing={needle}")

    for needle in (
        "export type NativeRecorderAsrPhase",
        "asrPhase?: NativeRecorderAsrPhase",
        "export function nativeRecorderAsrPhase",
        "return 'recoveryRequired';",
    ):
        if needle not in ts_audio:
            raise SystemExit(f"recorder_asr_phase=failed ts_missing={needle}")

    print("recorder_asr_phase=passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
