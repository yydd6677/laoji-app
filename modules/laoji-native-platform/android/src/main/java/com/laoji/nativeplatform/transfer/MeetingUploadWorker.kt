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
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
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
    val durationMs = inputData.getLong(KEY_DURATION_MS, -1).takeIf { it >= 0 }
    val checksumSha256 = inputData.getString(KEY_CHECKSUM_SHA256)?.trim()?.takeIf { it.isNotEmpty() }
    val protocol = inputData.getString(KEY_PROTOCOL) ?: PROTOCOL_LEGACY
    val deletionStore = MeetingDeletionStore(applicationContext)
    if (deletionStore.isDeleted(scope, meetingId)) {
      return@withContext failure("meeting-deleted", operationId)
    }
    val lease = CredentialLeaseStore(applicationContext).get(scope, generation)
      ?: return@withContext failure("credential-expired", operationId)
    val uri = Uri.parse(fileUri)
    try {
      if (deletionStore.isDeleted(scope, meetingId)) {
        return@withContext failure("meeting-deleted", operationId)
      }
      when (protocol) {
        PROTOCOL_RECORDING_ASSETS_V2 -> uploadRecordingAssetV2(
          lease.apiBaseUrl,
          lease.accessToken,
          scope,
          meetingId,
          remoteMeetingId,
          operationId,
          uri,
          mimeType,
          fileName,
          expectedBytes,
          durationMs,
          checksumSha256,
          deletionStore
        )
        PROTOCOL_LEGACY -> uploadLegacy(
          lease.apiBaseUrl,
          lease.accessToken,
          scope,
          meetingId,
          remoteMeetingId,
          operationId,
          uri,
          mimeType,
          fileName,
          expectedBytes,
          deletionStore
        )
        else -> failure("invalid-input", operationId)
      }
    } catch (_: Exception) {
      Result.retry()
    }
  }

  private fun uploadLegacy(
    baseUrl: String,
    accessToken: String,
    scope: String,
    meetingId: String,
    remoteMeetingId: String,
    operationId: String,
    uri: Uri,
    mimeType: String,
    fileName: String,
    expectedBytes: Long?,
    deletionStore: MeetingDeletionStore
  ): Result {
    val endpoint = runCatching { legacyUploadEndpoint(baseUrl, remoteMeetingId) }
      .getOrElse { return failure("invalid-endpoint", operationId) }
    val multipart = MultipartBody.Builder()
      .setType(MultipartBody.FORM)
      .addFormDataPart(
        "file",
        fileName,
        ContentUriRequestBody(
          applicationContext.contentResolver,
          uri,
          mimeType.toMediaType(),
          expectedBytes
        )
      )
      .build()
    val request = Request.Builder()
      .url(endpoint)
      .header("Authorization", "Bearer $accessToken")
      .post(multipart)
      .build()
    client.newCall(request).execute().use { response ->
      if (deletionStore.isDeleted(scope, meetingId)) return failure("meeting-deleted", operationId)
      return when {
        response.isSuccessful -> Result.success(output("uploaded", operationId))
        isRetryableHttp(response.code) -> Result.retry()
        response.code == 401 || response.code == 403 -> failure("unauthorized", operationId)
        else -> failure("http-${response.code}", operationId)
      }
    }
  }

  private fun uploadRecordingAssetV2(
    baseUrl: String,
    accessToken: String,
    scope: String,
    meetingId: String,
    remoteMeetingId: String,
    operationId: String,
    uri: Uri,
    mimeType: String,
    fileName: String,
    expectedBytes: Long?,
    durationMs: Long?,
    checksumSha256: String?,
    deletionStore: MeetingDeletionStore
  ): Result {
    val clientAssetId = inputData.getString(KEY_RECORDING_ASSET_ID)?.trim().orEmpty()
    val role = inputData.getString(KEY_RECORDING_ROLE)?.trim().orEmpty()
    val origin = inputData.getString(KEY_RECORDING_ORIGIN)?.trim().orEmpty()
    if (
      clientAssetId.isEmpty()
      || role !in setOf("primary", "secondary")
      || origin !in setOf("captured", "imported", "recovered")
    ) return failure("invalid-input", operationId)
    val mediaType = mimeType.toMediaTypeOrNull() ?: return failure("invalid-input", operationId)

    val metadata = runCatching { resolveFileMetadata(uri, expectedBytes, checksumSha256) }
      .getOrElse { return failure("file-missing", operationId) }
    val registerEndpoint = runCatching { recordingRegisterEndpoint(baseUrl, remoteMeetingId) }
      .getOrElse { return failure("invalid-endpoint", operationId) }
    val registration = JSONObject()
      .put("schema_version", 2)
      .put("client_asset_id", clientAssetId)
      .put("role", role)
      .put("origin", origin)
      .put("mime_type", mimeType)
      .put("file_name", fileName)
      .put("byte_size", metadata.byteSize)
      .put("duration_ms", durationMs ?: JSONObject.NULL)
      .put("checksum_sha256", metadata.checksumSha256)
    val registerRequest = Request.Builder()
      .url(registerEndpoint)
      .header("Authorization", "Bearer $accessToken")
      .header("Accept", "application/json")
      .header("Content-Type", "application/json")
      .header("Idempotency-Key", idempotencyKey(operationId, "register"))
      .post(registration.toString().toRequestBody("application/json".toMediaType()))
      .build()

    val registered = client.newCall(registerRequest).execute().use { response ->
      if (deletionStore.isDeleted(scope, meetingId)) return failure("meeting-deleted", operationId)
      if (isRetryableHttp(response.code)) return Result.retry()
      if (response.code == 401 || response.code == 403) return failure("unauthorized", operationId)
      if (!response.isSuccessful) return failure("http-${response.code}", operationId)
      runCatching { parseAssetResponse(response.body?.string(), remoteMeetingId, clientAssetId) }
        .getOrElse { return failure("invalid-response", operationId) }
    }
    if (registered.uploaded) {
      return Result.success(output("uploaded", operationId, registered.remoteAssetId, registered.revision))
    }

    val contentEndpoint = runCatching { recordingContentEndpoint(baseUrl, registered.remoteAssetId) }
      .getOrElse { return failure("invalid-endpoint", operationId) }
    val body = ContentUriRequestBody(
      applicationContext.contentResolver,
      uri,
      mediaType,
      metadata.byteSize
    )
    val multipart = MultipartBody.Builder()
      .setType(MultipartBody.FORM)
      .addFormDataPart("file", fileName, body)
      .build()
    val contentRequest = Request.Builder()
      .url(contentEndpoint)
      .header("Authorization", "Bearer $accessToken")
      .header("Accept", "application/json")
      .header("Idempotency-Key", idempotencyKey(operationId, "content"))
      .header("If-Match", "\"${registered.revision}\"")
      .put(multipart)
      .build()
    client.newCall(contentRequest).execute().use { response ->
      if (deletionStore.isDeleted(scope, meetingId)) return failure("meeting-deleted", operationId)
      if (isRetryableHttp(response.code)) return Result.retry()
      if (response.code == 401 || response.code == 403) return failure("unauthorized", operationId)
      if (!response.isSuccessful) return failure("http-${response.code}", operationId)
      val uploaded = runCatching {
        parseAssetResponse(response.body?.string(), remoteMeetingId, clientAssetId)
      }.getOrElse { return failure("invalid-response", operationId) }
      if (!uploaded.uploaded || uploaded.remoteAssetId != registered.remoteAssetId) {
        return failure("invalid-response", operationId)
      }
      return Result.success(output("uploaded", operationId, uploaded.remoteAssetId, uploaded.revision))
    }
  }

  private data class FileMetadata(val byteSize: Long, val checksumSha256: String)

  private data class AssetResponse(
    val remoteAssetId: String,
    val revision: Long,
    val uploaded: Boolean
  )

  private fun resolveFileMetadata(
    uri: Uri,
    expectedBytes: Long?,
    expectedChecksum: String?
  ): FileMetadata {
    val normalizedChecksum = expectedChecksum?.lowercase()?.takeIf {
      it.matches(Regex("^sha256:[0-9a-f]{64}$"))
    }
    if (expectedBytes != null && normalizedChecksum != null) {
      return FileMetadata(expectedBytes, normalizedChecksum)
    }
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    val input = applicationContext.contentResolver.openInputStream(uri)
      ?: throw IllegalStateException("Meeting audio file cannot be opened")
    input.use { stream ->
      val buffer = ByteArray(256 * 1024)
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) break
        if (count == 0) continue
        digest.update(buffer, 0, count)
        total += count
      }
    }
    if (total <= 0) throw IllegalStateException("Meeting audio file is empty")
    if (expectedBytes != null && expectedBytes != total) {
      throw IllegalStateException("Meeting audio file size changed")
    }
    val actualChecksum = "sha256:${digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }}"
    if (normalizedChecksum != null && normalizedChecksum != actualChecksum) {
      throw IllegalStateException("Meeting audio checksum changed")
    }
    return FileMetadata(total, actualChecksum)
  }

  private fun parseAssetResponse(raw: String?, meetingId: String, clientAssetId: String): AssetResponse {
    val value = JSONObject(raw ?: throw IllegalStateException("Missing response"))
    require(value.getInt("schema_version") == 2)
    require(value.getString("meeting_id") == meetingId)
    require(value.getString("client_asset_id") == clientAssetId)
    val remoteAssetId = value.getString("id").trim()
    val revision = value.getLong("revision")
    val uploadState = value.getString("upload_state")
    require(remoteAssetId.isNotEmpty() && revision >= 1)
    require(uploadState == "registered" || uploadState == "uploaded")
    return AssetResponse(remoteAssetId, revision, uploadState == "uploaded")
  }

  private fun idempotencyKey(operationId: String, stage: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
      .digest("$operationId:$stage".toByteArray(StandardCharsets.UTF_8))
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    return "recording-asset-$stage-$digest"
  }

  private fun isRetryableHttp(code: Int): Boolean = code == 408 || code == 429 || code >= 500

  private fun legacyUploadEndpoint(baseUrl: String, meetingId: String): String {
    val base = URI(baseUrl.trim().trimEnd('/'))
    requireValidBase(base)
    val encoded = URLEncoder.encode(meetingId, StandardCharsets.UTF_8.toString())
    return "${base.toASCIIString()}/api/laoji/meetings/$encoded/audio"
  }

  private fun recordingRegisterEndpoint(baseUrl: String, meetingId: String): String {
    val base = URI(baseUrl.trim().trimEnd('/'))
    requireValidBase(base)
    val encoded = URLEncoder.encode(meetingId, StandardCharsets.UTF_8.toString())
    return "${base.toASCIIString()}/api/laoji/v2/meeting-notes/$encoded/recording-assets"
  }

  private fun recordingContentEndpoint(baseUrl: String, assetId: String): String {
    val base = URI(baseUrl.trim().trimEnd('/'))
    requireValidBase(base)
    val encoded = URLEncoder.encode(assetId, StandardCharsets.UTF_8.toString())
    return "${base.toASCIIString()}/api/laoji/v2/recording-assets/$encoded/content"
  }

  private fun requireValidBase(base: URI) {
    require(base.scheme == "https" || base.scheme == "http")
    require(base.host?.isNotBlank() == true && base.userInfo == null && base.query == null && base.fragment == null)
  }

  private fun output(
    state: String,
    operationId: String,
    remoteAssetId: String? = null,
    remoteRevision: Long? = null
  ): Data = Data.Builder()
    .putString(KEY_STATE, state)
    .putString(KEY_OPERATION_ID, operationId)
    .apply {
      if (remoteAssetId != null) putString(KEY_REMOTE_ASSET_ID, remoteAssetId)
      if (remoteRevision != null) putLong(KEY_REMOTE_REVISION, remoteRevision)
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
    const val KEY_GENERATION = "generation"
    const val KEY_MEETING_ID = "meetingId"
    const val KEY_REMOTE_MEETING_ID = "remoteMeetingId"
    const val KEY_OPERATION_ID = "operationId"
    const val KEY_FILE_URI = "fileUri"
    const val KEY_MIME_TYPE = "mimeType"
    const val KEY_FILE_NAME = "fileName"
    const val KEY_EXPECTED_BYTES = "expectedBytes"
    const val KEY_DURATION_MS = "durationMs"
    const val KEY_CHECKSUM_SHA256 = "checksumSha256"
    const val KEY_PROTOCOL = "protocol"
    const val KEY_RECORDING_ASSET_ID = "recordingAssetId"
    const val KEY_RECORDING_ROLE = "recordingRole"
    const val KEY_RECORDING_ORIGIN = "recordingOrigin"
    const val KEY_REMOTE_ASSET_ID = "remoteAssetId"
    const val KEY_REMOTE_REVISION = "remoteRevision"
    const val KEY_STATE = "state"
    const val KEY_REASON = "reason"

    const val PROTOCOL_LEGACY = "legacy"
    const val PROTOCOL_RECORDING_ASSETS_V2 = "recording-assets-v2"

    private val client = OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(180, TimeUnit.SECONDS)
      .writeTimeout(180, TimeUnit.SECONDS)
      .build()
  }
}
