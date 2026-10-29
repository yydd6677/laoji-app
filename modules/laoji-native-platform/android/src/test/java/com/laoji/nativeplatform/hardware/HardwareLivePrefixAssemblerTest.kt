package com.laoji.nativeplatform.hardware

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream

class HardwareLivePrefixAssemblerTest {
  private fun data(start: Int, size: Int) = ByteArray(size) { ((start + it) * 19).toByte() }
  private fun append(output: ByteArrayOutputStream, ranges: List<HardwarePcmRange>) {
    for (range in ranges) { assertEquals(output.size().toLong(), range.offset); output.write(range.bytes) }
  }

  @Test fun contiguousSourceLeavesNoBufferOrRepair() {
    val source = HardwareLivePrefixAssembler(); val output = ByteArrayOutputStream()
    for (offset in 0 until 4920 step 492) append(output, source.accept(offset.toLong(), data(offset, 492)))
    assertArrayEquals(data(0, 4920), output.toByteArray())
    assertEquals(4920L, source.nextOffset); assertEquals(0, source.bufferedBytes); assertNull(source.missing())
  }
  @Test fun oneLostPacketRepairsBeforeLaterBytesCanLeave() {
    val source = HardwareLivePrefixAssembler(); val output = ByteArrayOutputStream()
    append(output, source.accept(0, data(0, 492)))
    assertTrue(source.accept(984, data(984, 492)).isEmpty())
    assertEquals(HardwareMissingPcm(492, 492), source.missing())
    assertEquals(492, output.size())
    append(output, source.accept(492, data(492, 492)))
    assertArrayEquals(data(0, 1476), output.toByteArray()); assertFalse(source.sealed); assertNull(source.missing())
  }
  @Test fun aLargeGapIsRepairedInBoundedOriginalOffsetRanges() {
    val source = HardwareLivePrefixAssembler(); val output = ByteArrayOutputStream()
    source.accept(70000, data(70000, 2))
    val ranges = mutableListOf<HardwareMissingPcm>()
    while (source.missing() != null) {
      val range = source.missing()!!; ranges += range
      append(output, source.accept(range.offset, data(range.offset.toInt(), range.length)))
    }
    assertEquals(listOf(HardwareMissingPcm(0, 32768), HardwareMissingPcm(32768, 32768), HardwareMissingPcm(65536, 4464)), ranges)
    assertArrayEquals(data(0, 70002), output.toByteArray()); assertEquals(0, source.bufferedBytes)
  }
  @Test fun bufferedPacketsAndDeliveredDuplicatesAreNotReplayed() {
    val source = HardwareLivePrefixAssembler(); val output = ByteArrayOutputStream(); val future = data(492, 492)
    source.accept(492, future); source.accept(492, future)
    assertEquals(492, source.bufferedBytes)
    future.fill(0) // Stored source is immutable with respect to caller reuse.
    append(output, source.accept(0, data(0, 492)))
    append(output, source.accept(0, data(0, 492)))
    assertArrayEquals(data(0, 984), output.toByteArray())
  }
  @Test fun conflictingOrOverlappingPendingRangesSealWithoutNewOutput() {
    for (overlap in listOf(4L to byteArrayOf(9, 9), 2L to data(2, 4))) {
      val source = HardwareLivePrefixAssembler(); source.accept(4, data(4, 4))
      assertTrue(source.accept(overlap.first, overlap.second).isEmpty())
      assertTrue(source.sealed); assertEquals(0L, source.nextOffset); assertEquals(0, source.bufferedBytes)
      assertTrue(source.accept(0, data(0, 8)).isEmpty())
    }
  }
  @Test fun partialDeliveredOverlapDoesNotSilentlyTrim() {
    val source = HardwareLivePrefixAssembler(); source.accept(0, data(0, 4))
    assertTrue(source.accept(2, data(2, 4)).isEmpty()); assertTrue(source.sealed); assertEquals(4L, source.nextOffset)
  }
  @Test fun memoryAndAheadLimitsFailClosedAndReleaseHeldBytes() {
    for (source in listOf(HardwareLivePrefixAssembler(maximumBufferedBytes = 4),
      HardwareLivePrefixAssembler(maximumAheadBytes = 7))) {
      source.accept(4, data(4, 4)); assertTrue(source.accept(8, data(8, 2)).isEmpty())
      assertTrue(source.sealed); assertEquals(0, source.bufferedBytes); assertNull(source.missing())
    }
  }
  @Test fun emptyEndMarkersCannotBypassFrameBound() {
    val source = HardwareLivePrefixAssembler(maximumFrames = 2)
    source.accept(2, byteArrayOf()); source.accept(4, byteArrayOf()); source.accept(6, byteArrayOf())
    assertTrue(source.sealed); assertEquals(0, source.bufferedBytes)
  }
  @Test fun emptyFinalMarkerPreservesExactGapAndDoesNotAddSilence() {
    val source = HardwareLivePrefixAssembler(); source.accept(8, byteArrayOf())
    assertEquals(HardwareMissingPcm(0, 8), source.missing())
    val output = ByteArrayOutputStream(); append(output, source.accept(0, data(0, 8)))
    assertArrayEquals(data(0, 8), output.toByteArray()); assertNull(source.missing())
  }
  @Test fun malformedAndOverflowingOffsetsDoNotAdvancePrefix() {
    for ((offset, bytes) in listOf(-2L to data(0, 2), 1L to data(0, 2), 0L to data(0, 1), (Long.MAX_VALUE - 1) to data(0, 4))) {
      val source = HardwareLivePrefixAssembler(); assertTrue(source.accept(offset, bytes).isEmpty())
      assertTrue(source.sealed); assertEquals(0L, source.nextOffset)
    }
  }
  @Test fun explicitSealIsTerminalAndKeepsOnlyDeliveredPrefix() {
    val source = HardwareLivePrefixAssembler(); source.accept(0, data(0, 4)); source.accept(8, data(8, 4))
    source.seal(); assertTrue(source.accept(4, data(4, 4)).isEmpty())
    assertEquals(4L, source.nextOffset); assertEquals(0, source.bufferedBytes)
  }
  @Test fun arbitraryArrivalOrdersStillEmitExactlyOneOriginalSource() {
    repeat(200) { seed ->
      val source = HardwareLivePrefixAssembler(); val output = ByteArrayOutputStream()
      val order = (0 until 40).toMutableList()
      java.util.Collections.shuffle(order, java.util.Random(seed.toLong()))
      for (index in order) {
        val offset = index * 492
        append(output, source.accept(offset.toLong(), data(offset, 492)))
        if (index % 9 == 0) append(output, source.accept(offset.toLong(), data(offset, 492)))
      }
      assertFalse("valid reordered source sealed at seed $seed", source.sealed)
      assertEquals(0, source.bufferedBytes); assertNull(source.missing())
      assertArrayEquals(data(0, 40 * 492), output.toByteArray())
    }
  }
}
