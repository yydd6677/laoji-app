package com.laoji.nativeplatform.calendar

// CAL-DAY-DRAG-001 / CAL-TIME-PRECISION-001: single-day drag projection stays pure Kotlin.

import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.floor

enum class CalendarHitKind {
  EMPTY,
  EVENT,
  EVENT_START_HANDLE,
  EVENT_END_HANDLE,
  DRAFT,
  DRAFT_START_HANDLE,
  DRAFT_END_HANDLE
}

enum class CalendarGestureOwner {
  PENDING_EMPTY,
  PENDING_EVENT,
  SCROLL,
  EVENT_MOVE,
  EVENT_RESIZE_START,
  EVENT_RESIZE_END,
  DRAFT_MOVE,
  DRAFT_RESIZE_START,
  DRAFT_RESIZE_END
}

object CalendarGestureMath {
  fun precisionForGesture(
    kind: CalendarMutationKind,
    defaultDurationMinutes: Int,
  ): Int = when (kind) {
    CalendarMutationKind.MOVE,
    CalendarMutationKind.RESIZE_END -> SOURCE_FIXED_PRECISION_MINUTES
    CalendarMutationKind.RESIZE_START -> sourceDurationPrecision(defaultDurationMinutes)
  }

  fun precisionForCreation(defaultDurationMinutes: Int): Int =
    sourceDurationPrecision(defaultDurationMinutes)

  // AbstractC150857e keeps movement and the end handle on a fixed 15-minute
  // grid. C150854b/C150859g choose 15 or 30 for creation and the start handle
  // from the configured default duration. There is no external precision prop
  // in the Feishu source contract.
  private const val SOURCE_FIXED_PRECISION_MINUTES = 15

  private fun sourceDurationPrecision(defaultDurationMinutes: Int): Int =
    if (defaultDurationMinutes < 30) 15 else 30

  fun minimumDuration(defaultDurationMinutes: Int): Int =
    defaultDurationMinutes.takeIf { it in 1 until 30 } ?: 30

  fun initialOwner(hitKind: CalendarHitKind): CalendarGestureOwner = when (hitKind) {
    CalendarHitKind.EMPTY -> CalendarGestureOwner.PENDING_EMPTY
    CalendarHitKind.EVENT -> CalendarGestureOwner.PENDING_EVENT
    CalendarHitKind.EVENT_START_HANDLE -> CalendarGestureOwner.EVENT_RESIZE_START
    CalendarHitKind.EVENT_END_HANDLE -> CalendarGestureOwner.EVENT_RESIZE_END
    CalendarHitKind.DRAFT -> CalendarGestureOwner.DRAFT_MOVE
    CalendarHitKind.DRAFT_START_HANDLE -> CalendarGestureOwner.DRAFT_RESIZE_START
    CalendarHitKind.DRAFT_END_HANDLE -> CalendarGestureOwner.DRAFT_RESIZE_END
  }

  fun resolvePendingOwner(
    current: CalendarGestureOwner,
    deltaX: Float,
    deltaY: Float,
    touchSlop: Float,
    longPressActivated: Boolean
  ): CalendarGestureOwner {
    if (current == CalendarGestureOwner.PENDING_EVENT && longPressActivated) {
      return CalendarGestureOwner.EVENT_MOVE
    }
    if (current !in setOf(CalendarGestureOwner.PENDING_EMPTY, CalendarGestureOwner.PENDING_EVENT)) {
      return current
    }
    return if (abs(deltaX) > touchSlop || abs(deltaY) > touchSlop) {
      CalendarGestureOwner.SCROLL
    } else {
      current
    }
  }

  fun createDraft(
    epochDay: Int,
    minute: Float,
    defaultDurationMinutes: Int,
    precisionMinutes: Int = 30
  ): CalendarDraft {
    val startMinute = CalendarGeometry.snapMinute(minute, precisionMinutes, SnapMode.FLOOR)
      .coerceAtMost(CalendarDateMath.MINUTES_PER_DAY - 1)
    val duration = defaultDurationMinutes.coerceIn(5, CalendarDateMath.MINUTES_PER_DAY)
    val startAbsolute = CalendarDateMath.absoluteMinute(epochDay, startMinute)
    val end = CalendarDateMath.canonicalEnd(startAbsolute + duration)
    return CalendarDraft(epochDay, end.epochDay, startMinute, end.minutes)
  }

