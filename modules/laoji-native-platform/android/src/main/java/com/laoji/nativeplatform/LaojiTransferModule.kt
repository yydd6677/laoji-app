package com.laoji.nativeplatform

// MIN-UPLOAD-001: durable transfer commands are scoped to encrypted credential leases.

import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.laoji.nativeplatform.transfer.CredentialLease
import com.laoji.nativeplatform.transfer.CredentialLeaseStore
import com.laoji.nativeplatform.transfer.MeetingUploadWorker
import com.laoji.nativeplatform.transfer.MeetingDeletionStore
import com.laoji.nativeplatform.transfer.meetingUploadTag
import com.laoji.nativeplatform.audio.RecorderServiceClient
import com.laoji.nativeplatform.audio.RecordingRepository
import com.laoji.nativeplatform.mediaimport.MediaIngestor
import com.laoji.nativeplatform.mediaclip.MediaClipExporter
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.TimeUnit

class LaojiTransferModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiTransfer")

    AsyncFunction("setCredentialLease") { scope: String, generation: Long, apiBaseUrl: String, accessToken: String ->
      CredentialLeaseStore(requireContext()).put(
        CredentialLease(scope, generation, apiBaseUrl.trim().trimEnd('/'), accessToken)
      )
    }

    AsyncFunction("setDeviceV2CredentialLease") {
        scope: String,
        generation: Long,
        apiBaseUrl: String,
        accessToken: String,
        deviceId: String,
        deviceEpochId: String,
        keyVersion: Int,
        expiresAtMs: Long,
      ->
      CredentialLeaseStore(requireContext()).put(
        CredentialLease(
          scope = scope,
          generation = generation,
          apiBaseUrl = apiBaseUrl.trim().trimEnd('/'),
          accessToken = accessToken,
          deviceId = deviceId,
          deviceEpochId = deviceEpochId,
          keyVersion = keyVersion,
          expiresAtMs = expiresAtMs,
        )
      )
    }

    AsyncFunction("clearCredentialLease") { scope: String ->
      CredentialLeaseStore(requireContext()).clear(scope)
      WorkManager.getInstance(requireContext()).cancelAllWorkByTag(scopeTag(scope))
    }

    AsyncFunction("enqueueMeetingUpload") { input: Map<String, Any?> ->
      val scope = input.requiredString("scope")
      val credentialScope = (input["credentialScope"] as? String)?.takeIf { it.isNotBlank() } ?: scope
      val generation = input.requiredLong("generation")
      val meetingId = input.requiredString("meetingId")
      val remoteMeetingId = input.requiredString("remoteMeetingId")
      val operationId = input.requiredString("operationId")
      val fileUri = input.requiredString("fileUri")
      val mimeType = input.requiredString("mimeType")
      val fileName = input.requiredString("fileName")
      val protocol = input.requiredString("protocol")
      val recordingAssetId = input["recordingAssetId"] as? String ?: ""
      val recordingRole = input["recordingRole"] as? String ?: "primary"
      val recordingOrigin = input["recordingOrigin"] as? String ?: "captured"
      val expectedBytes = input.requiredLong("expectedBytes")
      val durationMs = input.requiredLong("durationMs")
      val checksumSha256 = input["checksumSha256"] as? String ?: ""
      val deviceId = input["deviceId"] as? String ?: ""
      val deviceEpochId = input["deviceEpochId"] as? String ?: ""
      val bindingId = input["bindingId"] as? String ?: ""
      val bindingGeneration = input["bindingGeneration"] as? String ?: ""
      val bindingRevision = (input["bindingRevision"] as? Number)?.toLong() ?: -1L
      val cancelRevision = (input["cancelRevision"] as? Number)?.toLong() ?: -1L
      val assetGeneration = input["assetGeneration"] as? String ?: ""
      if (protocol == MeetingUploadWorker.PROTOCOL_DEVICE_V2_R2) {
        require(deviceId.isNotBlank() && deviceEpochId.isNotBlank()) { "device identity is required" }
        require(bindingId.isNotBlank() && bindingGeneration.matches(Regex("^[0-9a-f]{32}$"))) {
          "binding identity is required"
        }
        require(bindingRevision >= 1 && cancelRevision >= 0) { "binding revision is invalid" }
        require(assetGeneration.matches(Regex("^[0-9a-f]{32}$"))) { "asset generation is invalid" }
      }
      if (MeetingDeletionStore(requireContext()).isDeleted(scope, meetingId)) {
        throw IllegalStateException("meeting has been deleted")
      }
      val request = OneTimeWorkRequestBuilder<MeetingUploadWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
        .setInputData(
          workDataOf(
            MeetingUploadWorker.KEY_SCOPE to scope,
            MeetingUploadWorker.KEY_CREDENTIAL_SCOPE to credentialScope,
            MeetingUploadWorker.KEY_GENERATION to generation,
            MeetingUploadWorker.KEY_MEETING_ID to meetingId,
            MeetingUploadWorker.KEY_REMOTE_MEETING_ID to remoteMeetingId,
            MeetingUploadWorker.KEY_OPERATION_ID to operationId,
            MeetingUploadWorker.KEY_FILE_URI to fileUri,
            MeetingUploadWorker.KEY_MIME_TYPE to mimeType,
            MeetingUploadWorker.KEY_FILE_NAME to fileName,
            MeetingUploadWorker.KEY_PROTOCOL to protocol,
            MeetingUploadWorker.KEY_RECORDING_ASSET_ID to recordingAssetId,
            MeetingUploadWorker.KEY_RECORDING_ROLE to recordingRole,
            MeetingUploadWorker.KEY_RECORDING_ORIGIN to recordingOrigin,
            MeetingUploadWorker.KEY_EXPECTED_BYTES to expectedBytes,
            MeetingUploadWorker.KEY_DURATION_MS to durationMs,
            MeetingUploadWorker.KEY_CHECKSUM_SHA256 to checksumSha256,
            MeetingUploadWorker.KEY_DEVICE_ID to deviceId,
            MeetingUploadWorker.KEY_DEVICE_EPOCH_ID to deviceEpochId,
            MeetingUploadWorker.KEY_BINDING_ID to bindingId,
            MeetingUploadWorker.KEY_BINDING_GENERATION to bindingGeneration,
            MeetingUploadWorker.KEY_BINDING_REVISION to bindingRevision,
            MeetingUploadWorker.KEY_CANCEL_REVISION to cancelRevision,
            MeetingUploadWorker.KEY_ASSET_GENERATION to assetGeneration,
          )
        )
        .addTag(scopeTag(scope))
        .addTag(scopeTag(credentialScope))
        .addTag(meetingUploadTag(scope, meetingId))
        .addTag(operationTag(operationId))
        .build()
      val uniqueWorkName = if (protocol == MeetingUploadWorker.PROTOCOL_DEVICE_V2_R2) {
        "laoji-device-v2-r2:$deviceEpochId:$recordingAssetId:$assetGeneration"
      } else {
        "laoji-meeting-upload:$scope:$operationId"
      }
      WorkManager.getInstance(requireContext()).enqueueUniqueWork(
        uniqueWorkName,
        ExistingWorkPolicy.KEEP,
        request
      )
      request.id.toString()
    }

    AsyncFunction("getUploadState") { workId: String ->
      val info = WorkManager.getInstance(requireContext())
        .getWorkInfoById(UUID.fromString(workId))
        .get(5, TimeUnit.SECONDS)
      workInfoMap(info)
    }

    AsyncFunction("cancelUpload") { workId: String ->
      WorkManager.getInstance(requireContext()).cancelWorkById(UUID.fromString(workId))
    }

    AsyncFunction("deleteMeetingArtifacts") { scope: String, meetingId: String ->
      val context = requireContext()
      MeetingDeletionStore(context).markDeleted(scope, meetingId)
      WorkManager.getInstance(context).cancelAllWorkByTag(meetingUploadTag(scope, meetingId))
      val deletedFiles = RecordingRepository(context).deleteSession(
        meetingId,
        RecorderServiceClient.currentSessionId(),
      )
      val deletedImportedFiles = MediaIngestor(context).deleteMeetingAssets(meetingId)
      val deletedClipFiles = MediaClipExporter(context).deleteMeeting(meetingId)
      mapOf("deletedFiles" to deletedFiles + deletedImportedFiles + deletedClipFiles)
    }
  }

  private fun requireContext() = appContext.reactContext?.applicationContext
    ?: throw IllegalStateException("Android application context is unavailable")

  private fun workInfoMap(info: WorkInfo?): Map<String, Any?> {
    if (info == null) return mapOf("state" to "missing")
    return mapOf(
      "state" to info.state.name.lowercase(),
      "operationId" to info.outputData.getString(MeetingUploadWorker.KEY_OPERATION_ID),
      "result" to info.outputData.getString(MeetingUploadWorker.KEY_STATE),
      "reason" to info.outputData.getString(MeetingUploadWorker.KEY_REASON),
      "remoteAssetId" to info.outputData.getString(MeetingUploadWorker.KEY_REMOTE_ASSET_ID),
      "remoteRevision" to info.outputData.getLong(MeetingUploadWorker.KEY_REMOTE_REVISION, -1)
        .takeIf { it >= 1 },
      "transcriptionTaskId" to info.outputData.getString(MeetingUploadWorker.KEY_TRANSCRIPTION_TASK_ID),
      "runAttemptCount" to info.runAttemptCount
    )
  }

  private fun scopeTag(scope: String) = "laoji-upload-scope:$scope"
  private fun operationTag(operationId: String) = "laoji-upload-operation:$operationId"

  private fun Map<String, Any?>.requiredString(key: String): String =
    (this[key] as? String)?.takeIf { it.isNotBlank() }
      ?: throw IllegalArgumentException("$key is required")

  private fun Map<String, Any?>.requiredLong(key: String): Long =
    (this[key] as? Number)?.toLong()
      ?: throw IllegalArgumentException("$key is required")
}
