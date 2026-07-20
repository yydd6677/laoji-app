package com.laoji.nativeplatform.minutes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MinutesWaveformSignalProcessorTest {
  @Test
  fun `MIN-REC-WAVE-001 bounds the pending queue and consumes its peak`() {
    val processor = WaveformSignalProcessor(maxPending = 10)
    repeat(13) { index -> processor.offer(index / 12f) }

    assertEquals(10, processor.pendingCount)
    assertEquals(0f, processor.advance(0L), 0.0001f)
    assertEquals(0.1f, processor.advance(50L), 0.0001f)
    assertEquals(0, processor.pendingCount)
  }

  @Test
  fun `MIN-REC-WAVE-001 applies attack and decay without leaving bounds`() {
    assertEquals(0.2f, WaveformSignalProcessor.smooth(0f, 1f), 0.0001f)
    assertEquals(0.92f, WaveformSignalProcessor.smooth(1f, 0f), 0.0001f)
    assertTrue(WaveformSignalProcessor.smooth(0.99f, 1f) <= 1f)
    assertTrue(WaveformSignalProcessor.smooth(0.01f, 0f) >= 0f)
  }

  @Test
  fun `MIN-REC-WAVE-001 uses cosine interpolation`() {
    assertEquals(0.2f, WaveformSignalProcessor.cosineInterpolate(0.2f, 0.8f, 0f), 0.0001f)
    assertEquals(0.5f, WaveformSignalProcessor.cosineInterpolate(0.2f, 0.8f, 0.5f), 0.0001f)
    assertEquals(0.8f, WaveformSignalProcessor.cosineInterpolate(0.2f, 0.8f, 1f), 0.0001f)
  }

  @Test
  fun `MIN-REC-WAVE-001 reset drops queued and interpolated state`() {
    val processor = WaveformSignalProcessor()
    processor.offer(1f)
    processor.advance(0L)
    processor.advance(50L)
    processor.reset()

    assertEquals(0, processor.pendingCount)
    assertEquals(0f, processor.displayedValue, 0.0001f)
    assertEquals(0f, processor.advance(100L), 0.0001f)
  }
}
