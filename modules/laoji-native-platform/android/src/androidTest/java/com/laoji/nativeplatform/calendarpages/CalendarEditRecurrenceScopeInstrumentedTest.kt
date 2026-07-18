package com.laoji.nativeplatform.calendarpages

import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.laoji.nativeplatform.evidence.FeishuEvidence
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@FeishuEvidence("CAL-REPEAT-RRULE-001")
class CalendarEditRecurrenceScopeInstrumentedTest {
  @Test
  fun recurrenceRowsFollowTheSourceNormalOccurrenceAndExceptionMatrix() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      listOf(
        ScopeCase(null, recurrenceException = false, View.GONE, editable = false),
        ScopeCase("occurrence", recurrenceException = false, View.VISIBLE, editable = false),
        ScopeCase("occurrence", recurrenceException = true, View.GONE, editable = false),
        ScopeCase("following", recurrenceException = false, View.VISIBLE, editable = true),
        ScopeCase("series", recurrenceException = false, View.VISIBLE, editable = true),
      ).forEach { case ->
        scenario.onActivity { activity ->
          activity.page.setSnapshot(snapshot(case.scope, recurrenceException = case.recurrenceException))
          activity.page.commitProps()
          val repeat = activity.page.findByDescriptionPrefix("重复，")
          val repeatEnd = activity.page.findByDescriptionPrefix("截止时间，")
          assertEquals(case.visibility, repeat.visibility)
          assertEquals(case.visibility, repeatEnd.visibility)
          assertTrue(repeat.isEnabled)
          assertTrue(repeat.isClickable)
          assertTrue(repeatEnd.isEnabled)
          assertTrue(repeatEnd.isClickable)
          val expectedTextColor = if (case.editable) CalendarPagePalette.text else CalendarPagePalette.disabled
          val expectedIconColor = if (case.editable) CalendarPagePalette.placeholder else CalendarPagePalette.disabled
          assertEquals(expectedTextColor, repeat.descendants().filterIsInstance<TextView>().single().currentTextColor)
          assertEquals(expectedIconColor, repeat.descendants().filterIsInstance<ImageView>().first().imageTintList?.defaultColor)
          if (case.scope == "occurrence" && !case.recurrenceException) {
            assertEquals("重复，不重复", repeat.contentDescription.toString())
          }
        }
      }
    }
  }

  @Test
  fun repeatEndUsesSourceSwitchLoopingYearAndARealTouchDrivenDayWheel() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      scenario.onActivity { activity ->
        activity.page.setSnapshot(snapshot(
          scope = "series",
          startDate = "1900-01-01",
          recurrenceUntilDate = "2100-01-01",
        ))
        activity.page.commitProps()
        activity.page.findByDescriptionPrefix("截止时间，").performClick()
      }
      waitUntil(scenario) { activity ->
        activity.page.descendants().filterIsInstance<CalendarRepeatEndPageView>().singleOrNull()?.isLaidOut == true
      }

      var dayBefore = 0
      scenario.onActivity { activity ->
        val page = activity.page.descendants().filterIsInstance<CalendarRepeatEndPageView>().single()
        val sourceSwitch = page.descendants().filterIsInstance<CalendarSourceSwitch>().single()
        assertEquals(activity.pageDp(36), sourceSwitch.width)
        assertEquals(activity.pageDp(24), sourceSwitch.height)
        assertEquals(activity.pageDp(20).toFloat(), sourceSwitch.switchBoundsForTest().height())
        assertFalse(sourceSwitch.isChecked)
        dispatchHorizontalDrag(sourceSwitch, 0.28f, 0.82f)
        assertTrue(sourceSwitch.isChecked)
        dispatchHorizontalDrag(sourceSwitch, 0.72f, 0.18f)
        assertFalse(sourceSwitch.isChecked)

        val year = page.findByDescriptionPrefix("截止年份滚轮") as CalendarEditWheelView
        assertEquals(2100, year.selectedValue)
        assertTrue(year.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null))
        assertEquals(1900, year.selectedValue)

        val day = page.findByDescriptionPrefix("截止日期滚轮") as CalendarEditWheelView
        dayBefore = day.selectedValue
        dispatchDrag(day, 0.70f, 0.30f)
      }
      waitUntil(scenario) { activity ->
        val page = activity.page.descendants().filterIsInstance<CalendarRepeatEndPageView>().single()
        val day = page.findByDescriptionPrefix("截止日期滚轮") as CalendarEditWheelView
        day.selectedValue != dayBefore
      }
      scenario.onActivity { activity ->
        val page = activity.page.descendants().filterIsInstance<CalendarRepeatEndPageView>().single()
        val day = page.findByDescriptionPrefix("截止日期滚轮") as CalendarEditWheelView
        assertNotEquals(dayBefore, day.selectedValue)
        assertTrue(day.contentDescription.toString().contains("日(周"))
      }
    }
  }

  @Test
  fun sourceSwitchUsesCompoundButtonSemanticsSilentSyncAndRtlGeometry() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      val switchId = View.generateViewId()
      scenario.onActivity { activity ->
        val host = FrameLayout(activity).apply {
          layoutDirection = View.LAYOUT_DIRECTION_LTR
        }
        val switch = CalendarSourceSwitch(activity)
        switch.id = switchId
        host.addView(switch, FrameLayout.LayoutParams(activity.pageDp(80), activity.pageDp(24)))
        activity.setContentView(host)
      }
      waitUntil(scenario) { activity ->
        activity.findViewById<CalendarSourceSwitch>(switchId)?.isLaidOut == true
      }

      scenario.onActivity { activity ->
        val switch = activity.findViewById<CalendarSourceSwitch>(switchId)

        switch.setCheckedIgnoreEvent(false)
        var notifications = 0
        switch.setOnCheckedChangeListener { button, checked ->
          notifications += 1
          if (checked) button.isChecked = true
        }
        switch.isChecked = true
        assertEquals(1, notifications)
        switch.setCheckedIgnoreEvent(false)
        assertEquals(1, notifications)

        val ltr = switch.switchBoundsForTest()
        assertEquals((activity.pageDp(80) - activity.pageDp(36)).toFloat(), ltr.left)
        assertEquals(activity.pageDp(20).toFloat(), ltr.height())
        switch.layoutDirection = View.LAYOUT_DIRECTION_RTL
      }
      waitUntil(scenario) { activity ->
        val switch = activity.findViewById<CalendarSourceSwitch>(switchId) ?: return@waitUntil false
        switch.layoutDirection == View.LAYOUT_DIRECTION_RTL &&
          switch.switchBoundsForTest().left == 0f
      }

      scenario.onActivity { activity ->
        val switch = activity.findViewById<CalendarSourceSwitch>(switchId)
        val rtl = switch.switchBoundsForTest()
        assertEquals(0f, rtl.left)

        val node = AccessibilityNodeInfo.obtain()
        switch.onInitializeAccessibilityNodeInfo(node)
        assertTrue(node.isCheckable)
        assertFalse(node.isChecked)
        assertNotEquals("android.widget.Switch", node.className.toString())
        node.recycle()
      }
    }
  }

  private fun snapshot(
    scope: String?,
    recurrenceException: Boolean = false,
    startDate: String = "2026-07-17",
    recurrenceUntilDate: String? = "2026-10-17",
  ): Map<String, Any?> = mapOf(
    "schemaVersion" to 1,
    "state" to "ready",
    "editing" to true,
    "recurring" to true,
    "recurrenceException" to recurrenceException,
    "recurrenceScope" to scope,
    "saving" to false,
    "draft" to mapOf(
      "title" to "重复日程",
      "startDate" to startDate,
      "endDate" to startDate,
      "startTime" to "10:00",
      "endTime" to "11:00",
      "isAllDay" to false,
      "repeat" to "weekly",
      "recurrenceUntilDate" to recurrenceUntilDate,
      "reminderMinutes" to null,
      "location" to "",
      "notes" to "",
    ),
  )

  private data class ScopeCase(
    val scope: String?,
    val recurrenceException: Boolean,
    val visibility: Int,
    val editable: Boolean,
  )

  private fun View.findByDescriptionPrefix(prefix: String): View = descendants().single {
    it.contentDescription?.toString()?.startsWith(prefix) == true
  }

  private fun View.descendants(): List<View> {
    val result = mutableListOf<View>()
    val pending = ArrayDeque<View>()
    pending.add(this)
    while (pending.isNotEmpty()) {
      val view = pending.removeFirst()
      result += view
      if (view is ViewGroup) {
        for (index in 0 until view.childCount) pending.add(view.getChildAt(index))
      }
    }
    return result
  }

  private fun dispatchDrag(view: View, startFraction: Float, endFraction: Float) {
    val downTime = SystemClock.uptimeMillis()
    val x = view.width / 2f
    val startY = view.height * startFraction
    val endY = view.height * endFraction
    dispatch(view, downTime, downTime, MotionEvent.ACTION_DOWN, x, startY)
    for (frame in 1..8) {
      val fraction = frame / 8f
      dispatch(
        view,
        downTime,
        downTime + frame * 18L,
        MotionEvent.ACTION_MOVE,
        x,
        startY + (endY - startY) * fraction,
      )
    }
    dispatch(view, downTime, downTime + 162L, MotionEvent.ACTION_UP, x, endY)
  }

  private fun dispatchHorizontalDrag(view: View, startFraction: Float, endFraction: Float) {
    val downTime = SystemClock.uptimeMillis()
    val y = view.height / 2f
    val startX = view.width * startFraction
    val endX = view.width * endFraction
    dispatch(view, downTime, downTime, MotionEvent.ACTION_DOWN, startX, y)
    for (frame in 1..8) {
      val fraction = frame / 8f
      dispatch(
        view,
        downTime,
        downTime + frame * 18L,
        MotionEvent.ACTION_MOVE,
        startX + (endX - startX) * fraction,
        y,
      )
    }
    dispatch(view, downTime, downTime + 162L, MotionEvent.ACTION_UP, endX, y)
  }

  private fun dispatch(
    view: View,
    downTime: Long,
    eventTime: Long,
    action: Int,
    x: Float,
    y: Float,
  ) {
    MotionEvent.obtain(downTime, eventTime, action, x, y, 0).also { event ->
      event.source = InputDevice.SOURCE_TOUCHSCREEN
      view.dispatchTouchEvent(event)
      event.recycle()
    }
  }

  private fun waitUntil(
    scenario: ActivityScenario<CalendarEditPageTestActivity>,
    timeoutMs: Long = 3_000L,
    condition: (CalendarEditPageTestActivity) -> Boolean,
  ) {
    val deadline = SystemClock.uptimeMillis() + timeoutMs
    while (SystemClock.uptimeMillis() < deadline) {
      var met = false
      scenario.onActivity { met = condition(it) }
      if (met) return
      Thread.sleep(25L)
    }
    var met = false
    scenario.onActivity { met = condition(it) }
    assertTrue("condition was not met within ${timeoutMs}ms", met)
  }
}
