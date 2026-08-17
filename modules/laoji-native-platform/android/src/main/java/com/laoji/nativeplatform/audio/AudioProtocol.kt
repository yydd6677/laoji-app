package com.laoji.nativeplatform.audio

// MIN-ASR-001 / MIN-AUDIO-001: Qwen WebSocket frames and stop acknowledgements stay native.

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
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
  data class Config(val stopCapability: AsrStopCapability?) : AsrServerEvent()
  data object StopAcknowledged : AsrServerEvent()
  data object ReadyToStop : AsrServerEvent()
  data class Transcript(
    val text: String,
    val isFinal: Boolean,
    val speakerId: String?,
    val speakerName: String?,
    val speakerConfidence: Double?,
    val startMs: Long?,
    val endMs: Long?,
    val source: String?,
    val purpose: String?,
    val eventSequence: Long? = null,
    val stableSegmentKey: String? = null,
  ) : AsrServerEvent()

  data class Error(
    val detail: String,
    val code: String?,
    val retryable: Boolean,
  ) : AsrServerEvent()
  data object Ignored : AsrServerEvent()
}

data class AsrStopCapability(
  val finalDrainTimeoutMs: Long,
) {
  val clientDrainWaitTimeoutMs: Long
    get() = minOf(
      finalDrainTimeoutMs + AsrStopProtocolContract.FINAL_DRAIN_COMPLETION_GRACE_MS,
      AsrStopProtocolContract.MAX_CLIENT_FINAL_DRAIN_WAIT_MS,
    )
}

object AsrStopProtocolContract {
  const val ACK_THEN_DRAIN_V1 = "ack_then_drain_v1"
  const val MIN_SERVER_FINAL_DRAIN_TIMEOUT_MS = 1_000L
  const val MAX_SERVER_FINAL_DRAIN_TIMEOUT_MS = 120_000L
  const val MAX_STOP_ACK_WAIT_MS = 5_000L
  const val CONFIG_NEGOTIATION_GRACE_MS = 500L
  const val FINAL_DRAIN_COMPLETION_GRACE_MS = 2_000L
  const val MAX_CLIENT_FINAL_DRAIN_WAIT_MS =
    MAX_SERVER_FINAL_DRAIN_TIMEOUT_MS + FINAL_DRAIN_COMPLETION_GRACE_MS

  fun negotiate(stopProtocol: Any?, finalDrainTimeoutMs: Any?): AsrStopCapability? {
    if (stopProtocol !is String || stopProtocol != ACK_THEN_DRAIN_V1) return null
    val timeoutMs = when (finalDrainTimeoutMs) {
      is Int -> finalDrainTimeoutMs.toLong()
      is Long -> finalDrainTimeoutMs
      else -> return null
    }
    if (timeoutMs !in MIN_SERVER_FINAL_DRAIN_TIMEOUT_MS..MAX_SERVER_FINAL_DRAIN_TIMEOUT_MS) {
      return null
    }
    return AsrStopCapability(finalDrainTimeoutMs = timeoutMs)
  }

  fun ackWaitTimeoutMs(legacyTimeoutMs: Long): Long =
    legacyTimeoutMs.coerceAtLeast(1L).coerceAtMost(MAX_STOP_ACK_WAIT_MS)

  fun configNegotiationWaitMs(legacyTimeoutMs: Long): Long =
    legacyTimeoutMs.coerceAtLeast(1L).coerceAtMost(CONFIG_NEGOTIATION_GRACE_MS)
}

private sealed interface AsrStopConfigState {
  data object Unobserved : AsrStopConfigState
  data object Legacy : AsrStopConfigState
  data class Negotiated(val capability: AsrStopCapability) : AsrStopConfigState
}

class AsrStopHandshake {
  private val configState = AtomicReference<AsrStopConfigState>(AsrStopConfigState.Unobserved)
  private val stopStarted = AtomicBoolean(false)
  private val stopAcknowledged = AtomicBoolean(false)
  private val readyToStop = AtomicBoolean(false)
  private val closed = AtomicBoolean(false)
  private val configSignal = CountDownLatch(1)
  private val acknowledgementSignal = CountDownLatch(1)
  private val terminalSignal = CountDownLatch(1)

  fun beginStop(): Boolean = stopStarted.compareAndSet(false, true)

  fun hasStopStarted(): Boolean = stopStarted.get()

  fun isReadyToStop(): Boolean = readyToStop.get()

  fun observeConfig(capability: AsrStopCapability?) {
    val next = capability?.let(AsrStopConfigState::Negotiated) ?: AsrStopConfigState.Legacy
    if (configState.compareAndSet(AsrStopConfigState.Unobserved, next)) {
      configSignal.countDown()
    }
  }

  fun acknowledgeStop() {
    if (!stopStarted.get() || configState.get() !is AsrStopConfigState.Negotiated) return
    // ACK releases only the first phase; ready_to_stop remains the sole success terminal.
    stopAcknowledged.set(true)
    acknowledgementSignal.countDown()
  }

