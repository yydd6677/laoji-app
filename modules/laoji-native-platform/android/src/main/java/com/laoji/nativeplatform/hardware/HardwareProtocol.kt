package com.laoji.nativeplatform.hardware

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32

internal object HardwareProtocol {
  const val MAJOR = 1
  const val MINOR = 1
  const val HEADER_LENGTH = 32
  const val MAX_PAYLOAD = 65_536
  const val MAX_CONTROL_PAYLOAD = 8_192

  const val KIND_CONTROL_REQUEST = 0x01
  const val KIND_CONTROL_RESPONSE = 0x02
  const val KIND_EVENT = 0x03
  const val KIND_LIVE_AUDIO = 0x10
  const val KIND_FILE_CHUNK = 0x11
  const val KIND_ACK = 0x12

  const val FLAG_FINAL = 0x01
  const val FLAG_RETRYABLE = 0x02
  const val ALLOWED_FLAGS = FLAG_FINAL or FLAG_RETRYABLE

  val MAGIC = byteArrayOf('L'.code.toByte(), 'J'.code.toByte(), 'H'.code.toByte(), 'W'.code.toByte())

  fun crc32(payload: ByteArray): Long {
    if (payload.isEmpty()) return 0L
    return CRC32().apply { update(payload) }.value
  }

  fun encode(frame: HardwareFrame): ByteArray {
    require(frame.major == MAJOR) { "unsupported protocol major" }
    require(frame.payload.size <= MAX_PAYLOAD) { "hardware payload too large" }
    if (frame.isControl) {
      require(frame.payload.size <= MAX_CONTROL_PAYLOAD) { "hardware control payload too large" }
    }
    require(frame.flags and ALLOWED_FLAGS.inv() == 0) { "reserved hardware flags are set" }
    val wire = ByteBuffer.allocate(HEADER_LENGTH + frame.payload.size).order(ByteOrder.LITTLE_ENDIAN)
    wire.put(MAGIC)
    wire.put(frame.major.toByte())
    wire.put(frame.minor.toByte())
    wire.put(frame.kind.toByte())
    wire.put(frame.flags.toByte())
    wire.putShort(HEADER_LENGTH.toShort())
    wire.putShort(0)
    wire.putInt(frame.payload.size)
    wire.putInt(frame.streamId)
    wire.putInt(frame.sequence)
    wire.putInt(frame.correlationId)
    wire.putInt(crc32(frame.payload).toInt())
    wire.put(frame.payload)
    return wire.array()
  }

  fun controlPayload(operation: String, values: Map<String, Any?> = emptyMap()): ByteArray {
    val json = JSONObject()
      .put("schema_version", 1)
      .put("op", operation)
    values.forEach { (key, value) -> json.put(key, JSONObject.wrap(value)) }
    return json.toString().toByteArray(Charsets.UTF_8).also {
      require(it.size <= MAX_CONTROL_PAYLOAD) { "hardware control JSON too large" }
    }
  }
}

internal data class HardwareFrame(
  val kind: Int,
  val flags: Int,
  val streamId: Int,
  val sequence: Int,
  val correlationId: Int,
  val payload: ByteArray,
  val major: Int = HardwareProtocol.MAJOR,
  val minor: Int = HardwareProtocol.MINOR,
) {
  val isControl: Boolean
    get() = kind in setOf(
      HardwareProtocol.KIND_CONTROL_REQUEST,
      HardwareProtocol.KIND_CONTROL_RESPONSE,
      HardwareProtocol.KIND_EVENT,
      HardwareProtocol.KIND_ACK,
    )

  fun json(): JSONObject {
    require(isControl) { "frame is not control JSON" }
    return try {
      JSONObject(payload.toString(Charsets.UTF_8))
    } catch (error: Exception) {
      throw HardwareProtocolException("invalid control JSON", error)
    }
  }

  override fun equals(other: Any?): Boolean =
    other is HardwareFrame &&
      kind == other.kind && flags == other.flags && streamId == other.streamId &&
      sequence == other.sequence && correlationId == other.correlationId &&
      major == other.major && minor == other.minor && payload.contentEquals(other.payload)

  override fun hashCode(): Int = payload.contentHashCode()
}

