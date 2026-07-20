package com.laoji.nativeplatform.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// CAL-DAY-COMPOSE-001: the local fallback must preserve the independent
// rectangles exposed by Feishu's InstanceLayout contract.
class CalendarGeometryTest {
  private val day = CalendarDateMath.toEpochDay(2026, 7, 18)

  @Test
  fun `CAL-DAY-COMPOSE-001 lets a tail event occupy freed adjacent columns`() {
    val events = listOf(
      event("a", 540, 720),
      event("b", 540, 600),
      event("c", 540, 600),
      event("d", 600, 660),
    )

    val segments = CalendarGeometry.daySegments(events, day)
    val tail = segments.single { it.event.sourceEventId == "d" }

    assertEquals(1, tail.column)
    assertEquals(3, tail.columnCount)
    assertEquals(2, tail.columnSpan)
    assertTrue(segments.all { it.columnSpan in 1..it.columnCount })
  }

  @Test
  fun `CAL-DAY-COMPOSE-001 keeps non-overlapping events in separate stable clusters`() {
    val segments = CalendarGeometry.daySegments(
      listOf(event("early", 480, 540), event("late", 600, 660)),
      day,
    )

    assertEquals(2, segments.size)
    assertTrue(segments.all { it.column == 0 && it.columnCount == 1 && it.columnSpan == 1 })
  }

  @Test
  fun `CAL-DAY-COMPOSE-001 records source visual constants`() {
    assertEquals(4f, DayEventVisualContract.EVENT_RADIUS_DP, 0f)
    assertEquals(9f, DayEventVisualContract.TEXT_MARGIN_LEFT_DP, 0f)
    assertEquals(3f, DayEventVisualContract.TEXT_MARGIN_TOP_DP, 0f)
    assertEquals(14f, DayEventVisualContract.TITLE_TEXT_SIZE_SP, 0f)
    assertEquals(12f, DayEventVisualContract.DESCRIPTION_TEXT_SIZE_SP, 0f)
    assertEquals(3.5f, DayEventVisualContract.CURRENT_TIME_DOT_RADIUS_DP, 0f)
    assertEquals(1f, DayEventVisualContract.CURRENT_TIME_LINE_GAP_DP, 0f)
  }

  @Test
  fun `CAL-DAY-COMPOSE-001 maps source InstanceLayout percentages before fallback`() {
    val rect = DayEventVisualContract.instanceLayoutRect(
      layout = CalendarInstanceLayout(
        xOffsetPercent = 25f,
        yOffsetPercent = 10f,
        widthPercent = 50f,
        heightPercent = 20f,
      ),
      eventAreaLeft = 56f,
      eventAreaWidth = 401f,
      timelineTop = 16f,
      timelineHeight = 1201f,
    )

    assertEquals(156f, rect.left, 0.001f)
    assertEquals(136f, rect.top, 0.001f)
    assertEquals(357f, rect.right, 0.001f)
    assertEquals(376f, rect.bottom, 0.001f)
  }

  private fun event(id: String, start: Int, end: Int): CalendarEvent = CalendarEvent(
    sourceEventId = id,
    occurrenceDate = "2026-07-18",
    title = id,
    startEpochDay = day,
    endEpochDay = day,
    startMinutes = start,
    endMinutes = end,
    timeZoneId = "Asia/Shanghai",
    allDay = false,
    editable = true,
    revision = 1,
  )
}
