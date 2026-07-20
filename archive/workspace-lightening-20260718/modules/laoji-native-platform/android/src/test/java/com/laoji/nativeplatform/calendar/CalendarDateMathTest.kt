package com.laoji.nativeplatform.calendar

import org.junit.Assert.assertEquals
import org.junit.Test

class CalendarDateMathTest {
  @Test
  fun `CAL-PICKER-001 clamps a preserved month-end day`() {
    val january31 = CalendarDateMath.toEpochDay(2026, 1, 31)
    assertEquals(
      CalendarDateParts(2026, 2, 28),
      CalendarDateMath.fromEpochDay(CalendarDateMath.addMonths(january31, 1)),
    )
  }

  @Test
  fun `CAL-DAY-001 keeps exclusive midnight as 24 o'clock on the prior day`() {
    val july16 = CalendarDateMath.toEpochDay(2026, 7, 16)
    assertEquals(
      CalendarMinutePoint(july16, 1_440),
      CalendarDateMath.canonicalEnd(
        CalendarDateMath.absoluteMinute(july16 + 1, 0),
      ),
    )
  }

  @Test
  fun `CAL-MONTH-001 uses Sunday as the first column`() {
    val sunday = CalendarDateMath.toEpochDay(2026, 7, 12)
    val thursday = CalendarDateMath.toEpochDay(2026, 7, 16)
    assertEquals(0, CalendarDateMath.dayOfWeekSundayFirst(sunday))
    assertEquals(sunday, CalendarDateMath.startOfWeekSunday(thursday))
  }
}