  fun markReadyToStop() {
    if (!stopStarted.get()) return
    val state = freezeLegacyIfUnobserved()
    if (state is AsrStopConfigState.Negotiated && !stopAcknowledged.get()) return
    readyToStop.set(true)
    terminalSignal.countDown()
  }

  fun markClosed() {
    closed.set(true)
    configSignal.countDown()
    acknowledgementSignal.countDown()
    terminalSignal.countDown()
  }

  @Throws(InterruptedException::class)
  fun awaitCompletion(legacyTimeoutMs: Long): ReadyToStopOutcome {
    if (!stopStarted.get()) return ReadyToStopOutcome.END_FRAME_REJECTED
    if (readyToStop.get()) return ReadyToStopOutcome.READY

    if (configState.get() === AsrStopConfigState.Unobserved && !closed.get()) {
      configSignal.await(
        AsrStopProtocolContract.configNegotiationWaitMs(legacyTimeoutMs),
        TimeUnit.MILLISECONDS,
      )
    }
    val state = freezeLegacyIfUnobserved()
    if (readyToStop.get()) return ReadyToStopOutcome.READY
    if (closed.get()) return ReadyToStopOutcome.CLOSED

    if (state !is AsrStopConfigState.Negotiated) {
      val signaled = terminalSignal.await(legacyTimeoutMs.coerceAtLeast(1L), TimeUnit.MILLISECONDS)
      return when {
        readyToStop.get() -> ReadyToStopOutcome.READY
        closed.get() || signaled -> ReadyToStopOutcome.CLOSED
        else -> ReadyToStopOutcome.LEGACY_TIMEOUT
      }
    }

    if (!stopAcknowledged.get()) {
      acknowledgementSignal.await(
        AsrStopProtocolContract.ackWaitTimeoutMs(legacyTimeoutMs),
        TimeUnit.MILLISECONDS,
      )
    }
    if (!stopAcknowledged.get()) {
      return if (closed.get()) ReadyToStopOutcome.CLOSED else ReadyToStopOutcome.ACK_TIMEOUT
    }
    if (readyToStop.get()) return ReadyToStopOutcome.READY
    if (closed.get()) return ReadyToStopOutcome.CLOSED

    val signaled = terminalSignal.await(
      state.capability.clientDrainWaitTimeoutMs,
      TimeUnit.MILLISECONDS,
    )
    return when {
      readyToStop.get() -> ReadyToStopOutcome.READY
      closed.get() || signaled -> ReadyToStopOutcome.CLOSED
      else -> ReadyToStopOutcome.DRAIN_TIMEOUT
    }
  }

  private fun freezeLegacyIfUnobserved(): AsrStopConfigState {
    configState.compareAndSet(AsrStopConfigState.Unobserved, AsrStopConfigState.Legacy)
    if (configState.get() !== AsrStopConfigState.Unobserved) configSignal.countDown()
    return configState.get()
  }
}

object AsrProtocol {
  fun parse(text: String): AsrServerEvent {
    val json = try {
      JSONObject(text)
    } catch (_: Exception) {
      return AsrServerEvent.Ignored
    }
    return when (json.opt("type") as? String) {
      "config" -> AsrServerEvent.Config(
        stopCapability = AsrStopProtocolContract.negotiate(
          json.opt("stop_protocol"),
          json.opt("final_drain_timeout_ms"),
        ),
      )
      "stop_acknowledged" -> AsrServerEvent.StopAcknowledged
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
          speakerConfidence = json.optionalFiniteDouble("speaker_confidence", "speakerConfidence"),
          startMs = json.optionalMilliseconds("start_ms", "start_time"),
          endMs = json.optionalMilliseconds("end_ms", "end_time"),
          source = json.optionalString("source"),
          purpose = json.optionalString("purpose"),
        )
      }
      "error" -> AsrServerEvent.Error(
        detail = sanitizeServerDetail(json.optionalString("detail") ?: json.optionalString("message")),
        code = json.optionalErrorCode(),
        retryable = json.optBoolean("retryable", false),
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

  private fun JSONObject.optionalErrorCode(): String? {
    val candidate = optionalString("code") ?: optionalString("error_code") ?: return null
    return candidate.takeIf {
      it.length <= 64 && it.all { character -> character.isLetterOrDigit() || character == '_' || character == '-' || character == '.' }
    }
  }

  private fun JSONObject.optionalFiniteDouble(vararg keys: String): Double? {
    for (key in keys) {
      if (!has(key) || isNull(key)) continue
      val value = optDouble(key, Double.NaN)
      if (value.isFinite() && value in 0.0..1.0) return value
    }
    return null
  }

  private fun JSONObject.optionalMilliseconds(millisecondsKey: String, secondsKey: String): Long? {
    if (has(millisecondsKey) && !isNull(millisecondsKey)) return optLong(millisecondsKey)
    if (has(secondsKey) && !isNull(secondsKey)) return (optDouble(secondsKey) * 1_000.0).toLong()
    return null
  }
}
