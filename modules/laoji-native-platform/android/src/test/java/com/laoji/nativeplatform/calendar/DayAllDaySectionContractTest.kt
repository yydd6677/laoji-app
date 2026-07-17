package com.laoji.nativeplatform.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DayAllDaySectionContractTest {
  @Test
  fun `CAL-ALLDAY-EXPAND-001 computes collapsed expanded and overflow rows`() {
    val cases = listOf(
      RowCase(0, 0, 0, false, 0, 0, false),
      RowCase(1, 1, 1, false, 1, 0, false),
      RowCase(3, 3, 3, false, 3, 0, false),
      RowCase(4, 3, 4, true, 2, 2, true),
      RowCase(10, 3, 10, true, 2, 8, true),
    )

    cases.forEach { case ->
      val collapsedContent = DayAllDaySectionContract.collapsedContent(case.eventCount)
      assertEquals(
        "collapsed rows for ${case.eventCount} events",
        case.collapsedRows,
        DayAllDaySectionContract.collapsedRows(case.eventCount),
      )
      assertEquals(
        "expanded content rows for ${case.eventCount} events",
        case.expandedRows,
        DayAllDaySectionContract.expandedContentRows(case.eventCount),
      )
      assertEquals(
        "overflow for ${case.eventCount} events",
        case.overflow,
        DayAllDaySectionContract.hasOverflow(case.eventCount),
      )
      assertEquals(
        "visible collapsed events for ${case.eventCount} events",
        case.visibleEventCount,
        collapsedContent.visibleEventCount,
      )
      assertEquals(
        "remaining collapsed events for ${case.eventCount} events",
        case.remainingCount,
        collapsedContent.remainingCount,
      )
      assertEquals(
        "more row for ${case.eventCount} events",
        case.hasMoreRow,
        collapsedContent.hasMoreRow,
      )
    }
  }

  @Test
  fun `CAL-ALLDAY-EXPAND-001 caps expanded height at the pixel equivalent of 187 point 5 dp`() {
    val mdpiRowHeight = DayAllDaySectionContract.rowHeightPx(1f)
    val xhdpiRowHeight = DayAllDaySectionContract.rowHeightPx(2f)

    assertEquals(25, mdpiRowHeight)
    assertEquals(50, xhdpiRowHeight)
    assertEquals(3, DayAllDaySectionContract.horizontalSpacePx(1f))
    assertEquals(0f, DayAllDaySectionContract.INSTANCE_VERTICAL_SPACE_DP, 0f)
    assertEquals(187, DayAllDaySectionContract.expandedHeightCapPx(mdpiRowHeight))
    assertEquals(375, DayAllDaySectionContract.expandedHeightCapPx(xhdpiRowHeight))
    assertEquals(
      75,
      DayAllDaySectionContract.visibleHeightPx(10, expanded = false, rowHeightPx = mdpiRowHeight),
    )
    assertEquals(
      187,
      DayAllDaySectionContract.visibleHeightPx(10, expanded = true, rowHeightPx = mdpiRowHeight),
    )
    assertEquals(250, DayAllDaySectionContract.contentHeightPx(10, mdpiRowHeight))
    assertTrue(DayAllDaySectionContract.isExpandedScrollable(10, mdpiRowHeight))
    assertFalse(DayAllDaySectionContract.isExpandedScrollable(4, mdpiRowHeight))
  }

  @Test
  fun `CAL-ALLDAY-EXPAND-001 reduces expansion state across overflow changes`() {
    var state = DayAllDaySectionState().withEventCount(4)
    assertFalse(state.expanded)
    assertTrue(state.overflow)

    state = state.withExpanded(true)
    assertTrue(state.expanded)
    assertTrue(state.overflow)

    state = state.withEventCount(10)
    assertTrue(state.expanded)
    assertTrue(state.overflow)

    state = state.withExpanded(false)
    assertFalse(state.expanded)
    assertTrue(state.overflow)

    state = state.withExpanded(true).withEventCount(3)
    assertTrue(state.expanded)
    assertFalse(state.overflow)

    state = state.withEventCount(4)
    assertTrue(state.expanded)
    assertTrue(state.overflow)

    state = state.withExpanded(false)
    assertFalse(state.expanded)
    state = state.withEventCount(3).withExpanded(true)
    assertFalse(state.expanded)
    assertFalse(state.overflow)
  }

  @Test
  fun `CAL-ALLDAY-EXPAND-001 stabilizes height with the larger adjacent page while moving`() {
    val counts = listOf(1, 2, 7)

    assertEquals(2, DayAllDaySectionContract.stableEventCount(counts, 0f))
    assertEquals(7, DayAllDaySectionContract.stableEventCount(counts, 0.5f))
    assertEquals(7, DayAllDaySectionContract.stableEventCount(counts, 0.95f))
    assertEquals(7, DayAllDaySectionContract.stableEventCount(counts, 1f))
    assertEquals(2, DayAllDaySectionContract.stableEventCount(listOf(6, 2, 1), -0.05f))
    assertEquals(6, DayAllDaySectionContract.stableEventCount(listOf(6, 2, 1), -0.5f))
  }

  @Test
  fun `CAL-ALLDAY-EXPAND-001 delegates current-day ordering to CalendarGeometry`() {
    val day = CalendarDateMath.toEpochDay(2026, 7, 17)
    val events = listOf(
      allDayEvent("short", "B", day, day + 1),
      allDayEvent("outside", "Outside", day + 1, day + 2),
      allDayEvent("long", "Z", day, day + 2),
      allDayEvent("earlier", "Earlier", day - 1, day + 1),
      allDayEvent("timed", "Timed", day, day + 1).copy(
        allDay = false,
        startMinutes = 600,
        endMinutes = 660,
      ),
    )

    assertEquals(
      listOf("earlier", "long", "short"),
      DayAllDaySectionContract.orderedEvents(events, day).map { it.sourceEventId },
    )
  }

  private fun allDayEvent(
    id: String,
    title: String,
    startEpochDay: Int,
    endEpochDayExclusive: Int,
  ): CalendarEvent = CalendarEvent(
    sourceEventId = id,
    occurrenceDate = "2026-07-17",
    title = title,
    startEpochDay = startEpochDay,
    endEpochDay = endEpochDayExclusive - 1,
    endEpochDayExclusive = endEpochDayExclusive,
    startMinutes = null,
    endMinutes = null,
    timeZoneId = "Asia/Shanghai",
    allDay = true,
    editable = true,
    revision = 1,
  )

  private data class RowCase(
    val eventCount: Int,
    val collapsedRows: Int,
    val expandedRows: Int,
    val overflow: Boolean,
    val visibleEventCount: Int,
    val remainingCount: Int,
    val hasMoreRow: Boolean,
  )
}
