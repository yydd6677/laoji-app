package com.laoji.nativeplatform.audio

import android.content.Context
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

internal data class DeviceV2RealtimeCursor(
  val requestFingerprint: String,
  val lastChunkAck: Long = -1L,
  val lastEventAck: Long = 0L,
  val lastLocalEventAck: Long = 0L,
  val nextChunkSequence: Long = 0L,
  val nextSourceByteOffset: Long = 0L,
)

internal class DeviceV2RealtimeCursorStore(context: Context) {
  private val preferences = context.applicationContext.getSharedPreferences(
    PREFERENCES,
    Context.MODE_PRIVATE,
  )

  fun load(sessionId: String, config: DeviceV2RealtimeConfig): DeviceV2RealtimeCursor {
    val fingerprint = fingerprint(config)
    val raw = preferences.getString(key(sessionId), null) ?: return DeviceV2RealtimeCursor(fingerprint)
    return runCatching {
      val json = JSONObject(raw)
      DeviceV2RealtimeCursor(
        requestFingerprint = json.getString("request_fingerprint"),
        lastChunkAck = json.optLong("last_chunk_ack", -1L),
        lastEventAck = json.optLong("last_event_ack", 0L),
        lastLocalEventAck = json.optLong("last_local_event_ack", 0L),
        nextChunkSequence = json.optLong("next_chunk_sequence", 0L),
        nextSourceByteOffset = json.optLong("next_source_byte_offset", 0L),
      )
    }.getOrNull()?.takeIf {
      it.requestFingerprint == fingerprint &&
        it.lastChunkAck >= -1L &&
        it.lastEventAck >= 0L &&
        it.lastLocalEventAck >= 0L &&
        it.nextChunkSequence >= it.lastChunkAck + 1L &&
        it.nextSourceByteOffset >= 0L
    } ?: DeviceV2RealtimeCursor(fingerprint)
  }

  fun save(sessionId: String, cursor: DeviceV2RealtimeCursor) {
    require(cursor.lastChunkAck >= -1L && cursor.lastEventAck >= 0L)
    require(cursor.lastLocalEventAck >= 0L)
    require(cursor.nextChunkSequence >= cursor.lastChunkAck + 1L)
    require(cursor.nextSourceByteOffset >= 0L)
    val json = JSONObject()
      .put("schema_version", 2)
      .put("request_fingerprint", cursor.requestFingerprint)
      .put("last_chunk_ack", cursor.lastChunkAck)
      .put("last_event_ack", cursor.lastEventAck)
      .put("last_local_event_ack", cursor.lastLocalEventAck)
      .put("next_chunk_sequence", cursor.nextChunkSequence)
      .put("next_source_byte_offset", cursor.nextSourceByteOffset)
      .put("updated_at_ms", System.currentTimeMillis())
    if (!preferences.edit().putString(key(sessionId), json.toString()).commit()) {
      throw IllegalStateException("device-v2 realtime cursor could not be persisted")
    }
  }

  fun clear(sessionId: String) {
    preferences.edit().remove(key(sessionId)).commit()
  }

  private fun fingerprint(config: DeviceV2RealtimeConfig): String = sha256Hex(
    listOf(
      config.taskId,
      config.clientOperationId,
      config.bindingId,
      config.bindingGeneration,
      config.bindingRevision.toString(),
      config.cancelRevision.toString(),
      config.assetId,
      config.assetGeneration,
    ).joinToString("\u0000").toByteArray(Charsets.UTF_8),
  )

  private fun key(sessionId: String): String = "cursor:${sha256Hex(sessionId.toByteArray(Charsets.UTF_8))}"

