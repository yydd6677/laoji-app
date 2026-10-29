package com.laoji.nativeplatform.calendarpages

import java.time.LocalDate
import org.junit.Assert.*
import org.junit.Test

class CalendarEditTimeContractTest {
  @Test fun bridgeEchoFenceRejectsOldAndForeignViewAcksButKeepsTheLatestOwnerWritable() {
    val first = CalendarEditEchoFence("first")
    assertTrue(first.accepts(null))
    val a = first.edited(); val b = first.edited()
    assertFalse(first.accepts(null)); assertFalse(first.accepts(a)); assertTrue(first.accepts(b))
    assertFalse(first.accepts(a))
    val second = CalendarEditEchoFence("second")
    val other = second.edited()
    assertFalse(first.accepts(other)); assertFalse(second.accepts(b)); assertTrue(second.accepts(other))
  }

  private fun draft() = CalendarEditDraft(startDate = "2026-10-28", endDate = "2026-10-28",
    startTime = "09:23", timePrecision = "exact")

  @Test fun openingAndCompletingDoesNotRoundOrAddAnEnd() {
    val current = draft()
    val state = CalendarEditTimeState.fromDraft(current, CalendarEditEndpoint.START)
    assertEquals(23, state.startTime.minute)
    assertEquals(current, state.completedDraft())
    assertNull(state.completedDraft().endTime)
    for (minute in 0..59) {
      val changed = state.setMinuteIndex(minute).completedDraft()
      assertEquals("09:%02d".format(minute), changed.startTime)
      assertNull(changed.endTime)
    }
  }
  @Test fun selectingEveryPeriodKeepsNoExactClockOrReminder() {
    val state = CalendarEditTimeState.fromDraft(draft().copy(reminderMinutes = 15), CalendarEditEndpoint.START)
    for (period in CalendarTimePeriod.entries) {
      val result = state.setPeriod(period).completedDraft()
      assertEquals("period", result.timePrecision); assertEquals(period.wireName, result.timePeriod)
      assertNull(result.startTime); assertNull(result.endTime); assertNull(result.reminderMinutes)
      assertFalse(result.allDay); assertTrue(CalendarEditValidator.validate(result).valid)
    }
  }
  @Test fun invalidEndIsReportedRatherThanMovedToAnotherHourOrDay() {
    val initial = CalendarEditTimeState.fromDraft(draft(), CalendarEditEndpoint.START)
    val invalid = initial.setEndEnabled(true).setHour24(8).setMinuteIndex(12)
    val result = invalid.completedDraft()
    assertEquals("08:12", result.endTime); assertEquals("2026-10-28", result.endDate)
    assertFalse(CalendarEditValidator.validate(result).valid)
    val overnight = invalid.setDate(CalendarEditEndpoint.END, LocalDate.of(2026, 10, 29)).completedDraft()
    assertTrue(CalendarEditValidator.validate(overnight).valid)
  }
  @Test fun removingEndDoesNotDestroyAnExplicitDateRange() {
    val input = draft().copy(endDate = "2026-10-30", endTime = "10:07")
    val result = CalendarEditTimeState.fromDraft(input, CalendarEditEndpoint.END).setEndEnabled(false).completedDraft()
    assertNull(result.endTime); assertEquals("2026-10-30", result.endDate)
    assertEquals("09:23", result.startTime)
  }
  @Test fun legacyAllDayIsUntouchedUntilAnExplicitPrecisionChange() {
    val input = CalendarEditDraft(startDate = "2026-10-28", endDate = "2026-10-28", allDay = true)
    val state = CalendarEditTimeState.fromDraft(input, CalendarEditEndpoint.START)
    assertTrue(state.completedDraft().allDay)
    val period = state.setPeriod(CalendarTimePeriod.NIGHT).completedDraft()
    assertFalse(period.allDay); assertEquals("night", period.timePeriod)
    assertEquals("unspecified", state.precision.wireName)
  }
  @Test fun missingDateRemainsMissingWhenOnlyPrecisionIsEdited() {
    val state = CalendarEditTimeState.fromDraft(CalendarEditDraft(), CalendarEditEndpoint.START)
    val result = state.setPeriod(CalendarTimePeriod.NIGHT).completedDraft()
    assertEquals("", result.startDate)
    assertTrue(CalendarEditValidator.validate(result, requireDate = false).valid)
    assertFalse(CalendarEditValidator.validate(result).valid)
    val dated = state.copy(dateOnly = true).setDate(CalendarEditEndpoint.START, LocalDate.of(2026, 10, 28)).completedDraft()
    assertEquals("2026-10-28", dated.startDate)
  }
}
