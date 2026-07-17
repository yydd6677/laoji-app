package com.laoji.nativeplatform.media

// MIN-PLAYER-RECOVERY-001: portable recovery policy and encrypted-payload codec.

import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException
import java.net.URI
import kotlin.math.abs

const val MIN_PLAYER_RECOVERY_EVIDENCE_ID = "MIN-PLAYER-RECOVERY-001"
internal const val MINUTES_SIGNED_OUT_SCOPE = "signed_out"
internal const val MINUTES_RECOVERY_MAX_UNDATED_HTTPS_AGE_MS = 6L * 60L * 60L * 1_000L
internal const val MINUTES_RECOVERY_PROGRESS_PERSIST_INTERVAL_MS = 5_000L

internal data class MinutesPlaybackRecoveryRecord(
  val source: MinutesPlayerSource,
  val positionMs: Long,
  val rate: Float,
  val wasPlaying: Boolean,
  val savedAtEpochMs: Long,
)

internal interface MinutesPlaybackRecoveryStore {
  fun load(activeStorageScope: String): MinutesPlaybackRecoveryRecord?
  fun save(record: MinutesPlaybackRecoveryRecord): Boolean
  fun clear()
}

internal fun normalizeMinutesSourceStorageScope(value: String?): String? {
  val scope = value?.trim().orEmpty()
  if (scope == "guest") return scope
  if (!scope.startsWith("user:")) return null
  val userId = scope.removePrefix("user:")
  return scope.takeIf {
    userId.isNotBlank() &&
      userId.length <= 128 &&
      userId.all { character -> character.isLetterOrDigit() || character in "-_.@" }
  }
}

internal fun normalizeMinutesActiveStorageScope(value: String?): String? =
  value?.trim()?.takeIf { it == MINUTES_SIGNED_OUT_SCOPE }
    ?: normalizeMinutesSourceStorageScope(value)

internal fun interface MinutesLocalSourceAccess {
  fun isReadable(uri: String, scheme: String): Boolean
}

internal class MinutesPlaybackRecoveryPolicy(
  private val localSourceAccess: MinutesLocalSourceAccess,
  private val maxUndatedHttpsAgeMs: Long = MINUTES_RECOVERY_MAX_UNDATED_HTTPS_AGE_MS,
) {
  fun canPersist(
    source: MinutesPlayerSource,
    activeStorageScope: String,
    nowEpochMs: Long,
  ): Boolean = validateSource(source, activeStorageScope, nowEpochMs, nowEpochMs)

  fun canRestore(
    record: MinutesPlaybackRecoveryRecord,
    activeStorageScope: String,
    nowEpochMs: Long,
  ): Boolean = validateSource(
    source = record.source,
    activeStorageScope = activeStorageScope,
    savedAtEpochMs = record.savedAtEpochMs,
    nowEpochMs = nowEpochMs,
  ) && record.positionMs >= 0L && record.rate.isFinite()

  private fun validateSource(
    source: MinutesPlayerSource,
    activeStorageScope: String,
    savedAtEpochMs: Long,
    nowEpochMs: Long,
  ): Boolean {
    val sourceScope = normalizeMinutesSourceStorageScope(source.storageScope) ?: return false
    if (sourceScope != normalizeMinutesSourceStorageScope(activeStorageScope)) return false
    if (!stableSourceId(source.sourceId, source.uri)) return false
    if (source.uri.isBlank() || source.uri.length > MAX_URI_LENGTH) return false
    if (source.title.length > MAX_TITLE_LENGTH || source.headers.size > MAX_HEADER_COUNT) return false
    if (source.headers.any { (name, value) -> !safeHeader(name, value) }) return false

    val parsed = try {
      URI(source.uri)
    } catch (_: Exception) {
      return false
    }
    if (parsed.userInfo != null || parsed.scheme.isNullOrBlank()) return false
    return when (val scheme = parsed.scheme.lowercase()) {
      "file", "content" -> localSourceAccess.isReadable(source.uri, scheme)
      "https" -> {
        val expiresAt = source.expiresAt
        if (expiresAt != null) {
          expiresAt > nowEpochMs
        } else {
          savedAtEpochMs > 0L &&
            savedAtEpochMs <= nowEpochMs + MAX_CLOCK_SKEW_MS &&
            nowEpochMs - savedAtEpochMs <= maxUndatedHttpsAgeMs
        }
      }
      else -> false
    }
  }

  private fun stableSourceId(sourceId: String, uri: String): Boolean {
    if (sourceId.isBlank() || sourceId.length > MAX_SOURCE_ID_LENGTH) return false
    if (sourceId.contains(uri) || sourceId.contains("://")) return false
    if (sourceId.any { it == '?' || it == '&' || it == '=' || it == '#' }) return false
    return sourceId.substringAfter(':', sourceId).isNotBlank()
  }

  private fun safeHeader(name: String, value: String): Boolean =
    name.isNotBlank() && name.length <= MAX_HEADER_NAME_LENGTH &&
      value.isNotBlank() && value.length <= MAX_HEADER_VALUE_LENGTH &&
      !name.contains('\n') && !name.contains('\r') &&
      !value.contains('\n') && !value.contains('\r')

  companion object {
    private const val MAX_CLOCK_SKEW_MS = 5L * 60L * 1_000L
    private const val MAX_SOURCE_ID_LENGTH = 256
    private const val MAX_URI_LENGTH = 16_384
    private const val MAX_TITLE_LENGTH = 2_048
    private const val MAX_HEADER_COUNT = 32
    private const val MAX_HEADER_NAME_LENGTH = 256
    private const val MAX_HEADER_VALUE_LENGTH = 16_384
  }
}

