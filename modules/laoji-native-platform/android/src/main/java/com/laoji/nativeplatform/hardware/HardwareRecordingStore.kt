package com.laoji.nativeplatform.hardware

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID

internal data class PendingHardwareRecording(
  val recordingId: String, val deviceId: String, val sessionId: String, val localUri: String,
  val recordedAtMs: Long, val durationMs: Long, val byteSize: Long, val checksumSha256: String,
  val interrupted: Boolean, val sampleRateHz: Int, val bitsPerSample: Int, val channels: Int,
  val sourceDeviceRecordingId: String? = null, val sourceGeneration: String? = null, val title: String? = null,
  val captureMeetingId: String? = null,
  val purpose: String = "meeting", val sourceCaptureId: String? = null, val timeZone: String? = null,
  val audioChecksumSha256: String? = null,
) {
  fun toMap(): Map<String, Any?> = mapOf("recordingId" to recordingId, "deviceId" to deviceId,
    "sessionId" to sessionId, "localUri" to localUri, "recordedAtMs" to recordedAtMs,
    "durationMs" to durationMs, "byteSize" to byteSize, "checksumSha256" to checksumSha256,
    "interrupted" to interrupted, "sampleRateHz" to sampleRateHz, "bitsPerSample" to bitsPerSample,
    "channels" to channels, "sourceDeviceRecordingId" to sourceDeviceRecordingId,
    "sourceGeneration" to sourceGeneration, "title" to title, "captureMeetingId" to captureMeetingId,
    "purpose" to purpose, "sourceCaptureId" to sourceCaptureId, "timeZone" to timeZone, "audioChecksumSha256" to audioChecksumSha256)
}