  companion object {
    const val PREFERENCES = "laoji-device-v2-realtime-cursors"

    fun cleanupExpired(context: Context, nowMs: Long = System.currentTimeMillis()): Int {
      val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES,
        Context.MODE_PRIVATE,
      )
      val cutoff = nowMs - 24L * 60L * 60L * 1_000L
      val expired = preferences.all.mapNotNull { (key, value) ->
        val raw = value as? String ?: return@mapNotNull key
        val updatedAt = runCatching { JSONObject(raw).optLong("updated_at_ms", 0L) }.getOrDefault(0L)
        key.takeIf { updatedAt <= cutoff }
      }
      if (expired.isNotEmpty()) {
        val editor = preferences.edit()
        expired.forEach(editor::remove)
        editor.commit()
      }
      return expired.size
    }
  }
}

internal object DeviceV2RealtimeFrameCodec {
  private val magic = byteArrayOf('L'.code.toByte(), 'J'.code.toByte(), 'P'.code.toByte(), 'C'.code.toByte())

  fun encode(
    chunkSequence: Long,
    sourceByteOffset: Long,
    pcm: ByteArray,
    count: Int,
  ): ByteArray {
    val byteCount = count.coerceIn(0, pcm.size) and -2
    require(chunkSequence >= 0L && sourceByteOffset >= 0L)
    require(byteCount in 2..MAX_PCM_BYTES)
    val startMs = sourceByteOffset / BYTES_PER_MILLISECOND
    val endOffset = sourceByteOffset + byteCount
    val endMs = endOffset / BYTES_PER_MILLISECOND
    require(endMs > startMs && kotlin.math.abs(byteCount - (endMs - startMs) * BYTES_PER_MILLISECOND) <= 31L)
    val payload = pcm.copyOf(byteCount)
    val header = JSONObject()
      .put("schema_version", 2)
      .put("contract_revision", "realtime.chunk.v2")
      .put("type", "audio.chunk")
      .put("chunk_seq", chunkSequence)
      .put("start_ms", startMs)
      .put("end_ms", endMs)
      .put("content_sha256", "sha256:${sha256Hex(payload)}")
      .toString()
      .toByteArray(Charsets.UTF_8)
    require(header.size in 1..MAX_HEADER_BYTES)
    return ByteBuffer.allocate(7 + header.size + payload.size)
      .order(ByteOrder.BIG_ENDIAN)
      .put(magic)
      .put(2)
      .putShort(header.size.toShort())
      .put(header)
      .put(payload)
      .array()
  }

  data class Metadata(
    val chunkSequence: Long,
    val sourceStartByteOffset: Long,
    val sourceEndByteOffset: Long,
  )

  fun inspect(frame: ByteArray): Metadata {
    require(frame.size > 7)
    val buffer = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN)
    val observedMagic = ByteArray(4).also(buffer::get)
    require(observedMagic.contentEquals(magic) && buffer.get().toInt() == 2)
    val headerBytes = buffer.short.toInt() and 0xffff
    require(headerBytes in 1..MAX_HEADER_BYTES && frame.size > 7 + headerBytes)
    val header = ByteArray(headerBytes).also(buffer::get)
    val json = JSONObject(String(header, Charsets.UTF_8))
    val payloadBytes = frame.size - 7 - headerBytes
    val startMs = json.getLong("start_ms")
    val endMs = json.getLong("end_ms")
    require(startMs >= 0L && endMs > startMs)
    require(kotlin.math.abs(payloadBytes - (endMs - startMs) * BYTES_PER_MILLISECOND) <= 31L)
    val startBytes = startMs * BYTES_PER_MILLISECOND
    return Metadata(
      chunkSequence = json.getLong("chunk_seq"),
      sourceStartByteOffset = startBytes,
      sourceEndByteOffset = startBytes + payloadBytes,
    )
  }

  const val BYTES_PER_MILLISECOND = 32L
  const val MAX_HEADER_BYTES = 2_048
  const val MAX_PCM_BYTES = 1_048_576
}

internal sealed interface DeviceV2RealtimeServerEvent {
  data class Ready(
    val lastChunkAck: Long,
    val lastEventSequence: Long,
    val state: String,
  ) : DeviceV2RealtimeServerEvent

