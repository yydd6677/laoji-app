package com.laoji.nativeplatform.calendarpages

// CAL-EDIT-TIME-001: one working state owns both endpoints until Done commits atomically.

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

internal enum class CalendarEditEndpoint {
  START,
  END,
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

internal data class CalendarEditTimeState(
  val baseDraft: CalendarEditDraft,
  val startDate: LocalDate,
  val endDate: LocalDate,
  val startTime: LocalTime,
  val endTime: LocalTime,
  val allDay: Boolean,
  val timedEnabled: Boolean,
  val endTimedEnabled: Boolean,
  val selectedEndpoint: CalendarEditEndpoint,
) {
  val hasTime: Boolean
    get() = !allDay && timedEnabled

  fun timeEnabled(endpoint: CalendarEditEndpoint): Boolean = when (endpoint) {
    CalendarEditEndpoint.START -> hasTime
    CalendarEditEndpoint.END -> hasTime && endTimedEnabled
  }

  fun selectedDate(): LocalDate = dateFor(selectedEndpoint)

  fun selectedTime(): LocalTime = timeFor(selectedEndpoint)

  fun dateFor(endpoint: CalendarEditEndpoint): LocalDate = when (endpoint) {
    CalendarEditEndpoint.START -> startDate
    CalendarEditEndpoint.END -> endDate
  }

  fun timeFor(endpoint: CalendarEditEndpoint): LocalTime = when (endpoint) {
    CalendarEditEndpoint.START -> startTime
    CalendarEditEndpoint.END -> endTime
  }

  fun select(endpoint: CalendarEditEndpoint): CalendarEditTimeState = copy(selectedEndpoint = endpoint)

  fun setAllDay(enabled: Boolean): CalendarEditTimeState = copy(allDay = enabled)
    .enforceBoundary(selectedEndpoint)

  fun setTimedEnabled(enabled: Boolean): CalendarEditTimeState = copy(
    allDay = false,
    timedEnabled = enabled,
  ).enforceBoundary(selectedEndpoint)

  fun setEndTimedEnabled(enabled: Boolean): CalendarEditTimeState = copy(
    allDay = false,
    timedEnabled = timedEnabled || enabled,
    endTimedEnabled = enabled,
  ).enforceBoundary(CalendarEditEndpoint.END)

  fun setDate(endpoint: CalendarEditEndpoint, value: LocalDate): CalendarEditTimeState {
    val bounded = value.coerceCalendarRange()
    val changed = when (endpoint) {
      CalendarEditEndpoint.START -> copy(startDate = bounded)
      CalendarEditEndpoint.END -> copy(endDate = bounded)
    }
    return changed.enforceBoundary(endpoint)
  }

  fun setYear(value: Int): CalendarEditTimeState {
    val current = selectedDate()
    val year = value.coerceIn(MIN_YEAR, MAX_YEAR)
    val day = current.dayOfMonth.coerceAtMost(YearMonth.of(year, current.monthValue).lengthOfMonth())
    return setDate(selectedEndpoint, LocalDate.of(year, current.monthValue, day))
  }

  fun setMonth(value: Int): CalendarEditTimeState {
    val current = selectedDate()
    val month = value.coerceIn(1, 12)
    val day = current.dayOfMonth.coerceAtMost(YearMonth.of(current.year, month).lengthOfMonth())
    return setDate(selectedEndpoint, LocalDate.of(current.year, month, day))
  }

  fun setDayOfMonth(value: Int): CalendarEditTimeState {
    val current = selectedDate()
    val day = value.coerceIn(1, YearMonth.from(current).lengthOfMonth())
    return setDate(selectedEndpoint, current.withDayOfMonth(day))
  }

  fun setHour24(value: Int): CalendarEditTimeState = setTime(
    selectedEndpoint,
    selectedTime().withHour(value.coerceIn(0, 23)),
  )

  fun setHour12(value: Int): CalendarEditTimeState {
    val hour12 = value.coerceIn(1, 12) % 12
    val period = if (selectedTime().hour >= 12) 12 else 0
    return setHour24(hour12 + period)
  }

  fun setPeriod(value: Int): CalendarEditTimeState {
    val period = value.coerceIn(0, 1)
    val hour12 = selectedTime().hour % 12
    return setHour24(hour12 + period * 12)
  }

  fun setMinuteIndex(value: Int): CalendarEditTimeState = setTime(
    selectedEndpoint,
    selectedTime().withMinute(value.coerceIn(0, MINUTE_ITEM_COUNT - 1) * MINUTE_STEP),
  )

  fun completedDraft(): CalendarEditDraft {
    val safe = enforceBoundary(CalendarEditEndpoint.END)
    return when {
      safe.allDay -> safe.baseDraft.copy(
        startDate = safe.startDate.toString(),
        endDate = safe.endDate.toString(),
        startTime = null,
        endTime = null,
        allDay = true,
        reminderMinutes = null,
      ).normalized()
      !safe.timedEnabled -> safe.baseDraft.copy(
        startDate = safe.startDate.toString(),
        endDate = safe.endDate.toString(),
        startTime = null,
        endTime = null,
        allDay = false,
        reminderMinutes = null,
      ).normalized()
      else -> safe.baseDraft.copy(
        startDate = safe.startDate.toString(),
        endDate = safe.endDate.toString(),
        startTime = safe.startTime.format(TIME_FORMATTER),
        endTime = safe.endTime.takeIf { safe.endTimedEnabled }?.format(TIME_FORMATTER),
        allDay = false,
      ).normalized()
    }
  }

  private fun setTime(endpoint: CalendarEditEndpoint, value: LocalTime): CalendarEditTimeState {
    val minute = (value.minute / MINUTE_STEP) * MINUTE_STEP
    val snapped = value.withMinute(minute).withSecond(0).withNano(0)
    val changed = when (endpoint) {
      CalendarEditEndpoint.START -> copy(startTime = snapped)
      CalendarEditEndpoint.END -> copy(endTime = snapped)
    }
    return changed.enforceBoundary(endpoint)
  }

  private fun enforceBoundary(changedEndpoint: CalendarEditEndpoint): CalendarEditTimeState {
    if (endDate.isBefore(startDate)) {
      return when (changedEndpoint) {
        CalendarEditEndpoint.START -> copy(endDate = startDate).enforceBoundary(changedEndpoint)
        CalendarEditEndpoint.END -> copy(endDate = startDate).enforceBoundary(changedEndpoint)
      }
    }
    if (!hasTime || !endTimedEnabled) return this

    val start = LocalDateTime.of(startDate, startTime)
    val end = LocalDateTime.of(endDate, endTime)
    if (end.isAfter(start)) return this

    val minimumEnd = start.plusMinutes(
      if (changedEndpoint == CalendarEditEndpoint.START) DEFAULT_DURATION_MINUTES else MINUTE_STEP.toLong(),
    )
    return copy(endDate = minimumEnd.toLocalDate(), endTime = minimumEnd.toLocalTime())
  }

  companion object {
    const val MIN_YEAR = CalendarEditDateRange.MIN_YEAR
    const val MAX_YEAR = CalendarEditDateRange.MAX_YEAR
    const val MINUTE_STEP = 5
    const val MINUTE_ITEM_COUNT = 60 / MINUTE_STEP
    const val DEFAULT_DURATION_MINUTES = 60L

    private val DATE_FORMATTER = DateTimeFormatter.ISO_LOCAL_DATE
    private val TIME_FORMATTER = DateTimeFormatter.ofPattern("HH:mm")

    fun fromDraft(
      draft: CalendarEditDraft,
      selectedEndpoint: CalendarEditEndpoint,
    ): CalendarEditTimeState {
      val normalized = draft.normalized()
      val startDate = requireNotNull(parseDate(normalized.startDate)?.takeIf(CalendarEditDateRange::contains)) {
        "start date is outside the visible wheel range"
      }
      val parsedEndDate = requireNotNull(parseDate(normalized.endDate)?.takeIf(CalendarEditDateRange::contains)) {
        "end date is outside the visible wheel range"
      }
      val endDate = if (parsedEndDate.isBefore(startDate)) startDate else parsedEndDate
      val parsedStartTime = parseTime(normalized.startTime)
      val parsedEndTime = parseTime(normalized.endTime)
      val hasTime = !normalized.allDay && parsedStartTime != null
      val hasEndTime = hasTime && parsedEndTime != null
      val snappedStart = snapDown(startDate, parsedStartTime ?: LocalTime.of(10, 0))
      val snappedEnd = snapUp(endDate, parsedEndTime ?: LocalTime.of(11, 0))
      return CalendarEditTimeState(
        baseDraft = normalized,
        startDate = snappedStart.toLocalDate(),
        endDate = snappedEnd.toLocalDate(),
        startTime = snappedStart.toLocalTime(),
        endTime = snappedEnd.toLocalTime(),
        allDay = normalized.allDay,
        timedEnabled = hasTime,
        endTimedEnabled = hasEndTime,
        selectedEndpoint = selectedEndpoint,
      ).enforceBoundary(CalendarEditEndpoint.END)
    }

    private fun parseDate(value: String?): LocalDate? = try {
      value?.let { LocalDate.parse(it, DATE_FORMATTER) }
    } catch (_: DateTimeParseException) {
      null
    }

    private fun parseTime(value: String?): LocalTime? = try {
      value?.let { LocalTime.parse(it, TIME_FORMATTER) }
    } catch (_: DateTimeParseException) {
      null
    }

    private fun snapDown(date: LocalDate, value: LocalTime): LocalDateTime = LocalDateTime.of(date, value)
      .withMinute((value.minute / MINUTE_STEP) * MINUTE_STEP)
      .withSecond(0)
      .withNano(0)

    private fun snapUp(date: LocalDate, value: LocalTime): LocalDateTime {
      val dateTime = LocalDateTime.of(date, value).withSecond(0).withNano(0)
      val remainder = value.minute % MINUTE_STEP
      if (remainder == 0) return dateTime
      return dateTime.plusMinutes((MINUTE_STEP - remainder).toLong())
    }
  }
}

internal object CalendarEditTimeFormatter {
  private val weekdays = listOf("一", "二", "三", "四", "五", "六", "日")

