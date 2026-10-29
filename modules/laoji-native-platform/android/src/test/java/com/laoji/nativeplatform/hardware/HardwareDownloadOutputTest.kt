package com.laoji.nativeplatform.hardware

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import org.junit.Assert.*
import org.junit.Test

class HardwareDownloadOutputTest {
  @Test fun bulkCopyIsNeverExpandedIntoByteAtATimeWrites() {
    var bulk = 0
    val accepted = ByteArrayOutputStream()
    val raw = object : OutputStream() {
      override fun write(value: Int) { fail("byte-at-a-time path") }
      override fun write(bytes: ByteArray, offset: Int, length: Int) { bulk++; accepted.write(bytes, offset, length) }
    }
    val data = ByteArray(65536) { it.toByte() }
    HardwareDownloadOutput(raw).write(data)
    assertEquals(1, bulk); assertArrayEquals(data, accepted.toByteArray())
  }
  @Test fun diskFailureKeepsItsPublicStorageOutcomeAndOriginalCause() {
    val disk = IOException("disk full")
    val raw = object : OutputStream() { override fun write(value: Int) { throw disk } }
    try { HardwareDownloadOutput(raw).write(4); fail("ignored disk failure") }
    catch (error: HardwareRuntimeException) {
      assertEquals("storage_failed", error.publicCode); assertSame(disk, error.cause)
    }
    try { HardwareDownloadOutput.storage<Unit> { throw disk }; fail("ignored fsync failure") }
    catch (error: HardwareRuntimeException) { assertEquals("storage_failed", error.publicCode) }
  }
}