internal class HardwareProtocolException(message: String, cause: Throwable? = null) :
  IllegalStateException(message, cause)

/** Incremental decoder that discards ESP boot text until the next LJHW magic. */
internal class HardwareFrameDecoder {
  private val pending = ByteArrayOutputStream()

  @Synchronized
  fun feed(bytes: ByteArray, length: Int = bytes.size): List<HardwareFrame> {
    require(length in 0..bytes.size)
    pending.write(bytes, 0, length)
    var buffer = pending.toByteArray()
    val frames = mutableListOf<HardwareFrame>()
    var cursor = 0
    while (true) {
      val magic = findMagic(buffer, cursor)
      if (magic < 0) {
        val keep = minOf(HardwareProtocol.MAGIC.size - 1, buffer.size - cursor)
        replacePending(if (keep > 0) buffer.copyOfRange(buffer.size - keep, buffer.size) else byteArrayOf())
        return frames
      }
      cursor = magic
      if (buffer.size - cursor < HardwareProtocol.HEADER_LENGTH) {
        replacePending(buffer.copyOfRange(cursor, buffer.size))
        return frames
      }
      val header = ByteBuffer.wrap(buffer, cursor, HardwareProtocol.HEADER_LENGTH)
        .order(ByteOrder.LITTLE_ENDIAN)
      header.position(4)
      val major = header.get().toInt() and 0xff
      val minor = header.get().toInt() and 0xff
      val kind = header.get().toInt() and 0xff
      val flags = header.get().toInt() and 0xff
      val headerLength = header.short.toInt() and 0xffff
      val reserved = header.short.toInt() and 0xffff
      val payloadLength = header.int
      val streamId = header.int
      val sequence = header.int
      val correlationId = header.int
      val checksum = header.int.toLong() and 0xffffffffL
      if (
        headerLength != HardwareProtocol.HEADER_LENGTH || reserved != 0 || payloadLength !in 0..HardwareProtocol.MAX_PAYLOAD
      ) {
        cursor += 1
        continue
      }
      val total = HardwareProtocol.HEADER_LENGTH + payloadLength
      if (buffer.size - cursor < total) {
        replacePending(buffer.copyOfRange(cursor, buffer.size))
        return frames
      }
      if (major != HardwareProtocol.MAJOR) {
        throw HardwareProtocolException("unsupported hardware protocol major $major")
      }
      if (flags and HardwareProtocol.ALLOWED_FLAGS.inv() != 0) {
        throw HardwareProtocolException("reserved hardware frame flags are set")
      }
      val payload = buffer.copyOfRange(
        cursor + HardwareProtocol.HEADER_LENGTH,
        cursor + total,
      )
      if (HardwareProtocol.crc32(payload) != checksum) {
        throw HardwareProtocolException("hardware frame CRC mismatch")
      }
      val frame = HardwareFrame(
        kind = kind,
        flags = flags,
        streamId = streamId,
        sequence = sequence,
        correlationId = correlationId,
        payload = payload,
        major = major,
        minor = minor,
      )
      if (frame.isControl && payloadLength > HardwareProtocol.MAX_CONTROL_PAYLOAD) {
        throw HardwareProtocolException("hardware control frame exceeds maximum")
      }
      frames += frame
      cursor += total
      if (cursor == buffer.size) {
        replacePending(byteArrayOf())
        return frames
      }
    }
  }

  @Synchronized
  fun reset() = replacePending(byteArrayOf())

  private fun replacePending(value: ByteArray) {
    pending.reset()
    pending.write(value)
  }

  private fun findMagic(buffer: ByteArray, start: Int): Int {
    val limit = buffer.size - HardwareProtocol.MAGIC.size
    for (index in start..limit) {
      if (
        buffer[index] == HardwareProtocol.MAGIC[0] &&
        buffer[index + 1] == HardwareProtocol.MAGIC[1] &&
        buffer[index + 2] == HardwareProtocol.MAGIC[2] &&
        buffer[index + 3] == HardwareProtocol.MAGIC[3]
      ) return index
    }
    return -1
  }
}
