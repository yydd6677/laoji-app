package com.laoji.nativeplatform.hardware

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class HardwareTransferMetricsTest {
  @Test fun instrumentationPreservesBulkIoAndExactBytes() {
    val data = ByteArray(1024 * 1024) { (it % 251).toByte() }
    val source = ByteArrayInputStream(data)
    var singles = 0; var bulks = 0
    val saved = ByteArrayOutputStream()
    val sink = object : java.io.OutputStream() {
      override fun write(value: Int) { singles++; saved.write(value) }
      override fun write(bytes: ByteArray, offset: Int, length: Int) { bulks++; saved.write(bytes, offset, length) }
    }
    val timing = HardwareTransferMetrics()
    var progress = 0L
    val count = HardwareHttpBody.copy(timing.input(source), timing.output(sink),
      mapOf("content-length" to data.size.toString()), data.size.toLong()) {
      timing.progress { progress = it }
    }
    assertArrayEquals(data, saved.toByteArray()); assertEquals(data.size.toLong(), count)
    assertEquals(count, progress); assertEquals(0, singles); assertEquals(16, bulks)
    assertEquals(16, timing.reads); assertEquals(16, timing.writes)
  }
  @Test fun chunkFramingStillPassesThroughSameParser() {
    val timing = HardwareTransferMetrics(); val saved = ByteArrayOutputStream()
    HardwareHttpBody.copy(timing.input(ByteArrayInputStream("2\r\nab\r\n1\r\nc\r\n0\r\n\r\n".toByteArray())),
      timing.output(saved), mapOf("transfer-encoding" to "chunked"), 3)
    assertEquals("abc", saved.toString("UTF-8")); assertEquals(2, timing.writes)
  }
}
