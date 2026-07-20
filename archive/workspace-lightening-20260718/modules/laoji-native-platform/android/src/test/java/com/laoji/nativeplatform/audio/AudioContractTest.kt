package com.laoji.nativeplatform.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioContractTest {
  @Test
  fun `MIN-REC-STATE-001 accepts only legal recorder transitions`() {
    assertTrue(RecorderStateMachine.canTransition(RecorderState.IDLE, RecorderState.PREPARING))
    assertTrue(RecorderStateMachine.canTransition(RecorderState.RECORDING, RecorderState.PAUSED))
    assertTrue(RecorderStateMachine.canTransition(RecorderState.STOPPING, RecorderState.LOCAL_SAVED))
    assertFalse(RecorderStateMachine.canTransition(RecorderState.LOCAL_SAVED, RecorderState.RECORDING))
  }

  @Test
  fun `MIN-AUDIO-001 writes a repairable PCM16 WAV header`() {
    val pcmBytes = 32_000L
    val header = WavHeader.create(pcmBytes)
    assertEquals("RIFF", String(header, 0, 4, Charsets.US_ASCII))
    assertEquals("WAVE", String(header, 8, 4, Charsets.US_ASCII))
    assertEquals(
      pcmBytes,
      ByteBuffer.wrap(header, 40, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong(),
    )
    assertTrue(WavHeader.isPlausible(header, AudioRuntimeContract.WAV_HEADER_BYTES + pcmBytes))
  }

  @Test
  fun `MIN-AUDIO-001 measures signed little-endian PCM without crossing frames`() {
    val bytes = byteArrayOf(0, 0, -1, 127, 0, -128)
    val level = Pcm16Math.measure(bytes)
    assertEquals(32_768, level.peak)
    assertTrue(level.rms > 0)
  }
}
