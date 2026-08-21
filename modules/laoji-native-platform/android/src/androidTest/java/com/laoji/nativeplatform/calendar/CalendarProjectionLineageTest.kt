package com.laoji.nativeplatform.calendar

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.laoji.nativeplatform.projection.ProjectionEnvelope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CalendarProjectionLineageTest {
  @Test
  fun staleEventRevisionKeepsTheProjectionThatProducedIt() {
    val lineage = CalendarProjectionLineage(maximumEntries = 4)
    val old = projection(entityRevision = 1, viewRevision = 1, hash = "a")
    val current = projection(entityRevision = 2, viewRevision = 2, hash = "b")
    val eventV1 = event(revision = 1)
    val eventV2 = event(revision = 2)

    lineage.remember(listOf(eventV1), old)
    lineage.remember(listOf(eventV2), current)

    assertEquals(old, lineage.projectionFor(eventV1))
    assertEquals(current, lineage.projectionFor(eventV2))
  }

  @Test
  fun lineageIsBoundedAndClearable() {
    val lineage = CalendarProjectionLineage(maximumEntries = 1)
    val oldEvent = event(revision = 1)
    val currentEvent = event(revision = 2)
    lineage.remember(listOf(oldEvent), projection(1, 1, "a"))
    lineage.remember(listOf(currentEvent), projection(2, 2, "b"))
    assertNull(lineage.projectionFor(oldEvent))
    lineage.clear()
    assertNull(lineage.projectionFor(currentEvent))
  }

  private fun event(revision: Int) = CalendarEvent(
    sourceEventId = "event-1",
    occurrenceDate = "2026-08-21",
    title = "fixture",
    startEpochDay = 20_321,
    endEpochDay = 20_321,
    startMinutes = 600,
    endMinutes = 660,
    timeZoneId = "Asia/Shanghai",
    allDay = false,
    editable = true,
    revision = revision,
  )

  private fun projection(entityRevision: Int, viewRevision: Int, hash: String) = ProjectionEnvelope(
    deviceEpoch = "epoch-1",
    entityId = "calendar",
    entityRevision = entityRevision.toLong(),
    viewRevision = viewRevision.toLong(),
    surfaceInstanceId = "surface-1",
    payloadSha256 = "sha256:" + hash.repeat(64),
  )
}
