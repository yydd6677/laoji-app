package com.laoji.nativeplatform.calendar

import com.laoji.nativeplatform.projection.ProjectionEnvelope

private data class CalendarEventVersionKey(
  val sourceEventId: String,
  val occurrenceDate: String,
  val revision: Int,
)

/** Bounded provenance retained for gestures that outlive their source snapshot. */
internal class CalendarProjectionLineage(
  private val maximumEntries: Int = 2_048,
) {
  private val projectionByEventVersion = linkedMapOf<CalendarEventVersionKey, ProjectionEnvelope>()

  init {
    require(maximumEntries > 0) { "maximumEntries must be positive" }
  }

  fun remember(events: List<CalendarEvent>, projection: ProjectionEnvelope) {
    events.forEach { event -> projectionByEventVersion[event.versionKey()] = projection }
    while (projectionByEventVersion.size > maximumEntries) {
      projectionByEventVersion.remove(projectionByEventVersion.keys.first())
    }
  }

  fun projectionFor(event: CalendarEvent): ProjectionEnvelope? =
    projectionByEventVersion[event.versionKey()]

  fun clear() {
    projectionByEventVersion.clear()
  }

  private fun CalendarEvent.versionKey(): CalendarEventVersionKey = CalendarEventVersionKey(
    sourceEventId = sourceEventId,
    occurrenceDate = occurrenceDate,
    revision = revision,
  )
}
