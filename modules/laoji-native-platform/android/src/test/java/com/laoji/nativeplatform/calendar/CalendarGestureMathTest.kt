package com.laoji.nativeplatform.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarGestureMathTest {
  private val event = CalendarEvent(
    sourceEventId = "42",
    occurrenceDate = "2026-07-16",
    title = "评审",
    startEpochDay = CalendarDateMath.toEpochDay(2026, 7, 16),
    endEpochDay = CalendarDateMath.toEpochDay(2026, 7, 16),
    startMinutes = 600,
    endMinutes = 660,
    timeZoneId = "Asia/Shanghai",
    allDay = false,
    editable = true,
    revision = 3,
  )

  @Test
  fun `CAL-DAY-DRAG-001 resolves one owner and snaps contextual precision`() {
    assertEquals(
      CalendarGestureOwner.EVENT_MOVE,
      CalendarGestureMath.resolvePendingOwner(
        CalendarGestureOwner.PENDING_EVENT,
        deltaX = 0f,
        deltaY = 0f,
        touchSlop = 8f,
        longPressActivated = true,
      ),
    )
    assertEquals(15L, CalendarGestureMath.snapDelta(9L, 15))
    assertEquals(30L, CalendarGestureMath.snapDelta(19L, 30))
    assertEquals(30, CalendarGestureMath.precisionForCreation(30, 15))
    assertEquals(15, CalendarGestureMath.precisionForCreation(20, 5))
    assertEquals(15, CalendarGestureMath.precisionForGesture(CalendarMutationKind.MOVE, 60, 30))
    assertEquals(15, CalendarGestureMath.precisionForGesture(CalendarMutationKind.RESIZE_END, 60, 30))
    assertEquals(30, CalendarGestureMath.precisionForGesture(CalendarMutationKind.RESIZE_START, 60, 5))
    assertEquals(15, CalendarGestureMath.precisionForGesture(CalendarMutationKind.RESIZE_START, 20, 30))
  }

  @Test
  fun `CAL-TIME-PRECISION-001 snaps the final absolute time instead of the pointer delta`() {
    val nonGridEvent = event.copy(startMinutes = 607, endMinutes = 667)

    val moved = CalendarGestureMath.projectEvent(
      event = nonGridEvent,
      kind = CalendarMutationKind.MOVE,
      anchorEpochDay = nonGridEvent.startEpochDay,
      anchorMinute = 607f,
      currentEpochDay = nonGridEvent.startEpochDay,
      currentMinute = 617f,
      precisionMinutes = 15,
      minimumDurationMinutes = 30,
    )

    assertEquals(615, moved.startMinutes)
    assertEquals(675, moved.endMinutes)
    assertEquals(60L, moved.endAbsoluteMinute() - moved.startAbsoluteMinute())
  }

  @Test
  fun `CAL-TIME-PRECISION-001 derives start handle precision from default duration not event duration`() {
    val twentyMinuteEvent = event.copy(startMinutes = 600, endMinutes = 620)
    val startPrecision = CalendarGestureMath.precisionForGesture(
      CalendarMutationKind.RESIZE_START,
      defaultDurationMinutes = 30,
      preferredPrecisionMinutes = 5,
    )
    assertEquals(20L, twentyMinuteEvent.endAbsoluteMinute() - twentyMinuteEvent.startAbsoluteMinute())
    assertEquals(30, startPrecision)

    val resized = CalendarGestureMath.projectEvent(
      event = twentyMinuteEvent,
      kind = CalendarMutationKind.RESIZE_START,
      anchorEpochDay = twentyMinuteEvent.startEpochDay,
      anchorMinute = 600f,
      currentEpochDay = twentyMinuteEvent.startEpochDay,
      currentMinute = 570f,
      precisionMinutes = startPrecision,
      minimumDurationMinutes = CalendarGestureMath.minimumDuration(30),
    )
    assertEquals(570, resized.startMinutes)
    assertEquals(620, resized.endMinutes)
    assertEquals(15, CalendarGestureMath.precisionForGesture(CalendarMutationKind.MOVE, 30, 5))
    assertEquals(15, CalendarGestureMath.precisionForGesture(CalendarMutationKind.RESIZE_END, 30, 5))
  }

  @Test
  fun `CAL-TIME-PRECISION-001 caps resize minimum at thirty minutes`() {
    assertEquals(20, CalendarGestureMath.minimumDuration(20))
    assertEquals(30, CalendarGestureMath.minimumDuration(30))
    assertEquals(30, CalendarGestureMath.minimumDuration(60))
    assertEquals(30, CalendarGestureMath.minimumDuration(0))

    val twentyMinuteEvent = event.copy(startMinutes = 600, endMinutes = 620)
    val resized = CalendarGestureMath.projectEvent(
      event = twentyMinuteEvent,
      kind = CalendarMutationKind.RESIZE_START,
      anchorEpochDay = twentyMinuteEvent.startEpochDay,
      anchorMinute = 600f,
      currentEpochDay = twentyMinuteEvent.startEpochDay,
      currentMinute = 610f,
      precisionMinutes = CalendarGestureMath.precisionForGesture(
        CalendarMutationKind.RESIZE_START,
        defaultDurationMinutes = 60,
        preferredPrecisionMinutes = 15,
      ),
      minimumDurationMinutes = CalendarGestureMath.minimumDuration(60),
    )

    assertEquals(590, resized.startMinutes)
    assertEquals(620, resized.endMinutes)
    assertEquals(30L, resized.endAbsoluteMinute() - resized.startAbsoluteMinute())
  }

  @Test
  fun `CAL-TIME-PRECISION-001 projects cross-midnight events and drafts on absolute grid`() {
    val day = event.startEpochDay
    val crossMidnight = event.copy(
      startEpochDay = day,
      endEpochDay = day + 1,
      startMinutes = 1_430,
      endMinutes = 20,
    )
    val moved = CalendarGestureMath.projectEvent(
      event = crossMidnight,
      kind = CalendarMutationKind.MOVE,
      anchorEpochDay = day,
      anchorMinute = 1_430f,
      currentEpochDay = day + 1,
      currentMinute = 5f,
      precisionMinutes = 15,
      minimumDurationMinutes = CalendarGestureMath.minimumDuration(60),
    )

    assertEquals(day + 1, moved.startEpochDay)
    assertEquals(0, moved.startMinutes)
    assertEquals(day + 1, moved.endEpochDay)
    assertEquals(30, moved.endMinutes)
    assertEquals(30L, moved.endAbsoluteMinute() - moved.startAbsoluteMinute())

    val draft = CalendarDraft(day, day + 1, 1_430, 20)
    val resizedDraft = CalendarGestureMath.projectDraft(
      draft = draft,
      kind = CalendarMutationKind.RESIZE_END,
      anchorEpochDay = day + 1,
      anchorMinute = 20f,
      currentEpochDay = day + 1,
      currentMinute = 2f,
      precisionMinutes = 15,
      minimumDurationMinutes = CalendarGestureMath.minimumDuration(60),
    )

    assertEquals(day, resizedDraft.startEpochDay)
    assertEquals(1_430, resizedDraft.startMinutes)
    assertEquals(day + 1, resizedDraft.endEpochDay)
    assertEquals(20, resizedDraft.endMinutes)
    assertEquals(30L, resizedDraft.endAbsoluteMinute() - resizedDraft.startAbsoluteMinute())
  }

  @Test
  fun `CAL-DAY-DRAG-001 mutation ledger acknowledges or rolls back by operation id`() {
    val moved = event.copy(startMinutes = 630, endMinutes = 690)
    val ledger = CalendarMutationLedger()
    assertTrue(ledger.begin(CalendarMutation("op-1", CalendarMutationKind.MOVE, event, moved)))
    assertFalse(ledger.begin(CalendarMutation("op-1", CalendarMutationKind.MOVE, event, moved)))
    assertEquals(moved, ledger.overlay(listOf(event)).single())

    val result = ledger.resolve(CalendarMutationResolution("op-1", accepted = false))
    assertEquals(CalendarResolutionStatus.ROLLBACK, result.status)
    assertEquals(event, result.event)
    assertEquals(event, ledger.overlay(listOf(event)).single())
  }

  @Test
  fun `CAL-ALLDAY-RANGE-001 keeps the inclusive final day through a half-open end`() {
    val start = CalendarDateMath.toEpochDay(2026, 7, 16)
    val end = CalendarDateMath.toEpochDay(2026, 7, 18)
    val allDay = event.copy(
      startEpochDay = start,
      endEpochDay = end,
      endEpochDayExclusive = end + 1,
      startMinutes = null,
      endMinutes = null,
      allDay = true,
    ).normalized()

    assertEquals(end + 1, allDay.coveredEndEpochDayExclusive())
    assertEquals(3L * CalendarDateMath.MINUTES_PER_DAY, allDay.endAbsoluteMinute() - allDay.startAbsoluteMinute())
  }

  @Test
  fun `CAL-DRAG-PERMISSION-001 protects multi-day and read-only events from day mutations`() {
    assertTrue(event.canMutateInDayView())
    assertFalse(event.copy(editable = false).canMutateInDayView())
    assertFalse(event.copy(endEpochDay = event.startEpochDay + 1).canMutateInDayView())
    assertFalse(event.copy(allDay = true, startMinutes = null, endMinutes = null).canMutateInDayView())
  }
}
