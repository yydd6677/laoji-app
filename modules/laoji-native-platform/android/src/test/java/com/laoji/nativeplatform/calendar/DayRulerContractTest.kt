package com.laoji.nativeplatform.calendar

import org.junit.Assert.assertEquals
import org.junit.Test

// CAL-RULER-001: source-derived geometry and baseline contract.
class DayRulerContractTest {
  @Test
  fun `CAL-RULER-001 uses centered 12sp placeholder labels in the 56dp ruler`() {
    assertEquals(56f / 2f, DayRulerContract.labelCenterX(56f), 0f)
    assertEquals(12f, DayRulerContract.TEXT_SIZE_SP, 0f)
    assertEquals(0xFF8F959E.toInt(), DayRulerContract.TEXT_COLOR_LIGHT)
    assertEquals(0xFF757575.toInt(), DayRulerContract.TEXT_COLOR_DARK)
  }

  @Test
  fun `CAL-RULER-001 centers the text using font metrics rather than a fixed offset`() {
    assertEquals(100f - (-8f + 2f) / 2f, DayRulerContract.centeredBaseline(100f, -8f, 2f), 0f)
    assertEquals(44f, DayRulerContract.centeredBaseline(40f, -12f, 4f), 0f)
  }
}
