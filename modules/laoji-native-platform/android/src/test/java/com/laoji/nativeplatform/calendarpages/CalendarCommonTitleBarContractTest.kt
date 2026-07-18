package com.laoji.nativeplatform.calendarpages

// UI-TITLE-COMMON-001: expectations are derived from CommonTitleBar measure/layout
// and calendar SaveType source contracts, not from the previous LaoJi title bar.

import org.junit.Assert.assertEquals
import org.junit.Test

class CalendarCommonTitleBarContractTest {
  @Test
  fun sourceDimensionsAndTypographyRemainDistinct() {
    assertEquals(44f, CalendarCommonTitleBarContract.FULL_SCREEN_HEIGHT_DP)
    assertEquals(56f, CalendarCommonTitleBarContract.BOTTOM_SHEET_HEIGHT_DP)
    assertEquals(18f, CalendarCommonTitleBarContract.MAIN_TITLE_SP)
    assertEquals(17f, CalendarCommonTitleBarContract.ACTION_TEXT_SP)
    assertEquals(24f, CalendarCommonTitleBarContract.NORMAL_ICON_DP)
    assertEquals(20f, CalendarCommonTitleBarContract.SMALL_ICON_DP)
    assertEquals(48f, CalendarCommonTitleBarContract.NORMAL_RIGHT_SLOT_DP)
    assertEquals(44f, CalendarCommonTitleBarContract.SMALL_RIGHT_SLOT_DP)
    assertEquals(15f, CalendarCommonTitleBarContract.RIGHT_ACTION_END_PADDING_DP)
    assertEquals(1, CalendarCommonTitleBarContract.DIVIDER_HEIGHT_PX)
    assertEquals(116, CalendarCommonTitleBarContract.dpToPx(44f, 2.625f))
    assertEquals(24, CalendarCommonTitleBarContract.dpToPx(9f, 2.625f))
    assertEquals(23, CalendarCommonTitleBarContract.dpToPx(15f, 1.5f))
  }

  @Test
  fun defaultModeKeepsPhysicalCenterWhenMeasuredSidesLeaveRoom() {
    assertEquals(
      CalendarCommonTitleBarContract.CenterBounds(130, 230),
      CalendarCommonTitleBarContract.centerBounds(
        totalWidth = 360,
        measuredCenterWidth = 100,
        leftVisibleWidth = 54,
        rightVisibleWidth = 72,
        minSidePadding = 8,
      ),
    )
  }

  @Test
  fun defaultModeShiftsOnlyAfterMeasuredSideCollision() {
    assertEquals(
      CalendarCommonTitleBarContract.CenterBounds(88, 252),
      CalendarCommonTitleBarContract.centerBounds(
        totalWidth = 360,
        measuredCenterWidth = 164,
        leftVisibleWidth = 80,
        rightVisibleWidth = 100,
        minSidePadding = 8,
      ),
    )
  }

  @Test
  fun centerAlwaysUsesTheLargerMeasuredSideSymmetrically() {
    assertEquals(
      CalendarCommonTitleBarContract.CenterBounds(108, 252),
      CalendarCommonTitleBarContract.centerBounds(
        totalWidth = 360,
        measuredCenterWidth = 80,
        leftVisibleWidth = 60,
        rightVisibleWidth = 100,
        minSidePadding = 8,
        centerAlways = true,
      ),
    )
  }

  @Test
  fun leftAlignModeBeginsAfterTheMeasuredLeadingOwner() {
    assertEquals(
      CalendarCommonTitleBarContract.CenterBounds(68, 148),
      CalendarCommonTitleBarContract.centerBounds(
        totalWidth = 360,
        measuredCenterWidth = 80,
        leftVisibleWidth = 60,
        rightVisibleWidth = 100,
        minSidePadding = 8,
        leftAligned = true,
      ),
    )
  }

  @Test
  fun calendarSaveStateDoesNotInventASavingActionLabel() {
    assertEquals(
      CalendarTitleSaveType.DISABLE_SAVE_TOTALLY,
      CalendarTitleSaveContract.resolve(CalendarPageLoadState.READY, saving = true, draftValid = true),
    )
    assertEquals(
      CalendarTitleSaveType.DISABLE_SAVE_WITH_FEEDBACK,
      CalendarTitleSaveContract.resolve(CalendarPageLoadState.READY, saving = false, draftValid = false),
    )
    assertEquals(
      CalendarTitleSaveType.ENABLE_SAVE,
      CalendarTitleSaveContract.resolve(CalendarPageLoadState.READY, saving = false, draftValid = true),
    )
  }

  @Test
  fun eachCalendarTitleActionRejectsClicksWithinOneSecond() {
    var now = 2_000L
    var accepted = 0
    val gate = CalendarTitleClickGate { now }

    assertEquals(true, gate.run { accepted += 1 })
    now += 1_000L
    assertEquals(false, gate.run { accepted += 1 })
    now += 1L
    assertEquals(true, gate.run { accepted += 1 })
    assertEquals(2, accepted)
  }
}
