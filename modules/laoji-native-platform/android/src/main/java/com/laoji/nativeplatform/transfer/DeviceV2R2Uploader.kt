package com.laoji.nativeplatform.transfer

import android.content.Context
import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.CancellationException
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.FileInputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.util.UUID

internal data class DeviceV2R2UploadInput(
  val deviceId: String,
  val deviceEpochId: String,
  val bindingId: String,
  val bindingGeneration: String,
  val bindingRevision: Long,
  val cancelRevision: Long,
  val operationId: String,
  val assetId: String,
  val assetGeneration: String,
  val uri: Uri,
  val mimeType: String,
  val byteSize: Long,
  val sourceSha256: String,
)

internal sealed class DeviceV2R2UploadOutcome {
  data class Success(
    val assetRevisionId: String,
    val objectRevision: Long,
    val transcriptionTaskId: String,
  ) : DeviceV2R2UploadOutcome()

  data class Failure(val reason: String) : DeviceV2R2UploadOutcome()
  data object Retry : DeviceV2R2UploadOutcome()
}

/** Stage 2 upload executor. It never falls back to a legacy ingress. */
internal class DeviceV2R2Uploader(
  context: Context,
  private val client: OkHttpClient,
  private val credentialStore: CredentialLeaseStore,
) {
  private val applicationContext = context.applicationContext

  suspend fun upload(
    credentialScope: String,
    queuedGeneration: Long,
    input: DeviceV2R2UploadInput,
  ): DeviceV2R2UploadOutcome {
    return try {
      val initialLease = credentialStore.get(credentialScope, queuedGeneration)
        ?: return DeviceV2R2UploadOutcome.Failure("credential-expired")
      validateSource(input)
      val identity = stableIdentity(input)
      val sessionId = "v2-upload-${identity.take(48)}"
      val taskId = "v2-transcript-${identity.take(48)}"
      val taskGenerationId = "v2-transcript-generation-${input.assetGeneration}"
      var lease = initialLease

    suspend fun apiJson(path: String, method: String, body: JSONObject? = null): JSONObject {
      val requestBody = body?.toString()?.toRequestBody(JSON_MEDIA_TYPE)
      var response = client.newCall(apiRequest(lease, path, method, requestBody)).execute()
      if (response.code == 401 && lease.deviceId != null) {
        response.close()
        lease = DeviceV2LeaseRefresher(client, credentialStore).refresh(lease)
        response = client.newCall(apiRequest(lease, path, method, requestBody)).execute()
      }
      response.use { value ->
        if (value.code == 408 || value.code == 429 || value.code >= 500) throw RetryableUploadException()
        if (!value.isSuccessful) throw TerminalUploadException("http-${value.code}")
        return JSONObject(value.body?.string() ?: throw TerminalUploadException("invalid-response"))
      }
    }

      val create = JSONObject()
        .put("schema_version", 2)
        .put("session_id", sessionId)
        .put("binding_id", input.bindingId)
        .put("binding_generation", input.bindingGeneration)
        .put("binding_revision", input.bindingRevision)
        .put("cancel_revision", input.cancelRevision)
        .put("client_operation_id", input.operationId)
        .put("asset_id", input.assetId)
        .put("asset_generation", input.assetGeneration)
        .put("expected_size", input.byteSize)
        .put("expected_sha256", input.sourceSha256)
        .put("mime_type", input.mimeType)
      var session = requireSession(apiJson("/uploads", "POST", create))

      if (session.getString("state") == "verified") {
        return complete(
          ::apiJson,
          sessionId,
          input,
          taskId,
          taskGenerationId,
          emptyList(),
        )
      }
      val probe = requireSession(apiJson("/uploads/$sessionId", "GET"))
      if (probe.optBoolean("object_completed", false)) {
        return complete(::apiJson, sessionId, input, taskId, taskGenerationId, emptyList())
      }

      when (session.getString("mode")) {
      "single" -> {
        val putUrl = session.optString("put_url").takeIf { it.isNotBlank() }
          ?: throw TerminalUploadException("invalid-response")
        putObject(
          putUrl,
          ContentUriRequestBody(
            applicationContext.contentResolver,
            input.uri,
            input.mimeType.toMediaType(),
            input.byteSize,
          ),
        )
      }
      "multipart" -> {
        // Create replays do not probe R2. GET is the authoritative recovery
        // point and returns both part numbers and their exact ETags.
        session = probe
        val totalParts = session.getInt("total_parts")
        val partSize = session.getLong("part_size")
        validateMultipartLayout(totalParts, partSize, input.byteSize)
        val receipts = uploadedReceipts(session, totalParts)
        val missing = (1..totalParts).filterNot(receipts::containsKey)
        for (batch in missing.chunked(MAX_PARALLEL_PARTS)) {
          val request = JSONObject()
            .put("schema_version", 2)
            .put("binding_generation", input.bindingGeneration)
            .put("binding_revision", input.bindingRevision)
            .put("cancel_revision", input.cancelRevision)
            .put("part_numbers", JSONArray(batch))
          val signed = apiJson("/uploads/$sessionId/parts", "POST", request)
          val urls = signed.getJSONArray("parts")
          val byNumber = (0 until urls.length()).associate { index ->
            val item = urls.getJSONObject(index)
            item.getInt("part_number") to item.getString("url")
          }
          val uploaded = coroutineScope {
            batch.map { partNumber ->
              async(Dispatchers.IO) {
                val offset = (partNumber - 1L) * partSize
                val length = minOf(partSize, input.byteSize - offset)
                val url = byNumber[partNumber] ?: throw TerminalUploadException("invalid-response")
                partNumber to putObject(
                  url,
                  ContentUriRangeRequestBody(
                    applicationContext.contentResolver,
                    input.uri,
                    input.mimeType.toMediaType(),
                    offset,
                    length,
                  ),
                  requireEtag = true,
                )
              }
            }.awaitAll()
          }
          uploaded.forEach { (partNumber, etag) -> receipts[partNumber] = etag }
        }
        if (receipts.size != totalParts) throw RetryableUploadException()
        val ordered = receipts.entries.sortedBy { it.key }.map { it.key to it.value }
        return complete(::apiJson, sessionId, input, taskId, taskGenerationId, ordered)
      }
      else -> throw TerminalUploadException("invalid-response")
      }
      complete(::apiJson, sessionId, input, taskId, taskGenerationId, emptyList())
    } catch (_: RetryableUploadException) {
      DeviceV2R2UploadOutcome.Retry
    } catch (error: TerminalUploadException) {
      DeviceV2R2UploadOutcome.Failure(error.reason)
    } catch (_: JSONException) {
      DeviceV2R2UploadOutcome.Failure("invalid-response")
    } catch (_: IllegalArgumentException) {
      DeviceV2R2UploadOutcome.Failure("invalid-input")
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      DeviceV2R2UploadOutcome.Retry
    }
  }

  private suspend fun complete(
    apiJson: suspend (String, String, JSONObject?) -> JSONObject,
    sessionId: String,
    input: DeviceV2R2UploadInput,
    taskId: String,
    taskGenerationId: String,
    parts: List<Pair<Int, String>>,
  ): DeviceV2R2UploadOutcome.Success {
    val partArray = JSONArray()
    parts.forEach { (partNumber, etag) ->
      partArray.put(JSONObject().put("part_number", partNumber).put("etag", etag))
    }
    val body = JSONObject()
      .put("schema_version", 2)
      .put("binding_generation", input.bindingGeneration)
      .put("binding_revision", input.bindingRevision)
      .put("cancel_revision", input.cancelRevision)
      .put("parts", partArray)
      .put("transcription_task_id", taskId)
      .put("transcription_generation_id", taskGenerationId)
      .put("transcription_input_sha256", input.sourceSha256)
    val response = apiJson("/uploads/$sessionId/complete", "POST", body)
    val asset = response.getJSONObject("verified_asset")
    val task = response.getJSONObject("task")
    val assetRevisionId = asset.getString("asset_revision_id").trim()
    val objectRevision = asset.getLong("object_revision")
    val transcriptionTaskId = task.getString("task_id").trim()
    if (assetRevisionId.isEmpty() || objectRevision < 1 || transcriptionTaskId.isEmpty()) {
      throw TerminalUploadException("invalid-response")
    }
    return DeviceV2R2UploadOutcome.Success(
      assetRevisionId,
      objectRevision,
      transcriptionTaskId,
    )
  }

  private fun apiRequest(
    lease: CredentialLease,
    path: String,
    method: String,
    body: RequestBody?,
  ): Request {
    val deviceId = lease.deviceId ?: throw TerminalUploadException("invalid-credential")
    val epochId = lease.deviceEpochId ?: throw TerminalUploadException("invalid-credential")
    return Request.Builder()
      .url("${lease.apiBaseUrl.trimEnd('/')}/api/device/v2$path")
      .header("Authorization", "Bearer ${lease.accessToken}")
      .header("X-Laoji-Device-Id", deviceId)
      .header("X-Laoji-Epoch-Id", epochId)
      .header("Accept", "application/json")
      .method(method, body)
      .build()
  }

  private fun requireSession(root: JSONObject): JSONObject {
    if (root.getInt("schema_version") != 2) throw TerminalUploadException("invalid-response")
    return root.getJSONObject("session")
  }

  private fun uploadedReceipts(session: JSONObject, totalParts: Int): MutableMap<Int, String> {
    val result = linkedMapOf<Int, String>()
    val parts = session.optJSONArray("uploaded_parts") ?: JSONArray()
    for (index in 0 until parts.length()) {
      val item = parts.getJSONObject(index)
      val number = item.getInt("part_number")
      val etag = item.getString("etag").trim()
      if (number !in 1..totalParts || etag.isEmpty() || result.put(number, etag) != null) {
        throw TerminalUploadException("invalid-response")
      }
    }
    return result
  }

  private fun putObject(url: String, body: RequestBody, requireEtag: Boolean = false): String {
    val request = Request.Builder().url(url).put(body).build()
    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) throw RetryableUploadException()
      val etag = response.header("ETag")?.trim()?.takeIf { it.isNotEmpty() }
      if (requireEtag && etag == null) throw RetryableUploadException()
      return etag ?: "single"
    }
  }

  private fun stableIdentity(input: DeviceV2R2UploadInput): String {
    val value = "${input.deviceEpochId}\u0000${input.assetId}\u0000${input.assetGeneration}"
    return MessageDigest.getInstance("SHA-256")
      .digest(value.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun validateSource(input: DeviceV2R2UploadInput) {
    try {
      val descriptor = applicationContext.contentResolver.openAssetFileDescriptor(input.uri, "r")
        ?: throw TerminalUploadException("file-missing")
      descriptor.use { asset ->
        if (asset.length >= 0 && asset.length != input.byteSize) {
          throw TerminalUploadException("file-changed")
        }
        FileInputStream(asset.fileDescriptor).use { stream ->
          stream.channel.position(asset.startOffset)
          val digest = MessageDigest.getInstance("SHA-256")
          val buffer = ByteArray(1024 * 1024)
          var total = 0L
          while (true) {
            val read = stream.read(buffer)
            if (read <= 0) break
            total += read
            if (total > input.byteSize) throw TerminalUploadException("file-changed")
            digest.update(buffer, 0, read)
          }
          if (total != input.byteSize) throw TerminalUploadException("file-changed")
          val actual = "sha256:" + digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
          if (actual != input.sourceSha256.lowercase()) throw TerminalUploadException("file-changed")
        }
      }
    } catch (error: TerminalUploadException) {
      throw error
    } catch (_: SecurityException) {
      throw TerminalUploadException("file-missing")
    } catch (_: Exception) {
      throw TerminalUploadException("file-missing")
    }
  }

  private fun validateMultipartLayout(totalParts: Int, partSize: Long, byteSize: Long) {
    if (totalParts !in 1..10_000 || partSize < 5L * 1024L * 1024L || byteSize < 1L) {
      throw TerminalUploadException("invalid-response")
    }
    val expectedParts = (byteSize + partSize - 1L) / partSize
    if (expectedParts != totalParts.toLong()) throw TerminalUploadException("invalid-response")
  }

  private companion object {
    val JSON_MEDIA_TYPE = "application/json".toMediaType()
    const val MAX_PARALLEL_PARTS = 2
  }
}

internal class DeviceV2LeaseRefresher(
  private val client: OkHttpClient,
  private val store: CredentialLeaseStore,
) {
  fun refresh(lease: CredentialLease): CredentialLease {
    val deviceId = lease.deviceId ?: throw TerminalUploadException("invalid-credential")
    val epochId = lease.deviceEpochId ?: throw TerminalUploadException("invalid-credential")
    val keyVersion = lease.keyVersion ?: throw TerminalUploadException("invalid-credential")
    val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
    val entry = keyStore.getEntry("$DEVICE_KEY_PREFIX$keyVersion", null) as? KeyStore.PrivateKeyEntry
      ?: throw TerminalUploadException("device-key-missing")
    val publicHash = MessageDigest.getInstance("SHA-256")
      .digest(entry.certificate.publicKey.encoded)
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    val requestId = "native-auth-${UUID.randomUUID()}"
    val challengeBody = JSONObject()
      .put("schema_version", 2)
      .put("device_id", deviceId)
      .put("epoch_id", epochId)
      .put("key_version", keyVersion)
      .put("public_key_hash", publicHash)
      .put("request_id", requestId)
    val challenge = plainJson(lease, "/auth/challenges", challengeBody)
    val nonce = challenge.getString("nonce")
    val message = "laoji-device-v2\nauth\n$nonce\n$deviceId\n$epochId\n$requestId"
    val signer = Signature.getInstance("SHA256withECDSA")
    signer.initSign(entry.privateKey)
    signer.update(message.toByteArray(Charsets.UTF_8))
    val signature = Base64.encodeToString(
      signer.sign(),
      Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )
    val token = plainJson(
      lease,
      "/auth/tokens",
      JSONObject()
        .put("schema_version", 2)
        .put("challenge_id", challenge.getString("challenge_id"))
        .put("nonce", nonce)
        .put("signature", signature)
        .put("request_id", requestId),
    )
    val expires = token.getLong("expires_at")
    val refreshed = lease.copy(
      accessToken = token.getString("access_token"),
      expiresAtMs = if (expires < 1_000_000_000_000L) expires * 1000 else expires,
    )
    store.put(refreshed)
    return refreshed
  }

  private fun plainJson(lease: CredentialLease, path: String, body: JSONObject): JSONObject {
    val request = Request.Builder()
      .url("${lease.apiBaseUrl.trimEnd('/')}/api/device/v2$path")
      .header("Accept", "application/json")
      .post(body.toString().toRequestBody("application/json".toMediaType()))
      .build()
    client.newCall(request).execute().use { response ->
      if (response.code == 408 || response.code == 429 || response.code >= 500) throw RetryableUploadException()
      if (!response.isSuccessful) throw TerminalUploadException("unauthorized")
      return JSONObject(response.body?.string() ?: throw TerminalUploadException("invalid-response"))
    }
  }

  private companion object {
    const val ANDROID_KEY_STORE = "AndroidKeyStore"
    const val DEVICE_KEY_PREFIX = "laoji.device.v2.key."
  }
}

private class RetryableUploadException : RuntimeException()
private class TerminalUploadException(val reason: String) : RuntimeException(reason)
