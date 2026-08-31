package com.laoji.nativeplatform.hardware

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class HardwareProtocolTest {
  @Test
  fun fragmentedFrameSurvivesBootNoise() {
    val expected = HardwareFrame(
      kind = HardwareProtocol.KIND_CONTROL_REQUEST,
      flags = 0,
      streamId = 0,
      sequence = 7,
      correlationId = 9,
      payload = HardwareProtocol.controlPayload(
        "diagnostics.ping",
        mapOf("command_id" to "probe-1"),
      ),
    )
    val wire = "ESP-ROM boot noise\r\n".toByteArray() + HardwareProtocol.encode(expected)
    val decoder = HardwareFrameDecoder()
    val result = mutableListOf<HardwareFrame>()
    wire.asList().chunked(3).forEach { chunk ->
      result += decoder.feed(chunk.toByteArray())
    }
    assertEquals(listOf(expected), result)
    assertEquals("diagnostics.ping", result.single().json().getString("op"))
  }

  @Test
  fun audioFrameRoundTrips() {
    val payload = byteArrayOf(1, 0, -1, -1)
    val expected = HardwareFrame(
      kind = HardwareProtocol.KIND_LIVE_AUDIO,
      flags = HardwareProtocol.FLAG_FINAL,
      streamId = 42,
      sequence = 11,
      correlationId = 0,
      payload = payload,
    )
    val result = HardwareFrameDecoder().feed(HardwareProtocol.encode(expected)).single()
    assertEquals(expected, result)
    assertArrayEquals(payload, result.payload)
  }

  @Test(expected = HardwareProtocolException::class)
  fun crcMismatchFailsClosed() {
    val expected = HardwareFrame(
      kind = HardwareProtocol.KIND_LIVE_AUDIO,
      flags = 0,
      streamId = 2,
      sequence = 1,
      correlationId = 0,
      payload = "audio".toByteArray(),
    )
    val wire = HardwareProtocol.encode(expected)
    wire[wire.lastIndex] = (wire.last().toInt() xor 0x40).toByte()
    HardwareFrameDecoder().feed(wire)
  }
}
