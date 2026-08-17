package com.laoji.nativeplatform.mediaimport

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import kotlin.math.max

/**
 * Turns a user-selected video into the smallest audio-only asset that the
 * meeting pipeline needs.  AAC-in-MP4 can be remuxed without decoding; other
 * Android-supported audio codecs fall back to PCM/WAV decoding.  The source
 * URI is read directly and is never copied into the app's import directory.
 */
internal data class ExtractedAudio(
  val extension: String,
  val mimeType: String,
  val durationMs: Long,
)

internal object MediaAudioExtractor {
  fun extract(
    context: Context,
    sourceUri: Uri,
    temporaryFile: File,
    maximumBytes: Long,
  ): ExtractedAudio {
    temporaryFile.delete()
    val track = findAudioTrack(context, sourceUri)
    val durationMs = track.format.longValue(MediaFormat.KEY_DURATION)?.let { max(0L, it / 1000L) }

    val remuxed = runCatching {
      remuxAudio(context, sourceUri, track.index, temporaryFile, maximumBytes)
    }.getOrNull()
    if (remuxed != null && remuxed > 0L) {
      val outputDurationMs = durationMs ?: readDurationMs(temporaryFile)
      return ExtractedAudio(
        extension = "m4a",
        mimeType = "audio/mp4",
        durationMs = outputDurationMs ?: 0L,
      )
    }
    temporaryFile.delete()

    val decoded = decodeToWav(context, sourceUri, track.index, temporaryFile, maximumBytes)
    if (decoded.bytes <= 0L) {
      temporaryFile.delete()
      throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "所选文件没有可用的音频内容")
    }
    return ExtractedAudio(
      extension = "wav",
      mimeType = "audio/wav",
      durationMs = durationMs ?: decoded.durationMs,
    )
  }

  private data class AudioTrack(val index: Int, val format: MediaFormat)

  private fun findAudioTrack(context: Context, uri: Uri): AudioTrack {
    val extractor = MediaExtractor()
    try {
      setDataSource(extractor, context, uri)
      for (index in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(index)
        val mime = format.stringValue(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("audio/")) return AudioTrack(index, format)
      }
    } catch (error: MediaImportException) {
      throw error
    } catch (error: Throwable) {
      throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "无法读取视频中的音轨", error)
    } finally {
      runCatching { extractor.release() }
    }
    throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "所选视频不包含音轨")
  }

  private fun remuxAudio(
    context: Context,
    uri: Uri,
    trackIndex: Int,
    output: File,
    maximumBytes: Long,
  ): Long {
    val extractor = MediaExtractor()
    var muxer: MediaMuxer? = null
    try {
      setDataSource(extractor, context, uri)
      val format = extractor.getTrackFormat(trackIndex)
      val mime = format.stringValue(MediaFormat.KEY_MIME) ?: return 0L
      // MediaMuxer MPEG-4 output is intentionally restricted to codecs that
      // Android can store in an M4A container.  If it rejects another codec,
      // the caller will use the decoder/WAV fallback below.
      if (mime != "audio/mp4a-latm" && mime != "audio/aac" && mime != "audio/mpeg") return 0L
      output.parentFile?.mkdirs()
      muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val outputTrack = muxer.addTrack(format)
      muxer.start()
      extractor.selectTrack(trackIndex)
      val maxInputSize = format.integerValue(MediaFormat.KEY_MAX_INPUT_SIZE)
        ?.coerceIn(64 * 1024, 4 * 1024 * 1024)
        ?: 1024 * 1024
      val buffer = ByteBuffer.allocate(maxInputSize)
      val info = MediaCodec.BufferInfo()
      var total = 0L
      while (true) {
        buffer.clear()
        val sampleSize = extractor.readSampleData(buffer, 0)
        if (sampleSize < 0) break
        if (total + sampleSize > maximumBytes) {
          throw MediaImportException("ERR_MEDIA_IMPORT_TOO_LARGE", "提取后的音频超过当前允许的大小")
        }
        info.offset = 0
        info.size = sampleSize
        info.presentationTimeUs = extractor.sampleTime.coerceAtLeast(0L)
        info.flags = extractor.sampleFlags
        muxer.writeSampleData(outputTrack, buffer, info)
        total += sampleSize
        extractor.advance()
      }
      muxer.stop()
      muxer.release()
      muxer = null
      return total
    } finally {
      runCatching { muxer?.stop() }
      runCatching { muxer?.release() }
      runCatching { extractor.release() }
    }
  }

  private data class DecodedAudio(val bytes: Long, val durationMs: Long)

  private fun decodeToWav(
    context: Context,
    uri: Uri,
    trackIndex: Int,
    output: File,
    maximumBytes: Long,
  ): DecodedAudio {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    var random: RandomAccessFile? = null
    try {
      setDataSource(extractor, context, uri)
      val format = extractor.getTrackFormat(trackIndex)
      val mime = format.stringValue(MediaFormat.KEY_MIME)
        ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "无法读取视频音轨格式")
      codec = MediaCodec.createDecoderByType(mime)
      codec.configure(format, null, null, 0)
      codec.start()
      extractor.selectTrack(trackIndex)
      random = RandomAccessFile(output, "rw")
      random.setLength(0L)
      random.seek(44L)

      val info = MediaCodec.BufferInfo()
      var inputEnded = false
      var outputEnded = false
      var sampleRate = format.integerValue(MediaFormat.KEY_SAMPLE_RATE) ?: 16_000
      var channelCount = format.integerValue(MediaFormat.KEY_CHANNEL_COUNT) ?: 1
      var bytesWritten = 0L
      var lastPresentationUs = 0L
      val startedAt = System.nanoTime()
      while (!outputEnded) {
        if (System.nanoTime() - startedAt > 180L * 1_000_000_000L) {
          throw MediaImportException("ERR_MEDIA_IMPORT_FAILED", "提取视频音频超时")
        }
        if (!inputEnded) {
          val inputIndex = codec.dequeueInputBuffer(10_000L)
          if (inputIndex >= 0) {
            val input = codec.getInputBuffer(inputIndex)
              ?: throw MediaImportException("ERR_MEDIA_IMPORT_FAILED", "无法读取视频音轨")
            input.clear()
            val sampleSize = extractor.readSampleData(input, 0)
            if (sampleSize < 0) {
              codec.queueInputBuffer(
                inputIndex,
                0,
                0,
                0L,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM,
              )
              inputEnded = true
            } else {
              val presentationUs = extractor.sampleTime.coerceAtLeast(0L)
              codec.queueInputBuffer(inputIndex, 0, sampleSize, presentationUs, extractor.sampleFlags)
              lastPresentationUs = max(lastPresentationUs, presentationUs)
              extractor.advance()
            }
          }
        }

        when (val outputIndex = codec.dequeueOutputBuffer(info, 10_000L)) {
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val outputFormat = codec.outputFormat
            sampleRate = outputFormat.integerValue(MediaFormat.KEY_SAMPLE_RATE) ?: sampleRate
            channelCount = outputFormat.integerValue(MediaFormat.KEY_CHANNEL_COUNT) ?: channelCount
            val pcmEncoding = outputFormat.integerValue(MediaFormat.KEY_PCM_ENCODING)
            if (pcmEncoding != null && pcmEncoding != 2) {
              throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "设备返回了不支持的音频编码")
            }
          }
          else -> if (outputIndex >= 0) {
            val buffer = codec.getOutputBuffer(outputIndex)
            if (buffer != null && info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              val bytes = ByteArray(buffer.remaining())
              buffer.get(bytes)
              random.write(bytes)
              bytesWritten += bytes.size
              if (bytesWritten > maximumBytes) {
                throw MediaImportException("ERR_MEDIA_IMPORT_TOO_LARGE", "提取后的音频超过当前允许的大小")
              }
            }
            if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputEnded = true
            codec.releaseOutputBuffer(outputIndex, false)
          }
        }
      }
      if (bytesWritten <= 0L || sampleRate <= 0 || channelCount <= 0 || channelCount > 8) {
        throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "所选视频没有可用的音频内容")
      }
      writeWavHeader(random, bytesWritten, sampleRate, channelCount)
      val durationMs = if (sampleRate > 0 && channelCount > 0) {
        bytesWritten * 1000L / (sampleRate.toLong() * channelCount.toLong() * 2L)
      } else {
        lastPresentationUs / 1000L
      }
      random.fd.sync()
      return DecodedAudio(bytesWritten + 44L, durationMs)
    } catch (error: MediaImportException) {
      throw error
    } catch (error: Throwable) {
      throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "无法提取视频音频", error)
    } finally {
      runCatching { codec?.stop() }
      runCatching { codec?.release() }
      runCatching { extractor.release() }
      runCatching { random?.close() }
    }
  }

  private fun setDataSource(extractor: MediaExtractor, context: Context, uri: Uri) {
    try {
      if (uri.scheme == "file") {
        extractor.setDataSource(uri.path ?: throw IllegalArgumentException("file path missing"))
      } else {
        extractor.setDataSource(context, uri, emptyMap())
      }
    } catch (error: Throwable) {
      throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "无法读取所选文件", error)
    }
  }

  private fun readDurationMs(file: File): Long? {
    val retriever = android.media.MediaMetadataRetriever()
    return try {
      retriever.setDataSource(file.absolutePath)
      retriever.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toLongOrNull()
        ?.takeIf { it >= 0L }
    } catch (_: Throwable) {
      null
    } finally {
      runCatching { retriever.release() }
    }
  }

  private fun writeWavHeader(
    file: RandomAccessFile?,
    dataBytes: Long,
    sampleRate: Int,
    channels: Int,
  ) {
    requireNotNull(file)
    file.seek(0L)
    file.write("RIFF".toByteArray(Charsets.US_ASCII))
    file.writeLittleEndianInt((36L + dataBytes).coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
    file.write("WAVEfmt ".toByteArray(Charsets.US_ASCII))
    file.writeLittleEndianInt(16)
    file.writeLittleEndianShort(1)
    file.writeLittleEndianShort(channels)
    file.writeLittleEndianInt(sampleRate)
    file.writeLittleEndianInt(sampleRate * channels * 2)
    file.writeLittleEndianShort(channels * 2)
    file.writeLittleEndianShort(16)
    file.write("data".toByteArray(Charsets.US_ASCII))
    file.writeLittleEndianInt(dataBytes.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
  }

  private fun RandomAccessFile.writeLittleEndianInt(value: Int) {
    write(byteArrayOf(
      (value and 0xff).toByte(),
      ((value ushr 8) and 0xff).toByte(),
      ((value ushr 16) and 0xff).toByte(),
      ((value ushr 24) and 0xff).toByte(),
    ))
  }

  private fun RandomAccessFile.writeLittleEndianShort(value: Int) {
    write(byteArrayOf(
      (value and 0xff).toByte(),
      ((value ushr 8) and 0xff).toByte(),
    ))
  }

  private fun MediaFormat.stringValue(key: String): String? =
    if (containsKey(key)) getString(key) else null

  private fun MediaFormat.integerValue(key: String): Int? =
    if (containsKey(key)) runCatching { getInteger(key) }.getOrNull() else null

  private fun MediaFormat.longValue(key: String): Long? =
    if (containsKey(key)) runCatching { getLong(key) }.getOrNull() else null
}
