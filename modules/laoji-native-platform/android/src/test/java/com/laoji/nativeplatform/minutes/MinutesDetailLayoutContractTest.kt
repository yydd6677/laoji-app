package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001: source-derived pure layout contract coverage.

import org.junit.Assert.assertEquals
import org.junit.Test

class MinutesDetailLayoutContractTest {
  @Test
  fun `MIN-DETAIL-STICKY-001 upward scroll collapses runtime header before page`() {
    val result = MinutesDetailLayoutContract.consumePreScroll(
      collapseOffsetPx = 12,
      headerHeightPx = 96,
      deltaY = 40,
      childCanScrollUp = true,
    )

    assertEquals(52, result.collapseOffsetPx)
    assertEquals(40, result.consumedY)
  }

  @Test
  fun `MIN-DETAIL-STICKY-001 upward scroll clamps position but consumes the whole source frame`() {
    val result = MinutesDetailLayoutContract.consumePreScroll(
      collapseOffsetPx = 88,
      headerHeightPx = 96,
      deltaY = 40,
      childCanScrollUp = false,
    )

    assertEquals(96, result.collapseOffsetPx)
    assertEquals(40, result.consumedY)
  }

  @Test
  fun `MIN-DETAIL-STICKY-001 forced collapsed header leaves non touch frames to the page`() {
    val result = MinutesDetailLayoutContract.consumePreScroll(
      collapseOffsetPx = 96,
      headerHeightPx = 96,
      deltaY = 40,
      childCanScrollUp = true,
      forceHideTopView = true,
    )

    assertEquals(MinutesDetailLayoutContract.PreScrollResult(96, 0), result)
  }

  @Test
  fun `MIN-DETAIL-STICKY-001 downward scroll waits until active page reaches top`() {
    val blocked = MinutesDetailLayoutContract.consumePreScroll(
      collapseOffsetPx = 60,
      headerHeightPx = 96,
      deltaY = -30,
      childCanScrollUp = true,
    )
    val expanded = MinutesDetailLayoutContract.consumePreScroll(
      collapseOffsetPx = 60,
      headerHeightPx = 96,
      deltaY = -30,
      childCanScrollUp = false,
    )

    assertEquals(MinutesDetailLayoutContract.PreScrollResult(60, 0), blocked)
    assertEquals(MinutesDetailLayoutContract.PreScrollResult(30, -30), expanded)
  }

  @Test
  fun `MIN-DETAIL-STICKY-001 pager height follows visible runtime header`() {
    assertEquals(
      563,
      MinutesDetailLayoutContract.pagerHeightPx(
        stickyHeightPx = 700,
        headerHeightPx = 96,
        collapseOffsetPx = 0,
        tabHeightPx = 41,
      ),
    )
    assertEquals(
      659,
      MinutesDetailLayoutContract.pagerHeightPx(
        stickyHeightPx = 700,
        headerHeightPx = 96,
        collapseOffsetPx = 96,
        tabHeightPx = 41,
      ),
    )
  }

  @Test
  fun `MIN-DETAIL-PAGER-001 maps exactly three supported pages`() {
    assertEquals(44, MinutesDetailLayoutContract.TITLE_BAR_HEIGHT_DP)
    assertEquals(41, MinutesDetailLayoutContract.TAB_BAR_HEIGHT_DP)
    assertEquals(20, MinutesDetailLayoutContract.HEADER_HORIZONTAL_PADDING_DP)
    assertEquals(20, MinutesDetailLayoutContract.HEADER_TOP_PADDING_DP)
    assertEquals(6, MinutesDetailLayoutContract.SUBTITLE_TOP_MARGIN_DP)
    assertEquals(3, MinutesDetailLayoutContract.PAGE_COUNT)
    assertEquals(0, MinutesDetailLayoutContract.tabIndex(MinutesDetailTab.TRANSCRIPT))
    assertEquals(1, MinutesDetailLayoutContract.tabIndex(MinutesDetailTab.SUMMARY))
    assertEquals(2, MinutesDetailLayoutContract.tabIndex(MinutesDetailTab.SPEAKERS))
    assertEquals(MinutesDetailTab.TRANSCRIPT, MinutesDetailLayoutContract.tabAt(99))
  }
}
