package com.laoji.nativeplatform.hardware

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class HardwareLiveRepairReadTest {
  private fun reply() = JSONObject().put("transport", "ble").put("session_id", "capture-1")
    .put("source_stream_id", 11).put("stream_id", 12).put("offset_scope", "audio_payload")
    .put("offset", 492).put("length", 8).put("chunk_size_bytes", 492)
  private fun operation() = HardwareLiveRepairRead(HardwareMissingPcm(492, 8), "capture-1", 11)
  private fun frame(sequence: Int, offset: Long, bytes: ByteArray, final: Boolean = false) =
    HardwareFrame(HardwareProtocol.KIND_FILE_CHUNK, if (final) 1 else 0, 12, sequence, bytes, offset)

  @Test fun returnsOnlyCompleteExactRangeAndLeavesCommitAcknowledgementToOwner() {
    val read = operation(); read.open(reply())
    assertNull(read.accept(frame(1, 492, byteArrayOf(1, 2, 3, 4))))
    assertFalse(read.completion.isDone)
    assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8), read.accept(frame(2, 496, byteArrayOf(5, 6, 7, 8), true)))
    assertFalse(read.completion.isDone)
    assertNull(read.accept(frame(2, 496, byteArrayOf(5, 6, 7, 8), true)))
  }
  @Test fun emptyFinalMarkerIsAllowedAfterAllBytes() {
    val read = operation(); read.open(reply())
    assertNull(read.accept(frame(1, 492, ByteArray(8))))
    assertArrayEquals(ByteArray(8), read.accept(frame(2, 500, byteArrayOf(), true)))
  }
  @Test fun foreignOrChangedReplyCannotOpenReceiver() {
    for ((key, value) in listOf("transport" to "wifi", "session_id" to "other", "source_stream_id" to 99,
      "stream_id" to 11, "offset_scope" to "file", "offset" to 494, "length" to 6, "chunk_size_bytes" to 493)) {
      val read = operation()
      try { read.open(reply().put(key, value)); fail("accepted mismatched $key") } catch (_: HardwareProtocolException) { }
      assertEquals(0, read.streamId)
    }
  }
  @Test fun wrongSequenceOffsetLengthAndFinalAreRejected() {
    for (frame in listOf(frame(2, 492, ByteArray(8), true), frame(1, 494, ByteArray(8), true),
      frame(1, 492, ByteArray(10), true), frame(1, 492, ByteArray(6), true), frame(1, 492, ByteArray(3)))) {
      val read = operation(); read.open(reply())
      try { read.accept(frame); fail("accepted invalid repair") } catch (_: HardwareProtocolException) { }
    }
  }
  @Test fun cancellationIgnoresLatePackets() {
    val read = operation(); read.open(reply()); read.completion.completeExceptionally(IllegalStateException("capture ended"))
    assertNull(read.accept(frame(1, 492, ByteArray(8), true)))
  }
  @Test fun cannotAllocateAnUnboundedOrUnalignedRange() {
    for (range in listOf(HardwareMissingPcm(0, 32770), HardwareMissingPcm(0, 0), HardwareMissingPcm(1, 2), HardwareMissingPcm(Long.MAX_VALUE - 1, 4))) {
      try { HardwareLiveRepairRead(range, "capture", 1); fail("accepted invalid range") } catch (_: IllegalArgumentException) { }
    }
  }
  @Test fun fractionalOrStringIntegersAreNotCoercedIntoValidContracts() {
    for ((key, value) in listOf("stream_id" to 12.5, "length" to "8", "offset" to 492.2,
      "source_stream_id" to "11", "chunk_size_bytes" to 492.25)) {
      try { operation().open(reply().put(key, value)); fail("coerced invalid $key") } catch (_: HardwareProtocolException) { }
    }
  }
}
