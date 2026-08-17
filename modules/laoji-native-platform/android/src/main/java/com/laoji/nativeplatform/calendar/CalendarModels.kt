package com.laoji.nativeplatform.calendar

// CAL-ROOT-001: Bridge snapshots remain independent from Android rendering classes.

enum class CalendarMode(val bridgeValue: String) {
  MONTH("month"),
  DAY("day");

  companion object {
    fun fromBridge(value: String?): CalendarMode =
      entries.firstOrNull { it.bridgeValue == value } ?: MONTH
  }
}

data class CalendarSettings(
  val defaultEventDurationMinutes: Int = 30,
  val firstDayOfWeek: Int = 0
) {
  fun normalized(): CalendarSettings = copy(
    defaultEventDurationMinutes = defaultEventDurationMinutes.coerceIn(5, CalendarDateMath.MINUTES_PER_DAY),
    firstDayOfWeek = 0
  )
}

// CAL-DAY-COMPOSE-001: mirrors Feishu's InstanceLayout payload. Percentages are
// relative to the timed-event surface; a null value means the local fallback
// allocator is used until the source supplies the rectangle.
data class CalendarInstanceLayout(
  val xOffsetPercent: Float,
  val yOffsetPercent: Float,
  val widthPercent: Float,
  val heightPercent: Float,
  val zIndex: Int = 0,
  val fullDisplayWidthPercent: Float? = null,
) {
  fun normalized(): CalendarInstanceLayout {
    val x = xOffsetPercent.coerceIn(0f, 100f)
    val y = yOffsetPercent.coerceIn(0f, 100f)
    return copy(
      xOffsetPercent = x,
      yOffsetPercent = y,
      widthPercent = widthPercent.coerceIn(0f, 100f - x),
      heightPercent = heightPercent.coerceIn(0f, 100f - y),
      fullDisplayWidthPercent = fullDisplayWidthPercent?.coerceIn(0f, 100f),
    )
  }
}

data class CalendarEvent(
  val sourceEventId: String,
  val occurrenceDate: String,
  val title: String,
  val category: String = "其他",
  val startEpochDay: Int,
  val endEpochDay: Int,
  val endEpochDayExclusive: Int? = null,
  val startMinutes: Int?,
  val endMinutes: Int?,
  val timePeriodLabel: String? = null,
  val timeZoneId: String,
  val allDay: Boolean,
  val editable: Boolean,
  val revision: Int,
  val instanceLayout: CalendarInstanceLayout? = null,
) {
  val identity: String
    get() = "$sourceEventId@$occurrenceDate"

  fun normalized(): CalendarEvent {
    val normalizedCategory = CalendarUi.normalizeEventCategory(category)
    if (allDay) {
      val normalizedExclusiveEnd = maxOf(
        startEpochDay + 1,
        endEpochDayExclusive ?: endEpochDay + 1,
      )
      return copy(
        category = normalizedCategory,
        endEpochDay = maxOf(startEpochDay, endEpochDay),
        endEpochDayExclusive = normalizedExclusiveEnd,
        startMinutes = null,
        endMinutes = null,
        instanceLayout = null,
      )
    }

    val normalizedStart = (startMinutes ?: 0).coerceIn(0, CalendarDateMath.MINUTES_PER_DAY - 1)
    val normalizedEndDay = maxOf(startEpochDay, endEpochDay)
    val normalizedEnd = (endMinutes ?: normalizedStart + 30).coerceIn(0, CalendarDateMath.MINUTES_PER_DAY)
    val startAbsolute = CalendarDateMath.absoluteMinute(startEpochDay, normalizedStart)
    val endAbsolute = CalendarDateMath.absoluteMinute(normalizedEndDay, normalizedEnd)
    if (endAbsolute > startAbsolute) {
      return copy(
        category = normalizedCategory,
        endEpochDay = normalizedEndDay,
        endEpochDayExclusive = null,
        startMinutes = normalizedStart,
        endMinutes = normalizedEnd,
        instanceLayout = instanceLayout?.normalized(),
      )
    }

    val fallbackEnd = startAbsolute + 5
    val canonicalEnd = CalendarDateMath.canonicalEnd(fallbackEnd)
    return copy(
      category = normalizedCategory,
      startMinutes = normalizedStart,
      endEpochDay = canonicalEnd.epochDay,
      endEpochDayExclusive = null,
      endMinutes = canonicalEnd.minutes,
      instanceLayout = instanceLayout?.normalized(),
    )
  }

  fun startAbsoluteMinute(): Long {
    val minute = if (allDay) 0 else startMinutes ?: 0
    return CalendarDateMath.absoluteMinute(startEpochDay, minute)
  }

  fun endAbsoluteMinute(): Long {
    if (allDay) {
      return CalendarDateMath.absoluteMinute(
        maxOf(startEpochDay + 1, endEpochDayExclusive ?: endEpochDay + 1),
        0,
      )
    }
    return CalendarDateMath.absoluteMinute(endEpochDay, endMinutes ?: 0)
  }

  fun coveredEndEpochDayExclusive(): Int {
    if (allDay) return maxOf(startEpochDay + 1, endEpochDayExclusive ?: endEpochDay + 1)
    val endMinute = endMinutes ?: 0
    return if (endMinute == 0 && endEpochDay > startEpochDay) {
      endEpochDay
    } else {
      endEpochDay + 1
    }
  }

  fun canMutateInDayView(): Boolean = editable && !allDay && startEpochDay == endEpochDay
}