  fun dateLabel(value: LocalDate): String =
    "${value.year}年${value.monthValue}月${value.dayOfMonth}日 周${weekdays[value.dayOfWeek.value - 1]}"

  fun dateWheelLabel(value: LocalDate): String =
    "${value.monthValue}月${value.dayOfMonth}日 周${weekdays[value.dayOfWeek.value - 1]}"

  fun timeLabel(value: LocalTime?, is24Hour: Boolean): String {
    if (value == null) return "未设置"
    return if (is24Hour) {
      String.format(Locale.CHINA, "%02d:%02d", value.hour, value.minute)
    } else {
      val period = if (value.hour < 12) "上午" else "下午"
      val hour = value.hour % 12
      String.format(Locale.CHINA, "%s %d:%02d", period, if (hour == 0) 12 else hour, value.minute)
    }
  }

  fun yearWheelLabel(value: Int): String = "${value}年"

  fun monthWheelLabel(value: Int): String = "${value}月"

  fun dayWheelLabel(value: Int): String = "${value}日"

  fun dayWithWeekdayWheelLabel(value: LocalDate): String =
    "${value.dayOfMonth}日(周${weekdays[value.dayOfWeek.value - 1]})"

  fun periodWheelLabel(value: Int): String = if (value == 0) "上午" else "下午"

  fun hourWheelLabel(value: Int, is24Hour: Boolean): String = if (is24Hour) {
    String.format(Locale.CHINA, "%02d时", value)
  } else {
    "${value}时"
  }

  fun minuteWheelLabel(value: Int): String =
    String.format(Locale.CHINA, "%02d分", value * CalendarEditTimeState.MINUTE_STEP)
}

private fun LocalDate.coerceCalendarRange(): LocalDate = CalendarEditDateRange.clamp(this)
