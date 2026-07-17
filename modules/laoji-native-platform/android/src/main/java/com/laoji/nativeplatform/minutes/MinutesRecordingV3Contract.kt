package com.laoji.nativeplatform.minutes

// MIN-REC-LAYOUT-001: dimensions and responsive widths derived from Record V3.

import kotlin.math.max

internal object MinutesRecordingV3Contract {
  const val TOP_BAR_HEIGHT_DP = 44
  const val TITLE_MIN_HEIGHT_DP = 100
  const val TAB_HEIGHT_DP = 40
  const val BOTTOM_PANEL_HEIGHT_DP = 180
  const val DURATION_HEIGHT_DP = 26
  const val WAVE_CONTAINER_HEIGHT_DP = 56
  const val WAVE_HEIGHT_DP = 32
  const val ACTION_ROW_HEIGHT_DP = 64
  const val ACTION_HEIGHT_DP = 44
  const val ACTION_GAP_DP = 16
  const val ACTION_HORIZONTAL_PADDING_DP = 20
  const val PHONE_ACTION_WIDTH_DP = 78
  const val EXPANDED_ACTION_WIDTH_DP = 108
  const val STATUS_MAX_WIDTH_DP = 174
  const val STATUS_MIN_WIDTH_DP = 142

  data class ActionWidths(
    val statusWidthDp: Int?,
    val actionWidthDp: Int,
  )

  fun actionWidths(screenWidthDp: Int, expanded: Boolean = false): ActionWidths {
    if (expanded || screenWidthDp >= 600) {
      return ActionWidths(statusWidthDp = null, actionWidthDp = EXPANDED_ACTION_WIDTH_DP)
    }
    if (screenWidthDp > 402) {
      return ActionWidths(statusWidthDp = null, actionWidthDp = PHONE_ACTION_WIDTH_DP)
    }

    val statusWidth = max(STATUS_MAX_WIDTH_DP - (402 - screenWidthDp), STATUS_MIN_WIDTH_DP)
    val availableForActions = screenWidthDp -
      (ACTION_HORIZONTAL_PADDING_DP * 2) -
      statusWidth -
      (ACTION_GAP_DP * 2)
    val actionWidth = (availableForActions / 2).coerceIn(60, PHONE_ACTION_WIDTH_DP)
    return ActionWidths(statusWidthDp = statusWidth, actionWidthDp = actionWidth)
  }
}
