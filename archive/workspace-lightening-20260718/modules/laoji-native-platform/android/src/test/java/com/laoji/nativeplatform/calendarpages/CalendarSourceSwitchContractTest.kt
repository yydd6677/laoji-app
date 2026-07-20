package com.laoji.nativeplatform.calendarpages

// CAL-REPEAT-RRULE-001: UDSwitch geometry and animation constants.

import org.junit.Assert.assertEquals
import org.junit.Test

class CalendarSourceSwitchContractTest {
  @Test
  fun `uses the source UDSwitch dimensions and motion duration`() {
    assertEquals(36f, CalendarSourceSwitch.TRACK_WIDTH_DP)
    assertEquals(20f, CalendarSourceSwitch.THUMB_SIZE_DP)
    assertEquals(14f, CalendarSourceSwitch.TRACK_HEIGHT_DP)
    assertEquals(20f, CalendarSourceSwitch.SWITCH_HEIGHT_DP)
    assertEquals(24f, CalendarSourceSwitch.HOST_HEIGHT_DP)
    assertEquals(3f, CalendarSourceSwitch.TRACK_VERTICAL_PADDING_DP)
    assertEquals(250L, CalendarSourceSwitch.ANIMATION_DURATION_MS)
  }
}
