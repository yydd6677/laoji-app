package com.laoji.nativeplatform.hardware

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BleHardwareFramingTest {
  @Test
  fun frameRoundTripsAcrossNegotiatedMtu() {
    val payload = ByteArray(1_337) { index -> (index * 31).toByte() }
    val packets = BleHardwareFragmenter().fragment(payload, maximumPacketBytes = 244)
    assertEquals(6, packets.size)
    val reassembler = BleHardwareReassembler()
    packets.dropLast(1).forEach { assertNull(reassembler.offer(it)) }
    assertArrayEquals(payload, reassembler.offer(packets.last()))
  }

  @Test
  fun duplicateIdenticalFragmentIsIdempotent() {
    val packets = BleHardwareFragmenter(77).fragment(ByteArray(600) { it.toByte() }, 244)
    val reassembler = BleHardwareReassembler()
    assertNull(reassembler.offer(packets.first()))
    assertNull(reassembler.offer(packets.first()))
    var completed: ByteArray? = null
    packets.drop(1).forEach { completed = reassembler.offer(it) ?: completed }
    assertEquals(600, requireNotNull(completed).size)
  }

  @Test
  fun negotiatedMtuNeverProducesAnOversizedAttValue() {
    val payload = ByteArray(1_337) { index -> (index * 17).toByte() }
    val packetLimit = minOf(
      BleHardwareProfile.PREFERRED_MTU - 3,
      BleHardwareProfile.MAX_ATTRIBUTE_VALUE_BYTES,
    )
    val packets = BleHardwareFragmenter().fragment(payload, packetLimit)
    assertTrue(packets.all { it.size <= 512 })
    val reassembler = BleHardwareReassembler()
    var completed: ByteArray? = null
    packets.forEach { completed = reassembler.offer(it) ?: completed }
    assertArrayEquals(payload, completed)
  }

  @Test(expected = HardwareProtocolException::class)
  fun conflictingDuplicateFailsClosed() {
    val packets = BleHardwareFragmenter(91).fragment(ByteArray(500) { 7 }, 244)
    val reassembler = BleHardwareReassembler()
    reassembler.offer(packets.first())
    val changed = packets.first().clone().also { it[it.lastIndex] = 8 }
    reassembler.offer(changed)
  }
}