  fun projectEvent(
    event: CalendarEvent,
    kind: CalendarMutationKind,
    anchorEpochDay: Int,
    anchorMinute: Float,
    currentEpochDay: Int,
    currentMinute: Float,
    precisionMinutes: Int,
    minimumDurationMinutes: Int = precisionMinutes,
  ): CalendarEvent {
    val normalized = event.normalized()
    if (normalized.allDay || normalized.startMinutes == null || normalized.endMinutes == null) return normalized
    val precision = CalendarGeometry.normalizePrecision(precisionMinutes)
    val anchorAbsolute = absoluteMinute(anchorEpochDay, anchorMinute)
    val currentAbsolute = absoluteMinute(currentEpochDay, currentMinute)
    val pointerDelta = currentAbsolute - anchorAbsolute
    val originalStart = normalized.startAbsoluteMinute()
    val originalEnd = normalized.endAbsoluteMinute()
    val originalDuration = originalEnd - originalStart
    val minimumDuration = minimumDurationMinutes.coerceAtLeast(1).toLong()

    val projectedStart: Long
    val projectedEnd: Long
    when (kind) {
      CalendarMutationKind.MOVE -> {
        projectedStart = snapAbsoluteMinute(originalStart + pointerDelta, precision)
        projectedEnd = projectedStart + originalDuration
      }
      CalendarMutationKind.RESIZE_START -> {
        projectedStart = snapAbsoluteMinute(originalStart + pointerDelta, precision)
          .coerceAtMost(originalEnd - minimumDuration)
        projectedEnd = originalEnd
      }
      CalendarMutationKind.RESIZE_END -> {
        projectedStart = originalStart
        projectedEnd = snapAbsoluteMinute(originalEnd + pointerDelta, precision)
          .coerceAtLeast(originalStart + minimumDuration)
      }
    }

    val start = CalendarDateMath.canonicalStart(projectedStart)
    val end = CalendarDateMath.canonicalEnd(projectedEnd)
    return normalized.copy(
      startEpochDay = start.epochDay,
      endEpochDay = end.epochDay,
      startMinutes = start.minutes,
      endMinutes = end.minutes
    )
  }

  fun projectDraft(
    draft: CalendarDraft,
    kind: CalendarMutationKind,
    anchorEpochDay: Int,
    anchorMinute: Float,
    currentEpochDay: Int,
    currentMinute: Float,
    precisionMinutes: Int,
    minimumDurationMinutes: Int = precisionMinutes,
  ): CalendarDraft {
    val placeholder = CalendarEvent(
      sourceEventId = "__draft__",
      occurrenceDate = "",
      title = "",
      startEpochDay = draft.startEpochDay,
      endEpochDay = draft.endEpochDay,
      startMinutes = draft.startMinutes,
      endMinutes = draft.endMinutes,
      timeZoneId = "",
      allDay = false,
      editable = true,
      revision = 0
    )
    val projected = projectEvent(
      placeholder,
      kind,
      anchorEpochDay,
      anchorMinute,
      currentEpochDay,
      currentMinute,
      precisionMinutes,
      minimumDurationMinutes,
    )
    return CalendarDraft(
      projected.startEpochDay,
      projected.endEpochDay,
      projected.startMinutes ?: 0,
      projected.endMinutes ?: CalendarDateMath.MINUTES_PER_DAY
    )
  }

  fun snapDelta(deltaMinutes: Long, precisionMinutes: Int): Long {
    val precision = CalendarGeometry.normalizePrecision(precisionMinutes).toLong()
    val sign = if (deltaMinutes < 0L) -1L else 1L
    return ((abs(deltaMinutes) + precision / 2L) / precision) * precision * sign
  }

  fun snapAbsoluteMinute(absoluteMinute: Double, precisionMinutes: Int): Long {
    val precision = CalendarGeometry.normalizePrecision(precisionMinutes).toDouble()
    return (floor(absoluteMinute / precision + 0.5) * precision).toLong()
  }

  private fun absoluteMinute(epochDay: Int, minute: Float): Double =
    epochDay.toDouble() * CalendarDateMath.MINUTES_PER_DAY + minute.toDouble()
}

class CalendarOperationIdGenerator(
  private val prefix: String = "calendar",
  private val clock: () -> Long = System::nanoTime
) {
  private val sequence = AtomicLong(0L)

  fun next(): String = "$prefix-${clock().toString(36)}-${sequence.incrementAndGet().toString(36)}"
}

class CalendarMutationLedger {
  private val pending = linkedMapOf<String, CalendarMutation>()

  fun begin(mutation: CalendarMutation): Boolean {
    if (mutation.operationId.isBlank() || mutation.operationId in pending) return false
    pending[mutation.operationId] = mutation
    return true
  }

  fun pendingOperations(): List<CalendarMutation> = pending.values.toList()

  fun overlay(events: List<CalendarEvent>): List<CalendarEvent> {
    if (pending.isEmpty()) return events
    val optimisticByIdentity = pending.values.associate { it.original.identity to it.optimistic }
    val seen = mutableSetOf<String>()
    val merged = events.map { event ->
      val replacement = optimisticByIdentity[event.identity]
      if (replacement != null) {
        seen += event.identity
        replacement
      } else {
        event
      }
    }.toMutableList()
    pending.values.forEach { operation ->
      if (operation.original.identity !in seen && merged.none { it.identity == operation.original.identity }) {
        merged += operation.optimistic
      }
    }
    return merged
  }

  fun resolve(resolution: CalendarMutationResolution): CalendarResolutionResult {
    val operation = pending.remove(resolution.operationId)
      ?: return CalendarResolutionResult(
        resolution.operationId,
        CalendarResolutionStatus.IGNORED,
        null,
        resolution.message
      )
    return if (resolution.accepted) {
      CalendarResolutionResult(
        resolution.operationId,
        CalendarResolutionStatus.ACK,
        resolution.replacement?.normalized() ?: operation.optimistic,
        resolution.message
      )
    } else {
      CalendarResolutionResult(
        resolution.operationId,
        CalendarResolutionStatus.ROLLBACK,
        operation.original,
        resolution.message
      )
    }
  }

  fun clear(): List<CalendarMutation> {
    val cleared = pending.values.toList()
    pending.clear()
    return cleared
  }
}
