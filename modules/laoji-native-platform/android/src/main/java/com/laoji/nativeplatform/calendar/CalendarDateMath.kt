package com.laoji.nativeplatform.calendar

// CAL-PICKER-001: Gregorian epoch-day math preserves the selected day and clamps month ends.

data class CalendarDateParts(
  val year: Int,
  val month: Int,
  val day: Int
)

data class CalendarMinutePoint(
  val epochDay: Int,
  val minutes: Int
)

object CalendarDateMath {
  const val MINUTES_PER_DAY = 1_440
  private const val DAYS_FROM_CIVIL_ORIGIN_TO_UNIX_EPOCH = 719_468L

  fun isLeapYear(year: Int): Boolean = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)

  fun daysInMonth(year: Int, month: Int): Int = when (month) {
    2 -> if (isLeapYear(year)) 29 else 28
    4, 6, 9, 11 -> 30
    else -> 31
  }

  fun toEpochDay(year: Int, month: Int, day: Int): Int {
    require(month in 1..12)
    require(day in 1..daysInMonth(year, month))
    var adjustedYear = year.toLong()
    if (month <= 2) adjustedYear -= 1
    val era = floorDiv(adjustedYear, 400L)
    val yearOfEra = adjustedYear - era * 400L
    val adjustedMonth = month + if (month > 2) -3 else 9
    val dayOfYear = (153L * adjustedMonth + 2L) / 5L + day - 1L
    val dayOfEra = yearOfEra * 365L + yearOfEra / 4L - yearOfEra / 100L + dayOfYear
    return (era * 146_097L + dayOfEra - DAYS_FROM_CIVIL_ORIGIN_TO_UNIX_EPOCH).toInt()
  }

  fun fromEpochDay(epochDay: Int): CalendarDateParts {
    val shifted = epochDay.toLong() + DAYS_FROM_CIVIL_ORIGIN_TO_UNIX_EPOCH
    val era = floorDiv(shifted, 146_097L)
    val dayOfEra = shifted - era * 146_097L
    val yearOfEra = (dayOfEra - dayOfEra / 1_460L + dayOfEra / 36_524L - dayOfEra / 146_096L) / 365L
    var year = yearOfEra + era * 400L
    val dayOfYear = dayOfEra - (365L * yearOfEra + yearOfEra / 4L - yearOfEra / 100L)
    val monthPrime = (5L * dayOfYear + 2L) / 153L
    val day = dayOfYear - (153L * monthPrime + 2L) / 5L + 1L
    val month = monthPrime + if (monthPrime < 10L) 3L else -9L
    if (month <= 2L) year += 1L
    return CalendarDateParts(year.toInt(), month.toInt(), day.toInt())
  }

  fun dayOfWeekSundayFirst(epochDay: Int): Int = floorMod(epochDay + 4, 7)

  fun startOfWeekSunday(epochDay: Int): Int = epochDay - dayOfWeekSundayFirst(epochDay)

  fun monthStart(epochDay: Int): Int {
    val date = fromEpochDay(epochDay)
    return toEpochDay(date.year, date.month, 1)
  }

  fun monthGridStart(monthEpochDay: Int): Int {
    val first = monthStart(monthEpochDay)
    return first - dayOfWeekSundayFirst(first)
  }

  fun monthWeekCount(monthEpochDay: Int): Int {
    val first = fromEpochDay(monthStart(monthEpochDay))
    val leading = dayOfWeekSundayFirst(toEpochDay(first.year, first.month, 1))
    return ((leading + daysInMonth(first.year, first.month) + 6) / 7).coerceIn(4, 6)
  }

  fun addMonths(epochDay: Int, deltaMonths: Int, preserveDay: Boolean = true): Int {
    val date = fromEpochDay(epochDay)
    val monthIndex = date.year.toLong() * 12L + date.month - 1L + deltaMonths
    val targetYear = floorDiv(monthIndex, 12L).toInt()
    val targetMonth = floorMod(monthIndex, 12L).toInt() + 1
    val targetDay = if (preserveDay) date.day.coerceAtMost(daysInMonth(targetYear, targetMonth)) else 1
    return toEpochDay(targetYear, targetMonth, targetDay)
  }

  fun absoluteMinute(epochDay: Int, minutes: Int): Long = epochDay.toLong() * MINUTES_PER_DAY + minutes

  fun canonicalStart(absoluteMinute: Long): CalendarMinutePoint {
    val day = floorDiv(absoluteMinute, MINUTES_PER_DAY.toLong())
    val minute = floorMod(absoluteMinute, MINUTES_PER_DAY.toLong())
    return CalendarMinutePoint(day.toInt(), minute.toInt())
  }

  fun canonicalEnd(absoluteMinute: Long): CalendarMinutePoint {
    val minute = floorMod(absoluteMinute, MINUTES_PER_DAY.toLong()).toInt()
    val day = floorDiv(absoluteMinute, MINUTES_PER_DAY.toLong()).toInt()
    return if (minute == 0) {
      CalendarMinutePoint(day - 1, MINUTES_PER_DAY)
    } else {
      CalendarMinutePoint(day, minute)
    }
  }

  fun floorDiv(value: Long, divisor: Long): Long {
    var quotient = value / divisor
    if ((value xor divisor) < 0 && quotient * divisor != value) quotient -= 1
    return quotient
  }

  fun floorMod(value: Int, divisor: Int): Int = ((value % divisor) + divisor) % divisor

  fun floorMod(value: Long, divisor: Long): Long = ((value % divisor) + divisor) % divisor
}
