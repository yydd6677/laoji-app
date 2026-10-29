package com.laoji.nativeplatform.ui

// UI-SHELL-BOTTOM-MAIN-001: source-derived geometry remains JVM-testable.
object NativeBottomBarContract {
  const val CONTENT_HEIGHT_DP = 65f
  const val DIVIDER_HEIGHT_PX = 1
  const val ICON_SIZE_DP = 22f
  const val ICON_CONTAINER_WIDTH_DP = ICON_SIZE_DP + 16f
  const val ICON_CONTAINER_HEIGHT_DP = ICON_SIZE_DP + 8f
  const val ICON_CONTAINER_TOP_DP = 9f
  const val LABEL_GAP_DP = 5f
  const val LABEL_TOP_DP = ICON_CONTAINER_TOP_DP + ICON_CONTAINER_HEIGHT_DP + LABEL_GAP_DP
  const val LABEL_TEXT_SP = 12f
  const val LABEL_HORIZONTAL_PADDING_DP = 1f
  const val PRESS_SCALE_FROM = 1f
  const val PRESS_SCALE_TO = 0.985f
  const val PRESS_LEG_DURATION_MS = 90L

  fun dpToPx(value: Float, density: Float): Int = (value * density + 0.5f).toInt()

  fun totalHeightPx(contentHeightDp: Float, density: Float, navigationInsetPx: Int): Int =
    DIVIDER_HEIGHT_PX + dpToPx(contentHeightDp, density) + navigationInsetPx.coerceAtLeast(0)
}

// UI-SHELL-BOTTOM-MAIN-001: destination changes replace the approved active
// Expo root, so the newly active root consumes each positive motion command once.
internal class NativeBottomBarSelectionCommandGate {
  private var highWatermark = 0

  fun accept(command: Int?): Boolean {
    if (command == null || command <= 0 || command <= highWatermark) return false
    highWatermark = command
    return true
  }
}
