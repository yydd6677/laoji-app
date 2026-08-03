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
    if (frameCount <= 0L) throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "片段时间范围为空")
    val pcmBytes = frameCount * source.bytesPerFrame
    if (pcmBytes > 0xfffffff0L) {
      throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "音频片段过长")
    }

    val directory = File(root, normalizedMeetingId)
    if (!directory.exists() && !directory.mkdirs()) {
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "片段保存位置不可用")
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
            if (count <= 0) throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "录音在读取过程中提前结束")
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
            remaining -= count
          }
          output.fd.sync()
        }
      }
      if (temporaryFile.length() != pcmBytes + AudioRuntimeContract.WAV_HEADER_BYTES) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "片段文件大小无效")
      }
      if (finalFile.exists() && !finalFile.delete()) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "无法替换已有片段")
      }
      if (!temporaryFile.renameTo(finalFile)) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "片段无法保存")
      }
    } catch (error: MediaClipException) {
      temporaryFile.delete()
      throw error
    } catch (error: Exception) {
      temporaryFile.delete()
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "片段生成失败")
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
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "远端片段校验值无效")
    }
    if (expectedByteSize <= AudioRuntimeContract.WAV_HEADER_BYTES || source.length() != expectedByteSize) {
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "远端片段大小发生变化")
    }
    val directory = File(root, normalizedMeetingId)
    if (!directory.exists() && !directory.mkdirs()) {
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "片段保存位置不可用")
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
              throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "远端片段在导入过程中变大")
            }
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
          }
          output.flush()
          output.fd.sync()
          if (total != expectedByteSize) {
            throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "远端片段在导入过程中提前结束")
          }
        }
      }
      val actualChecksum = "sha256:${digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }}"
      if (actualChecksum != checksum) {
        throw MediaClipException("ERR_MEDIA_CLIP_SOURCE_CHANGED", "远端片段校验值发生变化")
      }
      val inspected = parsePcmWav(Uri.fromFile(temporaryFile).toString())
      if (kotlin.math.abs(inspected.durationMs - expectedDurationMs) > 250L) {
        throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "远端片段时长不一致")
      }
      if (finalFile.exists() && !finalFile.delete()) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "无法替换已有片段")
      }
      if (!temporaryFile.renameTo(finalFile)) {
        throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "片段无法保存")
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
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "远端片段导入失败")
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
        if (!file.delete()) throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "片段无法删除")
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
      throw MediaClipException("ERR_MEDIA_CLIP_STORAGE", "会议片段无法删除")
    }
    count
  }

  private fun parsePcmWav(sourceUri: String): PcmWavSource {
    val uri = runCatching { Uri.parse(sourceUri.trim()) }.getOrNull()
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "片段来源无效")
    if (uri.scheme != "file") {
      throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "本机仅支持从 WAV 录音生成片段")
    }
    val sourcePath = uri.path?.takeIf { it.isNotBlank() }
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "片段来源路径缺失")
    val file = runCatching { File(sourcePath).canonicalFile }.getOrNull()
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "片段来源路径无效")
    val filesRoot = applicationContext.filesDir.canonicalFile
    if (!file.path.startsWith("${filesRoot.path}${File.separator}") || !file.isFile || !file.canRead()) {
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "片段来源不可用")
    }
    if (file.length() < 44L) throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV 录音不完整")

    RandomAccessFile(file, "r").use { input ->
      val rootHeader = ByteArray(12)
      input.readFully(rootHeader)
      if (
        String(rootHeader, 0, 4, Charsets.US_ASCII) != "RIFF"
        || String(rootHeader, 8, 4, Charsets.US_ASCII) != "WAVE"
      ) throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "录音不是 WAV 格式")

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
          throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV 数据块无效")
        }
        if (chunkId == "fmt ") {
          if (chunkBytes < 16L) throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV 格式信息不完整")
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
          ) throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "本机不支持此 WAV 格式的片段生成")
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
        ?: throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV 格式块缺失")
      val frameBytes = bytesPerFrame
        ?: throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV 帧大小缺失")
      val pcmOffset = dataOffset
        ?: throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV 音频数据块缺失")
      val pcmBytes = dataBytes
        ?: throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV 音频数据大小缺失")
      if (pcmBytes <= 0L || pcmBytes % frameBytes != 0L) {
        throw MediaClipException("ERR_MEDIA_CLIP_FORMAT", "WAV 音频数据未按帧对齐")
      }
      return PcmWavSource(file, pcmOffset, pcmBytes, rate, frameBytes)
    }
  }

  private fun requireDownloadedSource(sourceUri: String): File {
    val uri = runCatching { Uri.parse(sourceUri.trim()) }.getOrNull()
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "下载的片段地址无效")
    if (uri.scheme != "file") {
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "下载的片段必须是本机文件")
    }
    val source = runCatching { File(uri.path.orEmpty()).canonicalFile }.getOrNull()
      ?: throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "下载的片段路径无效")
    val cacheRoot = applicationContext.cacheDir.canonicalFile
    val filesRoot = applicationContext.filesDir.canonicalFile
    val allowed = source.path.startsWith("${cacheRoot.path}${File.separator}")
      || source.path.startsWith("${filesRoot.path}${File.separator}")
    if (!allowed || !source.isFile || !source.canRead()) {
      throw MediaClipException("ERR_MEDIA_CLIP_SOURCE", "下载的片段不可用")
    }
    return source
  }

  private fun validateRange(startMs: Long, endMs: Long, durationMs: Long) {
    if (startMs < 0L || endMs <= startMs || endMs > durationMs) {
      throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "片段时间范围无效")
    }
    val length = endMs - startMs
    if (length < capabilities.minimumDurationMs || length > capabilities.maximumDurationMs) {
      throw MediaClipException("ERR_MEDIA_CLIP_RANGE", "片段时长超出支持范围")
    }
  }

  private fun validateIdentity(value: String, label: String): String {
    val normalized = value.trim()
    if (!SAFE_ID.matches(normalized)) {
      throw MediaClipException("ERR_MEDIA_CLIP_IDENTITY", "片段标识无效")
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
