package com.laoji.nativeplatform.calendar

// UI-SHELL-RESELECT-001, CAL-DAY-PAGER-001, CAL-DAY-DRAG-001, CAL-TIME-PRECISION-001:
// bounded paging and day interaction rules stay JVM-testable.

import java.util.Locale

enum class DayPageSlot(val position: Int, val dayDelta: Int) {
  LEFT(0, -1),
  CENTER(1, 0),
  RIGHT(2, 1);

  companion object {
    fun fromPosition(position: Int): DayPageSlot =
      entries.firstOrNull { it.position == position }
        ?: throw IllegalArgumentException("Day pager position must be in 0..2: $position")
  }
}

enum class SingleDayCompositionOwner {
  DATE_HEADER,
  ALL_DAY_SECTION,
  THREE_PAGE_PAGER,
}

enum class DayTimelineOwner {
  TIMELINE_CANVAS,
  GESTURE_LAYER,
}

data class DayPageBinding(
  val sessionId: Long,
  val epochDay: Int,
) {
  fun accepts(callbackSessionId: Long, callbackEpochDay: Int): Boolean =
    sessionId == callbackSessionId && epochDay == callbackEpochDay
}

data class DayPagerSettlement(
  val previousCenterEpochDay: Int,
  val settledPosition: Int,
  val dayDelta: Int,
  val nextCenterEpochDay: Int,
  val resetPosition: Int,
)

object DayPagerContract {
  const val PAGE_COUNT = 3
  const val CENTER_PAGE = 1
  const val HOUR_LINE_COUNT = 25
  const val DEFAULT_CREATION_DURATION_MINUTES = 30
  const val PROGRAMMATIC_DAY_SWITCH_DURATION_MS = 300L
  const val PROGRAMMATIC_VERTICAL_SCROLL_DURATION_MS = 250L
  const val TIMELINE_TOTAL_HEIGHT_DP = 1_236f
  const val TIMELINE_PADDING_TOP_DP = 16f
  const val TIMELINE_PADDING_RIGHT_DP = 3f
  const val TIMELINE_PADDING_BOTTOM_DP = 20f
  const val RULER_WIDTH_DP = 56f
  const val HOUR_HEIGHT_DP = 50f
  const val ACCESSIBILITY_PROVIDER_COUNT = 1

  val pageSlots: List<DayPageSlot> = DayPageSlot.entries.sortedBy(DayPageSlot::position)
  val compositionOwners: List<SingleDayCompositionOwner> = SingleDayCompositionOwner.entries
  val timelineOwners: List<DayTimelineOwner> = DayTimelineOwner.entries

  fun epochDayForPosition(centerEpochDay: Int, position: Int): Int =
    centerEpochDay + DayPageSlot.fromPosition(position).dayDelta

  fun settle(centerEpochDay: Int, settledPosition: Int): DayPagerSettlement {
    val slot = DayPageSlot.fromPosition(settledPosition)
    return DayPagerSettlement(
      previousCenterEpochDay = centerEpochDay,
      settledPosition = settledPosition,
      dayDelta = slot.dayDelta,
      nextCenterEpochDay = centerEpochDay + slot.dayDelta,
      resetPosition = CENTER_PAGE,
    )
  }

  fun positionProgress(position: Int, positionOffset: Float): Float {
    require(position in 0 until PAGE_COUNT) { "Day pager position must be in 0..2: $position" }
    require(positionOffset in 0f..1f) { "Day pager offset must be in 0..1: $positionOffset" }
    return (position + positionOffset - CENTER_PAGE).coerceIn(-1f, 1f)
  }

  fun hourLines(): IntRange = 0 until HOUR_LINE_COUNT

  fun hourLineOffsetDp(hour: Int): Float {
    require(hour in hourLines()) { "Hour line must be in 0..24: $hour" }
    return minuteToTimelineOffsetDp(hour * 60)
  }

  fun minuteToTimelineOffsetDp(minute: Int): Float =
    TIMELINE_PADDING_TOP_DP +
      minute.coerceIn(0, CalendarDateMath.MINUTES_PER_DAY) * HOUR_HEIGHT_DP / 60f

  fun timelineOffsetDpToMinute(offsetDp: Float): Float =
    ((offsetDp - TIMELINE_PADDING_TOP_DP) * 60f / HOUR_HEIGHT_DP)
      .coerceIn(0f, CalendarDateMath.MINUTES_PER_DAY.toFloat())

  fun centeredTimelineOffsetDp(minute: Int, viewportHeightDp: Float): Float {
    val safeViewport = viewportHeightDp.coerceAtLeast(0f)
    val maximum = (TIMELINE_TOTAL_HEIGHT_DP - safeViewport).coerceAtLeast(0f)
    return (minuteToTimelineOffsetDp(minute) - safeViewport / 2f).coerceIn(0f, maximum)
  }

