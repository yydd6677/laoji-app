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

    AsyncFunction("clearCredentialLease") { scope: String ->
      CredentialLeaseStore(requireContext()).clear(scope)
      WorkManager.getInstance(requireContext()).cancelAllWorkByTag(scopeTag(scope))
    }

    AsyncFunction("enqueueMeetingUpload") {
      scope: String,
      generation: Long,
      meetingId: String,
      remoteMeetingId: String,
      operationId: String,
      fileUri: String,
      mimeType: String,
      fileName: String ->
      if (MeetingDeletionStore(requireContext()).isDeleted(scope, meetingId)) {
        throw IllegalStateException("meeting has been deleted")
      }
      val request = OneTimeWorkRequestBuilder<MeetingUploadWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
        .setInputData(
          workDataOf(
            MeetingUploadWorker.KEY_SCOPE to scope,
            MeetingUploadWorker.KEY_GENERATION to generation,
            MeetingUploadWorker.KEY_MEETING_ID to meetingId,
            MeetingUploadWorker.KEY_REMOTE_MEETING_ID to remoteMeetingId,
            MeetingUploadWorker.KEY_OPERATION_ID to operationId,
            MeetingUploadWorker.KEY_FILE_URI to fileUri,
            MeetingUploadWorker.KEY_MIME_TYPE to mimeType,
            MeetingUploadWorker.KEY_FILE_NAME to fileName
          )
        )
        .addTag(scopeTag(scope))
        .addTag(meetingUploadTag(scope, meetingId))
        .addTag(operationTag(operationId))
        .build()
      WorkManager.getInstance(requireContext()).enqueueUniqueWork(
        "laoji-meeting-upload:$scope:$operationId",
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
      mapOf("deletedFiles" to deletedFiles)
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
      "runAttemptCount" to info.runAttemptCount
    )
  }

  private fun scopeTag(scope: String) = "laoji-upload-scope:$scope"
  private fun operationTag(operationId: String) = "laoji-upload-operation:$operationId"
}
