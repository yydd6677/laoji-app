package com.laoji.nativeplatform.transfer

// MIN-UPLOAD-001: content URIs stream to the request body without loading whole audio files.

import android.content.ContentResolver
import android.net.Uri
import okhttp3.MediaType
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.FileInputStream

internal class ContentUriRequestBody(
  private val contentResolver: ContentResolver,
  private val uri: Uri,
  private val mediaType: MediaType,
  private val expectedLength: Long?
) : RequestBody() {
  override fun contentType(): MediaType = mediaType

  override fun contentLength(): Long = expectedLength ?: -1L

  override fun writeTo(sink: BufferedSink) {
    val input = contentResolver.openInputStream(uri)
      ?: throw IllegalStateException("无法打开会议录音文件")
    input.use { stream -> sink.writeAll(stream.source()) }
  }
}

/** Streams an exact seekable range for one R2 multipart PUT. */
internal class ContentUriRangeRequestBody(
  private val contentResolver: ContentResolver,
  private val uri: Uri,
  private val mediaType: MediaType,
  private val offset: Long,
  private val length: Long,
) : RequestBody() {
  init {
    require(offset >= 0 && length > 0) { "录音分片范围无效" }
  }

  override fun contentType(): MediaType = mediaType

  override fun contentLength(): Long = length

  override fun writeTo(sink: BufferedSink) {
    val descriptor = contentResolver.openAssetFileDescriptor(uri, "r")
      ?: throw IllegalStateException("无法打开会议录音文件")
    descriptor.use { asset ->
      FileInputStream(asset.fileDescriptor).use { input ->
        input.channel.position(asset.startOffset + offset)
        var remaining = length
        val buffer = ByteArray(256 * 1024)
        while (remaining > 0) {
          val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
          if (count < 0) throw IllegalStateException("会议录音分片提前结束")
          if (count == 0) continue
          sink.write(buffer, 0, count)
          remaining -= count
        }
      }
    }
  }
}
