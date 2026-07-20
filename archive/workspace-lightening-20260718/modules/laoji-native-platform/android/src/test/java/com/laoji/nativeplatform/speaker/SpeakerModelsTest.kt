package com.laoji.nativeplatform.speaker

import org.junit.Assert.assertEquals
import org.junit.Test

class SpeakerModelsTest {
  @Test
  fun `MIN-SPEAKER-001 normalizes manager profiles and quality`() {
    val state = SpeakerSnapshotParser.manager(mapOf(
      "phase" to "ready",
      "speakers" to listOf(
        mapOf("id" to "speaker-1", "name" to "张三", "sampleCount" to -2, "quality" to 2f),
        mapOf("id" to "", "name" to "invalid"),
      ),
    ))
    assertEquals(1, state.speakers.size)
    assertEquals(0, state.speakers.single().sampleCount)
    assertEquals(1f, state.speakers.single().quality)
  }

  @Test
  fun `MIN-SPEAKER-001 bounds enrollment timing and level`() {
    val state = SpeakerSnapshotParser.enrollment(mapOf(
      "elapsedMs" to -1,
      "maxDurationMs" to 0,
      "level" to -4f,
      "voiceprintConsentAccepted" to true,
    ))
    assertEquals(0L, state.elapsedMs)
    assertEquals(1L, state.maxDurationMs)
    assertEquals(0f, state.level)
    assertEquals(true, state.voiceprintConsentAccepted)
  }
}
