package com.laoji.nativeplatform.calendarpages

import java.time.LocalDate
import java.time.LocalTime
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale

internal enum class CalendarEditEndpoint { START, END }
internal enum class CalendarTimePrecision(val wireName: String, val label: String) {
  UNSPECIFIED("unspecified", "未设置"), PERIOD("period", "时段"), EXACT("exact", "具体时间");
  companion object {
    fun fromWire(value: String?): CalendarTimePrecision? = entries.firstOrNull { it.wireName == value }
  }
}
internal enum class CalendarTimePeriod(val wireName: String, val label: String) {
  EARLY_MORNING("early_morning", "凌晨"), MORNING("morning", "上午"), NOON("noon", "中午"),
  AFTERNOON("afternoon", "下午"), EVENING("evening", "傍晚"), NIGHT("night", "晚上");
  companion object {
    fun fromWire(value: String?): CalendarTimePeriod? = entries.firstOrNull { it.wireName == value }
  }
}
internal object CalendarEditDateRange {
  const val MIN_YEAR = 1900
  const val MAX_YEAR = 2100
  fun contains(value: LocalDate): Boolean = value.year in MIN_YEAR..MAX_YEAR
  fun clamp(value: LocalDate): LocalDate = when {
    value.year < MIN_YEAR -> LocalDate.of(MIN_YEAR, 1, 1)
    value.year > MAX_YEAR -> LocalDate.of(MAX_YEAR, 12, 31)
    else -> value
  }
}

/** One disposable working copy. Only Done commits; no snapping or boundary repair. */
internal data class CalendarEditTimeState(
  val baseDraft: CalendarEditDraft,
  val startDate: LocalDate,
  val endDate: LocalDate,
  val startTime: LocalTime,
  val endTime: LocalTime,
  val precision: CalendarTimePrecision,
  val period: CalendarTimePeriod,
  val endTimedEnabled: Boolean,
  val selectedEndpoint: CalendarEditEndpoint,
  val dateOnly: Boolean = false,
  val timeChanged: Boolean = false,
  val dateChanged: Boolean = false,
) {
  val hasTime: Boolean get() = precision == CalendarTimePrecision.EXACT
  fun timeEnabled(endpoint: CalendarEditEndpoint): Boolean = hasTime &&
    (endpoint == CalendarEditEndpoint.START || endTimedEnabled)
  fun selectedDate(): LocalDate = if (selectedEndpoint == CalendarEditEndpoint.START) startDate else endDate
  fun selectedTime(): LocalTime = if (selectedEndpoint == CalendarEditEndpoint.START) startTime else endTime
  fun select(endpoint: CalendarEditEndpoint): CalendarEditTimeState =
    if (endpoint == CalendarEditEndpoint.END && !endTimedEnabled && !dateOnly) this else copy(selectedEndpoint = endpoint)
  fun setPrecision(value: CalendarTimePrecision): CalendarEditTimeState = copy(
    precision = value, timeChanged = timeChanged || value != precision,
    endTimedEnabled = endTimedEnabled && value == CalendarTimePrecision.EXACT,
    selectedEndpoint = CalendarEditEndpoint.START,
  )
  fun setPeriod(value: CalendarTimePeriod): CalendarEditTimeState = copy(
    precision = CalendarTimePrecision.PERIOD, period = value, timeChanged = true,
    endTimedEnabled = false, selectedEndpoint = CalendarEditEndpoint.START,
  )
  fun setEndEnabled(enabled: Boolean): CalendarEditTimeState = copy(
    endTimedEnabled = enabled, timeChanged = true,
    selectedEndpoint = if (enabled) CalendarEditEndpoint.END else CalendarEditEndpoint.START,
    endDate = if (!enabled && baseDraft.endDate == baseDraft.startDate) startDate else endDate,
  )
  fun setDate(endpoint: CalendarEditEndpoint, value: LocalDate): CalendarEditTimeState {
    val bounded = CalendarEditDateRange.clamp(value)
    return if (endpoint == CalendarEditEndpoint.START) copy(
      startDate = bounded,
      endDate = if (!endTimedEnabled && endDate == startDate) bounded else endDate,
      dateChanged = true,
    ) else copy(endDate = bounded, dateChanged = true)
  }
  fun setYear(value: Int): CalendarEditTimeState {
    val current = selectedDate()
    val year = value.coerceIn(MIN_YEAR, MAX_YEAR)
    return setDate(selectedEndpoint, LocalDate.of(year, current.monthValue,
      current.dayOfMonth.coerceAtMost(YearMonth.of(year, current.monthValue).lengthOfMonth())))
  }
  fun setMonth(value: Int): CalendarEditTimeState {
    val current = selectedDate()
    val month = value.coerceIn(1, 12)
    return setDate(selectedEndpoint, LocalDate.of(current.year, month,
      current.dayOfMonth.coerceAtMost(YearMonth.of(current.year, month).lengthOfMonth())))
  }
  fun setDayOfMonth(value: Int): CalendarEditTimeState = setDate(selectedEndpoint,
    selectedDate().withDayOfMonth(value.coerceIn(1, YearMonth.from(selectedDate()).lengthOfMonth())))
  fun setHour24(value: Int): CalendarEditTimeState = setTime(selectedTime().withHour(value.coerceIn(0, 23)))
  fun setMinuteIndex(value: Int): CalendarEditTimeState = setTime(selectedTime().withMinute(value.coerceIn(0, 59)))
  private fun setTime(value: LocalTime): CalendarEditTimeState =
    if (selectedEndpoint == CalendarEditEndpoint.START) copy(startTime = value.withSecond(0).withNano(0), timeChanged = true)
    else copy(endTime = value.withSecond(0).withNano(0), timeChanged = true)

  fun completedDraft(): CalendarEditDraft {
    val dates = if (dateOnly || dateChanged) baseDraft.copy(
      startDate = startDate.toString(), endDate = endDate.toString()) else baseDraft
    if (dateOnly || !timeChanged) return dates.normalized()
    return dates.copy(
      timePrecision = precision.wireName,
      timePeriod = if (precision == CalendarTimePrecision.PERIOD) period.wireName else null,
      startTime = if (hasTime) startTime.format(TIME_FORMATTER) else null,
      endTime = if (hasTime && endTimedEnabled) endTime.format(TIME_FORMATTER) else null,
      allDay = false,
      reminderMinutes = if (hasTime) baseDraft.reminderMinutes else null,
    ).normalized()
  }

  companion object {
    const val MIN_YEAR = CalendarEditDateRange.MIN_YEAR
    const val MAX_YEAR = CalendarEditDateRange.MAX_YEAR
    const val MINUTE_ITEM_COUNT = 60
    private val TIME_FORMATTER = DateTimeFormatter.ofPattern("HH:mm")
    fun fromDraft(draft: CalendarEditDraft, selectedEndpoint: CalendarEditEndpoint,
      dateOnly: Boolean = false): CalendarEditTimeState {
      val normalized = draft.normalized()
      // An empty date has a visible candidate, not an accepted default.
      val startDate = if (normalized.startDate.isBlank()) LocalDate.now()
        else LocalDate.parse(normalized.startDate)
      val endDate = if (normalized.endDate.isBlank()) startDate else LocalDate.parse(normalized.endDate)
      require(CalendarEditDateRange.contains(startDate) && CalendarEditDateRange.contains(endDate))
      val startTime = normalized.startTime?.let(LocalTime::parse) ?: LocalTime.of(10, 0)
      val endTime = normalized.endTime?.let(LocalTime::parse) ?: startTime.plusHours(1)
      val precision = requireNotNull(normalized.precision)
      val hasEnd = precision == CalendarTimePrecision.EXACT && normalized.endTime != null
      return CalendarEditTimeState(normalized, startDate, endDate, startTime, endTime,
        precision, CalendarTimePeriod.fromWire(normalized.timePeriod) ?: CalendarTimePeriod.MORNING,
        hasEnd, if (selectedEndpoint == CalendarEditEndpoint.END && (hasEnd || dateOnly)) selectedEndpoint
          else CalendarEditEndpoint.START, dateOnly)
    }
  }
}

