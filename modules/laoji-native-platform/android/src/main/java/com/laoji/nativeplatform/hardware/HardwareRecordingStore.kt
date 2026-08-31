package com.laoji.nativeplatform.hardware

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

internal data class PendingHardwareRecording(
  val recordingId: String,
  val deviceId: String,
  val sessionId: String,
  val localUri: String,
  val recordedAtMs: Long,
  val durationMs: Long,
  val byteSize: Long,
  val checksumSha256: String,
  val interrupted: Boolean,
  val sampleRateHz: Int,
  val bitsPerSample: Int,
  val channels: Int,
  val sourceDeviceRecordingId: String? = null,
  val sourceGeneration: String? = null,
  val title: String? = null,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "recordingId" to recordingId,
    "deviceId" to deviceId,
    "sessionId" to sessionId,
    "localUri" to localUri,
    "recordedAtMs" to recordedAtMs,
    "durationMs" to durationMs,
    "byteSize" to byteSize,
    "checksumSha256" to checksumSha256,
    "interrupted" to interrupted,
    "sampleRateHz" to sampleRateHz,
    "bitsPerSample" to bitsPerSample,
    "channels" to channels,
    "sourceDeviceRecordingId" to sourceDeviceRecordingId,
    "sourceGeneration" to sourceGeneration,
    "title" to title,
  )
}

internal class HardwareRecordingStore(context: Context) {
  private val root = File(context.applicationContext.filesDir, "meeting-audio/hardware-pending")

  @Synchronized
  fun createWriter(
    deviceId: String,
    sessionId: String,
    recordedAtMs: Long,
    sampleRateHz: Int,
    bitsPerSample: Int,
    channels: Int,
  ): HardwareRecordingWriter {
    require(sampleRateHz in 8_000..96_000)
    require(bitsPerSample == 16)
    require(channels in 1..2)
    ensureRoot()
    return HardwareRecordingWriter(
      root = root,
      recordingId = UUID.randomUUID().toString(),
      deviceId = deviceId,
      sessionId = sessionId.take(128),
      recordedAtMs = recordedAtMs.coerceAtLeast(0L),
      sampleRateHz = sampleRateHz,
      bitsPerSample = bitsPerSample,
      channels = channels,
    )
  }

  @Synchronized
  fun list(): List<PendingHardwareRecording> {
    ensureRoot()
    return root.listFiles { file -> file.isFile && file.name.endsWith(".json") }
      .orEmpty()
      .mapNotNull(::readMetadata)
      .sortedByDescending(PendingHardwareRecording::recordedAtMs)
  }

  @Synchronized
  fun acknowledge(recordingId: String): Boolean {
    val normalized = normalizedId(recordingId) ?: return false
    ensureRoot()
    val metadata = readMetadata(File(root, "$normalized.json"))
    val mediaDeleted = metadata?.localUri
      ?.let(Uri::parse)
      ?.path
      ?.let(::File)
      ?.let { !it.exists() || it.delete() }
      ?: true
    val metadataFile = File(root, "$normalized.json")
    val metadataDeleted = !metadataFile.exists() || metadataFile.delete()
    File(root, ".$normalized.json.part").delete()
    File(root, ".$normalized.wav.part").delete()
    return mediaDeleted && metadataDeleted
  }

  @Synchronized
  fun deviceDownloadPart(
    deviceId: String,
    deviceRecordingId: String,
    generation: String,
  ): Pair<String, File> {
    require(normalizedId(deviceRecordingId) != null) { "invalid device recording id" }
    require(normalizedId(generation) != null) { "invalid device recording generation" }
    ensureRoot()
    val stable = UUID.nameUUIDFromBytes(
      "$deviceId\u0000$deviceRecordingId\u0000$generation".toByteArray(Charsets.UTF_8),
    ).toString()
    return stable to File(root, ".$stable.device.wav.part")
  }

