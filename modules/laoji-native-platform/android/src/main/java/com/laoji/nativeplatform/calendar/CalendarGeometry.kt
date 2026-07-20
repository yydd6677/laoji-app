package com.laoji.nativeplatform.calendar

// CAL-DAY-COMPOSE-001: Month spans and timed overlaps use deterministic, JVM-testable
// fallback allocation while the production layout remains an explicit InstanceLayout input.

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

data class CalendarRect(
  val left: Float,
  val top: Float,
  val right: Float,
  val bottom: Float
) {
  val width: Float get() = right - left
  val height: Float get() = bottom - top

  fun contains(x: Float, y: Float): Boolean = x >= left && x <= right && y >= top && y <= bottom
}

data class MonthEventSegment(
  val event: CalendarEvent,
  val weekIndex: Int,
  val startColumn: Int,
  val endColumn: Int,
  val lane: Int,
  val startsBeforeSegment: Boolean,
  val continuesAfterSegment: Boolean
)

data class DayEventSegment(
  val event: CalendarEvent,
  val startMinute: Int,
  val endMinute: Int,
  val column: Int,
  val columnCount: Int,
  val columnSpan: Int = 1,
  val instanceLayout: CalendarInstanceLayout? = null,
  val startsBeforeDay: Boolean,
  val continuesAfterDay: Boolean
)

object CalendarGeometry {
  fun minuteToY(minute: Int, timelineTop: Float, hourHeight: Float): Float =
    timelineTop + minute.coerceIn(0, CalendarDateMath.MINUTES_PER_DAY) * hourHeight / 60f

  fun yToMinute(y: Float, timelineTop: Float, hourHeight: Float): Float =
    ((y - timelineTop) * 60f / hourHeight).coerceIn(0f, CalendarDateMath.MINUTES_PER_DAY.toFloat())

  fun snapMinute(minute: Float, precisionMinutes: Int, mode: SnapMode = SnapMode.NEAREST): Int {
    val precision = normalizePrecision(precisionMinutes)
    val units = minute / precision
    val snapped = when (mode) {
      SnapMode.FLOOR -> floor(units).toInt()
      SnapMode.NEAREST -> units.roundToInt()
      SnapMode.CEIL -> ceil(units).toInt()
    }
    return (snapped * precision).coerceIn(0, CalendarDateMath.MINUTES_PER_DAY)
  }

  fun normalizePrecision(precisionMinutes: Int): Int = when (precisionMinutes) {
    5, 15, 30 -> precisionMinutes
    in Int.MIN_VALUE..9 -> 5
    in 10..22 -> 15
    else -> 30
  }

  // CAL-MONTH-SPAN-001: C155132d clips each instance to its seven-day matrix,
  // takes the first free row at the start column, and occupies that row for the
  // complete clipped width before the Canvas formula maps column/width to one rect.
  fun monthSegments(
    events: List<CalendarEvent>,
    gridStartEpochDay: Int,
    weekCount: Int
  ): List<MonthEventSegment> {
    val gridEnd = gridStartEpochDay + weekCount.coerceIn(1, 6) * 7
    val unassigned = buildList {
      events.forEach { source ->
        val event = source.normalized()
        val visibleStart = maxOf(event.startEpochDay, gridStartEpochDay)
        val visibleEnd = minOf(event.coveredEndEpochDayExclusive(), gridEnd)
        if (visibleStart >= visibleEnd) return@forEach

        var cursor = visibleStart
        while (cursor < visibleEnd) {
          val week = (cursor - gridStartEpochDay) / 7
          val weekEnd = minOf(gridStartEpochDay + (week + 1) * 7, visibleEnd)
          add(
            MonthEventSegment(
              event = event,
              weekIndex = week,
              startColumn = (cursor - gridStartEpochDay) % 7,
              endColumn = (weekEnd - 1 - gridStartEpochDay) % 7,
              lane = -1,
              startsBeforeSegment = cursor > event.startEpochDay,
              continuesAfterSegment = weekEnd < event.coveredEndEpochDayExclusive()
            )
          )
          cursor = weekEnd
        }
      }
    }.sortedWith(
      compareBy<MonthEventSegment> { it.weekIndex }
        .thenBy { it.startColumn }
        .thenByDescending { it.endColumn - it.startColumn }
        .thenBy { it.event.identity }
    )

    val laneEndsByWeek = mutableMapOf<Int, MutableList<Int>>()
    return unassigned.map { segment ->
      val laneEnds = laneEndsByWeek.getOrPut(segment.weekIndex) { mutableListOf() }
      val freeLane = laneEnds.indexOfFirst { it < segment.startColumn }
      val lane = if (freeLane >= 0) {
        laneEnds[freeLane] = segment.endColumn
        freeLane
      } else {
        laneEnds += segment.endColumn
        laneEnds.lastIndex
      }
      segment.copy(lane = lane)
    }
  }

