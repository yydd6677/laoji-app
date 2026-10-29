package com.laoji.nativeplatform.audio

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import kotlin.random.Random

class RealtimePackingTest {
  private class ReferencePacking(private val packetBytes: Int = 16000) {
    private var pending = ByteArray(0)
    fun append(buffer: ByteArray, count: Int): List<ByteArray> {
      val combined = pending + buffer.copyOf(count)
      val result = mutableListOf<ByteArray>()
      var offset = 0
      while (combined.size - offset >= packetBytes + 32) {
        result += combined.copyOfRange(offset, offset + packetBytes); offset += packetBytes
      }
      pending = combined.copyOfRange(offset, combined.size)
      return result
    }
    fun finish(): ByteArray? = pending.takeIf { it.isNotEmpty() }
  }

  @Test fun reusableBufferPreservesEveryPacketAndEmissionBoundary() {
    for (packetBytes in listOf(32, 64, 3200, 16000)) {
      val random = Random(1253 + packetBytes)
      val packer = RealtimePcmPacketizer(packetBytes)
      val reference = ReferencePacking(packetBytes)
      // Odd capture reads, empty appends, multiple output packets in one read,
      // caller-buffer reuse and the retained one-ms tail all stay lossless.
      repeat(2000) {
        val size = random.nextInt(0, 20001)
        val input = random.nextBytes(size + 13)
        val expected = reference.append(input, size)
        val actual = packer.append(input, size)
        input.fill(0)
        assertEquals(expected.size, actual.size)
        expected.indices.forEach { assertArrayEquals(expected[it], actual[it]) }
      }
      val expected = reference.finish()
      if (expected != null && expected.size % 2 == 0) assertArrayEquals(expected, packer.finish())
      else if (expected != null) assertThrows(IllegalArgumentException::class.java) { packer.finish() }
      packer.clear(); assertNull(packer.finish())
    }
  }

  @Test fun packingAllocationObservationDoesNotChangeTheWireContract() {
    // Android's compilation bootclasspath intentionally omits JDK management
    // classes. Resolve the optional host-only observation API reflectively.
    val bean = Class.forName("java.lang.management.ManagementFactory").getMethod("getThreadMXBean").invoke(null)
    val api = Class.forName("com.sun.management.ThreadMXBean")
    if (!api.isInstance(bean) || api.getMethod("isThreadAllocatedMemorySupported").invoke(bean) != true) return
    api.getMethod("setThreadAllocatedMemoryEnabled", java.lang.Boolean.TYPE).invoke(bean, true)
    val allocated = api.getMethod("getThreadAllocatedBytes", java.lang.Long.TYPE)
    fun allocatedBytes(): Long = allocated.invoke(bean, Thread.currentThread().id) as Long
    val input = ByteArray(3200) { (it * 11).toByte() }
    fun observe(append: (ByteArray, Int) -> List<ByteArray>, finish: () -> ByteArray?): Pair<Long, Long> {
      val before = allocatedBytes()
      var bytes = 0L
      repeat(10000) { append(input, input.size).forEach { bytes += it.size } }
      bytes += finish()?.size ?: 0
      return allocatedBytes() - before to bytes
    }
    val old = ReferencePacking(); val current = RealtimePcmPacketizer()
    val baseline = observe(old::append, old::finish)
    val candidate = observe(current::append, current::finish)
    assertEquals(32_000_000L, baseline.second); assertEquals(baseline.second, candidate.second)
    // Allocation totals are evidence only, not a timing/GC threshold in CI.
    println("packing_host_allocations input_bytes=${baseline.second} baseline_bytes=${baseline.first} candidate_bytes=${candidate.first}")
  }

  @Test fun irregularCaptureReadsAndSubMillisecondTailAreLossless() {
    for (length in listOf(32, 15998, 16000, 16002, 16030, 16032, 32014, 256002)) {
      val input = ByteArray(length) { (it * 17).toByte() }
      val packer = RealtimePcmPacketizer()
      val packets = mutableListOf<ByteArray>()
      var offset = 0
      while (offset < input.size) {
        val size = minOf(3197, input.size - offset)
        packets += packer.append(input.copyOfRange(offset, offset + size), size)
        offset += size
      }
      packer.finish()?.let(packets::add)
      assertArrayEquals(input, packets.fold(ByteArray(0)) { all, part -> all + part })
      assertTrue(packets.all { it.size >= 32 && it.size % 2 == 0 && it.size < 16032 })
      assertNull(packer.finish())
    }
  }

  @Test fun transportPackingReducesDurablePacketsWithoutChangingVadCuts() {
    val packer = RealtimePcmPacketizer()
    var packets = 0
    repeat(100) { packets += packer.append(ByteArray(3200), 3200).size }
    if (packer.finish() != null) packets++
    assertEquals(20, packets) // 10 seconds / 500ms, not 100 independent fsyncs.
  }

  @Test fun emptyCancelAndIncompleteSampleFailClosed() {
    val packer = RealtimePcmPacketizer()
    assertNull(packer.finish())
    packer.append(ByteArray(40), 40)
    packer.clear()
    assertNull(packer.finish())
    packer.append(ByteArray(33), 33)
    assertThrows(IllegalArgumentException::class.java) { packer.finish() }
  }

  @Test fun spoolIndexRebuildsAndUsesCumulativeAckWithoutDeletingLaterFiles() {
    val root = Files.createTempDirectory("laoji-spool-test").toFile()
    try {
      File(root, "orphan.tmp").writeBytes(ByteArray(7))
      File(root, "chunk-4.bin").writeBytes(ByteArray(10))
      File(root, "event-2.bin").writeBytes(ByteArray(5))
      val index = RealtimeSpoolIndex(root)
      assertEquals(22L, index.bytes)
      val later = File(root, "chunk-5.bin").apply { writeBytes(ByteArray(12)) }
      index.committed(later)
      assertEquals(34L, index.bytes)
      index.committed(later)
      assertEquals(34L, index.bytes)
      index.through("chunk", 4).forEach { assertTrue(it.delete()); index.deleted(it) }
      assertEquals(listOf(later), index.files("chunk"))
      assertEquals(24L, index.bytes)
      assertEquals(index.bytes, RealtimeSpoolIndex(root).bytes)
      assertEquals(1, index.files("event").size)
    } finally { root.deleteRecursively() }
  }
}
