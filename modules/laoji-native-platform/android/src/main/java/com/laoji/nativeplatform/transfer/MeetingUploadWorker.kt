package com.laoji.nativeplatform.transfer

// MIN-UPLOAD-001: WorkManager owns network constraints, retry, and process-death recovery.

import android.content.Context
import android.net.Uri
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

internal class MeetingUploadWorker(
  appContext: Context,
  params: WorkerParameters
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
    val scope = inputData.getString(KEY_SCOPE) ?: return@withContext failure("invalid-input")
    val credentialScope = inputData.getString(KEY_CREDENTIAL_SCOPE) ?: scope
    val generation = inputData.getLong(KEY_GENERATION, -1)
    val meetingId = inputData.getString(KEY_MEETING_ID) ?: return@withContext failure("invalid-input")
    val operationId = inputData.getString(KEY_OPERATION_ID) ?: return@withContext failure("invalid-input")
    val protocol = inputData.getString(KEY_PROTOCOL)
    if (protocol != PROTOCOL_DEVICE_V2_R2) return@withContext failure("invalid-input", operationId)
    val fileUri = inputData.getString(KEY_FILE_URI) ?: return@withContext failure("invalid-input")
    val mimeType = inputData.getString(KEY_MIME_TYPE) ?: "audio/wav"
    val expectedBytes = inputData.getLong(KEY_EXPECTED_BYTES, -1).takeIf { it >= 0 }
    val checksumSha256 = inputData.getString(KEY_CHECKSUM_SHA256)?.trim()?.takeIf { it.isNotEmpty() }
    val deletionStore = MeetingDeletionStore(applicationContext)
    if (deletionStore.isDeleted(scope, meetingId)) {
      return@withContext failure("meeting-deleted", operationId)
    }
    val credentialStore = CredentialLeaseStore(applicationContext)
    val lease = credentialStore.get(credentialScope, generation)
      ?: return@withContext failure("credential-expired", operationId)
    val uri = Uri.parse(fileUri)
    try {
      if (deletionStore.isDeleted(scope, meetingId)) {
        return@withContext failure("meeting-deleted", operationId)
      }
      uploadDeviceV2R2(
        lease,
        credentialStore,
        credentialScope,
        generation,
        scope,
        meetingId,
        operationId,
        uri,
        mimeType,
        expectedBytes,
        checksumSha256,
        deletionStore,
      )
    } catch (error: CancellationException) {
      // WorkManager cancellation is terminal for this attempt. Never turn a
      // user delete/stop into a new retry that can resurrect the upload.
      throw error
    } catch (_: Exception) {
      Result.retry()
    }
  }

  private suspend fun uploadDeviceV2R2(
    lease: CredentialLease,
    credentialStore: CredentialLeaseStore,
    credentialScope: String,
    generation: Long,
    scope: String,
    meetingId: String,
    operationId: String,
    uri: Uri,
    mimeType: String,
    expectedBytes: Long?,
    checksumSha256: String?,
    deletionStore: MeetingDeletionStore,
  ): Result {
    val deviceId = inputData.getString(KEY_DEVICE_ID)?.trim().orEmpty()
    val deviceEpochId = inputData.getString(KEY_DEVICE_EPOCH_ID)?.trim().orEmpty()
    val bindingId = inputData.getString(KEY_BINDING_ID)?.trim().orEmpty()
    val bindingGeneration = inputData.getString(KEY_BINDING_GENERATION)?.trim().orEmpty()
    val bindingRevision = inputData.getLong(KEY_BINDING_REVISION, -1)
    val cancelRevision = inputData.getLong(KEY_CANCEL_REVISION, -1)
    val assetId = inputData.getString(KEY_RECORDING_ASSET_ID)?.trim().orEmpty()
    val assetGeneration = inputData.getString(KEY_ASSET_GENERATION)?.trim().orEmpty()
    if (
      deviceId.isEmpty()
      || deviceEpochId.isEmpty()
      || bindingId.isEmpty()
      || !bindingGeneration.matches(Regex("^[0-9a-f]{32}$"))
      || bindingRevision < 1
      || cancelRevision < 0
      || assetId.isEmpty()
      || !assetGeneration.matches(Regex("^[0-9a-f]{32}$"))
      || expectedBytes == null
      || expectedBytes < 1
      || checksumSha256 == null
      || !checksumSha256.matches(Regex("^sha256:[0-9a-f]{64}$"))
      || lease.deviceId != deviceId
      || lease.deviceEpochId != deviceEpochId
    ) return failure("invalid-input", operationId)
    val outcome = DeviceV2R2Uploader(applicationContext, client, credentialStore).upload(
      credentialScope,
      generation,
      DeviceV2R2UploadInput(
        deviceId = deviceId,
        deviceEpochId = deviceEpochId,
        bindingId = bindingId,
        bindingGeneration = bindingGeneration,
        bindingRevision = bindingRevision,
        cancelRevision = cancelRevision,
        operationId = operationId,
        assetId = assetId,
        assetGeneration = assetGeneration,
        uri = uri,
        mimeType = mimeType,
        byteSize = expectedBytes,
        sourceSha256 = checksumSha256,
      ),
    )
    if (deletionStore.isDeleted(scope, meetingId)) {
      return failure("meeting-deleted", operationId)
    }
    return when (outcome) {
      is DeviceV2R2UploadOutcome.Success -> Result.success(
        output(
          "uploaded",
          operationId,
          outcome.assetRevisionId,
          outcome.objectRevision,
          outcome.transcriptionTaskId,
        )
      )
      is DeviceV2R2UploadOutcome.Failure -> failure(outcome.reason, operationId)
      DeviceV2R2UploadOutcome.Retry -> Result.retry()
    }
  }

  private fun output(
    state: String,
    operationId: String,
    remoteAssetId: String? = null,
    remoteRevision: Long? = null,
    transcriptionTaskId: String? = null,
  ): Data = Data.Builder()
    .putString(KEY_STATE, state)
    .putString(KEY_OPERATION_ID, operationId)
    .apply {
      if (remoteAssetId != null) putString(KEY_REMOTE_ASSET_ID, remoteAssetId)
      if (remoteRevision != null) putLong(KEY_REMOTE_REVISION, remoteRevision)
      if (transcriptionTaskId != null) putString(KEY_TRANSCRIPTION_TASK_ID, transcriptionTaskId)
    }
    .build()

  private fun failure(reason: String, operationId: String = ""): Result = Result.failure(
    Data.Builder()
      .putString(KEY_STATE, "failed")
      .putString(KEY_REASON, reason)
      .putString(KEY_OPERATION_ID, operationId)
      .build()
  )

  companion object {
    const val KEY_SCOPE = "scope"
    const val KEY_CREDENTIAL_SCOPE = "credentialScope"
    const val KEY_GENERATION = "generation"
    const val KEY_MEETING_ID = "meetingId"
    const val KEY_OPERATION_ID = "operationId"
    const val KEY_FILE_URI = "fileUri"
    const val KEY_MIME_TYPE = "mimeType"
    const val KEY_EXPECTED_BYTES = "expectedBytes"
    const val KEY_CHECKSUM_SHA256 = "checksumSha256"
    const val KEY_PROTOCOL = "protocol"
    const val KEY_RECORDING_ASSET_ID = "recordingAssetId"
    const val KEY_REMOTE_ASSET_ID = "remoteAssetId"
    const val KEY_REMOTE_REVISION = "remoteRevision"
    const val KEY_TRANSCRIPTION_TASK_ID = "transcriptionTaskId"
    const val KEY_DEVICE_ID = "deviceId"
    const val KEY_DEVICE_EPOCH_ID = "deviceEpochId"
    const val KEY_BINDING_ID = "bindingId"
    const val KEY_BINDING_GENERATION = "bindingGeneration"
    const val KEY_BINDING_REVISION = "bindingRevision"
    const val KEY_CANCEL_REVISION = "cancelRevision"
    const val KEY_ASSET_GENERATION = "assetGeneration"
    const val KEY_STATE = "state"
    const val KEY_REASON = "reason"

    const val PROTOCOL_DEVICE_V2_R2 = "device-v2-r2"

    private val client = OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(180, TimeUnit.SECONDS)
      .writeTimeout(180, TimeUnit.SECONDS)
      .build()
  }
}
