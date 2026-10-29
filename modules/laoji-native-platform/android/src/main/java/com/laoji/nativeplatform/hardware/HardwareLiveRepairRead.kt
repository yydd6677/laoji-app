package com.laoji.nativeplatform.hardware

import org.json.JSONObject
import java.util.concurrent.CompletableFuture

/** One bounded repair response, owned by one capture/connection epoch.
 * Caller serializes access and commits the returned range before completion. */
internal class HardwareLiveRepairRead(
  val range: HardwareMissingPcm,
  val sessionId: String,
  val sourceStreamId: Long,
) {
  init {
    require(range.offset >= 0 && range.offset % 2L == 0L && range.length in 2..32768 && range.length % 2 == 0)
    require(range.offset <= Long.MAX_VALUE - range.length && sourceStreamId in 1..0xffffffffL && sessionId.isNotBlank())
  }
  val completion = CompletableFuture<Unit>()
  var streamId = 0
    private set
  private var chunkBytes = 0
  private var sequence = 0
  private var received = 0
  private var finished = false
  private val data = ByteArray(range.length)
  private fun integer(value: JSONObject, key: String): Long {
    val raw = value.opt(key) as? Number ?: throw HardwareProtocolException("invalid live repair integer")
    val number = raw.toDouble(); val result = raw.toLong()
    if (!number.isFinite() || result.toDouble() != number) throw HardwareProtocolException("invalid live repair integer")
    return result
  }

  fun open(value: JSONObject) {
    val stream = integer(value, "stream_id")
    val chunk = integer(value, "chunk_size_bytes")
    if (streamId != 0 || stream !in 1..0xffffffffL || stream == sourceStreamId ||
      value.getString("transport") != "ble" || value.getString("session_id") != sessionId ||
      integer(value, "source_stream_id") != sourceStreamId || value.getString("offset_scope") != "audio_payload" ||
      integer(value, "offset") != range.offset || integer(value, "length") != range.length.toLong() ||
      chunk !in 2..492 || chunk % 2 != 0L) throw HardwareProtocolException("invalid live repair contract")
    streamId = stream.toInt(); chunkBytes = chunk.toInt()
  }

  fun accept(frame: HardwareFrame): ByteArray? {
    if (completion.isDone || finished) return null
    if (streamId == 0 || frame.kind != HardwareProtocol.KIND_FILE_CHUNK || frame.streamId != streamId ||
      frame.sequence != HardwareProtocol.nextSequence(sequence) || frame.pcmOffset != range.offset + received ||
      frame.payload.size > chunkBytes || frame.payload.size % 2 != 0 || frame.payload.size > data.size - received ||
      (frame.payload.isEmpty() && frame.flags and HardwareProtocol.FLAG_FINAL == 0)) {
      throw HardwareProtocolException("invalid live repair source range")
    }
    frame.payload.copyInto(data, received)
    received += frame.payload.size; sequence = frame.sequence
    if (frame.flags and HardwareProtocol.FLAG_FINAL != 0) {
      if (received != range.length) throw HardwareProtocolException("truncated live repair range")
      finished = true
      return data
    }
    return null
  }
}
