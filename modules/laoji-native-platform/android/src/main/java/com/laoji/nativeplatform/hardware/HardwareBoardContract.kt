package com.laoji.nativeplatform.hardware

import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** Catalog-only data. No checksum; cannot be used to commit or receive audio. */
internal data class HardwareRecordingPreview(val recordingId: String, val generation: String?,
  val byteSize: Long?, val durationMs: Long?, val createdEpochMs: Long?, val localRecordingId: String? = null,
  val purpose: String = "meeting", val captureId: String? = null) {
  fun toMap(): Map<String, Any?> = mapOf("recordingId" to recordingId,
    "title" to HardwareBoardContract.recordingTitle(recordingId), "generation" to generation,
    "byteSize" to byteSize, "durationMs" to durationMs, "createdEpochMs" to createdEpochMs,
    "recovered" to recordingId.startsWith("RECOVERED_"), "localRecordingId" to localRecordingId, "purpose" to purpose,
    "captureId" to captureId)
}

/** Data contract of ESP32S3 voice memo V1.0, independently of GPIO or firmware model aliases. */
internal object HardwareBoardContract {
  fun purpose(value: JSONObject): String = value.optString("purpose", "meeting").also {
    if (it !in setOf("meeting", "schedule")) throw HardwareProtocolException("invalid capture purpose")
  }
  private val generatedName = Regex("^(RECOVERED_)?LJ_([0-9]+)_([0-9a-fA-F]{8})\\.wav$")

  /** Same identity before and after the temporary WAV is adopted by a meeting. */
  fun localRecordingId(deviceId: String, recordingId: String, generation: String): String =
    UUID.nameUUIDFromBytes("$deviceId\u0000${fileName(recordingId)}\u0000${HardwareBoardContract.generation(generation)}"
      .toByteArray(Charsets.UTF_8)).toString()

  /** The board's storage is not the phone's filesystem. Unknown reasons must
   * not invent a low-storage diagnosis or leak an untrusted device message. */
  fun captureInterruption(reason: String): HardwareRuntimeException = when (reason) {
    "storage_failed" -> HardwareRuntimeException("device_storage_failed", "录音设备未能保存录音，请检查存储卡。")
    "audio_failed" -> HardwareRuntimeException("device_audio_failed", "录音设备录音中断，可重新录制。")
    else -> HardwareRuntimeException("device_recording_interrupted", "录音设备录音中断，可重新录制。")
  }

  /** Presentation only: never rename the source or change its transfer identity.
   * The embedded start time survives FAT mtime changes and later clock sync.
   * A board without a synced clock has no truthful calendar time to display. */
  fun recordingTitle(id: String, timeZone: TimeZone = TimeZone.getDefault()): String {
    val match = generatedName.matchEntire(id) ?: return id.removeSuffix(".wav")
    val started = match.groupValues[2].toLongOrNull()
    if (started == null || started < 1577836800000L || started >= 4102444800000L)
      return id.removeSuffix(".wav")
    val date = SimpleDateFormat("yyyy-MM-dd HH-mm-ss", Locale.ROOT).apply { this.timeZone = timeZone }
      .format(Date(started))
    return "${if (match.groupValues[1].isEmpty()) "录音" else "恢复录音"} $date"
  }

  // Larger completed files use the bulk lane rather than the real-time PCM lane.
  fun preferWifi(byteSize: Long, supported: Boolean): Boolean = supported && byteSize >= 1024 * 1024
  fun fileName(value: String): String {
    if (value.isBlank() || value in setOf(".", "..") || value.toByteArray(Charsets.UTF_8).size > 255 ||
      value.any { it.code < 32 || it in "/\\<>:\"|?*" }) {
      throw HardwareProtocolException("invalid single file name")
    }
    return value
  }

  fun generation(value: String): String {
    if (!value.matches(Regex("^[A-Za-z0-9._:-]{1,128}$"))) throw HardwareProtocolException("invalid generation")
    return value
  }

