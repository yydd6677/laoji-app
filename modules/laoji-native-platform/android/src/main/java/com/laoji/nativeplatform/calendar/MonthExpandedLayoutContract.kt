package com.laoji.nativeplatform.calendar

// CAL-MONTH-EXPAND-001: Pure layout and tap-state rules keep the expanded month page JVM-testable.

import kotlin.math.abs

data class MonthExpandedSelection(
  val epochDay: Int,
  val row: Int,
  val column: Int,
)

enum class MonthExpandedTapAction {
  OPEN,
  CLOSE,
  SWITCH_WITHIN_ROW,
  CLOSE_THEN_OPEN,
}

data class MonthExpandedTapTransition(
  val action: MonthExpandedTapAction,
  val targetSelection: MonthExpandedSelection?,
)

data class MonthExpandedEventsBounds(
  val top: Float,
  val bottom: Float,
)

data class MonthEventSpanBounds(
  val left: Float,
  val right: Float,
)

data class MonthEventTimeBounds(
  val startMinute: Int,
  val endMinute: Int,
)

// CAL-MONTH-EXPAND-001: the source draws today's blue marker first and the
// selected non-today day as a neutral circle behind its date text.
enum class MonthDateMarker {
  NONE,
  TODAY,
  SELECTED,
}

object MonthExpandedLayoutContract {
  const val ROW_ANIMATION_DURATION_MS = 350L
  const val TAP_THRESHOLD_DP = 20f
  const val DAY_PAGE_COUNT = 7
  const val DATE_RADIUS_DP = 11f
  const val GRID_START_MARGIN_DP = 16f
  const val GRID_END_MARGIN_DP = 11.5f
  const val EVENT_ROW_HEIGHT_DP = 48f
  const val DATE_TEXT_SIZE_SP = 12f
  const val DATE_TOP_DP = 10f
  const val DATE_BASELINE_DP = 22f
  const val DATE_MARKER_CENTER_DP = 18f
  const val OVERFLOW_BADGE_WIDTH_DP = 19f
  const val OVERFLOW_BADGE_HEIGHT_DP = 12f
  const val OVERFLOW_BADGE_RADIUS_DP = 2.5f
  // [SOURCE] The compact month-grid branch is not EventChipView's 14dp day
  // branch. MonthAllDayInstanceDrawableData delegates to C153808d.m522727f,
  // which sets MONTH_VIEW_TEXT_SIZE_DP to 11.
  const val EVENT_TEXT_SIZE_DP = 11f
  // [SOURCE] re3/C153854f initializes the month instance block to 16dp with a
  // 3dp lane gap; C153808d.m522727f passes a 2.5dp month-view radius.
  const val EVENT_HEIGHT_DP = 16f
  const val EVENT_VERTICAL_GAP_DP = 3f
  const val EVENT_RIGHT_GAP_DP = 3f
  const val EVENT_RADIUS_DP = 2.5f

  // CAL-MONTH-SPAN-001: C155132d assigns one width across all occupied day
  // columns and C152323a subtracts horizontalSpace only at the final edge.
  fun eventSpanBounds(
    gridStart: Float,
    cellWidth: Float,
    startColumn: Int,
    endColumn: Int,
    rightGap: Float,
  ): MonthEventSpanBounds {
    require(startColumn in 0 until DAY_PAGE_COUNT)
    require(endColumn in startColumn until DAY_PAGE_COUNT)
    return MonthEventSpanBounds(
      left = gridStart + startColumn * cellWidth,
      right = gridStart + (endColumn + 1) * cellWidth - rightGap,
    )
  }

  // CAL-TIMEFORMAT-001: month expansion uses the same half-open event bounds
  // as the day owner before passing both values to the shared formatter.
  fun eventTimeBounds(epochDay: Int, event: CalendarEvent): MonthEventTimeBounds =
    MonthEventTimeBounds(
      startMinute = if (epochDay == event.startEpochDay) event.startMinutes ?: 0 else 0,
      endMinute = if (epochDay == event.endEpochDay) {
        event.endMinutes ?: CalendarDateMath.MINUTES_PER_DAY
      } else {
        CalendarDateMath.MINUTES_PER_DAY
      },
    )

