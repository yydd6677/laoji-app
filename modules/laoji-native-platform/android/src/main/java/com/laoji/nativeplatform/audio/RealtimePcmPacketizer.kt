package com.laoji.nativeplatform.audio

/** Lossless transport packing, independent of capture frames or VAD windows. */
internal class RealtimePcmPacketizer(private val packetBytes: Int = 16_000) {
  private val pending: ByteArray
  private var pendingBytes = 0

  init {
    require(packetBytes >= 32 && packetBytes <= Int.MAX_VALUE - 32 && packetBytes % 32 == 0)
    pending = ByteArray(packetBytes + 32)
  }

  fun append(buffer: ByteArray, count: Int): List<ByteArray> {
    require(count in 0..buffer.size)
    val result = mutableListOf<ByteArray>()
    var offset = 0
    // Keep >=1ms for finalization. Otherwise a sub-ms tail after the last full
    // packet cannot be represented as a standalone non-zero wire time range.
    while (offset < count) {
      val copied = minOf(count - offset, pending.size - pendingBytes)
      buffer.copyInto(pending, pendingBytes, offset, offset + copied)
      offset += copied
      pendingBytes += copied
      if (pendingBytes == pending.size) {
        result += pending.copyOf(packetBytes)
        pending.copyInto(pending, 0, packetBytes, pendingBytes)
        pendingBytes = 32
      }
    }
    return result
  }

  fun finish(): ByteArray? {
    if (pendingBytes == 0) return null
    require(pendingBytes >= 32 && pendingBytes % 2 == 0) { "Incomplete PCM sample/time range" }
    return pending.copyOf(pendingBytes).also { clear() }
  }

  fun clear() { pending.fill(0); pendingBytes = 0 }
}
