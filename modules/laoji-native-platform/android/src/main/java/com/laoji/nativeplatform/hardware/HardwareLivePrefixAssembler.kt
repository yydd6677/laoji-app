package com.laoji.nativeplatform.hardware

import java.util.TreeMap

internal data class HardwarePcmRange(val offset: Long, val bytes: ByteArray)
internal data class HardwareMissingPcm(val offset: Long, val length: Int)

/** Live-repair byte owner selected by the peripheral capability contract.
 * Serial caller owns capture identity, repair-ticket fencing and deadlines.
 * Only original-offset contiguous bytes leave this bounded buffer. Delivered
 * late duplicates are ignored, never rewritten; final source SHA remains the
 * whole-file integrity authority. No invented silence or timeline shifts. */
internal class HardwareLivePrefixAssembler(
  private val maximumBufferedBytes: Int = 128 * 1024,
  private val maximumAheadBytes: Int = 128 * 1024,
  private val maximumFrames: Int = 512,
) {
  init { require(maximumBufferedBytes > 0 && maximumAheadBytes > 0 && maximumFrames > 0) }
  private val pending = TreeMap<Long, ByteArray>()
  var nextOffset = 0L
    private set
  var bufferedBytes = 0
    private set
  var sealed = false
    private set

  fun seal() { sealed = true; pending.clear(); bufferedBytes = 0 }

  fun missing(maximumBytes: Int = 32768): HardwareMissingPcm? {
    val limit = maximumBytes and -2
    if (sealed || pending.isEmpty() || limit <= 0) return null
    val length = minOf(pending.firstKey() - nextOffset, limit.toLong()).toInt()
    return if (length > 0) HardwareMissingPcm(nextOffset, length) else null
  }

  /** Accept live bytes or a separately validated complete repair range.
   * Every returned range must be durably consumed in order by the caller. */
  fun accept(offset: Long, bytes: ByteArray): List<HardwarePcmRange> {
    if (sealed) return emptyList()
    if (offset < 0 || offset % 2 != 0L || bytes.size % 2 != 0 || offset > Long.MAX_VALUE - bytes.size) {
      seal(); return emptyList()
    }
    val end = offset + bytes.size
    // Already delivered ranges cannot become a second write. A partial
    // overlap is ambiguous and is not silently trimmed to a new offset.
    if (offset < nextOffset) {
      if (end > nextOffset) seal()
      return emptyList()
    }
    val duplicate = pending[offset]
    if (duplicate != null) {
      if (!duplicate.contentEquals(bytes)) seal()
      return emptyList()
    }
    val before = pending.floorEntry(offset)
    val after = pending.ceilingEntry(offset)
    if ((before != null && before.key + before.value.size > offset)
      || (after != null && end > after.key)) {
      seal(); return emptyList()
    }
    if (end - nextOffset > maximumAheadBytes || bytes.size > maximumBufferedBytes) {
      seal(); return emptyList()
    }
    if (offset != nextOffset) {
      if (pending.size >= maximumFrames || bytes.size > maximumBufferedBytes - bufferedBytes) {
        seal(); return emptyList()
      }
      pending[offset] = bytes.copyOf(); bufferedBytes += bytes.size
      return emptyList()
    }
    val result = mutableListOf<HardwarePcmRange>()
    if (bytes.isNotEmpty()) result += HardwarePcmRange(offset, bytes.copyOf())
    nextOffset = end
    while (pending.isNotEmpty() && pending.firstKey() == nextOffset) {
      val item = pending.pollFirstEntry()
      bufferedBytes -= item.value.size
      if (item.value.isNotEmpty()) result += HardwarePcmRange(item.key, item.value)
      nextOffset += item.value.size
    }
    return result
  }
}