  fun hourLabel(
    hour: Int,
    is24Hour: Boolean,
    amLabel: String = "AM",
    pmLabel: String = "PM",
  ): String = DayTimeFormatter.formatHourLine(hour, is24Hour, amLabel, pmLabel)

  fun createDraft(
    epochDay: Int,
    minute: Float,
    defaultDurationMinutes: Int,
  ): CalendarDraft =
    CalendarGestureMath.createDraft(
      epochDay = epochDay,
      minute = minute.coerceIn(0f, (CalendarDateMath.MINUTES_PER_DAY - 1).toFloat()),
      defaultDurationMinutes = defaultDurationMinutes,
      precisionMinutes = CalendarGestureMath.precisionForCreation(
        defaultDurationMinutes,
        preferredPrecisionMinutes = 15,
      ),
    )

  fun createThirtyMinuteDraft(epochDay: Int, minute: Float): CalendarDraft =
    createDraft(epochDay, minute, DEFAULT_CREATION_DURATION_MINUTES)

  fun adjustmentPrecision(
    kind: CalendarMutationKind,
    defaultDurationMinutes: Int,
    preferredPrecisionMinutes: Int = 15,
  ): Int =
    CalendarGestureMath.precisionForGesture(
      kind = kind,
      defaultDurationMinutes = defaultDurationMinutes,
      preferredPrecisionMinutes = preferredPrecisionMinutes,
    )

  fun minimumDuration(defaultDurationMinutes: Int): Int =
    CalendarGestureMath.minimumDuration(defaultDurationMinutes)

  fun programmaticStartPosition(previousEpochDay: Int, nextEpochDay: Int): Int {
    val delta = nextEpochDay.toLong() - previousEpochDay.toLong()
    return when {
      delta > 0L -> DayPageSlot.LEFT.position
      delta < 0L -> DayPageSlot.RIGHT.position
      else -> CENTER_PAGE
    }
  }

  fun shouldAnimateProgrammaticSwitch(previousEpochDay: Int, nextEpochDay: Int): Boolean =
    previousEpochDay != nextEpochDay
}

object DayTimeFormatter {
  fun formatHourLine(
    hour: Int,
    is24Hour: Boolean,
    amLabel: String = "AM",
    pmLabel: String = "PM",
    locale: Locale = Locale.getDefault(),
  ): String {
    require(hour in 0..24) { "Hour line must be in 0..24: $hour" }
    return formatMinute(hour * 60, is24Hour, amLabel, pmLabel, locale)
  }

  fun formatRange(
    startMinute: Int,
    endMinute: Int,
    is24Hour: Boolean,
    amLabel: String = "AM",
    pmLabel: String = "PM",
    locale: Locale = Locale.getDefault(),
  ): String = "${formatMinute(startMinute, is24Hour, amLabel, pmLabel, locale)}-" +
    formatMinute(endMinute, is24Hour, amLabel, pmLabel, locale)

  fun formatMinute(
    minute: Int,
    is24Hour: Boolean,
    amLabel: String = "AM",
    pmLabel: String = "PM",
    locale: Locale = Locale.getDefault(),
  ): String {
    require(minute in 0..CalendarDateMath.MINUTES_PER_DAY) {
      "Minute must be in 0..1440: $minute"
    }
    if (is24Hour) {
      return String.format(locale, "%02d:%02d", minute / 60, minute % 60)
    }

    val normalized = minute % CalendarDateMath.MINUTES_PER_DAY
    val hour = normalized / 60
    val minuteOfHour = normalized % 60
    val displayHour = (hour % 12).let { if (it == 0) 12 else it }
    val period = if (hour < 12) amLabel else pmLabel
    val clock = if (minuteOfHour == 0) {
      displayHour.toString()
    } else {
      String.format(locale, "%d:%02d", displayHour, minuteOfHour)
    }
    return "$clock $period".trim()
  }
}

object DayTimelineAccessibilityContract {
  fun virtualEventIdentities(events: List<CalendarEvent>, epochDay: Int): List<String> =
    CalendarGeometry.daySegments(events, epochDay).map { it.event.identity }

  fun screenBounds(
    contentBounds: CalendarRect,
    scrollOffset: Float,
    hostScreenX: Float,
    hostScreenY: Float,
  ): CalendarRect = CalendarRect(
    left = hostScreenX + contentBounds.left,
    top = hostScreenY + contentBounds.top - scrollOffset,
    right = hostScreenX + contentBounds.right,
    bottom = hostScreenY + contentBounds.bottom - scrollOffset,
  )
}