data class CalendarSnapshot(
  val schemaVersion: Int = 1,
  val generation: Int = 0,
  val rangeStartEpochDay: Int,
  val rangeEndEpochDayExclusive: Int,
  val selectedEpochDay: Int,
  val todayEpochDay: Int,
  val settings: CalendarSettings = CalendarSettings(),
  val events: List<CalendarEvent> = emptyList()
) {
  fun normalized(): CalendarSnapshot {
    val safeRangeEnd = maxOf(rangeStartEpochDay + 1, rangeEndEpochDayExclusive)
    return copy(
      rangeEndEpochDayExclusive = safeRangeEnd,
      selectedEpochDay = selectedEpochDay.coerceIn(rangeStartEpochDay, safeRangeEnd - 1),
      settings = settings.normalized(),
      events = events.map(CalendarEvent::normalized)
    )
  }
}

enum class CalendarMutationKind(val bridgeValue: String) {
  MOVE("move"),
  RESIZE_START("resize-start"),
  RESIZE_END("resize-end");

  companion object {
    fun fromBridge(value: String?): CalendarMutationKind =
      entries.firstOrNull { it.bridgeValue == value } ?: MOVE
  }
}

data class CalendarMutation(
  val operationId: String,
  val kind: CalendarMutationKind,
  val original: CalendarEvent,
  val optimistic: CalendarEvent
)

data class CalendarMutationResolution(
  val operationId: String,
  val accepted: Boolean,
  val replacement: CalendarEvent? = null,
  val message: String? = null
)

enum class CalendarResolutionStatus(val bridgeValue: String) {
  ACK("ack"),
  ROLLBACK("rollback"),
  IGNORED("ignored")
}

data class CalendarResolutionResult(
  val operationId: String,
  val status: CalendarResolutionStatus,
  val event: CalendarEvent?,
  val message: String?
)

data class CalendarDraft(
  val startEpochDay: Int,
  val endEpochDay: Int,
  val startMinutes: Int,
  val endMinutes: Int
) {
  fun startAbsoluteMinute(): Long = CalendarDateMath.absoluteMinute(startEpochDay, startMinutes)

  fun endAbsoluteMinute(): Long = CalendarDateMath.absoluteMinute(endEpochDay, endMinutes)
}

// CAL-PICKER-HOST-001: QuickChoose exposes the same four expansion states as Feishu's panel.
enum class CalendarPickerExpandState {
  CLOSING,
  OPENING,
  CLOSED,
  OPENED,
}

// CAL-PICKER-001: Date/year-month switching keeps both settled and transitional states explicit.
enum class CalendarPickerContentState {
  TO_DATE_PANEL,
  TO_YEAR_MONTH_PANEL,
  DATE_PANEL,
  YEAR_MONTH_PANEL,
}