  @Synchronized
  fun commitDeviceDownload(
    localRecordingId: String,
    partFile: File,
    deviceId: String,
    deviceRecordingId: String,
    generation: String,
    title: String?,
    recordedAtMs: Long,
    durationMs: Long,
    byteSize: Long,
  ): PendingHardwareRecording {
    val normalizedLocal = requireNotNull(normalizedId(localRecordingId))
    require(normalizedId(deviceRecordingId) != null)
    require(normalizedId(generation) != null)
    require(partFile.isFile && partFile.length() == byteSize && byteSize > 44L)
    ensureRoot()
    val finalFile = File(root, "$normalizedLocal.wav")
    val metadataFile = File(root, "$normalizedLocal.json")
    readMetadata(metadataFile)?.let { existing ->
      if (
        existing.sourceDeviceRecordingId == deviceRecordingId &&
        existing.sourceGeneration == generation && finalFile.isFile &&
        finalFile.length() == byteSize
      ) {
        if (partFile.exists()) partFile.delete()
        return existing
      }
    }
    finalFile.delete()
    metadataFile.delete()
    if (!partFile.renameTo(finalFile)) {
      throw HardwareRuntimeException("storage_failed", "设备录音无法保存到本机。")
    }
    syncDirectory(root)
    val checksum = sha256(finalFile)
    val result = PendingHardwareRecording(
      recordingId = normalizedLocal,
      deviceId = deviceId,
      sessionId = deviceRecordingId,
      localUri = Uri.fromFile(finalFile).toString(),
      recordedAtMs = recordedAtMs.coerceAtLeast(0L),
      durationMs = durationMs.coerceAtLeast(0L),
      byteSize = byteSize,
      checksumSha256 = checksum,
      interrupted = false,
      sampleRateHz = 16_000,
      bitsPerSample = 16,
      channels = 1,
      sourceDeviceRecordingId = deviceRecordingId,
      sourceGeneration = generation,
      title = title?.trim()?.take(120)?.takeIf(String::isNotBlank),
    )
    if (!writeMetadata(result)) {
      finalFile.delete()
      throw HardwareRuntimeException("storage_failed", "设备录音索引无法保存。")
    }
    return result
  }

  private fun ensureRoot() {
    if (!root.exists() && !root.mkdirs()) {
      throw HardwareRuntimeException("storage_failed", "无法创建外接录音保存位置。")
    }
    if (!root.isDirectory) {
      throw HardwareRuntimeException("storage_failed", "外接录音保存位置不可用。")
    }
  }

  private fun readMetadata(file: File): PendingHardwareRecording? {
    return runCatching {
      val json = JSONObject(file.readText(Charsets.UTF_8))
      if (json.optInt("schema_version", -1) != 1) return null
      val recordingId = normalizedId(json.optString("recording_id")) ?: return null
      if (file.name != "$recordingId.json") return null
      val wav = File(root, "$recordingId.wav")
      val byteSize = json.optLong("byte_size", -1L)
      if (!wav.isFile || byteSize <= 44L || wav.length() != byteSize) return null
      PendingHardwareRecording(
        recordingId = recordingId,
        deviceId = json.getString("device_id"),
        sessionId = json.getString("session_id"),
        localUri = Uri.fromFile(wav).toString(),
        recordedAtMs = json.getLong("recorded_at_ms"),
        durationMs = json.getLong("duration_ms"),
        byteSize = byteSize,
        checksumSha256 = json.getString("checksum_sha256"),
        interrupted = json.optBoolean("interrupted", false),
        sampleRateHz = json.getInt("sample_rate_hz"),
        bitsPerSample = json.getInt("bits_per_sample"),
        channels = json.getInt("channels"),
        sourceDeviceRecordingId = json.optString("source_device_recording_id")
          .takeIf(String::isNotBlank),
        sourceGeneration = json.optString("source_generation").takeIf(String::isNotBlank),
        title = json.optString("title").takeIf(String::isNotBlank),
      )
    }.getOrNull()
  }

  companion object {
    private val SAFE_ID = Regex("^[A-Za-z0-9._:-]{1,128}$")
    internal fun normalizedId(value: String): String? = value.trim().takeIf(SAFE_ID::matches)
  }

  private fun writeMetadata(recording: PendingHardwareRecording): Boolean {
    val metadataFile = File(root, "${recording.recordingId}.json")
    val metadataTemp = File(root, ".${recording.recordingId}.json.part")
    val json = JSONObject()
      .put("schema_version", 1)
      .put("recording_id", recording.recordingId)
      .put("device_id", recording.deviceId)
      .put("session_id", recording.sessionId)
      .put("recorded_at_ms", recording.recordedAtMs)
      .put("duration_ms", recording.durationMs)
      .put("byte_size", recording.byteSize)
      .put("checksum_sha256", recording.checksumSha256)
      .put("interrupted", recording.interrupted)
      .put("sample_rate_hz", recording.sampleRateHz)
      .put("bits_per_sample", recording.bitsPerSample)
      .put("channels", recording.channels)
      .put("source_device_recording_id", recording.sourceDeviceRecordingId)
      .put("source_generation", recording.sourceGeneration)
      .put("title", recording.title)
    FileOutputStream(metadataTemp).use { metadata ->
      metadata.write(json.toString().toByteArray(Charsets.UTF_8))
      metadata.fd.sync()
    }
    metadataFile.delete()
    val renamed = metadataTemp.renameTo(metadataFile)
    if (!renamed) metadataTemp.delete()
    if (renamed) syncDirectory(root)
    return renamed
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) digest.update(buffer, 0, count)
      }
    }
    return "sha256:" + digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun syncDirectory(directory: File) {
    runCatching { FileInputStream(directory).use { it.fd.sync() } }
  }
}

