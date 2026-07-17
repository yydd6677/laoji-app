package com.laoji.nativeplatform.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// CAL-PICKER-001 / CAL-PICKER-HOST-001: pure regression coverage for the source-derived contract.
class CalendarQuickChooseContractTest {
  @Test
  fun `CAL-PICKER-001 fixes wheel range looping geometry and timing`() {
    assertEquals(1900, CalendarQuickChooseContract.MIN_YEAR)
    assertEquals(2100, CalendarQuickChooseContract.MAX_YEAR)
    assertEquals(5, CalendarQuickChooseContract.VISIBLE_WHEEL_ITEMS)
    assertEquals(48f, CalendarQuickChooseContract.WHEEL_ITEM_HEIGHT_DP)
    assertEquals(240f, CalendarQuickChooseContract.WHEEL_HEIGHT_DP)
    assertEquals(256f, CalendarQuickChooseContract.YEAR_MONTH_HEIGHT_DP)
    assertEquals(150L, CalendarQuickChooseContract.CONTENT_SWITCH_DURATION_MS)
    assertEquals(100L, CalendarQuickChooseContract.DATE_HEIGHT_DURATION_MS)
    assertEquals(214_748_364, CalendarQuickChooseContract.DATE_PAGER_ITEM_COUNT)
    assertEquals(5L, CalendarQuickChooseContract.WHEEL_INERTIA_TICK_MS)
    assertEquals(10L, CalendarQuickChooseContract.WHEEL_FLING_DISTANCE_SAMPLE_MS)
    assertEquals(2_000f, CalendarQuickChooseContract.WHEEL_MAX_FLING_VELOCITY)
    assertEquals(20f, CalendarQuickChooseContract.WHEEL_STOP_FLING_VELOCITY)
  }

  @Test
  fun `CAL-PICKER-HOST-001 derives remaining duration from current progress`() {
    assertEquals(200L, CalendarQuickChooseContract.animationDurationMs(0f, 1f))
    assertEquals(100L, CalendarQuickChooseContract.animationDurationMs(0.25f, 0.75f))
    assertEquals(50L, CalendarQuickChooseContract.animationDurationMs(0.25f, 0f))
    assertEquals(0L, CalendarQuickChooseContract.animationDurationMs(1f, 1f))
  }

  @Test
  fun `CAL-PICKER-HOST-001 maps expansion progress to the full measured height`() {
    assertEquals(-320f, CalendarQuickChooseContract.translationForProgress(0f, 320), 0.001f)
    assertEquals(-160f, CalendarQuickChooseContract.translationForProgress(0.5f, 320), 0.001f)
    assertEquals(0f, CalendarQuickChooseContract.translationForProgress(1f, 320), 0.001f)
    assertEquals(0.5f, CalendarQuickChooseContract.progressForTranslation(-160f, 320), 0.001f)
  }

  @Test
  fun `CAL-PICKER-HOST-001 preserves four states and releases by drag direction`() {
    assertEquals(
      CalendarPickerExpandState.OPENING,
      CalendarQuickChooseContract.stateForProgress(0.25f, 0.5f, CalendarPickerExpandState.CLOSED),
    )
    assertEquals(
      CalendarPickerExpandState.CLOSING,
      CalendarQuickChooseContract.stateForProgress(0.75f, 0.5f, CalendarPickerExpandState.OPENED),
    )
    assertEquals(
      CalendarPickerExpandState.OPENED,
      CalendarQuickChooseContract.releaseTarget(CalendarPickerExpandState.OPENING, true),
    )
    assertEquals(
      CalendarPickerExpandState.CLOSED,
      CalendarQuickChooseContract.releaseTarget(CalendarPickerExpandState.CLOSING, true),
    )
    assertEquals(
      CalendarPickerExpandState.CLOSED,
      CalendarQuickChooseContract.releaseTarget(CalendarPickerExpandState.OPENED, false),
    )
    assertEquals(
      CalendarPickerExpandState.OPENED,
      CalendarQuickChooseContract.releaseTarget(CalendarPickerExpandState.OPENED, true),
    )
  }