// CAL-PICKER-001 / CAL-PICKER-HOST-001: state contains only committed date data; there is no draft.
data class CalendarPickerState(
  val expandState: CalendarPickerExpandState,
  val contentState: CalendarPickerContentState,
  val committedEpochDay: Int,
) {
  val isOpen: Boolean
    get() = expandState != CalendarPickerExpandState.CLOSED

  val committedDate: CalendarDateParts
    get() = CalendarDateMath.fromEpochDay(committedEpochDay)

  companion object {
    fun closed(selectedEpochDay: Int): CalendarPickerState = CalendarPickerState(
      expandState = CalendarPickerExpandState.CLOSED,
      contentState = CalendarPickerContentState.DATE_PANEL,
      committedEpochDay = selectedEpochDay,
    )
  }

  fun withCommittedEpochDay(epochDay: Int): CalendarPickerState = copy(committedEpochDay = epochDay)
}

// CAL-PICKER-001: the quick chooser receives only snapshot-backed current-day and event-dot data.
data class CalendarQuickChooseDateData(
  val todayEpochDay: Int?,
  val eventCountByEpochDay: Map<Int, Int>,
) {
  fun eventCount(epochDay: Int): Int = eventCountByEpochDay[epochDay] ?: 0

  companion object {
    val EMPTY = CalendarQuickChooseDateData(todayEpochDay = null, eventCountByEpochDay = emptyMap())
  }
}

// CAL-PICKER-001 / CAL-PICKER-HOST-001: source-derived geometry, timing, and date operations.
object CalendarQuickChooseContract {
  const val MIN_YEAR = 1900
  const val MAX_YEAR = 2100
  const val VISIBLE_WHEEL_ITEMS = 5
  const val WHEEL_ITEM_HEIGHT_DP = 48f
  const val WHEEL_HEIGHT_DP = 240f
  const val WHEEL_VERTICAL_PADDING_DP = 8f
  const val YEAR_MONTH_HEIGHT_DP = 256f
  const val DATE_WEEK_HEADER_HEIGHT_DP = 32f
  const val DATE_ROW_HEIGHT_DP = 38f
  const val DRAG_BAR_HEIGHT_DP = 28f
  const val DRAG_BAR_TOP_MARGIN_DP = 2f
  const val SHADOW_TAIL_HEIGHT_DP = 15f
  const val DIVIDER_HEIGHT_DP = 0.5f
  const val EXPAND_DURATION_MS = 200L
  const val CONTENT_SWITCH_DURATION_MS = 150L
  const val DATE_HEIGHT_DURATION_MS = 100L
  const val DATE_PAGER_ITEM_COUNT = 214_748_364
  const val DATE_PAGER_ANCHOR_POSITION = DATE_PAGER_ITEM_COUNT / 2
  const val WHEEL_INERTIA_TICK_MS = 5L
  const val WHEEL_FLING_DISTANCE_SAMPLE_MS = 10L
  const val WHEEL_MAX_FLING_VELOCITY = 2_000f
  const val WHEEL_STOP_FLING_VELOCITY = 20f
  const val WHEEL_FLING_DECELERATION_PER_TICK = 20f

  fun initialContentState(mode: CalendarMode): CalendarPickerContentState = when (mode) {
    CalendarMode.MONTH -> CalendarPickerContentState.YEAR_MONTH_PANEL
    CalendarMode.DAY -> CalendarPickerContentState.DATE_PANEL
  }

  fun animationDurationMs(currentProgress: Float, targetProgress: Float): Long =
    (kotlin.math.abs(targetProgress.coerceIn(0f, 1f) - currentProgress.coerceIn(0f, 1f)) *
      EXPAND_DURATION_MS).toLong()

  fun translationForProgress(progress: Float, panelHeightPx: Int): Float =
    (progress.coerceIn(0f, 1f) - 1f) * panelHeightPx.coerceAtLeast(0)

  fun progressForTranslation(translationY: Float, panelHeightPx: Int): Float {
    if (panelHeightPx <= 0) return 0f
    return ((translationY.coerceIn(-panelHeightPx.toFloat(), 0f) + panelHeightPx) / panelHeightPx)
      .coerceIn(0f, 1f)
  }

  fun stateForProgress(
    previousProgress: Float,
    nextProgress: Float,
    currentState: CalendarPickerExpandState,
  ): CalendarPickerExpandState {
    val previous = previousProgress.coerceIn(0f, 1f)
    val next = nextProgress.coerceIn(0f, 1f)
    return when {
      next == 0f -> CalendarPickerExpandState.CLOSED
      next == 1f -> CalendarPickerExpandState.OPENED
      next > previous -> CalendarPickerExpandState.OPENING
      next < previous -> CalendarPickerExpandState.CLOSING
      else -> currentState
    }
  }

