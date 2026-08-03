package com.laoji.nativeplatform.transfer

// MIN-UPLOAD-001: content URIs stream to the request body without loading whole audio files.

import android.content.ContentResolver
import android.net.Uri
import okhttp3.MediaType
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source

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