internal class HardwareRecordingWriter(
  private val root: File,
  val recordingId: String,
  val deviceId: String,
  val sessionId: String,
  val recordedAtMs: Long,
  val sampleRateHz: Int,
  val bitsPerSample: Int,
  val channels: Int,
) {
  private val tempFile = File(root, ".$recordingId.wav.part")
  private val finalFile = File(root, "$recordingId.wav")
  private val metadataFile = File(root, "$recordingId.json")
  private val metadataTemp = File(root, ".$recordingId.json.part")
  private val output = RandomAccessFile(tempFile, "rw")
  private var pcmBytes = 0L
  private var closed = false

  init {
    output.setLength(0)
    output.write(ByteArray(44))
  }

  @Synchronized
  fun append(payload: ByteArray) {
    check(!closed) { "hardware recording is closed" }
    val blockAlign = channels * (bitsPerSample / 8)
    require(payload.size % blockAlign == 0) { "hardware PCM is not sample aligned" }
    output.write(payload)
    pcmBytes = Math.addExact(pcmBytes, payload.size.toLong())
  }

  @Synchronized
  fun finish(interrupted: Boolean): PendingHardwareRecording? {
    if (closed) return null
    closed = true
    if (pcmBytes <= 0L) {
      runCatching { output.close() }
      tempFile.delete()
      return null
    }
    val blockAlign = channels * (bitsPerSample / 8)
    val byteRate = sampleRateHz * blockAlign
    output.seek(0)
    output.write(wavHeader(pcmBytes, byteRate, blockAlign))
    output.fd.sync()
    output.close()
    if (finalFile.exists() || !tempFile.renameTo(finalFile)) {
      tempFile.delete()
      throw HardwareRuntimeException("storage_failed", "外接录音无法完成保存。")
    }
    syncDirectory(root)
    val byteSize = finalFile.length()
    val durationMs = pcmBytes * 1000L / byteRate.coerceAtLeast(1)
    val checksum = sha256(finalFile)
    val result = PendingHardwareRecording(
      recordingId = recordingId,
      deviceId = deviceId,
      sessionId = sessionId,
      localUri = Uri.fromFile(finalFile).toString(),
      recordedAtMs = recordedAtMs,
      durationMs = durationMs,
      byteSize = byteSize,
      checksumSha256 = checksum,
      interrupted = interrupted,
      sampleRateHz = sampleRateHz,
      bitsPerSample = bitsPerSample,
      channels = channels,
    )
    val json = JSONObject()
      .put("schema_version", 1)
      .put("recording_id", recordingId)
      .put("device_id", deviceId)
      .put("session_id", sessionId)
      .put("recorded_at_ms", recordedAtMs)
      .put("duration_ms", durationMs)
      .put("byte_size", byteSize)
      .put("checksum_sha256", checksum)
      .put("interrupted", interrupted)
      .put("sample_rate_hz", sampleRateHz)
      .put("bits_per_sample", bitsPerSample)
      .put("channels", channels)
    FileOutputStream(metadataTemp).use { metadata ->
      metadata.write(json.toString().toByteArray(Charsets.UTF_8))
      metadata.fd.sync()
    }
    if (metadataFile.exists() || !metadataTemp.renameTo(metadataFile)) {
      metadataTemp.delete()
      finalFile.delete()
      throw HardwareRuntimeException("storage_failed", "外接录音索引无法保存。")
    }
    syncDirectory(root)
    return result
  }

  @Synchronized
  fun discard() {
    if (!closed) {
      closed = true
      runCatching { output.close() }
    }
    tempFile.delete()
    finalFile.delete()
    metadataTemp.delete()
    metadataFile.delete()
  }

  private fun wavHeader(dataBytes: Long, byteRate: Int, blockAlign: Int): ByteArray {
    require(dataBytes <= 0xffffffffL - 36L) { "WAV exceeds RIFF limit" }
    val buffer = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
    buffer.put("RIFF".toByteArray(Charsets.US_ASCII))
    buffer.putInt((36L + dataBytes).toInt())
    buffer.put("WAVE".toByteArray(Charsets.US_ASCII))
    buffer.put("fmt ".toByteArray(Charsets.US_ASCII))
    buffer.putInt(16)
    buffer.putShort(1)
    buffer.putShort(channels.toShort())
    buffer.putInt(sampleRateHz)
    buffer.putInt(byteRate)
    buffer.putShort(blockAlign.toShort())
    buffer.putShort(bitsPerSample.toShort())
    buffer.put("data".toByteArray(Charsets.US_ASCII))
    buffer.putInt(dataBytes.toInt())
    return buffer.array()
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) digest.update(buffer, 0, count)
      }
    }
    return "sha256:" + digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun syncDirectory(directory: File) {
    runCatching {
      FileInputStream(directory).use { it.fd.sync() }
    }
  }
}
