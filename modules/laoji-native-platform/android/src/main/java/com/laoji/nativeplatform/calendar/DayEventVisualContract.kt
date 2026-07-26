package com.laoji.nativeplatform.calendar

import kotlin.math.floor

// CAL-DAY-COMPOSE-001: values below are transcribed from the Feishu day
// instance drawable path. The event rectangle itself remains a separate
// layout contract because Feishu receives InstanceLayout from its Rust side.

object DayEventVisualContract {
  const val EVENT_RADIUS_DP = 4f
  // [PRODUCT] LaoJi uses a continuous event outline instead of Feishu's
  // one-sided calendar-color strip.
  const val EVENT_BORDER_WIDTH_DP = CalendarProductVisualContract.EVENT_BORDER_WIDTH_DP
  const val TEXT_MARGIN_LEFT_DP = 9f
  const val TEXT_MARGIN_TOP_DP = 3f
  const val TEXT_MARGIN_RIGHT_DP = 4f
  const val TEXT_MARGIN_BOTTOM_DP = 3f
  const val TITLE_TEXT_SIZE_SP = 14f
  const val DESCRIPTION_TEXT_SIZE_SP = 12f
  const val TEXT_VERTICAL_SPACE_DP = 1f
  const val PRESSED_OVERLAY_ALPHA = 0.1f

  const val CURRENT_TIME_DOT_RADIUS_DP = 3.5f
  const val CURRENT_TIME_LINE_GAP_DP = 1f

  fun eventTextWidth(rectWidthDp: Float): Float =
    (rectWidthDp - TEXT_MARGIN_LEFT_DP - TEXT_MARGIN_RIGHT_DP).coerceAtLeast(0f)

  // Feishu's DayEventInstanceDrawableData converts x/y/width/height percentages
  // to the event surface before the drawable is measured. Keep that conversion
  // explicit so a source rectangle never passes through lane fallback math.
  fun instanceLayoutRect(
    layout: CalendarInstanceLayout,
    eventAreaLeft: Float,
    eventAreaWidth: Float,
    timelineTop: Float,
    timelineHeight: Float,
  ): CalendarRect {
    val normalized = layout.normalized()
    val left = eventAreaLeft + sourceRound(eventAreaWidth * normalized.xOffsetPercent / 100f)
    val top = timelineTop + sourceRound(timelineHeight * normalized.yOffsetPercent / 100f)
    val right = eventAreaLeft + sourceRound(
      eventAreaWidth * (normalized.xOffsetPercent + normalized.widthPercent) / 100f,
    )
    val bottom = timelineTop + sourceRound(
      timelineHeight * (normalized.yOffsetPercent + normalized.heightPercent) / 100f,
    )
    return CalendarRect(left, top, right, bottom)
  }

  private fun sourceRound(value: Float): Float = floor(value + 0.5f)
}
