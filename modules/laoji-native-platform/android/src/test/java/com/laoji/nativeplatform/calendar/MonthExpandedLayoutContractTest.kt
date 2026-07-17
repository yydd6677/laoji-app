package com.laoji.nativeplatform.calendar

// CAL-MONTH-EXPAND-001: JVM tests pin the decompiled month-row layout and tap transition contract.

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MonthExpandedLayoutContractTest {
  @Test
  fun `CAL-MONTH-EXPAND-001 keeps four week row targets for first middle and last selection`() {
    assertTops(4, 0, 0f, 450f, 600f, 750f)
    assertTops(4, 2, -300f, -150f, 0f, 450f)
    assertTops(4, 3, -450f, -300f, -150f, 0f)
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 keeps five week row targets for first middle and last selection`() {
    assertTops(5, 0, 0f, 480f, 600f, 720f, 840f)
    assertTops(5, 2, -240f, -120f, 0f, 480f, 600f)
    assertTops(5, 4, -480f, -360f, -240f, -120f, 0f)
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 keeps six week row targets for first middle and last selection`() {
    assertTops(6, 0, 0f, 500f, 600f, 700f, 800f, 900f)
    assertTops(6, 3, -300f, -200f, -100f, 0f, 500f, 600f)
    assertTops(6, 5, -500f, -400f, -300f, -200f, -100f, 0f)
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 lays closed rows equally and reserves the middle event owner`() {
    assertArrayEquals(
      floatArrayOf(0f, 120f, 240f, 360f, 480f),
      MonthExpandedLayoutContract.rowTargetTops(600f, 5, null).toFloatArray(),
      0.001f,
    )
    assertEquals(
      MonthExpandedEventsBounds(120f, 480f),
      MonthExpandedLayoutContract.selectedEventsBounds(600f, 5, 2),
    )
    assertEquals(
      MonthExpandedEventsBounds(120f, 600f),
      MonthExpandedLayoutContract.selectedEventsBounds(600f, 5, 4),
    )
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 closes when the same date is tapped`() {
    val transition = MonthExpandedLayoutContract.resolveTap(selection(), 100, 2, 3)

    assertEquals(MonthExpandedTapAction.CLOSE, transition.action)
    assertNull(transition.targetSelection)
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 switches date without closing inside the same row`() {
    val transition = MonthExpandedLayoutContract.resolveTap(selection(), 101, 2, 4)

    assertEquals(MonthExpandedTapAction.SWITCH_WITHIN_ROW, transition.action)
    assertEquals(MonthExpandedSelection(101, 2, 4), transition.targetSelection)
    assertEquals(
      MonthExpandedLayoutContract.rowTargetTops(600f, 5, 2),
      MonthExpandedLayoutContract.rowTargetTops(600f, 5, transition.targetSelection?.row),
    )
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 closes then opens when another row is tapped`() {
    val transition = MonthExpandedLayoutContract.resolveTap(selection(), 107, 3, 3)

    assertEquals(MonthExpandedTapAction.CLOSE_THEN_OPEN, transition.action)
    assertEquals(MonthExpandedSelection(107, 3, 3), transition.targetSelection)
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 opens the first selected date`() {
    val transition = MonthExpandedLayoutContract.resolveTap(null, 100, 2, 3)

    assertEquals(MonthExpandedTapAction.OPEN, transition.action)
    assertEquals(selection(), transition.targetSelection)
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 fixes row movement at 350 milliseconds`() {
    assertEquals(350L, MonthExpandedLayoutContract.ROW_ANIMATION_DURATION_MS)
    assertEquals(
      700L,
      MonthExpandedLayoutContract.totalAnimationDurationMs(MonthExpandedTapAction.CLOSE_THEN_OPEN),
    )
    assertEquals(0L, MonthExpandedLayoutContract.totalAnimationDurationMs(MonthExpandedTapAction.SWITCH_WITHIN_ROW))
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 uses a strict twenty dp threshold on both axes`() {
    assertTrue(MonthExpandedLayoutContract.isTapWithinThreshold(19.999f, -19.999f))
    assertFalse(MonthExpandedLayoutContract.isTapWithinThreshold(20f, 0f))
    assertFalse(MonthExpandedLayoutContract.isTapWithinThreshold(0f, -20f))
    assertTrue(MonthExpandedLayoutContract.isTapWithinThreshold(39.999f, 0f, pixelsPerDp = 2f))
    assertFalse(MonthExpandedLayoutContract.isTapWithinThreshold(40f, 0f, pixelsPerDp = 2f))
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 owns seven independent day page identities`() {
    val pages = MonthExpandedLayoutContract.dayPageEpochDays(1_000)

    assertEquals(listOf(1_000, 1_001, 1_002, 1_003, 1_004, 1_005, 1_006), pages)
    assertEquals(MonthExpandedLayoutContract.DAY_PAGE_COUNT, pages.size)
    assertEquals(MonthExpandedLayoutContract.DAY_PAGE_COUNT, pages.toSet().size)
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 pins source dimensions and complete outer page cache`() {
    assertEquals(11f, MonthExpandedLayoutContract.DATE_RADIUS_DP, 0f)
    assertEquals(16f, MonthExpandedLayoutContract.GRID_START_MARGIN_DP, 0f)
    assertEquals(11.5f, MonthExpandedLayoutContract.GRID_END_MARGIN_DP, 0f)
    assertEquals(48f, MonthExpandedLayoutContract.EVENT_ROW_HEIGHT_DP, 0f)
    assertEquals(3, MonthPagerContract.PAGE_COUNT)
  }

  private fun assertTops(weekCount: Int, selectedRow: Int, vararg expected: Float) {
    assertArrayEquals(
      expected,
      MonthExpandedLayoutContract.rowTargetTops(600f, weekCount, selectedRow).toFloatArray(),
      0.001f,
    )
  }

  private fun selection(): MonthExpandedSelection = MonthExpandedSelection(100, 2, 3)
}
