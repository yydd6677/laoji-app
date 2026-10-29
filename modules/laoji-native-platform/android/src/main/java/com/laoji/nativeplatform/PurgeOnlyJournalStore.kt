package com.laoji.nativeplatform

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class PurgeOnlyRow(
  val scopeKind: String,
  val capabilityId: String,
  val capabilitySecret: String,
  val deviceEpochId: String,
  val bindingId: String?,
  val bindingGeneration: String?,
  val registrationRequestId: String,
  val purgeRequestId: String?,
  val state: String,
  val nextRetryAt: Long,
  val createdAt: Long,
  val lastErrorCode: String?,
)

/** Native-only durable owner for credentials that survive ordinary app data erasure. */
internal class PurgeOnlyJournalStore(context: Context) {
  private val applicationContext = context.applicationContext
  private val directory = File(applicationContext.noBackupFilesDir, JOURNAL_DIRECTORY)
  private val atomicFile = AtomicFile(File(directory, JOURNAL_FILE))

  @Synchronized
  fun prepare(
    scopeKind: String,
    deviceEpochId: String,
    bindingId: String?,
    bindingGeneration: String?,
    registrationRequestId: String,
  ): Map<String, Any> {
    val scope = requireScope(scopeKind)
    val epoch = requireUuid(deviceEpochId, "epoch")
    val normalizedBinding = if (scope == "binding") requireUuid(bindingId.orEmpty(), "binding") else null
    val generation = if (scope == "binding") requireOpaque(bindingGeneration.orEmpty(), "binding generation", 256) else null
    val registration = requireOpaque(registrationRequestId, "registration request", 180)
    val rows = load().toMutableList()
    val existing = rows.firstOrNull {
      it.scopeKind == scope && it.deviceEpochId == epoch
        && it.bindingId == normalizedBinding && it.bindingGeneration == generation
    }
    if (existing != null) return publicRegistration(existing)
    require(rows.size < MAX_ROWS) { "清理凭据数量已达上限" }
    val secretBytes = ByteArray(32).also(SecureRandom()::nextBytes)
    val row = PurgeOnlyRow(
      scopeKind = scope,
      capabilityId = UUID.randomUUID().toString(),
      capabilitySecret = encodeBase64(secretBytes),
      deviceEpochId = epoch,
      bindingId = normalizedBinding,
      bindingGeneration = generation,
      registrationRequestId = registration,
      purgeRequestId = null,
      state = "registering",
      nextRetryAt = 0,
      createdAt = System.currentTimeMillis(),
      lastErrorCode = null,
    )
    rows += row
    save(rows)
    return publicRegistration(row)
  }

  @Synchronized
  fun markArmed(capabilityId: String) {
    val id = requireUuid(capabilityId, "capability")
    val rows = load().toMutableList()
    val index = rows.indexOfFirst { it.capabilityId == id }
    require(index >= 0) { "清理凭据不存在" }
    val row = rows[index]
    if (row.state == "registering") {
      rows[index] = row.copy(state = "armed", lastErrorCode = null)
      save(rows)
    }
  }

  @Synchronized
  fun beginErase(): Map<String, Any> {
    val rows = load().map { row ->
      when (row.state) {
        "armed" -> row.copy(state = "pending", lastErrorCode = null)
        "registering" -> row.copy(state = "pending_probe", lastErrorCode = null)
        else -> row
      }
    }
    if (rows.isNotEmpty()) save(rows)
    return status(rows)
  }

  @Synchronized
  fun status(): Map<String, Any> = status(load())