  fun dateMarker(epochDay: Int, selectedEpochDay: Int?, todayEpochDay: Int?): MonthDateMarker = when {
    epochDay == todayEpochDay -> MonthDateMarker.TODAY
    epochDay == selectedEpochDay -> MonthDateMarker.SELECTED
    else -> MonthDateMarker.NONE
  }

  fun animationLegCount(action: MonthExpandedTapAction): Int = when (action) {
    MonthExpandedTapAction.SWITCH_WITHIN_ROW -> 0
    MonthExpandedTapAction.CLOSE_THEN_OPEN -> 2
    MonthExpandedTapAction.OPEN,
    MonthExpandedTapAction.CLOSE -> 1
  }

  fun totalAnimationDurationMs(action: MonthExpandedTapAction): Long =
    animationLegCount(action) * ROW_ANIMATION_DURATION_MS

  fun isTapWithinThreshold(
    deltaX: Float,
    deltaY: Float,
    pixelsPerDp: Float = 1f,
  ): Boolean {
    require(pixelsPerDp > 0f) { "pixelsPerDp must be positive" }
    val threshold = TAP_THRESHOLD_DP * pixelsPerDp
    return abs(deltaX) < threshold && abs(deltaY) < threshold
  }

  fun dayPageEpochDays(weekStartEpochDay: Int): List<Int> =
    List(DAY_PAGE_COUNT) { weekStartEpochDay + it }

  fun resolveTap(
    current: MonthExpandedSelection?,
    tappedEpochDay: Int,
    tappedRow: Int,
    tappedColumn: Int,
  ): MonthExpandedTapTransition {
    require(tappedRow >= 0) { "tappedRow must be non-negative" }
    require(tappedColumn in 0 until DAY_PAGE_COUNT) { "tappedColumn must be within the seven day pages" }
    val target = MonthExpandedSelection(tappedEpochDay, tappedRow, tappedColumn)
    return when {
      current == null -> MonthExpandedTapTransition(MonthExpandedTapAction.OPEN, target)
      current.epochDay == tappedEpochDay -> MonthExpandedTapTransition(MonthExpandedTapAction.CLOSE, null)
      current.row == tappedRow -> MonthExpandedTapTransition(MonthExpandedTapAction.SWITCH_WITHIN_ROW, target)
      else -> MonthExpandedTapTransition(MonthExpandedTapAction.CLOSE_THEN_OPEN, target)
    }
  }

  fun closeSelectionEpochDay(
    todayEpochDay: Int?,
    monthEpochDay: Int,
    gridStartEpochDay: Int,
    weekCount: Int,
  ): Int {
    require(weekCount in 4..6) { "weekCount must be in 4..6" }
    val today = todayEpochDay ?: return monthEpochDay
    return if (today in gridStartEpochDay until gridStartEpochDay + weekCount * DAY_PAGE_COUNT) {
      today
    } else {
      monthEpochDay
    }
  }

  fun rowTargetTops(
    containerHeight: Float,
    weekCount: Int,
    selectedRow: Int?,
  ): List<Float> {
    require(containerHeight >= 0f) { "containerHeight must be non-negative" }
    require(weekCount in 4..6) { "weekCount must be in 4..6" }
    if (selectedRow != null) require(selectedRow in 0 until weekCount) {
      "selectedRow must be within the visible weeks"
    }

    val rowHeight = containerHeight / weekCount
    return List(weekCount) { row ->
      when {
        selectedRow == null -> row * rowHeight
        row <= selectedRow -> (row - selectedRow) * rowHeight
        else -> containerHeight - rowHeight + (row - selectedRow - 1) * rowHeight
      }
    }
  }

  fun selectedEventsBounds(
    containerHeight: Float,
    weekCount: Int,
    selectedRow: Int,
  ): MonthExpandedEventsBounds {
    require(containerHeight >= 0f) { "containerHeight must be non-negative" }
    require(weekCount in 4..6) { "weekCount must be in 4..6" }
    require(selectedRow in 0 until weekCount) { "selectedRow must be within the visible weeks" }
    val rowHeight = containerHeight / weekCount
    val bottom = if (selectedRow == weekCount - 1) containerHeight else containerHeight - rowHeight
    return MonthExpandedEventsBounds(top = rowHeight, bottom = bottom)
  }
}