  data class AudioAck(val chunkSequence: Long, val lastChunkAck: Long) : DeviceV2RealtimeServerEvent
  data class Transcript(
    val eventSequence: Long,
    val eventKind: String,
    val stableSegmentKey: String?,
    val outcome: String,
    val text: String,
    val sourceStartMs: Long,
    val sourceEndMs: Long,
  ) : DeviceV2RealtimeServerEvent

  data class EventsAcked(val throughEventSequence: Long) : DeviceV2RealtimeServerEvent
  data class Error(val code: String, val message: String) : DeviceV2RealtimeServerEvent
  data object Finalizing : DeviceV2RealtimeServerEvent
  data object Complete : DeviceV2RealtimeServerEvent
  data object Ignored : DeviceV2RealtimeServerEvent
}

internal object DeviceV2RealtimeProtocol {
  fun openFrame(config: RecorderStartConfig, cursor: DeviceV2RealtimeCursor): String {
    val v2 = requireNotNull(config.deviceV2)
    return JSONObject()
      .put("schema_version", 2)
      .put("type", "session.open")
      .put("task_id", v2.taskId)
      .put("client_operation_id", v2.clientOperationId)
      .put("binding_id", v2.bindingId)
      .put("binding_generation", v2.bindingGeneration)
      .put("binding_revision", v2.bindingRevision)
      .put("cancel_revision", v2.cancelRevision)
      .put("asset_id", v2.assetId)
      .put("asset_generation", v2.assetGeneration)
      .put("codec_revision", "pcm16-16000-mono-v1")
      .put("expires_at_epoch", v2.expiresAtEpoch)
      .put("after_event_seq", cursor.lastEventAck)
      .toString()
  }

  fun finalizeFrame(): String = JSONObject()
    .put("schema_version", 2)
    .put("type", "session.finalize")
    .toString()

  fun eventAckFrame(throughEventSequence: Long): String = JSONObject()
    .put("schema_version", 2)
    .put("type", "events.ack")
    .put("through_event_seq", throughEventSequence)
    .toString()

  fun parse(text: String): DeviceV2RealtimeServerEvent {
    val json = try {
      JSONObject(text)
    } catch (_: Exception) {
      return DeviceV2RealtimeServerEvent.Ignored
    }
    return try {
      when (json.optString("type")) {
        "session.ready" -> DeviceV2RealtimeServerEvent.Ready(
          lastChunkAck = json.getLong("last_contiguous_chunk_seq"),
          lastEventSequence = json.getLong("last_durable_event_seq"),
          state = json.getString("state"),
        )
        "audio.ack" -> DeviceV2RealtimeServerEvent.AudioAck(
          chunkSequence = json.getLong("chunk_seq"),
          lastChunkAck = json.getLong("last_contiguous_chunk_seq"),
        )
        "events.acked" -> DeviceV2RealtimeServerEvent.EventsAcked(json.getLong("acked_through"))
        "session.finalizing" -> DeviceV2RealtimeServerEvent.Finalizing
        "session.complete" -> DeviceV2RealtimeServerEvent.Complete
        "error" -> DeviceV2RealtimeServerEvent.Error(
          code = json.optString("code", "REALTIME_PROTOCOL_INVALID"),
          message = json.optString("message", "实时转写协议无效"),
        )
        else -> if (json.optString("contract_revision") == "transcript.stream.v2") {
          DeviceV2RealtimeServerEvent.Transcript(
            eventSequence = json.getLong("event_sequence"),
            eventKind = json.getString("event_kind"),
            stableSegmentKey = json.optString("stable_segment_key").takeIf { it.isNotBlank() },
            outcome = json.getString("outcome"),
            text = json.optString("text"),
            sourceStartMs = json.getLong("source_start_ms"),
            sourceEndMs = json.getLong("source_end_ms"),
          )
        } else {
          DeviceV2RealtimeServerEvent.Ignored
        }
      }
    } catch (_: Exception) {
      DeviceV2RealtimeServerEvent.Error("REALTIME_RESPONSE_INVALID", "实时转写响应无效")
    }
  }
}

private fun sha256Hex(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
  .digest(value)
  .joinToString("") { "%02x".format(it.toInt() and 0xff) }
