package com.laoji.nativeplatform.calendarpages

// UI-TITLE-COMMON-001 / CAL-REPEAT-RRULE-001: defaults and validation follow
// ChooseRepeatEndFragment's repeat-type offsets and start-date boundary.

import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class CalendarRepeatEndStateTest {
  private fun draft(
    repeat: String,
    startDate: String = "2026-07-17",
    untilDate: String? = null,
  ) = CalendarEditDraft(
    title = "重复日程",
    startDate = startDate,
    endDate = startDate,
    repeat = repeat,
    recurrenceUntilDate = untilDate,
  )

  @Test
  fun sourceDefaultsDependOnRepeatFamily() {
    assertEquals(LocalDate.of(2026, 8, 17), CalendarRepeatEndState.fromDraft(draft("daily")).selectedDate)
    assertEquals(LocalDate.of(2026, 10, 17), CalendarRepeatEndState.fromDraft(draft("weekly")).selectedDate)
    assertEquals(LocalDate.of(2027, 7, 17), CalendarRepeatEndState.fromDraft(draft("monthly")).selectedDate)
    assertEquals(LocalDate.of(2031, 7, 17), CalendarRepeatEndState.fromDraft(draft("yearly")).selectedDate)
  }

  @Test
  fun productSafetyClampsOnlyGeneratedDefaultsAndRejectsExternalDates() {
    assertEquals(
      LocalDate.of(2100, 12, 31),
      CalendarRepeatEndState.fromDraft(draft("yearly", startDate = "2099-07-17")).selectedDate,
    )
    assertThrows(IllegalArgumentException::class.java) {
      CalendarRepeatEndState.fromDraft(draft("yearly", untilDate = "2200-06-01"))
    }
    assertThrows(IllegalArgumentException::class.java) {
      CalendarRepeatEndState.fromDraft(draft("daily", untilDate = "1800-06-01"))
    }
  }

  @Test
  fun repeatEndDayLabelsIncludeTheSourceWeekdayContext() {
    assertEquals(
      "17日(周五)",
      CalendarEditTimeFormatter.dayWithWeekdayWheelLabel(LocalDate.of(2026, 7, 17)),
    )
  }

  @Test
  fun explicitUntilDateRestoresAndCompletesWithoutMutation() {
    val state = CalendarRepeatEndState.fromDraft(draft("weekly", untilDate = "2026-09-01"))
    assertFalse(state.neverEnds)
    assertTrue(state.valid)
    assertEquals("2026-09-01", state.completedDraft().recurrenceUntilDate)
  }

  @Test
  fun neverEndClearsUntilDateAndDateBeforeStartDisablesCompletion() {
    val state = CalendarRepeatEndState.fromDraft(draft("daily", untilDate = "2026-07-16"))
    assertFalse(state.valid)
    assertNull(state.setNeverEnds(true).completedDraft().recurrenceUntilDate)
  }

  @Test
  fun yearAndMonthChangesClampLeapAndMonthEndDates() {
    val leap = CalendarRepeatEndState.fromDraft(draft("yearly", "2024-02-29", "2024-02-29"))
    assertEquals(LocalDate.of(2025, 2, 28), leap.setYear(2025).selectedDate)
    val monthEnd = CalendarRepeatEndState.fromDraft(draft("monthly", "2026-01-31", "2026-01-31"))
    assertEquals(LocalDate.of(2026, 2, 28), monthEnd.setMonth(2).selectedDate)
  }
}
