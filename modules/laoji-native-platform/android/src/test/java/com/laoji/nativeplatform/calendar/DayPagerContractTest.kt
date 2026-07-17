package com.laoji.nativeplatform.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DayPagerContractTest {
  private val epochDay = CalendarDateMath.toEpochDay(2026, 7, 17)

  @Test
  fun `CAL-DAY-PAGER-001 binds exactly left center and right at one-day offsets`() {
    assertEquals(3, DayPagerContract.PAGE_COUNT)
    assertEquals(1, DayPagerContract.CENTER_PAGE)
    assertEquals(
      listOf(epochDay - 1, epochDay, epochDay + 1),
      DayPagerContract.pageSlots.map { slot ->
        DayPagerContract.epochDayForPosition(epochDay, slot.position)
      },
    )
  }

  @Test
  fun `CAL-DAY-PAGER-001 settles one day and always returns to center`() {
    val previous = DayPagerContract.settle(epochDay, DayPageSlot.LEFT.position)
    val current = DayPagerContract.settle(epochDay, DayPageSlot.CENTER.position)
    val next = DayPagerContract.settle(epochDay, DayPageSlot.RIGHT.position)

    assertEquals(-1, previous.dayDelta)
    assertEquals(epochDay - 1, previous.nextCenterEpochDay)
    assertEquals(0, current.dayDelta)
    assertEquals(epochDay, current.nextCenterEpochDay)
    assertEquals(1, next.dayDelta)
    assertEquals(epochDay + 1, next.nextCenterEpochDay)
    assertTrue(listOf(previous, current, next).all { it.resetPosition == DayPagerContract.CENTER_PAGE })
  }

  @Test
  fun `CAL-DAY-PAGER-001 maps continuous ViewPager positions around the center`() {
    assertEquals(-1f, DayPagerContract.positionProgress(0, 0f), 0f)
    assertEquals(-0.5f, DayPagerContract.positionProgress(0, 0.5f), 0f)
    assertEquals(0f, DayPagerContract.positionProgress(1, 0f), 0f)
    assertEquals(0.5f, DayPagerContract.positionProgress(1, 0.5f), 0f)
    assertEquals(1f, DayPagerContract.positionProgress(2, 0f), 0f)
  }

  @Test
  fun `CAL-DAY-PAGER-001 clamps distant programmatic motion to the target-adjacent page for 300ms`() {
    assertEquals(300L, DayPagerContract.PROGRAMMATIC_DAY_SWITCH_DURATION_MS)
    assertEquals(250L, DayPagerContract.PROGRAMMATIC_VERTICAL_SCROLL_DURATION_MS)
    assertTrue(DayPagerContract.shouldAnimateProgrammaticSwitch(epochDay, epochDay + 1))
    assertTrue(DayPagerContract.shouldAnimateProgrammaticSwitch(epochDay, epochDay - 1))
    assertTrue(DayPagerContract.shouldAnimateProgrammaticSwitch(epochDay, epochDay + 2))
    assertEquals(DayPageSlot.LEFT.position, DayPagerContract.programmaticStartPosition(epochDay, epochDay + 1))
    assertEquals(DayPageSlot.RIGHT.position, DayPagerContract.programmaticStartPosition(epochDay, epochDay - 1))
    assertEquals(DayPageSlot.LEFT.position, DayPagerContract.programmaticStartPosition(epochDay, epochDay + 2))
    assertEquals(DayPageSlot.RIGHT.position, DayPagerContract.programmaticStartPosition(epochDay, epochDay - 2))
    val futureTarget = epochDay + 3
    val pastTarget = epochDay - 3
    assertEquals(
      futureTarget - 1,
      DayPagerContract.epochDayForPosition(
        futureTarget,
        DayPagerContract.programmaticStartPosition(epochDay, futureTarget),
      ),
    )
    assertEquals(
      pastTarget + 1,
      DayPagerContract.epochDayForPosition(
        pastTarget,
        DayPagerContract.programmaticStartPosition(epochDay, pastTarget),
      ),
    )
  }

  @Test
  fun `CAL-DAY-PAGER-001 rejects positions that could skip multiple days`() {
    listOf(-1, 3, Int.MAX_VALUE).forEach { invalidPosition ->
      try {
        DayPagerContract.settle(epochDay, invalidPosition)
        fail("Expected position $invalidPosition to be rejected")
      } catch (_: IllegalArgumentException) {
        // Expected: a three-page pager has no integer-position escape hatch.
      }
    }
  }

  @Test
  fun `CAL-DAY-PAGER-001 keeps page callbacks inside session and date ownership`() {
    val binding = DayPageBinding(sessionId = 9L, epochDay = epochDay)

    assertTrue(binding.accepts(9L, epochDay))
    assertFalse(binding.accepts(8L, epochDay))
    assertFalse(binding.accepts(9L, epochDay + 1))
    assertNotEquals(binding, DayPageBinding(10L, epochDay))
  }

  @Test
  fun `CAL-DAY-PAGER-001 exposes separate composition and timeline owners`() {
    assertEquals(
      listOf(
        SingleDayCompositionOwner.DATE_HEADER,
        SingleDayCompositionOwner.ALL_DAY_SECTION,
        SingleDayCompositionOwner.THREE_PAGE_PAGER,
      ),
      DayPagerContract.compositionOwners,
    )
    assertEquals(
      listOf(DayTimelineOwner.TIMELINE_CANVAS, DayTimelineOwner.GESTURE_LAYER),
      DayPagerContract.timelineOwners,
    )
    assertEquals(2, DayPagerContract.timelineOwners.toSet().size)
    assertEquals(5, DayPagerContract.compositionOwners.size + DayPagerContract.timelineOwners.size)
  }

  @Test
  fun `CAL-DAY-PAGER-001 draws 25 hour boundaries with 12 and 24 hour edge labels`() {
    assertEquals((0..24).toList(), DayPagerContract.hourLines().toList())
    assertEquals(25, DayPagerContract.hourLines().count())

    assertEquals("00:00", DayPagerContract.hourLabel(0, is24Hour = true))
    assertEquals("12:00", DayPagerContract.hourLabel(12, is24Hour = true))
    assertEquals("24:00", DayPagerContract.hourLabel(24, is24Hour = true))
    assertEquals("12 AM", DayPagerContract.hourLabel(0, is24Hour = false))
    assertEquals("12 PM", DayPagerContract.hourLabel(12, is24Hour = false))
    assertEquals("12 AM", DayPagerContract.hourLabel(24, is24Hour = false))
  }

  @Test
  fun `CAL-DAY-PAGER-001 uses the source timeline geometry without half-hour lines`() {
    assertEquals(1_236f, DayPagerContract.TIMELINE_TOTAL_HEIGHT_DP, 0f)
    assertEquals(16f, DayPagerContract.TIMELINE_PADDING_TOP_DP, 0f)
    assertEquals(3f, DayPagerContract.TIMELINE_PADDING_RIGHT_DP, 0f)
    assertEquals(20f, DayPagerContract.TIMELINE_PADDING_BOTTOM_DP, 0f)
    assertEquals(56f, DayPagerContract.RULER_WIDTH_DP, 0f)
    assertEquals(50f, DayPagerContract.HOUR_HEIGHT_DP, 0f)
    assertEquals(16f, DayPagerContract.hourLineOffsetDp(0), 0f)
    assertEquals(41f, DayPagerContract.minuteToTimelineOffsetDp(30), 0f)
    assertEquals(66f, DayPagerContract.minuteToTimelineOffsetDp(60), 0f)
    assertEquals(30f, DayPagerContract.timelineOffsetDpToMinute(41f), 0f)
    assertEquals(1_216f, DayPagerContract.hourLineOffsetDp(24), 0f)
    assertEquals(
      DayPagerContract.TIMELINE_TOTAL_HEIGHT_DP,
      DayPagerContract.hourLineOffsetDp(24) + DayPagerContract.TIMELINE_PADDING_BOTTOM_DP,
      0f,
    )
    assertEquals(25, DayPagerContract.hourLines().map(DayPagerContract::hourLineOffsetDp).size)
  }

  @Test
  fun `UI-SHELL-RESELECT-001 centers the current minute within timeline bounds`() {
    assertEquals(316f, DayPagerContract.centeredTimelineOffsetDp(720, 600f), 0f)
    assertEquals(0f, DayPagerContract.centeredTimelineOffsetDp(0, 600f), 0f)
    assertEquals(636f, DayPagerContract.centeredTimelineOffsetDp(1_440, 600f), 0f)
  }

  @Test
  fun `CAL-DAY-PAGER-001 exposes one event-only accessibility provider with screen bounds`() {
    val timed = event(editable = true)
    val allDay = timed.copy(
      sourceEventId = "all-day",
      allDay = true,
      startMinutes = null,
      endMinutes = null,
    )

    assertEquals(1, DayPagerContract.ACCESSIBILITY_PROVIDER_COUNT)
    assertEquals(
      listOf(timed.identity),
      DayTimelineAccessibilityContract.virtualEventIdentities(listOf(timed, allDay), epochDay),
    )
    assertTrue(DayTimelineAccessibilityContract.virtualEventIdentities(emptyList(), epochDay).isEmpty())
    assertEquals(
      CalendarRect(156f, 224f, 356f, 274f),
      DayTimelineAccessibilityContract.screenBounds(
        contentBounds = CalendarRect(56f, 324f, 256f, 374f),
        scrollOffset = 300f,
        hostScreenX = 100f,
        hostScreenY = 200f,
      ),
    )
  }

  @Test
  fun `CAL-TIME-PRECISION-001 uses one formatter for ruler event and draft boundaries`() {
    assertEquals(
      DayPagerContract.hourLabel(24, is24Hour = true),
      DayTimeFormatter.formatMinute(1_440, is24Hour = true),
    )
    assertEquals("23:00-24:00", DayTimeFormatter.formatRange(1_380, 1_440, is24Hour = true))
    assertEquals(
      DayPagerContract.hourLabel(0, is24Hour = false),
      DayTimeFormatter.formatMinute(0, is24Hour = false),
    )
    assertEquals("12 AM-12:30 AM", DayTimeFormatter.formatRange(0, 30, is24Hour = false))
  }

  @Test
  fun `CAL-TIME-PRECISION-001 creates 30 minutes and adjusts on passed 15-minute precision`() {
    val draft = DayPagerContract.createThirtyMinuteDraft(epochDay, minute = 644f)

    assertEquals(630, draft.startMinutes)
    assertEquals(660, draft.endMinutes)
    assertEquals(
      30L,
      draft.endAbsoluteMinute() - draft.startAbsoluteMinute(),
    )
    val finalSlot = DayPagerContract.createThirtyMinuteDraft(epochDay, minute = 1_440f)
    assertEquals(epochDay, finalSlot.startEpochDay)
    assertEquals(epochDay, finalSlot.endEpochDay)
    assertEquals(1_410, finalSlot.startMinutes)
    assertEquals(1_440, finalSlot.endMinutes)
    assertEquals(
      15,
      DayPagerContract.adjustmentPrecision(CalendarMutationKind.MOVE, defaultDurationMinutes = 30),
    )
    assertEquals(
      15,
      DayPagerContract.adjustmentPrecision(CalendarMutationKind.RESIZE_END, defaultDurationMinutes = 60),
    )
    assertEquals(
      15,
      DayPagerContract.adjustmentPrecision(
        CalendarMutationKind.RESIZE_START,
        defaultDurationMinutes = 20,
        preferredPrecisionMinutes = 5,
      ),
    )
    assertEquals(
      30,
      DayPagerContract.adjustmentPrecision(
        CalendarMutationKind.RESIZE_START,
        defaultDurationMinutes = 30,
        preferredPrecisionMinutes = 5,
      ),
    )
    assertEquals(15, CalendarGestureMath.precisionForCreation(20, 5))
    assertEquals(30, CalendarGestureMath.precisionForCreation(30, 5))

    val moved = CalendarGestureMath.projectDraft(
      draft = draft,
      kind = CalendarMutationKind.MOVE,
      anchorEpochDay = epochDay,
      anchorMinute = 644f,
      currentEpochDay = epochDay,
      currentMinute = 653f,
      precisionMinutes = DayPagerContract.adjustmentPrecision(
        CalendarMutationKind.MOVE,
        defaultDurationMinutes = 30,
      ),
      minimumDurationMinutes = DayPagerContract.minimumDuration(30),
    )
    assertEquals(645, moved.startMinutes)
    assertEquals(675, moved.endMinutes)
  }

  @Test
  fun `CAL-TIME-PRECISION-001 creates drafts with the snapshot default duration`() {
    val draft = DayPagerContract.createDraft(epochDay, minute = 644f, defaultDurationMinutes = 45)

    assertEquals(630, draft.startMinutes)
    assertEquals(675, draft.endMinutes)
    assertEquals(45L, draft.endAbsoluteMinute() - draft.startAbsoluteMinute())
  }

  @Test
  fun `CAL-DAY-DRAG-001 excludes cross-day all-day and read-only events`() {
    val mutableEvent = event(editable = true)
    assertTrue(mutableEvent.canMutateInDayView())
    assertFalse(mutableEvent.copy(editable = false).canMutateInDayView())
    assertFalse(mutableEvent.copy(endEpochDay = epochDay + 1).canMutateInDayView())
    assertFalse(
      mutableEvent.copy(
        allDay = true,
        startMinutes = null,
        endMinutes = null,
      ).canMutateInDayView(),
    )
  }

  private fun event(editable: Boolean): CalendarEvent = CalendarEvent(
    sourceEventId = "day-contract",
    occurrenceDate = "2026-07-17",
    title = "合同评审",
    startEpochDay = epochDay,
    endEpochDay = epochDay,
    startMinutes = 600,
    endMinutes = 660,
    timeZoneId = "Asia/Shanghai",
    allDay = false,
    editable = editable,
    revision = 1,
  )
}