internal object CalendarEditTimeFormatter {
  private val weekdays = listOf("一", "二", "三", "四", "五", "六", "日")
  fun dateLabel(value: LocalDate): String =
    "${value.year}年${value.monthValue}月${value.dayOfMonth}日 周${weekdays[value.dayOfWeek.value - 1]}"
  fun dateWheelLabel(value: LocalDate): String =
    "${value.monthValue}月${value.dayOfMonth}日 周${weekdays[value.dayOfWeek.value - 1]}"
  fun timeLabel(value: LocalTime?, is24Hour: Boolean): String = when {
    value == null -> "未设置"
    is24Hour -> String.format(Locale.CHINA, "%02d:%02d", value.hour, value.minute)
    else -> String.format(Locale.CHINA, "%s %d:%02d", if (value.hour < 12) "上午" else "下午",
      if (value.hour % 12 == 0) 12 else value.hour % 12, value.minute)
  }
  fun yearWheelLabel(value: Int): String = "${value}年"
  fun monthWheelLabel(value: Int): String = "${value}月"
  fun dayWheelLabel(value: Int): String = "${value}日"
  fun dayWithWeekdayWheelLabel(value: LocalDate): String = "${value.dayOfMonth}日(周${weekdays[value.dayOfWeek.value - 1]})"
  fun hourWheelLabel(value: Int, is24Hour: Boolean): String = if (is24Hour)
    String.format(Locale.CHINA, "%02d时", value) else "${value}时"
  fun minuteWheelLabel(value: Int): String = String.format(Locale.CHINA, "%02d分", value)
}
