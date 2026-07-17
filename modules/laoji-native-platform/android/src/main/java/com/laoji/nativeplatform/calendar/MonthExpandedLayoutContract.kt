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

object MonthExpandedLayoutContract {
  const val ROW_ANIMATION_DURATION_MS = 350L
  const val TAP_THRESHOLD_DP = 20f
  const val DAY_PAGE_COUNT = 7
  const val DATE_RADIUS_DP = 11f
  const val GRID_START_MARGIN_DP = 16f
  const val GRID_END_MARGIN_DP = 11.5f
  const val EVENT_ROW_HEIGHT_DP = 48f

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