  @Synchronized
  fun resume(apiBase: String): Map<String, Any> {
    val base = requireApiBase(apiBase)
    var rows = load().toMutableList()
    var confirmed = 0
    var confirmedAbsent = 0
    for (original in rows.toList()) {
      if (original.state !in setOf("pending_probe", "pending", "executing")) continue
      if (original.nextRetryAt > System.currentTimeMillis()) continue
      var row = original
      val requestId = row.purgeRequestId ?: UUID.randomUUID().toString()
      if (row.purgeRequestId == null) {
        row = row.copy(purgeRequestId = requestId)
        replaceAndSave(rows, row)
      }
      try {
        if (row.state == "pending_probe" || row.state == "executing") {
          val probe = request(base, row, requestId, "GET")
          if (probe.httpStatus == 404 && probe.errorCode == "CAPABILITY_NOT_REGISTERED" && row.state == "pending_probe") {
            rows.removeAll { it.capabilityId == row.capabilityId }
            saveOrClear(rows)
            confirmedAbsent += 1
            continue
          }
          if (probe.httpStatus !in 200..299) throw PurgeRemoteException(probe.errorCode ?: "PURGE_STATUS_RETRY")
          if (probe.state == "confirmed") {
            rows.removeAll { it.capabilityId == row.capabilityId }
            saveOrClear(rows)
            confirmed += 1
            continue
          }
        }
        row = row.copy(state = "executing", lastErrorCode = null)
        replaceAndSave(rows, row)
        val executed = request(base, row, requestId, "POST")
        if (executed.httpStatus !in 200..299) throw PurgeRemoteException(executed.errorCode ?: "PURGE_EXECUTE_RETRY")
        if (executed.state == "confirmed") {
          rows.removeAll { it.capabilityId == row.capabilityId }
          saveOrClear(rows)
          confirmed += 1
        } else {
          val pending = row.copy(state = "pending", nextRetryAt = System.currentTimeMillis() + RETRY_DELAY_MS)
          replaceAndSave(rows, pending)
        }
      } catch (error: Exception) {
        val code = when (error) {
          is PurgeRemoteException -> sanitizeError(error.code)
          else -> "PURGE_NETWORK_RETRY"
        }
        val pending = row.copy(
          state = if (original.state == "pending_probe") "pending_probe" else "pending",
          nextRetryAt = System.currentTimeMillis() + RETRY_DELAY_MS,
          lastErrorCode = code,
        )
        replaceAndSave(rows, pending)
      }
    }
    return status(rows) + mapOf("confirmedNow" to confirmed, "confirmedAbsentNow" to confirmedAbsent)
  }

  private fun replaceAndSave(rows: MutableList<PurgeOnlyRow>, row: PurgeOnlyRow) {
    val index = rows.indexOfFirst { it.capabilityId == row.capabilityId }
    require(index >= 0) { "清理凭据不存在" }
    rows[index] = row
    save(rows)
  }

  private fun publicRegistration(row: PurgeOnlyRow): Map<String, Any> = mapOf(
    "capabilityId" to row.capabilityId,
    "secretSha256" to sha256(row.capabilitySecret.toByteArray(Charsets.US_ASCII)),
    "registrationRequestId" to row.registrationRequestId,
    "scopeKind" to row.scopeKind,
  )

  private fun status(rows: List<PurgeOnlyRow>): Map<String, Any> = mapOf(
    "schemaVersion" to 1,
    "rowCount" to rows.size,
    "registering" to rows.count { it.state == "registering" },
    "armed" to rows.count { it.state == "armed" },
    "pending" to rows.count { it.state in setOf("pending_probe", "pending", "executing") },
  )