internal class MinutesPlaybackProgressThrottle(
  private val intervalMs: Long = MINUTES_RECOVERY_PROGRESS_PERSIST_INTERVAL_MS,
  private val minimumPositionDeltaMs: Long = 1_000L,
) {
  private var lastSavedAtMs: Long? = null
  private var lastPositionMs = 0L

  fun shouldPersist(nowMs: Long, positionMs: Long): Boolean {
    val lastSavedAt = lastSavedAtMs ?: return true
    return nowMs - lastSavedAt >= intervalMs &&
      abs(positionMs - lastPositionMs) >= minimumPositionDeltaMs
  }

  fun markPersisted(nowMs: Long, positionMs: Long) {
    lastSavedAtMs = nowMs
    lastPositionMs = positionMs.coerceAtLeast(0L)
  }

  fun reset() {
    lastSavedAtMs = null
    lastPositionMs = 0L
  }
}

internal object MinutesPlaybackRecoveryCodec {
  private const val PAYLOAD_VERSION = 1
  private const val MAX_STRING_BYTES = 1_048_576
  private const val MAX_HEADER_COUNT = 32

  fun encode(record: MinutesPlaybackRecoveryRecord): ByteArray {
    val output = ByteArrayOutputStream()
    DataOutputStream(output).use { data ->
      data.writeInt(PAYLOAD_VERSION)
      data.writeString(record.source.sourceId)
      data.writeString(record.source.uri)
      data.writeString(record.source.title)
      data.writeLong(record.source.durationMsHint.coerceAtLeast(0L))
      data.writeBoolean(record.source.retainForBackground)
      data.writeLong(record.positionMs.coerceAtLeast(0L))
      data.writeFloat(record.rate)
      data.writeString(record.source.storageScope)
      data.writeBoolean(record.source.expiresAt != null)
      record.source.expiresAt?.let(data::writeLong)
      data.writeLong(record.savedAtEpochMs)
      data.writeBoolean(record.wasPlaying)
      val headers = record.source.headers.entries.sortedBy { it.key }.take(MAX_HEADER_COUNT)
      data.writeInt(headers.size)
      headers.forEach { (name, value) ->
        data.writeString(name)
        data.writeString(value)
      }
    }
    return output.toByteArray()
  }

  fun decode(payload: ByteArray): MinutesPlaybackRecoveryRecord {
    try {
      DataInputStream(ByteArrayInputStream(payload)).use { data ->
        if (data.readInt() != PAYLOAD_VERSION) throw IOException("unsupported recovery payload")
        val sourceId = data.readString()
        val uri = data.readString()
        val title = data.readString()
        val durationMsHint = data.readLong().coerceAtLeast(0L)
        val retainForBackground = data.readBoolean()
        val positionMs = data.readLong()
        val rate = data.readFloat()
        val storageScope = data.readString()
        val expiresAt = if (data.readBoolean()) data.readLong() else null
        val savedAtEpochMs = data.readLong()
        val wasPlaying = data.readBoolean()
        val headerCount = data.readInt()
        if (headerCount !in 0..MAX_HEADER_COUNT) throw IOException("invalid recovery headers")
        val headers = buildMap {
          repeat(headerCount) { put(data.readString(), data.readString()) }
        }
        if (data.available() != 0) throw IOException("trailing recovery payload")
        return MinutesPlaybackRecoveryRecord(
          source = MinutesPlayerSource(
            sourceId = sourceId,
            uri = uri,
            headers = headers,
            title = title,
            durationMsHint = durationMsHint,
            retainForBackground = retainForBackground,
            storageScope = storageScope,
            expiresAt = expiresAt,
          ),
          positionMs = positionMs,
          rate = rate,
          wasPlaying = wasPlaying,
          savedAtEpochMs = savedAtEpochMs,
        )
      }
    } catch (error: EOFException) {
      throw IOException("truncated recovery payload", error)
    }
  }

  private fun DataOutputStream.writeString(value: String) {
    val bytes = value.toByteArray(Charsets.UTF_8)
    require(bytes.size <= MAX_STRING_BYTES) { "recovery field is too large" }
    writeInt(bytes.size)
    write(bytes)
  }

  private fun DataInputStream.readString(): String {
    val size = readInt()
    if (size !in 0..MAX_STRING_BYTES) throw IOException("invalid recovery field size")
    return ByteArray(size).also(::readFully).toString(Charsets.UTF_8)
  }
}