  fun daySegments(events: List<CalendarEvent>, epochDay: Int): List<DayEventSegment> {
    val raw = events.asSequence()
      .map(CalendarEvent::normalized)
      .filter { !it.allDay && epochDay in it.startEpochDay until it.coveredEndEpochDayExclusive() }
      .mapNotNull { event ->
        val start = if (epochDay == event.startEpochDay) event.startMinutes ?: 0 else 0
        val end = if (epochDay == event.endEpochDay) event.endMinutes ?: 0 else CalendarDateMath.MINUTES_PER_DAY
        if (end <= start) null else DayEventSegment(
          event = event,
          startMinute = start,
          endMinute = end,
          column = -1,
          columnCount = 1,
          instanceLayout = event.instanceLayout,
          startsBeforeDay = event.startEpochDay < epochDay,
          continuesAfterDay = event.coveredEndEpochDayExclusive() > epochDay + 1
        )
      }
      .sortedWith(
        compareBy<DayEventSegment> { it.startMinute }
          .thenByDescending { it.endMinute }
          .thenBy { it.event.identity }
      )
      .toList()

    if (raw.isEmpty()) return emptyList()
    val output = mutableListOf<DayEventSegment>()
    var cluster = mutableListOf<DayEventSegment>()
    var clusterEnd = -1

    fun flushCluster() {
      if (cluster.isEmpty()) return
      val laneEnds = mutableListOf<Int>()
      val assigned = cluster.map { segment ->
        val freeLane = laneEnds.indexOfFirst { it <= segment.startMinute }
        val lane = if (freeLane >= 0) {
          laneEnds[freeLane] = segment.endMinute
          freeLane
        } else {
          laneEnds += segment.endMinute
          laneEnds.lastIndex
        }
        segment.copy(column = lane)
      }
      val count = laneEnds.size.coerceAtLeast(1)
      // The Rust layout returns an independent rectangle for every instance.
      // A later event may use columns freed by an earlier one, so a single
      // cluster-wide width would leave visible empty space at the tail.
      output += assigned.map { segment ->
        val span = (segment.column until count)
          .takeWhile { lane ->
            assigned.none { other ->
              other.column == lane &&
                other.event.identity != segment.event.identity &&
                other.startMinute < segment.endMinute &&
                other.endMinute > segment.startMinute
            }
          }
          .count()
          .coerceAtLeast(1)
        segment.copy(columnCount = count, columnSpan = span)
      }
      cluster = mutableListOf()
      clusterEnd = -1
    }

    raw.forEach { segment ->
      if (cluster.isNotEmpty() && segment.startMinute >= clusterEnd) flushCluster()
      cluster += segment
      clusterEnd = maxOf(clusterEnd, segment.endMinute)
    }
    flushCluster()
    return output
  }

  fun visibleAllDayEvents(events: List<CalendarEvent>, epochDay: Int): List<CalendarEvent> =
    events.asSequence()
      .map(CalendarEvent::normalized)
      .filter { it.allDay && epochDay in it.startEpochDay until it.coveredEndEpochDayExclusive() }
      .sortedWith(
        compareBy<CalendarEvent> { it.startEpochDay }
          .thenByDescending { it.coveredEndEpochDayExclusive() }
          .thenBy { it.title }
          .thenBy { it.identity }
      )
      .toList()
}

// CAL-MONTH-001: Tests assert three pages, center index one, and a bounded one-month settlement delta.
object MonthPagerContract {
  const val PAGE_COUNT = 3
  const val CENTER_PAGE = 1

  fun monthDeltaForSettledPage(position: Int): Int =
    (position.coerceIn(0, PAGE_COUNT - 1) - CENTER_PAGE).coerceIn(-1, 1)
}

enum class SnapMode {
  FLOOR,
  NEAREST,
  CEIL
}
