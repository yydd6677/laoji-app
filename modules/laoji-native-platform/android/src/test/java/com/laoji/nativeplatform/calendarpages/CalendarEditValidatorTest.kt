package com.laoji.nativeplatform.calendarpages

// CAL-REPEAT-RRULE-001: product-safe date validation around the source wheel range.

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarEditValidatorTest {
  private fun draft(
    startDate: String,
    endDate: String = startDate,
    recurrenceUntilDate: String? = null,
  ) = CalendarEditDraft(
    title = "日期边界",
    startDate = startDate,
    endDate = endDate,
    repeat = if (recurrenceUntilDate == null) "once" else "yearly",
    recurrenceUntilDate = recurrenceUntilDate,
  )

  @Test
  fun `accepts both supported boundary years`() {
    assertTrue(CalendarEditValidator.validate(draft("1900-01-01")).valid)
    assertTrue(CalendarEditValidator.validate(draft("2100-12-31")).valid)
  }

  @Test
  fun `rejects start end and repeat dates outside the wheel range`() {
    assertFalse(CalendarEditValidator.validate(draft("1800-01-01")).valid)
    assertFalse(CalendarEditValidator.validate(draft("2026-01-01", endDate = "2200-01-01")).valid)
    assertFalse(CalendarEditValidator.validate(draft(
      "2026-01-01",
      recurrenceUntilDate = "2200-01-01",
    )).valid)
  }
}
