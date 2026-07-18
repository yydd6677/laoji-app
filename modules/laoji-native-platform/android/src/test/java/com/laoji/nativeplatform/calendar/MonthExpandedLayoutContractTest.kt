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

  @Test
  fun `CAL-MONTH-EXPAND-001 gives today precedence over a selected-date marker`() {
    assertEquals(
      MonthDateMarker.TODAY,
      MonthExpandedLayoutContract.dateMarker(10, selectedEpochDay = 10, todayEpochDay = 10),
    )
    assertEquals(
      MonthDateMarker.SELECTED,
      MonthExpandedLayoutContract.dateMarker(11, selectedEpochDay = 11, todayEpochDay = 10),
    )
    assertEquals(
      MonthDateMarker.NONE,
      MonthExpandedLayoutContract.dateMarker(12, selectedEpochDay = 11, todayEpochDay = 10),
    )
  }

  @Test
  fun `CAL-MONTH-EXPAND-001 pins source date typography and overflow badge geometry`() {
    assertEquals(12f, MonthExpandedLayoutContract.DATE_TEXT_SIZE_SP, 0f)
    assertEquals(10f, MonthExpandedLayoutContract.DATE_TOP_DP, 0f)
    assertEquals(22f, MonthExpandedLayoutContract.DATE_BASELINE_DP, 0f)
    assertEquals(19f, MonthExpandedLayoutContract.OVERFLOW_BADGE_WIDTH_DP, 0f)
    assertEquals(12f, MonthExpandedLayoutContract.OVERFLOW_BADGE_HEIGHT_DP, 0f)
    assertEquals(2.5f, MonthExpandedLayoutContract.OVERFLOW_BADGE_RADIUS_DP, 0f)
  }

  @Test
  fun `CAL-MONTH-SPAN-001 keeps a multi-day event continuous across occupied columns`() {
    val bounds = MonthExpandedLayoutContract.eventSpanBounds(
      gridStart = 16f,
      cellWidth = 50f,
      startColumn = 1,
      endColumn = 4,
      rightGap = 3f,
    )

    assertEquals(66f, bounds.left, 0f)
    assertEquals(263f, bounds.right, 0f)
    assertEquals(197f, bounds.right - bounds.left, 0f)
    assertEquals(16f, MonthExpandedLayoutContract.EVENT_HEIGHT_DP, 0f)
    assertEquals(3f, MonthExpandedLayoutContract.EVENT_VERTICAL_GAP_DP, 0f)
    assertEquals(3f, MonthExpandedLayoutContract.EVENT_RIGHT_GAP_DP, 0f)
    assertEquals(2.5f, MonthExpandedLayoutContract.EVENT_RADIUS_DP, 0f)
  }

  @Test
  fun `CAL-TIMEFORMAT-001 month expansion derives cross-midnight display bounds once`() {
    val startDay = CalendarDateMath.toEpochDay(2026, 7, 18)
    val event = CalendarEvent(
      sourceEventId = "overnight",
      occurrenceDate = "2026-07-18",
      title = "夜间维护",
      startEpochDay = startDay,
      endEpochDay = startDay + 1,
      startMinutes = 1_380,
      endMinutes = 60,
      timeZoneId = "Asia/Shanghai",
      allDay = false,
      editable = true,
      revision = 1,
    )

    assertEquals(
      MonthEventTimeBounds(1_380, CalendarDateMath.MINUTES_PER_DAY),
      MonthExpandedLayoutContract.eventTimeBounds(startDay, event),
    )
    assertEquals(
      MonthEventTimeBounds(0, 60),
      MonthExpandedLayoutContract.eventTimeBounds(startDay + 1, event),
    )
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
