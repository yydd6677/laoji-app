package com.laoji.nativeplatform.mediaclip

import android.content.Context
import android.net.Uri
import com.laoji.nativeplatform.audio.AudioRuntimeContract
import com.laoji.nativeplatform.audio.WavHeader
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.math.ceil

internal data class WavClipCapabilities(
  val minimumDurationMs: Long = 1_000L,
  val maximumDurationMs: Long = 300_000L,
  val adjustmentStepMs: Long = 1_000L,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "localWav" to true,
    "minimumDurationMs" to minimumDurationMs,
    "maximumDurationMs" to maximumDurationMs,
    "adjustmentStepMs" to adjustmentStepMs,
  )
}

internal data class InspectedWavClipSource(
  val sourceUri: String,
  val byteSize: Long,
  val durationMs: Long,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "sourceUri" to sourceUri,
    "mimeType" to "audio/wav",
    "byteSize" to byteSize,
    "durationMs" to durationMs,
  )
}

internal data class ExportedWavClip(
  val meetingId: String,
  val clipId: String,
  val localUri: String,
  val fileName: String,
  val byteSize: Long,
  val durationMs: Long,
  val checksumSha256: String,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "meetingId" to meetingId,
    "clipId" to clipId,
    "localUri" to localUri,
    "mimeType" to "audio/wav",
    "fileName" to fileName,
    "byteSize" to byteSize,
    "durationMs" to durationMs,
    "checksumSha256" to checksumSha256,
  )
}

internal class MediaClipException(
  val code: String,
  override val message: String,
) : Exception(message)

private data class PcmWavSource(
  val file: File,
  val dataOffset: Long,
  val dataBytes: Long,
  val sampleRateHz: Int,
  val bytesPerFrame: Int,
) {
  val durationMs: Long
    get() = dataBytes * 1_000L / (sampleRateHz.toLong() * bytesPerFrame)
}

internal class MediaClipExporter(context: Context) {
  private val applicationContext = context.applicationContext
  private val root = File(applicationContext.filesDir, "meeting-clips")
  private val capabilities = WavClipCapabilities()

  fun capabilities(): WavClipCapabilities = capabilities

  fun inspect(sourceUri: String): InspectedWavClipSource {
    val source = parsePcmWav(sourceUri)
    return InspectedWavClipSource(
      sourceUri = Uri.fromFile(source.file).toString(),
      byteSize = source.file.length(),
      durationMs = source.durationMs,
    )
  }

