#!/usr/bin/env python3
"""Static Android Stage 2 contract probe.

This is intentionally a source-level guard, not a claim of device execution.
It catches regressions in the invariants that are otherwise hard to exercise
without a dedicated LaoJi emulator or phone.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def require(path: Path, *needles: str) -> None:
    text = path.read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in text]
    if missing:
        raise AssertionError(f"{path}: missing {missing}")


def main() -> None:
    transfer = ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/LaojiTransferModule.kt"
    worker = ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/transfer/MeetingUploadWorker.kt"
    uploader = ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/transfer/DeviceV2R2Uploader.kt"
    erase = ROOT / "src/services/localDataEraseCoordinator.ts"
    live_screen = ROOT / "src/screens/MeetingLiveScreen.android.tsx"
    feature_flags = ROOT / "src/config/featureFlags.ts"

    require(
        transfer,
        "getWorkInfosForUniqueWork(uniqueWorkName)",
        "firstOrNull()",
        "unique upload work was not persisted",
    )
    if "return request.id.toString()" in transfer.read_text(encoding="utf-8"):
        raise AssertionError("KEEP enqueue must not return the discarded request UUID")
    require(worker, "catch (error: CancellationException)", "throw error")
    require(uploader, "catch (error: CancellationException)", "throw error")
    require(
        uploader,
        "asset.length != input.byteSize",
        "MessageDigest.getInstance(\"SHA-256\")",
        "actual != input.sourceSha256.lowercase()",
        "validateMultipartLayout(totalParts, partSize, input.byteSize)",
        "number !in 1..totalParts",
        "suspendCancellableCoroutine",
        "invokeOnCancellation { call.cancel() }",
    )
    require(erase, "clearNativeTransferLease(`device-v2:${epochId}`)")
    require(
        feature_flags,
        "realtimeAsrV2Candidate: extra.featureFlags?.realtimeAsrV2Candidate === true",
    )
    require(
        live_screen,
        "getFeatureFlags().realtimeAsrV2Candidate",
        "realtimeV2?.realtimeAsrV2",
        "startDeviceV2RealtimeRecording",
        "acknowledgeNativeDeviceV2Transcript",
    )
    print("stage2_android_contract=passed")


if __name__ == "__main__":
    main()