  private fun request(base: String, row: PurgeOnlyRow, requestId: String, method: String): RemoteResult {
    val endpoint = URL("$base/api/device/v2/purge-capabilities/${row.capabilityId}${if (method == "POST") "/execute" else ""}")
    val connection = endpoint.openConnection() as HttpURLConnection
    return try {
      connection.requestMethod = method
      connection.connectTimeout = HTTP_TIMEOUT_MS
      connection.readTimeout = HTTP_TIMEOUT_MS
      connection.setRequestProperty("Authorization", "LaojiPurge ${row.capabilitySecret}")
      connection.setRequestProperty("X-Laoji-Purge-Request-Id", requestId)
      connection.setRequestProperty("Accept", "application/json")
      if (method == "POST") {
        connection.doOutput = true
        connection.setFixedLengthStreamingMode(0)
        connection.outputStream.use { it.flush() }
      }
      val status = connection.responseCode
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText().take(MAX_RESPONSE_CHARS) }.orEmpty()
      val json = runCatching { JSONObject(body) }.getOrNull()
      val detail = json?.optJSONObject("detail")
      RemoteResult(
        httpStatus = status,
        state = json?.optString("state")?.takeIf { it in setOf("pending", "running", "confirmed") },
        errorCode = sanitizeError(detail?.optString("code") ?: json?.optString("code")),
      )
    } finally {
      connection.disconnect()
    }
  }

  private fun requireApiBase(value: String): String {
    val normalized = value.trim().trimEnd('/')
    val uri = URI(normalized)
    val local = uri.host in setOf("127.0.0.1", "localhost", "10.0.2.2")
    require(uri.scheme == "https" || (uri.scheme == "http" && local)) { "清理服务地址必须使用 HTTPS" }
    require(uri.rawQuery == null && uri.rawFragment == null && uri.path.orEmpty().trim('/') == "") { "清理服务地址无效" }
    return normalized
  }

  private fun load(): List<PurgeOnlyRow> {
    if (!atomicFile.baseFile.isFile) return emptyList()
    val plaintext = decrypt(atomicFile.readFully())
    val root = JSONObject(String(plaintext, Charsets.UTF_8))
    require(root.optInt("schemaVersion") == 1) { "清理日志版本无效" }
    val array = root.getJSONArray("rows")
    require(array.length() <= MAX_ROWS) { "清理日志过大" }
    return (0 until array.length()).map { index -> decodeRow(array.getJSONObject(index)) }
  }

  private fun save(rows: List<PurgeOnlyRow>) {
    require(rows.size <= MAX_ROWS) { "清理日志过大" }
    directory.mkdirs()
    val array = JSONArray()
    rows.forEach { array.put(encodeRow(it)) }
    val plaintext = JSONObject().put("schemaVersion", 1).put("rows", array).toString().toByteArray(Charsets.UTF_8)
    require(plaintext.size <= MAX_PLAINTEXT_BYTES) { "清理日志过大" }
    val encrypted = encrypt(plaintext)
    var stream: FileOutputStream? = null
    try {
      val output = atomicFile.startWrite()
      stream = output
      output.write(encrypted)
      output.fd.sync()
      atomicFile.finishWrite(output)
      stream = null
    } catch (error: Exception) {
      stream?.let(atomicFile::failWrite)
      throw error
    }
  }

  private fun saveOrClear(rows: List<PurgeOnlyRow>) {
    if (rows.isNotEmpty()) {
      save(rows)
      return
    }
    atomicFile.delete()
    runCatching { keyStore().deleteEntry(KEY_ALIAS) }
    runCatching { directory.delete() }
  }

  private fun encodeRow(row: PurgeOnlyRow): JSONObject = JSONObject()
    .put("scopeKind", row.scopeKind)
    .put("capabilityId", row.capabilityId)
    .put("capabilitySecret", row.capabilitySecret)
    .put("deviceEpochId", row.deviceEpochId)
    .put("bindingId", row.bindingId)
    .put("bindingGeneration", row.bindingGeneration)
    .put("registrationRequestId", row.registrationRequestId)
    .put("purgeRequestId", row.purgeRequestId)
    .put("state", row.state)
    .put("nextRetryAt", row.nextRetryAt)
    .put("createdAt", row.createdAt)
    .put("lastErrorCode", row.lastErrorCode)

  private fun decodeRow(value: JSONObject): PurgeOnlyRow {
    val scope = requireScope(value.getString("scopeKind"))
    return PurgeOnlyRow(
      scopeKind = scope,
      capabilityId = requireUuid(value.getString("capabilityId"), "capability"),
      capabilitySecret = requireOpaque(value.getString("capabilitySecret"), "capability secret", 64),
      deviceEpochId = requireUuid(value.getString("deviceEpochId"), "epoch"),
      bindingId = value.optString("bindingId").takeIf { it.isNotBlank() }?.let { requireUuid(it, "binding") },
      bindingGeneration = value.optString("bindingGeneration").takeIf { it.isNotBlank() },
      registrationRequestId = requireOpaque(value.getString("registrationRequestId"), "registration request", 180),
      purgeRequestId = value.optString("purgeRequestId").takeIf { it.isNotBlank() },
      state = value.getString("state").also { require(it in VALID_STATES) },
      nextRetryAt = value.optLong("nextRetryAt", 0),
      createdAt = value.getLong("createdAt"),
      lastErrorCode = sanitizeError(value.optString("lastErrorCode")),
    ).also {
      require((scope == "epoch" && it.bindingId == null && it.bindingGeneration == null)
        || (scope == "binding" && it.bindingId != null && !it.bindingGeneration.isNullOrBlank()))
    }
  }

  private fun encrypt(plaintext: ByteArray): ByteArray {
    val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
    cipher.updateAAD(AAD)
    val ciphertext = cipher.doFinal(plaintext)
    return ByteArrayOutputStream().also { output ->
      DataOutputStream(output).use { data ->
        data.writeInt(ENVELOPE_MAGIC)
        data.writeInt(ENVELOPE_VERSION)
        data.writeInt(cipher.iv.size)
        data.write(cipher.iv)
        data.writeInt(ciphertext.size)
        data.write(ciphertext)
      }
    }.toByteArray()
  }

  private fun decrypt(envelope: ByteArray): ByteArray = DataInputStream(ByteArrayInputStream(envelope)).use { data ->
    require(data.readInt() == ENVELOPE_MAGIC && data.readInt() == ENVELOPE_VERSION) { "清理日志信封无效" }
    val ivSize = data.readInt()
    require(ivSize == 12) { "清理日志 IV 无效" }
    val iv = ByteArray(ivSize).also(data::readFully)
    val ciphertextSize = data.readInt()
    require(ciphertextSize in 1..MAX_CIPHERTEXT_BYTES) { "清理日志密文无效" }
    val ciphertext = ByteArray(ciphertextSize).also(data::readFully)
    require(data.available() == 0) { "清理日志包含尾随数据" }
    val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(128, iv))
    cipher.updateAAD(AAD)
    cipher.doFinal(ciphertext)
  }

  private fun encryptionKey(): SecretKey {
    val store = keyStore()
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).apply {
      init(
        KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setRandomizedEncryptionRequired(true)
          .build(),
      )
    }.generateKey()
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
  private fun requireScope(value: String): String = value.trim().lowercase().also { require(it in setOf("epoch", "binding")) }
  private fun requireUuid(value: String, field: String): String = value.trim().lowercase().also {
    require(runCatching { UUID.fromString(it).toString() == it }.getOrDefault(false)) { "$field 无效" }
  }
  private fun requireOpaque(value: String, field: String, maximum: Int): String = value.trim().also {
    require(it.isNotEmpty() && it.length <= maximum && it.none { char -> char.code < 32 || char.code == 127 }) { "$field 无效" }
  }
  private fun encodeBase64(value: ByteArray): String = Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  private fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
  private fun sanitizeError(value: String?): String? = value?.trim()?.uppercase()?.takeIf {
    it.matches(Regex("^[A-Z0-9_]{1,80}$"))
  }

  private data class RemoteResult(val httpStatus: Int, val state: String?, val errorCode: String?)
  private class PurgeRemoteException(val code: String) : RuntimeException(code)

  companion object {
    private const val ANDROID_KEY_STORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "laoji_purge_only_v1"
    private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
    private const val JOURNAL_DIRECTORY = "purge-only"
    private const val JOURNAL_FILE = "journal-v1.bin"
    private const val ENVELOPE_MAGIC = 0x4c4a504a
    private const val ENVELOPE_VERSION = 1
    private const val MAX_ROWS = 4096
    private const val MAX_PLAINTEXT_BYTES = 4 * 1_048_576
    private const val MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 4096
    private const val MAX_RESPONSE_CHARS = 16_384
    private const val HTTP_TIMEOUT_MS = 15_000
    private const val RETRY_DELAY_MS = 30_000L
    private val AAD = "LAOJI-PURGE-ONLY-JOURNAL-V1".toByteArray(Charsets.US_ASCII)
    private val VALID_STATES = setOf("registering", "armed", "pending_probe", "pending", "executing")
  }
}