  fun releaseTarget(
    state: CalendarPickerExpandState,
    movedBeyondTouchSlop: Boolean,
  ): CalendarPickerExpandState {
    if (!movedBeyondTouchSlop) return CalendarPickerExpandState.CLOSED
    return when (state) {
      CalendarPickerExpandState.CLOSING -> CalendarPickerExpandState.CLOSED
      CalendarPickerExpandState.OPENING,
      CalendarPickerExpandState.OPENED -> CalendarPickerExpandState.OPENED
      CalendarPickerExpandState.CLOSED -> CalendarPickerExpandState.CLOSED
    }
  }

  fun datePagerPositionForMonth(monthEpochDay: Int): Int {
    val month = CalendarDateMath.fromEpochDay(CalendarDateMath.monthStart(monthEpochDay))
    val delta = (month.year.toLong() - 2000L) * 12L + month.month - 1L
    return (DATE_PAGER_ANCHOR_POSITION.toLong() + delta)
      .coerceIn(0L, (DATE_PAGER_ITEM_COUNT - 1).toLong())
      .toInt()
  }

  fun datePagerMonthForPosition(position: Int): Int = CalendarDateMath.addMonths(
    CalendarDateMath.toEpochDay(2000, 1, 1),
    position.coerceIn(0, DATE_PAGER_ITEM_COUNT - 1) - DATE_PAGER_ANCHOR_POSITION,
    preserveDay = false,
  )

  fun dateData(snapshot: CalendarSnapshot?): CalendarQuickChooseDateData {
    if (snapshot == null) return CalendarQuickChooseDateData.EMPTY
    val normalized = snapshot.normalized()
    val counts = linkedMapOf<Int, Int>()
    normalized.events.forEach { event ->
      val start = maxOf(normalized.rangeStartEpochDay, event.startEpochDay)
      val endExclusive = minOf(normalized.rangeEndEpochDayExclusive, event.coveredEndEpochDayExclusive())
      for (epochDay in start until endExclusive) {
        counts[epochDay] = (counts[epochDay] ?: 0) + 1
      }
    }
    return CalendarQuickChooseDateData(
      todayEpochDay = normalized.todayEpochDay,
      eventCountByEpochDay = counts.toSortedMap(),
    )
  }

  fun dateContentHeightDp(monthEpochDay: Int): Float =
    DATE_WEEK_HEADER_HEIGHT_DP + CalendarDateMath.monthWeekCount(monthEpochDay) * DATE_ROW_HEIGHT_DP

  fun commitYearMonth(currentEpochDay: Int, year: Int, month: Int): Int {
    val current = CalendarDateMath.fromEpochDay(currentEpochDay)
    val safeYear = year.coerceIn(MIN_YEAR, MAX_YEAR)
    val safeMonth = month.coerceIn(1, 12)
    val safeDay = current.day.coerceAtMost(CalendarDateMath.daysInMonth(safeYear, safeMonth))
    return CalendarDateMath.toEpochDay(safeYear, safeMonth, safeDay)
  }
}

// UI-SHELL-001, UI-MOTION-001: Shell dimensions and motion duration are pure Kotlin test contracts.
object CalendarShellContract {
  const val TITLE_BAR_HEIGHT_DP = 50f
  const val ICON_HIT_SIZE_DP = 40f
  const val FAB_SIZE_DP = 48f
  const val FAB_EDGE_MARGIN_DP = 16f
  // Product interaction retained from the original LaoJi radial-create design.
  const val FAB_GESTURE_SURFACE_DP = 236f
  const val FAB_OPTION_SIZE_DP = 60f
  const val FAB_ARC_RADIUS_DP = 116f
  const val FAB_TARGET_HIT_RADIUS_DP = 42f
  const val FAB_LONG_PRESS_DELAY_MS = 350L
  const val FAB_EXPANSION_DURATION_MS = 180L
  const val FAB_COLLAPSE_DURATION_MS = 120L
  const val FAB_OPEN_ROTATION_DEGREES = 45f
  const val FAB_HOVER_SCALE = 1.12f
  const val FAB_VOICE_OFFSET_X_DP = -98f
  const val FAB_VOICE_OFFSET_Y_DP = -58f
  const val FAB_MANUAL_OFFSET_X_DP = -34f
  const val FAB_MANUAL_OFFSET_Y_DP = -112f
}