/** Only complete verified files enter the pending index. Source recordings remain on the board. */
internal class HardwareRecordingStore(context: Context) {
  private val root = File(context.applicationContext.filesDir, "meeting-audio/hardware-pending")
  @Synchronized fun associate(recording: PendingHardwareRecording, meetingId: String): PendingHardwareRecording {
    require(UUID.fromString(meetingId).toString() == meetingId)
    val metadata = File(root, "${recording.recordingId}.json")
    val json = JSONObject(metadata.readText()).put("capture_meeting_id", meetingId)
    val temp = File(root, ".${recording.recordingId}.json.part")
    FileOutputStream(temp).use { it.write(json.toString().toByteArray(Charsets.UTF_8)); it.fd.sync() }
    check(temp.renameTo(metadata))
    return recording.copy(captureMeetingId = meetingId)
  }
  @Synchronized fun list(): List<PendingHardwareRecording> {
    ensureRoot()
    return root.listFiles { file -> file.isFile && file.name.endsWith(".json") }.orEmpty()
      .mapNotNull(::readMetadata).sortedByDescending { it.recordedAtMs }
  }
  @Synchronized fun acknowledge(id: String): Boolean {
    val normalized = normalizedId(id) ?: return false
    ensureRoot()
    val media = File(root, "$normalized.wav")
    if (media.exists() && !media.delete()) return false
    val metadata = File(root, "$normalized.json")
    return !metadata.exists() || metadata.delete()
  }
  @Synchronized fun deviceDownloadPart(deviceId: String, deviceRecordingId: String, generation: String): Pair<String, File> {
    HardwareBoardContract.fileName(deviceRecordingId)
    HardwareBoardContract.generation(generation)
    ensureRoot()
    val id = HardwareBoardContract.localRecordingId(deviceId, deviceRecordingId, generation)
    return id to File(root, ".$id.device.wav.part")
  }
  @Synchronized fun commitDeviceDownload(
    localRecordingId: String, partFile: File, deviceId: String, deviceRecordingId: String,
    generation: String, title: String?, recordedAtMs: Long, durationMs: Long, byteSize: Long,
    verifiedFileSha256: String,
    purpose: String = "meeting", captureId: String? = null, timeZone: String? = null,
    audioChecksumSha256: String? = null,
  ): PendingHardwareRecording {
    val id = requireNotNull(normalizedId(localRecordingId))
    require(verifiedFileSha256.matches(Regex("sha256:[0-9a-f]{64}")))
    require(purpose in setOf("meeting", "schedule"))
    require(purpose != "schedule" || !captureId.isNullOrBlank())
    require(partFile.parentFile?.canonicalFile == root.canonicalFile && partFile.isFile && partFile.length() == byteSize && byteSize > 44)
    val final = File(root, "$id.wav")
    val meta = File(root, "$id.json")
    readMetadata(meta)?.let { existing ->
      if (existing.sourceDeviceRecordingId == deviceRecordingId && existing.sourceGeneration == generation && existing.byteSize == byteSize) {
        partFile.delete(); return existing
      }
    }
    if (final.exists() && !final.delete()) throw HardwareRuntimeException("storage_failed", "无法保存设备录音。")
    if (!partFile.renameTo(final)) throw HardwareRuntimeException("storage_failed", "无法保存设备录音。")
    val result = PendingHardwareRecording(id, deviceId, deviceRecordingId, Uri.fromFile(final).toString(),
      recordedAtMs, durationMs, byteSize, verifiedFileSha256, false, 16000, 16, 1,
      deviceRecordingId, generation, title, purpose = purpose, sourceCaptureId = captureId, timeZone = timeZone,
      audioChecksumSha256 = audioChecksumSha256)
    val json = JSONObject().put("schema_version", 1).put("recording_id", id).put("device_id", deviceId)
      .put("session_id", result.sessionId).put("recorded_at_ms", recordedAtMs).put("duration_ms", durationMs)
      .put("byte_size", byteSize).put("checksum_sha256", result.checksumSha256).put("interrupted", false)
      .put("sample_rate_hz", 16000).put("bits_per_sample", 16).put("channels", 1)
      .put("source_device_recording_id", deviceRecordingId).put("source_generation", generation).put("title", title)
      .put("purpose", purpose).put("source_capture_id", captureId).put("time_zone", timeZone)
      .put("audio_checksum_sha256", audioChecksumSha256)
    val temp = File(root, ".$id.json.part")
    FileOutputStream(temp).use { it.write(json.toString().toByteArray(Charsets.UTF_8)); it.fd.sync() }
    if (meta.exists() && !meta.delete() || !temp.renameTo(meta)) throw HardwareRuntimeException("storage_failed", "录音索引无法保存。")
    runCatching { FileInputStream(root).use { it.fd.sync() } }
    return result
  }
  private fun ensureRoot() {
    if (!root.isDirectory && !root.mkdirs()) throw HardwareRuntimeException("storage_failed", "无法创建录音保存位置。")
  }
  private fun readMetadata(file: File): PendingHardwareRecording? = runCatching {
    val value = JSONObject(file.readText(Charsets.UTF_8))
    if (value.optInt("schema_version") != 1) return null
    val id = normalizedId(value.getString("recording_id")) ?: return null
    val wav = File(root, "$id.wav")
    val size = value.getLong("byte_size")
    if (file.name != "$id.json" || !wav.isFile || size <= 44 || wav.length() != size) return null
    fun optional(key: String): String? = if (value.isNull(key)) null else value.optString(key).takeIf { it.isNotBlank() }
    PendingHardwareRecording(id, value.getString("device_id"), value.getString("session_id"), Uri.fromFile(wav).toString(),
      value.getLong("recorded_at_ms"), value.getLong("duration_ms"), size, value.getString("checksum_sha256"),
      value.optBoolean("interrupted"), value.getInt("sample_rate_hz"), value.getInt("bits_per_sample"), value.getInt("channels"),
      optional("source_device_recording_id"), optional("source_generation"), optional("title"), optional("capture_meeting_id"),
      value.optString("purpose", "meeting").also { require(it in setOf("meeting", "schedule")) },
      optional("source_capture_id"), optional("time_zone"), optional("audio_checksum_sha256"))
  }.getOrNull()

  companion object {
    internal fun normalizedId(value: String): String? = value.trim().takeIf { it.matches(Regex("^[A-Za-z0-9._:-]{1,128}$")) }
  }
}
