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
    lease_store = ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/transfer/CredentialLeaseStore.kt"
    realtime_socket = ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/audio/DeviceV2RealtimeAsrSocket.kt"
    device_api = ROOT / "src/services/deviceV2Api.ts"
    erase = ROOT / "src/services/localDataEraseCoordinator.ts"
    live_screen = ROOT / "src/screens/MeetingLiveScreen.android.tsx"
    feature_flags = ROOT / "src/config/featureFlags.ts"
    upload_owner = ROOT / "src/services/deviceUploadOperations.ts"
    coordinator = ROOT / "src/native/nativeTransferCoordinator.ts"
    operations = ROOT / "src/data/repositories/vnext/deviceOperationsRepository.ts"
    recording = ROOT / "src/services/meetingRecording.ts"
    completion = ROOT / "src/components/DeviceMeetingCompletionProvider.tsx"
    upload_migration = ROOT / "src/data/db/migrations/0046DeviceUploadExecutor.ts"
    stable_identity_migration = ROOT / "src/data/db/migrations/0047TranscriptStableIdentity.ts"
    media_ingestor = ROOT / "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/mediaimport/MediaIngestor.kt"
    media_import_provider = ROOT / "src/components/MeetingMediaImportProvider.tsx"
    app_config = ROOT / "app.config.js"
    cleartext_plugin = ROOT / "plugins/withAndroidCleartextTraffic.js"

    require(
        app_config,
        "HTTP development endpoints require EXPO_ALLOW_CLEARTEXT=true",
        "process.env.EXPO_ALLOW_CLEARTEXT !== 'true'",
    )
    require(
        cleartext_plugin,
        "EXPO_ALLOW_CLEARTEXT === 'true'",
        "allowCleartext ? 'true' : 'false'",
    )
    require(
        media_ingestor,
        'state = "staged"',
        '"staged", "copying", "extracting" -> ingest(',
        'current.state in setOf("staged", "copying", "extracting", "prepared")',
    )
    require(
        media_import_provider,
        "await stageMeetingMediaImport({",
        "await saveMeetingMediaImportDraft(request.meetingId, activeDraft);",
        "recoveredTargetMeetingId",
    )

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
        "refreshCancellable(lease)",
        "fun refreshCancellable(lease: CredentialLease): CredentialLease",
    )
    require(
        lease_store,
        "A token refresh replaces the encrypted lease",
        "it.generation >= generation",
    )
    require(
        realtime_socket,
        "DeviceV2LeaseRefresher(client, credentialStore).refresh(nextLease)",
        "scheduleReconnect(refresh = true)",
        "lastLocalEventAck",
    )
    require(
        device_api,
        "export async function refreshDeviceV2Session",
        "let sessionPromise: Promise<DeviceV2Session> | null = null",
        "session = await refreshDeviceV2SessionSingleFlight(session)",
    )
    require(erase, "clearNativeTransferLease(`device-v2:${epochId}`)")
    require(
        feature_flags,
        "realtimeAsrV2Candidate: extra.featureFlags?.realtimeAsrV2Candidate === true",
    )
    require(
        upload_owner,
        "ensureDeviceUploadOperation",
        "bindDeviceUploadOperationToAsset",
        "capability: 'media.upload'",
        "canonical asset identity",
        "syncDeviceUploadOperationState",
        "state: 'running' | 'failure' | 'cancelled'",
    )
    require(
        coordinator,
        "ensureDeviceUploadOperation({",
        "bindDeviceUploadOperationToAsset(",
        "attachDeviceOperationExecutor(",
    )
    require(
        operations,
        "executor_kind",
        "listPendingDeviceUploadOperations",
        "listTerminalDeviceUploadAssetIds",
        "asset.remote_asset_id IS NOT NULL",
    )
    require(upload_migration, "idx_device_upload_pending_asset", "version: 46")
    require(
        stable_identity_migration,
        "idx_transcript_segment_stable_identity",
        "revision_id, stable_segment_key",
        "version: 47",
    )
    require(
        recording,
        "listPendingDeviceUploadOperations('guest')",
        "listTerminalDeviceUploadAssetIds('guest')",
        "const canonicalIds = new Set",
        "const records = await listPendingMeetingAudioUploads(storageScope);",
        "nativeWorkId:",
    )
    meetings_store = ROOT / "src/store/MeetingsStore.tsx"
    require(
        meetings_store,
        "commitGuestNativeUploadSuccess",
        "success missing remote identity",
        "await clearPendingMeetingAudioUpload('guest'",
        "await markDeviceUploadOperationSuccess(operationId)",
        "guestCanonicalUploadCommitted",
        "await loadCanonicalOwnedScope()",
        "orphaned success commit deferred",
        "rerunRequested\n        && !shouldPollPendingUploads",
        "an immediate rerun would turn",
    )
    require(
        ROOT / "src/screens/TranscriptionScreen.android.tsx",
        "This detail screen observes their durable state",
        "if (isGuest) return;",
    )
    require(
        completion,
        "An explicitly completed, empty payload is a valid",
        "await clearDeviceTranscriptTask(meeting.id)",
        "{ hasTranscript: Boolean(meeting.hasTranscript) }",
        "mirrorLegacyTranscriptProcessingFailure",
        "finalEvent.outcome === 'no_speech'",
        "snapshot.state === 'no_content'",
        "const byStableKey = new Map",
        "textState: finalEvent?.outcome === 'text' ? 'final' : 'stable'",
        "stableEvents.some(event => !storedKeys.has",
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
