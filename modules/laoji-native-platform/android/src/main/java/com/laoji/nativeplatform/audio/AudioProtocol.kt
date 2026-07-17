package com.laoji.nativeplatform.audio

// MIN-ASR-001 / MIN-AUDIO-001: Qwen WebSocket frames and stop acknowledgements stay native.

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.math.sqrt

data class PcmLevel(
  val peak: Int,
  val rms: Int,
  val normalized: Double,
)

object Pcm16Math {
  fun measure(bytes: ByteArray, count: Int = bytes.size): PcmLevel {
    val usableCount = count.coerceIn(0, bytes.size) and -2
    if (usableCount == 0) return PcmLevel(peak = 0, rms = 0, normalized = 0.0)

    var peak = 0
    var sumSquares = 0.0
    var offset = 0
    while (offset < usableCount) {
      val sample = ((bytes[offset].toInt() and 0xff) or (bytes[offset + 1].toInt() shl 8)).toShort().toInt()
      val absolute = if (sample == Short.MIN_VALUE.toInt()) 32_768 else kotlin.math.abs(sample)
      if (absolute > peak) peak = absolute
      sumSquares += sample.toDouble() * sample.toDouble()
      offset += 2
    }
    val sampleCount = usableCount / 2
    val rms = sqrt(sumSquares / sampleCount).toInt().coerceIn(0, 32_768)
    return PcmLevel(
      peak = peak,
      rms = rms,
      normalized = (peak / 32_768.0).coerceIn(0.0, 1.0),
    )
  }
}

object WavHeader {
  fun create(pcmBytes: Long): ByteArray {
    require(pcmBytes in 0..0xfffffff0L) { "PCM payload is too large for a RIFF/WAV file" }
    val dataSize = pcmBytes.toInt()
    val buffer = ByteBuffer.allocate(AudioRuntimeContract.WAV_HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
    buffer.put("RIFF".toByteArray(Charsets.US_ASCII))
    buffer.putInt(dataSize + 36)
    buffer.put("WAVE".toByteArray(Charsets.US_ASCII))
    buffer.put("fmt ".toByteArray(Charsets.US_ASCII))
    buffer.putInt(16)
    buffer.putShort(1)
    buffer.putShort(AudioRuntimeContract.CHANNEL_COUNT.toShort())
    buffer.putInt(AudioRuntimeContract.SAMPLE_RATE_HZ)
    buffer.putInt(AudioRuntimeContract.BYTES_PER_SECOND)
    buffer.putShort((AudioRuntimeContract.CHANNEL_COUNT * AudioRuntimeContract.BYTES_PER_SAMPLE).toShort())
    buffer.putShort(AudioRuntimeContract.BITS_PER_SAMPLE.toShort())
    buffer.put("data".toByteArray(Charsets.US_ASCII))
    buffer.putInt(dataSize)
    return buffer.array()
  }

  fun isPlausible(header: ByteArray, fileLength: Long): Boolean {
    if (header.size < AudioRuntimeContract.WAV_HEADER_BYTES || fileLength < AudioRuntimeContract.WAV_HEADER_BYTES) {
      return false
    }
    val riff = String(header, 0, 4, Charsets.US_ASCII)
    val wave = String(header, 8, 4, Charsets.US_ASCII)
    val data = String(header, 36, 4, Charsets.US_ASCII)
    if (riff != "RIFF" || wave != "WAVE" || data != "data") return false
    val declared = ByteBuffer.wrap(header, 40, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xffffffffL
    return declared == fileLength - AudioRuntimeContract.WAV_HEADER_BYTES
  }
}

object WavRecoveryMath {
  fun alignedPcmBytes(fileLength: Long): Long =
    (fileLength - AudioRuntimeContract.WAV_HEADER_BYTES).coerceAtLeast(0L) and -2L
}

sealed class AsrServerEvent {
  data object ReadyToStop : AsrServerEvent()
  data class Transcript(
    val text: String,
    val isFinal: Boolean,
    val speakerId: String?,
    val speakerName: String?,
    val startMs: Long?,
    val endMs: Long?,
    val source: String?,
    val purpose: String?,
  ) : AsrServerEvent()

  data class Error(val detail: String) : AsrServerEvent()
  data object Ignored : AsrServerEvent()
}

object AsrProtocol {
  fun parse(text: String): AsrServerEvent {
    val json = try {
      JSONObject(text)
    } catch (_: Exception) {
      return AsrServerEvent.Ignored
    }
    return when (json.optString("type")) {
      "ready_to_stop" -> AsrServerEvent.ReadyToStop
      "transcript.completed", "transcript.partial", "transcript.delta" -> {
        val transcript = json.optString("text").trim()
        if (transcript.isEmpty()) return AsrServerEvent.Ignored
        val type = json.optString("type")
        AsrServerEvent.Transcript(
          text = transcript,
          isFinal = type == "transcript.completed" || json.optBoolean("is_final", false),
          speakerId = json.optionalString("speaker_id"),
          speakerName = json.optionalString("speaker_name"),
          startMs = json.optionalMilliseconds("start_ms", "start_time"),
          endMs = json.optionalMilliseconds("end_ms", "end_time"),
          source = json.optionalString("source"),
          purpose = json.optionalString("purpose"),
        )
      }
      "error" -> AsrServerEvent.Error(
        sanitizeServerDetail(json.optionalString("detail") ?: json.optionalString("message")),
      )
      else -> AsrServerEvent.Ignored
    }
  }

  fun transcriptIdentity(sessionId: String, transcript: AsrServerEvent.Transcript): String {
    val canonical = listOf(
      sessionId,
      transcript.speakerId.orEmpty(),
      transcript.startMs?.toString().orEmpty(),
      transcript.endMs?.toString().orEmpty(),
      transcript.text,
    ).joinToString("\u001f")
    return MessageDigest.getInstance("SHA-256")
      .digest(canonical.toByteArray(Charsets.UTF_8))
      .take(16)
      .joinToString("") { "%02x".format(it) }
  }

  private fun sanitizeServerDetail(detail: String?): String {
    val normalized = detail
      ?.replace(Regex("[\\r\\n\\t]+"), " ")
      ?.trim()
      ?.take(256)
    return normalized?.takeIf { it.isNotEmpty() } ?: "realtime transcription server error"
  }

  private fun JSONObject.optionalString(key: String): String? =
    optString(key).trim().takeIf { it.isNotEmpty() && it != "null" }

  private fun JSONObject.optionalMilliseconds(millisecondsKey: String, secondsKey: String): Long? {
    if (has(millisecondsKey) && !isNull(millisecondsKey)) return optLong(millisecondsKey)
    if (has(secondsKey) && !isNull(secondsKey)) return (optDouble(secondsKey) * 1_000.0).toLong()
    return null
  }
}
