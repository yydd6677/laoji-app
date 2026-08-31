package com.laoji.nativeplatform.hardware

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal object BleHardwareProfile {
  const val SERVICE_UUID = "9f7a0001-6d6f-4a6f-8a4b-6c616f6a6901"
  const val CONTROL_RX_UUID = "9f7a0002-6d6f-4a6f-8a4b-6c616f6a6901"
  const val CONTROL_TX_UUID = "9f7a0003-6d6f-4a6f-8a4b-6c616f6a6901"
  const val AUDIO_TX_UUID = "9f7a0004-6d6f-4a6f-8a4b-6c616f6a6901"
  const val CLIENT_CONFIGURATION_UUID = "00002902-0000-1000-8000-00805f9b34fb"
  const val FRAGMENT_HEADER_BYTES = 6
  const val MAX_FRAME_BYTES = 48 * 1024
  const val PREFERRED_MTU = 517
  const val MAX_ATTRIBUTE_VALUE_BYTES = 512
}

/** LJHW/1 BLE fragmentation. A fragment never crosses one GATT notification/write. */
internal class BleHardwareFragmenter(startingFrameId: Int = 1) {
  private var nextFrameId = startingFrameId.coerceIn(1, 0xffff)

  @Synchronized
  fun fragment(frame: ByteArray, maximumPacketBytes: Int): List<ByteArray> {
    require(frame.isNotEmpty()) { "BLE hardware frame is empty" }
    require(frame.size <= BleHardwareProfile.MAX_FRAME_BYTES) { "BLE hardware frame is too large" }
    val capacity = maximumPacketBytes - BleHardwareProfile.FRAGMENT_HEADER_BYTES
    require(capacity > 0) { "BLE hardware MTU is too small" }
    val count = (frame.size + capacity - 1) / capacity
    require(count in 1..255) { "BLE hardware frame needs too many fragments" }
    val frameId = nextFrameId
    nextFrameId = if (nextFrameId == 0xffff) 1 else nextFrameId + 1
    return List(count) { index ->
      val offset = index * capacity
      val length = minOf(capacity, frame.size - offset)
      ByteBuffer.allocate(BleHardwareProfile.FRAGMENT_HEADER_BYTES + length)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putShort(frameId.toShort())
        .put(index.toByte())
        .put(count.toByte())
        .putShort(length.toShort())
        .put(frame, offset, length)
        .array()
    }
  }
}

/** Reassembles one logical LJHW frame while rejecting mixed/conflicting fragments. */
internal class BleHardwareReassembler {
  private var frameId = -1
  private var fragmentCount = 0
  private var fragments: Array<ByteArray?> = emptyArray()
  private var receivedBytes = 0

  @Synchronized
  fun offer(packet: ByteArray): ByteArray? {
    if (packet.size < BleHardwareProfile.FRAGMENT_HEADER_BYTES) {
      throw HardwareProtocolException("BLE hardware fragment is truncated")
    }
    val header = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN)
    val incomingFrameId = header.short.toInt() and 0xffff
    val index = header.get().toInt() and 0xff
    val count = header.get().toInt() and 0xff
    val length = header.short.toInt() and 0xffff
    if (incomingFrameId == 0 || count == 0 || index >= count || length != packet.size - 6) {
      throw HardwareProtocolException("BLE hardware fragment header is invalid")
    }
    if (incomingFrameId != frameId) {
      reset(incomingFrameId, count)
    } else if (count != fragmentCount) {
      clear()
      throw HardwareProtocolException("BLE hardware fragment count changed")
    }
    val body = packet.copyOfRange(BleHardwareProfile.FRAGMENT_HEADER_BYTES, packet.size)
    val previous = fragments[index]
    if (previous != null) {
      if (!previous.contentEquals(body)) {
        clear()
        throw HardwareProtocolException("BLE hardware duplicate fragment changed")
      }
      return null
    }
    if (receivedBytes + body.size > BleHardwareProfile.MAX_FRAME_BYTES) {
      clear()
      throw HardwareProtocolException("BLE hardware frame exceeds maximum")
    }
    fragments[index] = body
    receivedBytes += body.size
    if (fragments.any { it == null }) return null
    val output = ByteArrayOutputStream(receivedBytes)
    fragments.forEach { output.write(requireNotNull(it)) }
    return output.toByteArray().also { clear() }
  }

  @Synchronized
  fun clear() {
    frameId = -1
    fragmentCount = 0
    fragments = emptyArray()
    receivedBytes = 0
  }

  private fun reset(incomingFrameId: Int, count: Int) {
    frameId = incomingFrameId
    fragmentCount = count
    fragments = arrayOfNulls(count)
    receivedBytes = 0
  }
}
