package com.laoji.nativeplatform.transfer

// MIN-UPLOAD-001: WorkManager owns network constraints, retry, and process-death recovery.

import android.content.Context
import android.net.Uri
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

internal class MeetingUploadWorker(
  appContext: Context,
  params: WorkerParameters
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
    val scope = inputData.getString(KEY_SCOPE) ?: return@withContext failure("invalid-input")
    val generation = inputData.getLong(KEY_GENERATION, -1)
    val meetingId = inputData.getString(KEY_MEETING_ID) ?: return@withContext failure("invalid-input")
    val remoteMeetingId = inputData.getString(KEY_REMOTE_MEETING_ID) ?: meetingId
    val operationId = inputData.getString(KEY_OPERATION_ID) ?: return@withContext failure("invalid-input")
    val fileUri = inputData.getString(KEY_FILE_URI) ?: return@withContext failure("invalid-input")
    val mimeType = inputData.getString(KEY_MIME_TYPE) ?: "audio/wav"
    val fileName = inputData.getString(KEY_FILE_NAME) ?: "meeting.wav"
    val expectedBytes = inputData.getLong(KEY_EXPECTED_BYTES, -1).takeIf { it >= 0 }
    val deletionStore = MeetingDeletionStore(applicationContext)
    if (deletionStore.isDeleted(scope, meetingId)) {
      return@withContext failure("meeting-deleted", operationId)
    }
    val lease = CredentialLeaseStore(applicationContext).get(scope, generation)
      ?: return@withContext failure("credential-expired", operationId)
    val endpoint = runCatching { uploadEndpoint(lease.apiBaseUrl, remoteMeetingId) }
      .getOrElse { return@withContext failure("invalid-endpoint", operationId) }
    val uri = Uri.parse(fileUri)
    val body = ContentUriRequestBody(
      applicationContext.contentResolver,
      uri,
      mimeType.toMediaType(),
      expectedBytes
    )
    val multipart = MultipartBody.Builder()
      .setType(MultipartBody.FORM)
      .addFormDataPart("file", fileName, body)
      .build()
    val request = Request.Builder()
      .url(endpoint)
      .header("Authorization", "Bearer ${lease.accessToken}")
      .post(multipart)
      .build()

    try {
      if (deletionStore.isDeleted(scope, meetingId)) {
        return@withContext failure("meeting-deleted", operationId)
      }
      client.newCall(request).execute().use { response ->
        if (deletionStore.isDeleted(scope, meetingId)) {
          return@use failure("meeting-deleted", operationId)
        }
        when {
          response.isSuccessful -> Result.success(output("uploaded", operationId))
          response.code == 401 || response.code == 403 -> failure("unauthorized", operationId)
          response.code == 404 || response.code == 409 || response.code == 413 -> {
            failure("http-${response.code}", operationId)
          }
          response.code == 408 || response.code == 429 || response.code >= 500 -> Result.retry()
          else -> failure("http-${response.code}", operationId)
        }
      }
    } catch (_: Exception) {
      Result.retry()
    }
  }

  private fun uploadEndpoint(baseUrl: String, meetingId: String): String {
    val base = URI(baseUrl.trim().trimEnd('/'))
    require(base.scheme == "https" || base.scheme == "http")
    require(base.host?.isNotBlank() == true && base.userInfo == null && base.query == null && base.fragment == null)
    val encoded = URLEncoder.encode(meetingId, StandardCharsets.UTF_8.toString())
    return "${base.toASCIIString()}/api/laoji/meetings/$encoded/audio"
  }

  private fun output(state: String, operationId: String): Data = Data.Builder()
    .putString(KEY_STATE, state)
    .putString(KEY_OPERATION_ID, operationId)
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
    const val KEY_GENERATION = "generation"
    const val KEY_MEETING_ID = "meetingId"
    const val KEY_REMOTE_MEETING_ID = "remoteMeetingId"
    const val KEY_OPERATION_ID = "operationId"
    const val KEY_FILE_URI = "fileUri"
    const val KEY_MIME_TYPE = "mimeType"
    const val KEY_FILE_NAME = "fileName"
    const val KEY_EXPECTED_BYTES = "expectedBytes"
    const val KEY_STATE = "state"
    const val KEY_REASON = "reason"

    private val client = OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(90, TimeUnit.SECONDS)
      .writeTimeout(90, TimeUnit.SECONDS)
      .build()
  }
}
