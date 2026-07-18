package com.laoji.nativeplatform.calendarpages

// CAL-PICKER-WHEEL-TAP-001 / CAL-REPEAT-RRULE-001: pure source geometry checks.

import kotlin.math.PI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarEditWheelContractTest {
  @Test
  fun `calendar source wheel derives its cylinder from text height`() {
    val geometry = CalendarEditWheelContract.geometry(20f)

    assertEquals(50f, geometry.itemHeightPx, 0.001f)
    assertEquals((50f * 6f * 2f / PI.toFloat()).toInt(), geometry.measuredHeightPx)
    assertEquals(geometry.measuredHeightPx / 2f, geometry.radiusPx, 0.001f)
    assertEquals((geometry.measuredHeightPx - 50f) / 2f, geometry.firstLineY, 0.001f)
    assertEquals((geometry.measuredHeightPx + 50f) / 2f, geometry.secondLineY, 0.001f)
  }

  @Test
  fun `short taps map the visible cylinder row while drag release snaps nearest`() {
    val geometry = CalendarEditWheelContract.geometry(20f)
    val centerOffset = CalendarEditWheelContract.shortTapOffset(
      geometry.measuredHeightPx / 2f,
      0f,
      geometry,
    )
    val nextArc = geometry.itemHeightPx * 4f
    val nextY = geometry.radiusPx - kotlin.math.cos(nextArc / geometry.radiusPx) * geometry.radiusPx
    val nextOffset = CalendarEditWheelContract.shortTapOffset(nextY, 0f, geometry)

    assertEquals(0f, centerOffset, 0.001f)
    assertEquals(geometry.itemHeightPx, nextOffset, 0.001f)
    assertEquals(-10f, CalendarEditWheelContract.nearestSnapOffset(10f, geometry.itemHeightPx), 0.001f)
    assertEquals(10f, CalendarEditWheelContract.nearestSnapOffset(40f, geometry.itemHeightPx), 0.001f)
  }

  @Test
  fun `outer rows use the source 2_2 power fade`() {
    assertEquals(255, CalendarEditWheelContract.outerAlpha(0f))
    assertEquals(0, CalendarEditWheelContract.outerAlpha(90f))
    assertTrue(CalendarEditWheelContract.outerAlpha(45f) in 190..205)
  }
}
