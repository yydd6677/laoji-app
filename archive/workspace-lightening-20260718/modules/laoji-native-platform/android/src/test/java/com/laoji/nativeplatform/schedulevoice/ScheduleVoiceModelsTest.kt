package com.laoji.nativeplatform.schedulevoice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ScheduleVoiceModelsTest {
  @Test
  fun `UI-OVERLAY-001 parses fixed-slot confirmation snapshot`() {
    val parsed = ScheduleVoiceSnapshot.parse(
      mapOf(
        "schemaVersion" to 1,
        "phase" to "confirm",
        "text" to "明天下午开会",
        "title" to "开会",
        "fields" to listOf(mapOf("key" to "date", "label" to "日期", "value" to "7月17日")),
        "canSave" to true,
      ),
    )
    assertEquals(ScheduleVoicePhase.CONFIRM, parsed?.phase)
    assertEquals("开会", parsed?.title)
    assertEquals("日期", parsed?.fields?.single()?.label)
    assertEquals(true, parsed?.canSave)
  }

  @Test
  fun `UI-OVERLAY-001 rejects unsupported snapshot schema`() {
    assertNull(ScheduleVoiceSnapshot.parse(mapOf("schemaVersion" to 2, "phase" to "input")))
  }

  @Test
  fun `MIN-AUDIO-001 short tap latches while held release stops`() {
    assertEquals(false, ScheduleVoiceGesture.shouldStopOnRelease(startedFromInput = true, heldForMs = 120))
    assertEquals(true, ScheduleVoiceGesture.shouldStopOnRelease(startedFromInput = true, heldForMs = 321))
    assertEquals(true, ScheduleVoiceGesture.shouldStopOnRelease(startedFromInput = false, heldForMs = 40))
  }
}
