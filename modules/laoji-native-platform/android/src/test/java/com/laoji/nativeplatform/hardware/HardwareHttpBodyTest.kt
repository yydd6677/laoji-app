package com.laoji.nativeplatform.hardware

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException

class HardwareHttpBodyTest {
  private fun decode(wire: String, size: Long = 6, headers: Map<String, String> = mapOf("transfer-encoding" to "chunked")): String {
    val output = ByteArrayOutputStream()
    assertEquals(size, HardwareHttpBody.copy(ByteArrayInputStream(wire.toByteArray()), output, headers, size))
    return output.toString("UTF-8")
  }
  @Test fun contentLengthBodyIsNotChanged() {
    assertEquals("abcdef", decode("abcdef", headers = mapOf("content-length" to "6")))
  }
  @Test fun chunksAreRemovedBeforeWavValidation() {
    assertEquals("abcdef", decode("2\r\nab\r\n4\r\ncdef\r\n0\r\n\r\n"))
  }
  @Test fun knownBoardRedundantLengthIsCrossChecked() {
    assertEquals("abcdef", decode("6\r\nabcdef\r\n0\r\n\r\n", headers = mapOf("transfer-encoding" to "chunked", "content-length" to "6")))
  }
  @Test fun extensionAndBoundedTrailersAreSupported() {
    assertEquals("abcdef", decode("6;foo=bar\r\nabcdef\r\n0\r\nX-Check: yes\r\n\r\n"))
  }
  @Test(expected = IOException::class) fun conflictingLengthRejected() { decode("", headers = mapOf("transfer-encoding" to "chunked", "content-length" to "7")) }
  @Test(expected = IOException::class) fun earlyFinalRejected() { decode("0\r\n\r\n") }
  @Test(expected = IOException::class) fun missingFinalRejected() { decode("6\r\nabcdef\r\n") }
  @Test(expected = IOException::class) fun oversizedChunkRejectedBeforeWrite() { decode("7\r\nabcdefg\r\n0\r\n\r\n") }
  @Test(expected = IOException::class) fun overflowRejected() { decode("ffffffffffffffff\r\n") }
  @Test(expected = IOException::class) fun invalidHexRejected() { decode("zz\r\n") }
  @Test(expected = IOException::class) fun truncatedPayloadRejected() { decode("6\r\nabc") }
  @Test(expected = IOException::class) fun malformedDelimiterRejected() { decode("6\r\nabcdef\n0\r\n\r\n") }
  @Test(expected = IOException::class) fun unboundedLineRejected() { decode("a".repeat(1025)) }
  @Test(expected = IOException::class) fun reframingTrailerRejected() { decode("6\r\nabcdef\r\n0\r\nContent-Length: 7\r\n\r\n") }
  @Test(expected = IOException::class) fun unrecognizedEncodingRejected() { decode("", headers = mapOf("transfer-encoding" to "gzip")) }
  @Test(expected = IOException::class) fun missingFramingRejected() { decode("", headers = emptyMap()) }
  @Test(expected = IOException::class) fun plainBodyTruncationRejected() { decode("abc", headers = mapOf("content-length" to "6")) }
  @Test fun splitNetworkReadsAndResumeSuffixPreserveBytes() {
    val wire = ByteArrayInputStream("2\r\nab\r\n4\r\ncdef\r\n0\r\n\r\n".toByteArray())
    val input = object : java.io.FilterInputStream(wire) {
      override fun read(bytes: ByteArray, start: Int, length: Int): Int = super.read(bytes, start, minOf(1, length))
    }
    val output = ByteArrayOutputStream()
    output.write("prefix".toByteArray())
    val progress = mutableListOf<Long>()
    HardwareHttpBody.copy(input, output, mapOf("transfer-encoding" to "chunked"), 6) { progress.add(it) }
    assertEquals("prefixabcdef", output.toString("UTF-8"))
    assertEquals(6L, progress.last())
    assertTrue(progress.zipWithNext().all { it.first < it.second })
  }
}
