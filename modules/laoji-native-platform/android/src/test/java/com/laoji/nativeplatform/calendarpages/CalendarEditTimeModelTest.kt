package com.laoji.nativeplatform.calendarpages

import java.time.LocalDate
import java.time.LocalTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// CAL-EDIT-TIME-001: pure regression coverage for boundaries and system-format labels.
class CalendarEditTimeModelTest {
  @Test
  fun `CAL-EDIT-TIME-001 keeps a rounded cross-day interval`() {
    val state = CalendarEditTimeState.fromDraft(
      timedDraft(
        startDate = "2026-07-31",
        endDate = "2026-08-01",
        startTime = "23:58",
        endTime = "00:02",
      ),
      CalendarEditEndpoint.START,
    )

    val completed = state.completedDraft()
    assertEquals("2026-07-31", completed.startDate)
    assertEquals("23:55", completed.startTime)
    assertEquals("2026-08-01", completed.endDate)
    assertEquals("00:05", completed.endTime)
  }

  @Test
  fun `CAL-EDIT-TIME-001 clips January 31 at February month end`() {
    val state = CalendarEditTimeState.fromDraft(
      timedDraft("2026-01-31", "2026-01-31", "10:00", "11:00"),
      CalendarEditEndpoint.START,
    ).setMonth(2)

    assertEquals(LocalDate.of(2026, 2, 28), state.startDate)
    assertEquals(LocalDate.of(2026, 2, 28), state.endDate)
    assertEquals("2026-02-28", state.completedDraft().endDate)
  }

  @Test
  fun `CAL-EDIT-TIME-001 renders exact 24-hour labels`() {
    assertEquals("00:05", CalendarEditTimeFormatter.timeLabel(LocalTime.of(0, 5), true))
    assertEquals("13:07", CalendarEditTimeFormatter.timeLabel(LocalTime.of(13, 7), true))
    assertEquals("23时", CalendarEditTimeFormatter.hourWheelLabel(23, true))
  }

  @Test
  fun `CAL-EDIT-TIME-001 renders midnight noon and afternoon in 12-hour labels`() {
    assertEquals("上午 12:05", CalendarEditTimeFormatter.timeLabel(LocalTime.of(0, 5), false))
    assertEquals("下午 12:00", CalendarEditTimeFormatter.timeLabel(LocalTime.NOON, false))
    assertEquals("下午 1:07", CalendarEditTimeFormatter.timeLabel(LocalTime.of(13, 7), false))
    assertEquals("12时", CalendarEditTimeFormatter.hourWheelLabel(12, false))
  }

  @Test
  fun `CAL-EDIT-TIME-001 clamps an edited end after the start boundary`() {
    val state = CalendarEditTimeState.fromDraft(
      timedDraft("2026-07-17", "2026-07-17", "10:00", "11:00"),
      CalendarEditEndpoint.END,
    ).setHour24(9)

    assertEquals(LocalDate.of(2026, 7, 17), state.endDate)
    assertEquals(LocalTime.of(10, 5), state.endTime)
    assertTrue(state.endTime.isAfter(state.startTime))
  }

  @Test
  fun `CAL-EDIT-TIME-001 moves an invalid end across midnight when start advances`() {
    val state = CalendarEditTimeState.fromDraft(
      timedDraft("2026-07-17", "2026-07-17", "23:00", "23:30"),
      CalendarEditEndpoint.START,
    ).setMinuteIndex(7)

    assertEquals(LocalTime.of(23, 35), state.startTime)
    assertEquals(LocalDate.of(2026, 7, 18), state.endDate)
    assertEquals(LocalTime.of(0, 35), state.endTime)
  }

  @Test
  fun `CAL-EDIT-TIME-001 preserves dates while all-day and optional-time normalize`() {
    val initial = CalendarEditTimeState.fromDraft(
      timedDraft("2026-07-17", "2026-07-19", "10:00", "11:00"),
      CalendarEditEndpoint.START,
    )
    val allDayDraft = initial.setAllDay(true).completedDraft()
    assertEquals("2026-07-17", allDayDraft.startDate)
    assertEquals("2026-07-19", allDayDraft.endDate)
    assertNull(allDayDraft.startTime)
    assertNull(allDayDraft.endTime)

    val restoredTimedDraft = initial.setAllDay(true).setAllDay(false).completedDraft()
    assertEquals("10:00", restoredTimedDraft.startTime)
    assertEquals("11:00", restoredTimedDraft.endTime)

    val dateOnly = initial.setTimedEnabled(false).completedDraft()
    assertNull(dateOnly.startTime)
    assertNull(dateOnly.endTime)
  }

  private fun timedDraft(
    startDate: String,
    endDate: String,
    startTime: String,
    endTime: String,
  ): CalendarEditDraft = CalendarEditDraft(
    title = "测试日程",
    startDate = startDate,
    endDate = endDate,
    startTime = startTime,
    endTime = endTime,
    allDay = false,
  )
}