  fun export(
    sourceUri: String,
    meetingId: String,
    clipId: String,
    startMs: Long,
    endMs: Long,
  ): ExportedWavClip = synchronized(mediaClipIoLock) {
    val normalizedMeetingId = validateIdentity(meetingId, "meeting")
    val normalizedClipId = validateIdentity(clipId, "clip")
    val source = parsePcmWav(sourceUri)
    validateRange(startMs, endMs, source.durationMs)

    val startFrame = startMs * source.sampleRateHz / 1_000L
    val endFrame = ceil(endMs * source.sampleRateHz / 1_000.0).toLong()
      .coerceAtMost(source.dataBytes / source.bytesPerFrame)
    val frameCount = endFrame - startFrame
    if (frameCount <= 0L) throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "media clip range is empty")
    val pcmBytes = frameCount * source.bytesPerFrame
    if (pcmBytes > 0xfffffff0L) {
      throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "media clip is too large")
    }

    val directory = File(root, normalizedMeetingId)
    if (!directory.exists() && !directory.mkdirs()) {
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "media clip directory is unavailable")
    }
    val finalFile = File(directory, "$normalizedClipId.wav")
    val temporaryFile = File(directory, "$normalizedClipId.wav.part")
    temporaryFile.delete()
    val header = WavHeader.create(pcmBytes)
    val digest = MessageDigest.getInstance("SHA-256")

    try {
      RandomAccessFile(source.file, "r").use { input ->
        RandomAccessFile(temporaryFile, "rw").use { output ->
          output.setLength(0L)
          output.write(header)
          digest.update(header)
          input.seek(source.dataOffset + startFrame * source.bytesPerFrame)
          val buffer = ByteArray(COPY_BUFFER_BYTES)
          var remaining = pcmBytes
          while (remaining > 0L) {
            val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
            if (count <= 0) throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "media clip source ended early")
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
            remaining -= count
          }
          output.fd.sync()
        }
      }
      if (temporaryFile.length() != pcmBytes + AudioRuntimeContract.WAV_HEADER_BYTES) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "media clip file size is invalid")
      }
      if (finalFile.exists() && !finalFile.delete()) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "existing media clip could not be replaced")
      }
      if (!temporaryFile.renameTo(finalFile)) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "media clip could not be finalized")
      }
    } catch (error: MediaClipException) {
      temporaryFile.delete()
      throw error
    } catch (error: Exception) {
      temporaryFile.delete()
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "media clip export failed")
    }

    ExportedWavClip(
      meetingId = normalizedMeetingId,
      clipId = normalizedClipId,
      localUri = Uri.fromFile(finalFile).toString(),
      fileName = finalFile.name,
      byteSize = finalFile.length(),
      durationMs = frameCount * 1_000L / source.sampleRateHz,
      checksumSha256 = "sha256:${digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }}",
    )
  }

  fun importRemote(
    sourceUri: String,
    meetingId: String,
    clipId: String,
    expectedByteSize: Long,
    expectedChecksumSha256: String,
    expectedDurationMs: Long,
  ): ExportedWavClip = synchronized(mediaClipIoLock) {
    val normalizedMeetingId = validateIdentity(meetingId, "meeting")
    val normalizedClipId = validateIdentity(clipId, "clip")
    val source = requireDownloadedSource(sourceUri)
    val checksum = expectedChecksumSha256.trim().lowercase()
    if (!SHA256.matches(checksum)) {
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "remote media clip checksum is invalid")
    }
    if (expectedByteSize <= AudioRuntimeContract.WAV_HEADER_BYTES || source.length() != expectedByteSize) {
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "remote media clip size changed")
    }
    val directory = File(root, normalizedMeetingId)
    if (!directory.exists() && !directory.mkdirs()) {
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "media clip directory is unavailable")
    }
    val finalFile = File(directory, "$normalizedClipId.wav")
    val temporaryFile = File(directory, "$normalizedClipId.wav.part")
    temporaryFile.delete()
    val digest = MessageDigest.getInstance("SHA-256")
    try {
      FileInputStream(source).use { input ->
        FileOutputStream(temporaryFile).use { output ->
          val buffer = ByteArray(COPY_BUFFER_BYTES)
          var total = 0L
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            total += count
            if (total > expectedByteSize) {
              throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "remote media clip grew during import")
            }
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
          }
          output.flush()
          output.fd.sync()
          if (total != expectedByteSize) {
            throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "remote media clip ended early")
          }
        }
      }
      val actualChecksum = "sha256:${digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }}"
      if (actualChecksum != checksum) {
        throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "remote media clip checksum changed")
      }
      val inspected = parsePcmWav(Uri.fromFile(temporaryFile).toString())
      if (kotlin.math.abs(inspected.durationMs - expectedDurationMs) > 250L) {
        throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "remote media clip duration is inconsistent")
      }
      if (finalFile.exists() && !finalFile.delete()) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "existing media clip could not be replaced")
      }
      if (!temporaryFile.renameTo(finalFile)) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "media clip could not be finalized")
      }
      return@synchronized ExportedWavClip(
        meetingId = normalizedMeetingId,
        clipId = normalizedClipId,
        localUri = Uri.fromFile(finalFile).toString(),
        fileName = finalFile.name,
        byteSize = finalFile.length(),
        durationMs = inspected.durationMs,
        checksumSha256 = actualChecksum,
      )
    } catch (error: MediaClipException) {
      temporaryFile.delete()
      throw error
    } catch (error: Exception) {
      temporaryFile.delete()
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "remote media clip import failed")
    }
  }

  fun delete(meetingId: String, clipId: String): Boolean = synchronized(mediaClipIoLock) {
    val directory = File(root, validateIdentity(meetingId, "meeting"))
    val normalizedClipId = validateIdentity(clipId, "clip")
    val files = listOf(
      File(directory, "$normalizedClipId.wav"),
      File(directory, "$normalizedClipId.wav.part"),
    )
    var deleted = false
    files.forEach { file ->
      if (file.exists()) {
        if (!file.delete()) throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "media clip could not be deleted")
        deleted = true
      }
    }
    if (directory.listFiles().isNullOrEmpty()) directory.delete()
    deleted
  }

  fun deleteMeeting(meetingId: String): Int = synchronized(mediaClipIoLock) {
    val directory = File(root, validateIdentity(meetingId, "meeting"))
    if (!directory.exists()) return@synchronized 0
    val files = directory.walkBottomUp().filter { it.isFile }.toList()
    val count = files.size
    if (!directory.deleteRecursively()) {
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "meeting media clips could not be deleted")
    }
    count
  }

  private fun parsePcmWav(sourceUri: String): PcmWavSource {
    val uri = runCatching { Uri.parse(sourceUri.trim()) }.getOrNull()
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "invalid media clip source")
    if (uri.scheme != "file") {
      throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "only local WAV recordings can be clipped on this device")
    }
    val sourcePath = uri.path?.takeIf { it.isNotBlank() }
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "media clip source path is missing")
    val file = runCatching { File(sourcePath).canonicalFile }.getOrNull()
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "media clip source path is invalid")
    val filesRoot = applicationContext.filesDir.canonicalFile
    if (!file.path.startsWith("${filesRoot.path}${File.separator}") || !file.isFile || !file.canRead()) {
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "media clip source is unavailable")
    }
    if (file.length() < 44L) throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV source is incomplete")

    RandomAccessFile(file, "r").use { input ->
      val rootHeader = ByteArray(12)
      input.readFully(rootHeader)
      if (
        String(rootHeader, 0, 4, Charsets.US_ASCII) != "RIFF"
        || String(rootHeader, 8, 4, Charsets.US_ASCII) != "WAVE"
      ) throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "source is not a WAV file")

      var offset = 12L
      var sampleRateHz: Int? = null
      var bytesPerFrame: Int? = null
      var dataOffset: Long? = null
      var dataBytes: Long? = null
      while (offset + 8L <= file.length() && offset <= MAX_HEADER_SCAN_BYTES) {
        input.seek(offset)
        val chunkHeader = ByteArray(8)
        input.readFully(chunkHeader)
        val chunkId = String(chunkHeader, 0, 4, Charsets.US_ASCII)
        val chunkBytes = uint32LittleEndian(chunkHeader, 4)
        val payloadOffset = offset + 8L
        if (chunkBytes < 0L || payloadOffset + chunkBytes > file.length()) {
          throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV chunk is invalid")
        }
        if (chunkId == "fmt ") {
          if (chunkBytes < 16L) throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV format is incomplete")
          val format = ByteArray(16)
          input.readFully(format)
          val values = ByteBuffer.wrap(format).order(ByteOrder.LITTLE_ENDIAN)
          val encoding = values.short.toInt() and 0xffff
          val channels = values.short.toInt() and 0xffff
          val sampleRate = values.int
          values.int
          val blockAlign = values.short.toInt() and 0xffff
          val bitsPerSample = values.short.toInt() and 0xffff
          if (
            encoding != 1
            || channels != AudioRuntimeContract.CHANNEL_COUNT
            || sampleRate != AudioRuntimeContract.SAMPLE_RATE_HZ
            || bitsPerSample != AudioRuntimeContract.BITS_PER_SAMPLE
            || blockAlign != AudioRuntimeContract.CHANNEL_COUNT * AudioRuntimeContract.BYTES_PER_SAMPLE
          ) throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV format is not supported for local clipping")
          sampleRateHz = sampleRate
          bytesPerFrame = blockAlign
        } else if (chunkId == "data") {
          dataOffset = payloadOffset
          dataBytes = chunkBytes
        }
        if (sampleRateHz != null && dataOffset != null) break
        offset = payloadOffset + chunkBytes + (chunkBytes and 1L)
      }
      val rate = sampleRateHz
        ?: throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV format chunk is missing")
      val frameBytes = bytesPerFrame
        ?: throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV frame size is missing")
      val pcmOffset = dataOffset
        ?: throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV data chunk is missing")
      val pcmBytes = dataBytes
        ?: throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV data size is missing")
      if (pcmBytes <= 0L || pcmBytes % frameBytes != 0L) {
        throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV data is not frame aligned")
      }
      return PcmWavSource(file, pcmOffset, pcmBytes, rate, frameBytes)
    }
  }

  private fun requireDownloadedSource(sourceUri: String): File {
    val uri = runCatching { Uri.parse(sourceUri.trim()) }.getOrNull()
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "invalid downloaded media clip URI")
    if (uri.scheme != "file") {
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "downloaded media clip must be a local file")
    }
    val source = runCatching { File(uri.path.orEmpty()).canonicalFile }.getOrNull()
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "downloaded media clip path is invalid")
    val cacheRoot = applicationContext.cacheDir.canonicalFile
    val filesRoot = applicationContext.filesDir.canonicalFile
    val allowed = source.path.startsWith("${cacheRoot.path}${File.separator}")
      || source.path.startsWith("${filesRoot.path}${File.separator}")
    if (!allowed || !source.isFile || !source.canRead()) {
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "downloaded media clip is unavailable")
    }
    return source
  }

  private fun validateRange(startMs: Long, endMs: Long, durationMs: Long) {
    if (startMs < 0L || endMs <= startMs || endMs > durationMs) {
      throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "media clip range is invalid")
    }
    val length = endMs - startMs
    if (length < capabilities.minimumDurationMs || length > capabilities.maximumDurationMs) {
      throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "media clip duration is outside supported limits")
    }
  }

  private fun validateIdentity(value: String, label: String): String {
    val normalized = value.trim()
    if (!SAFE_ID.matches(normalized)) {
      throw MediaClipException("ERR_MEDIA_CLIP_IDENTITY", "$label identity is invalid")
    }
    return normalized
  }

  private fun uint32LittleEndian(bytes: ByteArray, offset: Int): Long =
    ByteBuffer.wrap(bytes, offset, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xffffffffL

  companion object {
    private const val COPY_BUFFER_BYTES = 64 * 1_024
    private const val MAX_HEADER_SCAN_BYTES = 1_048_576L
    private val SAFE_ID = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,159}")
    private val SHA256 = Regex("sha256:[0-9a-f]{64}")
    private val mediaClipIoLock = Any()
  }
}