  @Test
  fun `CAL-PICKER-001 commits immediately and clips the preserved day at month end`() {
    val january31 = CalendarDateMath.toEpochDay(2026, 1, 31)
    val february = CalendarQuickChooseContract.commitYearMonth(january31, 2026, 2)
    assertEquals(CalendarDateParts(2026, 2, 28), CalendarDateMath.fromEpochDay(february))

    val leapFebruary = CalendarQuickChooseContract.commitYearMonth(january31, 2028, 2)
    assertEquals(CalendarDateParts(2028, 2, 29), CalendarDateMath.fromEpochDay(leapFebruary))

    val clampedYear = CalendarQuickChooseContract.commitYearMonth(january31, 2200, 12)
    assertEquals(CalendarDateParts(2100, 12, 31), CalendarDateMath.fromEpochDay(clampedYear))
  }

  @Test
  fun `CAL-PICKER-001 date state height follows four five and six week months`() {
    val fourRows = CalendarDateMath.toEpochDay(2026, 2, 1)
    val fiveRows = CalendarDateMath.toEpochDay(2026, 7, 1)
    val sixRows = CalendarDateMath.toEpochDay(2026, 8, 1)
    assertEquals(184f, CalendarQuickChooseContract.dateContentHeightDp(fourRows))
    assertEquals(222f, CalendarQuickChooseContract.dateContentHeightDp(fiveRows))
    assertEquals(260f, CalendarQuickChooseContract.dateContentHeightDp(sixRows))
  }

  @Test
  fun `CAL-PICKER-001 month opens wheels while day opens date state`() {
    assertEquals(
      CalendarPickerContentState.YEAR_MONTH_PANEL,
      CalendarQuickChooseContract.initialContentState(CalendarMode.MONTH),
    )
    assertEquals(
      CalendarPickerContentState.DATE_PANEL,
      CalendarQuickChooseContract.initialContentState(CalendarMode.DAY),
    )
    assertTrue(CalendarPickerState.closed(10).expandState == CalendarPickerExpandState.CLOSED)
    assertFalse(CalendarPickerState.closed(10).isOpen)
  }

  @Test
  fun `CAL-PICKER-001 maps source-sized pager positions back to calendar months`() {
    val january2000 = CalendarDateMath.toEpochDay(2000, 1, 1)
    val july2026 = CalendarDateMath.toEpochDay(2026, 7, 1)
    assertEquals(
      CalendarQuickChooseContract.DATE_PAGER_ANCHOR_POSITION,
      CalendarQuickChooseContract.datePagerPositionForMonth(january2000),
    )
    assertEquals(
      CalendarDateMath.monthStart(july2026),
      CalendarQuickChooseContract.datePagerMonthForPosition(
        CalendarQuickChooseContract.datePagerPositionForMonth(july2026),
      ),
    )
  }

  @Test
  fun `CAL-PICKER-001 derives empty and populated event dots from snapshots`() {
    assertEquals(CalendarQuickChooseDateData.EMPTY, CalendarQuickChooseContract.dateData(null))

    val july1 = CalendarDateMath.toEpochDay(2026, 7, 1)
    val july20 = CalendarDateMath.toEpochDay(2026, 7, 20)
    val july21 = CalendarDateMath.toEpochDay(2026, 7, 21)
    val snapshot = CalendarSnapshot(
      rangeStartEpochDay = july1,
      rangeEndEpochDayExclusive = CalendarDateMath.toEpochDay(2026, 8, 1),
      selectedEpochDay = july20,
      todayEpochDay = july21,
      events = listOf(
        CalendarEvent(
          sourceEventId = "all-day",
          occurrenceDate = "2026-07-20",
          title = "跨日事项",
          startEpochDay = july20,
          endEpochDay = july21,
          endEpochDayExclusive = july21 + 1,
          startMinutes = null,
          endMinutes = null,
          timeZoneId = "Asia/Shanghai",
          allDay = true,
          editable = true,
          revision = 1,
        ),
        CalendarEvent(
          sourceEventId = "timed",
          occurrenceDate = "2026-07-21",
          title = "定时事项",
          startEpochDay = july21,
          endEpochDay = july21,
          startMinutes = 600,
          endMinutes = 660,
          timeZoneId = "Asia/Shanghai",
          allDay = false,
          editable = true,
          revision = 1,
        ),
      ),
    )

    val data = CalendarQuickChooseContract.dateData(snapshot)
    assertEquals(july21, data.todayEpochDay)
    assertEquals(mapOf(july20 to 1, july21 to 2), data.eventCountByEpochDay)
  }
}