  fun preview(id: String, value: JSONObject?): HardwareRecordingPreview {
    val name = fileName(id)
    if (value == null) return HardwareRecordingPreview(name, null, null, null, null)
    if (value.getString("recording_id") != name) throw HardwareProtocolException("preview identity mismatch")
    val size = value.getLong("file_bytes")
    val duration = value.getLong("duration_ms")
    if (size < 44 || size > 0xffffffffL || duration < 0 || duration > size * 1000 / 32000)
      throw HardwareProtocolException("invalid preview dimensions")
    return HardwareRecordingPreview(name, generation(value.getString("generation")), size, duration,
      value.optLong("created_epoch_ms", -1).takeIf { it >= 0 }, purpose = purpose(value),
      captureId = value.optString("capture_id").takeIf { it.isNotBlank() })
  }

  fun recording(value: JSONObject): HardwareDeviceRecording {
    if (purpose(value) == "schedule" && value.optString("capture_id").isBlank()) throw HardwareProtocolException("schedule identity missing")
    val id = fileName(value.getString("recording_id"))
    val audio = value.getJSONObject("audio")
    if (value.optString("container") != "wav" || audio.optString("codec") != "pcm_s16le" ||
      audio.optInt("sample_rate_hz") != 16000 || audio.optInt("bits_per_sample") != 16 || audio.optInt("channels") != 1) {
      throw HardwareProtocolException("unsupported audio profile")
    }
    val pcm = value.getLong("audio_bytes")
    val size = value.getLong("file_bytes")
    val duration = value.getLong("duration_ms")
    val hash = value.getString("checksum_sha256").lowercase()
    if (pcm <= 0 || pcm % 2L != 0L || pcm > 0xffffffffL - 36L || size < pcm + 44 ||
      value.getLong("samples") != pcm / 2 || duration < 0 || kotlin.math.abs(duration - pcm * 1000 / 32000) > 1 ||
      !hash.matches(Regex("sha256:[0-9a-f]{64}")) || value.optString("checksum_scope") != "audio_payload") {
      throw HardwareProtocolException("inconsistent recording metadata")
    }
    return HardwareDeviceRecording(id, generation(value.getString("generation")), recordingTitle(id),
      size, duration, hash, "audio_payload", value.optLong("created_epoch_ms", -1).takeIf { it >= 0 },
      false, value.optBoolean("recovered"), pcm, purpose(value),
      value.optString("capture_id").takeIf { it.isNotBlank() && it.length <= 95 },
      value.optString("time_zone").takeIf { it in TimeZone.getAvailableIDs() })
  }

  /** capture.finished is authoritative for an already validated 16 kHz mono session. */
  fun finishedRecording(event: JSONObject, startedAtMs: Long): HardwareDeviceRecording {
    if (event.optString("op") != "capture.finished") throw HardwareProtocolException("finished event required")
    val value = JSONObject(event.toString()).put("container", "wav")
      .put("audio", JSONObject().put("codec", "pcm_s16le").put("sample_rate_hz", 16000)
        .put("bits_per_sample", 16).put("channels", 1))
    if (!value.has("created_epoch_ms")) value.put("created_epoch_ms", startedAtMs)
    return recording(value)
  }

  fun wifiOffer(value: JSONObject, recording: HardwareDeviceRecording): HardwareWifiOffer {
    val base = value.getString("base_url")
    val path = value.getString("recording_base_path")
    val token = value.getString("bearer_token")
    val ssid = value.getString("ssid")
    val password = value.getString("password")
    if (base != "http://192.168.4.1" || path != "/recording/" || ssid.isBlank() ||
      ssid.toByteArray(Charsets.UTF_8).size > 32 || password.length !in 8..63 ||
      token.length !in 16..192 || token.any { it.code !in 33..126 } ||
      value.optString("security_mode") != "development_http" || value.optLong("expires_in_ms") <= 0) {
      throw HardwareProtocolException("invalid Wi-Fi offer")
    }
    return HardwareWifiOffer(recording.recordingId, recording.generation, ssid, password, base,
      path + percentEncode(fileName(recording.recordingId)), token, "development_http", null,
      value.optLong("expires_epoch_ms"), value.getLong("expires_in_ms"))
  }

  fun percentEncode(value: String): String = buildString {
    value.toByteArray(Charsets.UTF_8).forEach { byte ->
      val code = byte.toInt() and 255
      if (code in 65..90 || code in 97..122 || code in 48..57 || code.toChar() in "-._~") append(code.toChar())
      else append("%%%02X".format(code))
    }
  }
}
