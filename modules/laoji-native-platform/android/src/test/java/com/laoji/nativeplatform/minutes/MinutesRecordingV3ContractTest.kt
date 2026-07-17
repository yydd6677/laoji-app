package com.laoji.nativeplatform.minutes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MinutesRecordingV3ContractTest {
  @Test
  fun `MIN-REC-LAYOUT-001 uses the active 180dp Record V3 bottom panel`() {
    assertEquals(180, MinutesRecordingV3Contract.BOTTOM_PANEL_HEIGHT_DP)
    assertEquals(44, MinutesRecordingV3Contract.TOP_BAR_HEIGHT_DP)
    assertEquals(100, MinutesRecordingV3Contract.TITLE_MIN_HEIGHT_DP)
    assertEquals(40, MinutesRecordingV3Contract.TAB_HEIGHT_DP)
    assertEquals(32, MinutesRecordingV3Contract.WAVE_HEIGHT_DP)
  }

  @Test
  fun `MIN-REC-LAYOUT-001 follows Record V3 phone action width branches`() {
    val widePhone = MinutesRecordingV3Contract.actionWidths(411)
    assertNull(widePhone.statusWidthDp)
    assertEquals(78, widePhone.actionWidthDp)

    val compactPhone = MinutesRecordingV3Contract.actionWidths(360)
    assertEquals(142, compactPhone.statusWidthDp)
    assertEquals(73, compactPhone.actionWidthDp)

    val narrowPhone = MinutesRecordingV3Contract.actionWidths(320)
    assertEquals(142, narrowPhone.statusWidthDp)
    assertEquals(60, narrowPhone.actionWidthDp)
  }

  @Test
  fun `MIN-REC-LAYOUT-001 uses expanded action widths at 600dp`() {
    val expanded = MinutesRecordingV3Contract.actionWidths(600)
    assertNull(expanded.statusWidthDp)
    assertEquals(108, expanded.actionWidthDp)
  }
}
