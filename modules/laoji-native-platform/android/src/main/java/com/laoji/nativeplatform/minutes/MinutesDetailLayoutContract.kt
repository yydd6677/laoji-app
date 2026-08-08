package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001: source-derived detail geometry and scroll rules.

internal object MinutesDetailLayoutContract {
  const val TITLE_BAR_HEIGHT_DP = 44
  const val TAB_BAR_HEIGHT_DP = 41
  const val RECORDING_SELECTOR_HEIGHT_DP = 44
  const val STATUS_SLOT_HEIGHT_DP = 44
  const val TAB_MIN_WIDTH_DP = 60
  const val TAB_HORIZONTAL_PADDING_DP = 10
  const val TAB_INDICATOR_HEIGHT_DP = 2
  const val TAB_DIVIDER_LEFT_MARGIN_DP = 20
  const val TAB_DIVIDER_RIGHT_MARGIN_DP = 10
  const val HEADER_HORIZONTAL_PADDING_DP = 20
  const val HEADER_TOP_PADDING_DP = 20
  const val HEADER_BOTTOM_PADDING_DP = 16
  const val SUBTITLE_TOP_MARGIN_DP = 6
  const val PAGE_COUNT = 5

  data class PreScrollResult(
    val collapseOffsetPx: Int,
    val consumedY: Int,
  )

  fun consumePreScroll(
    collapseOffsetPx: Int,
    headerHeightPx: Int,
    deltaY: Int,
    childCanScrollUp: Boolean,
    forceHideTopView: Boolean = false,
  ): PreScrollResult {
    val headerHeight = headerHeightPx.coerceAtLeast(0)
    val offset = collapseOffsetPx.coerceIn(0, headerHeight)
    if (forceHideTopView && offset >= headerHeight) {
      return PreScrollResult(offset, 0)
    }
    if (deltaY > 0 && offset < headerHeight) {
      return PreScrollResult((offset + deltaY).coerceAtMost(headerHeight), deltaY)
    }
    if (deltaY < 0 && offset >= 0 && !childCanScrollUp) {
      return PreScrollResult((offset + deltaY).coerceAtLeast(0), deltaY)
    }
    return PreScrollResult(offset, 0)
  }

  fun pagerHeightPx(
    stickyHeightPx: Int,
    tabHeightPx: Int,
    statusHeightPx: Int = 0,
    selectionHeightPx: Int = 0,
  ): Int {
    // The page keeps its fully-collapsed viewport height throughout a gesture.
    // The parent clips the covered portion while the header is visible. This
    // avoids remeasuring RecyclerView/ViewPager on every collapse offset.
    return (
      stickyHeightPx -
        tabHeightPx.coerceAtLeast(0) -
        statusHeightPx.coerceAtLeast(0) -
        selectionHeightPx.coerceAtLeast(0)
    ).coerceAtLeast(0)
  }

  fun tabIndex(tab: MinutesDetailTab): Int = MinutesDetailTab.entries.indexOf(tab).coerceAtLeast(0)

  fun tabAt(index: Int): MinutesDetailTab = MinutesDetailTab.entries.getOrElse(index) {
    MinutesDetailTab.NOTES
  }
}
