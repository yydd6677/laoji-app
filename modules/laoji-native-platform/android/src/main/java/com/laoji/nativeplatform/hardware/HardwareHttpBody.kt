package com.laoji.nativeplatform.hardware

import java.io.InputStream
import java.io.OutputStream
import java.io.IOException

/** Framing only; callers must still verify the WAV and source SHA before commit. */
internal object HardwareHttpBody {
  fun copy(
    input: InputStream,
    output: OutputStream,
    headers: Map<String, String>,
    expectedBytes: Long,
    onProgress: (Long) -> Unit = {},
  ): Long {
    require(expectedBytes > 0)
    val encoding = headers["transfer-encoding"]?.trim()?.lowercase()
    if (encoding != null && encoding != "chunked") throw IOException("Unsupported body encoding")
    val declared = headers["content-length"]
    if (declared != null && declared.toLongOrNull() != expectedBytes) throw IOException("Body length mismatch")
    if (encoding == null && declared == null) throw IOException("Missing body framing")

    // The known development_http board sets Content-Length manually and also
    // uses ESP-IDF send_chunk. Decode TE, while cross-checking its redundant CL.
    // This parser is not used for public HTTP or arbitrary remote endpoints.
    val buffer = ByteArray(64 * 1024)
    var received = 0L
    fun readExactly(size: Long) {
      if (size > expectedBytes - received) throw IOException("Body exceeds source length")
      var left = size
      while (left > 0) {
        val count = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
        if (count < 0) throw IOException("Truncated body")
        if (count == 0) continue
        output.write(buffer, 0, count)
        left -= count
        received += count
        onProgress(received)
      }
    }
    if (encoding == null) {
      readExactly(expectedBytes)
      return received
    }
    while (true) {
      val sizeField = line(input, 1024).substringBefore(';').trim()
      if (!sizeField.matches(Regex("[0-9a-fA-F]{1,16}"))) throw IOException("Invalid chunk size")
      val size = sizeField.toLongOrNull(16) ?: throw IOException("Chunk size overflow")
      if (size == 0L) {
        var trailerBytes = 0
        var trailerCount = 0
        while (true) {
          val trailer = line(input, 4096)
          trailerBytes += trailer.length + 2
          if (trailerBytes > 16384 || ++trailerCount > 64) throw IOException("Trailers exceed bound")
          if (trailer.isEmpty()) break
          val name = trailer.substringBefore(':').trim().lowercase()
          if (':' !in trailer || name in setOf("content-length", "transfer-encoding")) {
            throw IOException("Invalid trailer")
          }
        }
        if (received != expectedBytes) throw IOException("Truncated chunked body")
        return received
      }
      readExactly(size)
      if (input.read() != 13 || input.read() != 10) throw IOException("Invalid chunk terminator")
    }
  }

  private fun line(input: InputStream, limit: Int): String {
    val result = StringBuilder()
    while (result.length < limit) {
      val value = input.read()
      if (value < 0) throw IOException("Truncated chunk framing")
      if (value == 13) {
        if (input.read() != 10) throw IOException("Invalid chunk framing")
        return result.toString()
      }
      if (value !in 32..126) throw IOException("Invalid chunk framing")
      result.append(value.toChar())
    }
    throw IOException("Chunk line exceeds bound")
  }
}
