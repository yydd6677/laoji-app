package com.laoji.nativeplatform.calendarpages

import android.os.Build
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inspector.WindowInspector
import android.widget.DatePicker
import android.widget.NumberPicker
import android.widget.Switch
import android.widget.TextView
import android.widget.TimePicker
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// CAL-EDIT-TIME-001: production-view runtime coverage; no test helper mutates wheel selection.
@RunWith(AndroidJUnit4::class)
class CalendarEditTimePageInstrumentedTest {
  @Test
  fun `CAL-EDIT-TIME-001_all_four_rows_open_without_system_picker_windows`() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      val baselineWindowCount = AtomicInteger()
      scenario.onActivity { baselineWindowCount.set(globalWindowRoots(it).size) }

      listOf("开始日期，", "结束日期，", "开始时间，", "结束时间，").forEach { rowPrefix ->
        scenario.onActivity { activity ->
          activity.page.findByDescriptionPrefix(rowPrefix).performClick()
        }
        waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().size == 1 }
        scenario.onActivity { activity ->
          val child = activity.page.descendants<CalendarEditTimePageView>().single()
          assertTrue(child.isShown)
          assertTrue(child.parent is ViewGroup)
          assertEquals(activity.pageDp(44), child.descendants<CalendarPageTitleBar>().single().measuredHeight)
          assertEquals(baselineWindowCount.get(), globalWindowRoots(activity).size)
          assertNoSystemPicker(globalWindowRoots(activity))
          child.findText("取消").performClick()
        }
        waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().isEmpty() }
      }
    }
  }

  @Test
  fun `CAL-EDIT-TIME-001_switches_endpoints_all_day_and_commits_real_drag`() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      val originalStart = AtomicReference<String>()
      val editedStart = AtomicReference<String>()
      scenario.onActivity { activity ->
        originalStart.set(activity.page.findByDescriptionPrefix("开始日期，").contentDescription.toString())
        activity.page.findByDescriptionPrefix("开始日期，").performClick()
      }
      waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().size == 1 }

      scenario.onActivity { activity ->
        val child = activity.timePage()
        val start = child.findByDescriptionPrefix("开始 区域")
        val end = child.findByDescriptionPrefix("结束 区域")
        assertTrue(start.isSelected)
        end.performClick()
        assertTrue(end.isSelected)
        assertFalse(start.isSelected)

        child.descendants<Switch>().single { it.contentDescription == "全天" }.performClick()
        assertTrue(child.visibleWheel("年份滚轮").isShown)
        assertTrue(child.visibleWheel("月份滚轮").isShown)
        child.descendants<Switch>().single { it.contentDescription == "全天" }.performClick()

        start.performClick()
        val before = start.contentDescription.toString()
        dispatchDrag(child.visibleWheel("日期滚轮"), 0.78f, 0.28f)
        editedStart.set(before)
      }
      waitUntil(scenario, timeoutMs = 5_000L) { activity ->
        activity.timePage().findByDescriptionPrefix("开始 区域").contentDescription.toString() != editedStart.get()
      }
      scenario.onActivity { activity -> activity.timePage().findText("完成").performClick() }
      waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().isEmpty() }
      scenario.onActivity { activity ->
        assertNotEquals(
          originalStart.get(),
          activity.page.findByDescriptionPrefix("开始日期，").contentDescription.toString(),
        )
      }
    }
  }

  @Test
  fun `CAL-EDIT-TIME-001_cancel_and_Android_Back_restore_entry_draft`() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      val originalTime = AtomicReference<String>()
      val originalDate = AtomicReference<String>()
      scenario.onActivity { activity ->
        originalTime.set(activity.page.findByDescriptionPrefix("开始时间，").contentDescription.toString())
        originalDate.set(activity.page.findByDescriptionPrefix("开始日期，").contentDescription.toString())
        activity.page.findByDescriptionPrefix("开始时间，").performClick()
      }
      waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().size == 1 }
      scenario.onActivity { activity ->
        val child = activity.timePage()
        assertTrue(
          child.visibleWheel("分钟滚轮").performAccessibilityAction(
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,
            null,
          ),
        )
        child.findText("取消").performClick()
      }
      waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().isEmpty() }
      scenario.onActivity { activity ->
        assertEquals(originalTime.get(), activity.page.findByDescriptionPrefix("开始时间，").contentDescription)
        activity.page.findByDescriptionPrefix("开始日期，").performClick()
      }
      waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().size == 1 }
      scenario.onActivity { activity ->
        val start = activity.timePage().findByDescriptionPrefix("开始 区域")
        val before = start.contentDescription.toString()
        assertTrue(
          activity.timePage().visibleWheel("日期滚轮").performAccessibilityAction(
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,
            null,
          ),
        )
        assertNotEquals(before, start.contentDescription.toString())
        activity.onBackPressedDispatcher.onBackPressed()
      }
      waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().isEmpty() }
      scenario.onActivity { activity ->
        assertEquals(originalDate.get(), activity.page.findByDescriptionPrefix("开始日期，").contentDescription)
      }
    }
  }

  @Test
  fun `CAL-EDIT-TIME-001_accessibility_and_optional_time_use_production_controls`() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      scenario.onActivity { it.page.findByDescriptionPrefix("开始时间，").performClick() }
      waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().size == 1 }

      val before = AtomicReference<String>()
      scenario.onActivity { activity ->
        val child = activity.timePage()
        val start = child.findByDescriptionPrefix("开始 区域")
        before.set(start.contentDescription.toString())
        val minuteWheel = child.visibleWheel("分钟滚轮")
        val node = minuteWheel.createAccessibilityNodeInfo()
        assertTrue(node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD })
        assertTrue(minuteWheel.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null))
      }
      waitUntil(scenario) {
        it.timePage().findByDescriptionPrefix("开始 区域").contentDescription.toString() != before.get()
      }
      scenario.onActivity { activity ->
        val child = activity.timePage()
        child.descendants<Switch>().single { it.contentDescription == "具体时间" }.performClick()
        assertTrue(child.visibleWheel("日期滚轮").isShown)
        assertTrue(child.descendants<CalendarEditWheelView>()
          .filter { it.contentDescription.toString().startsWith("小时滚轮") }
          .all { it.visibility == View.GONE })
        child.findText("完成").performClick()
      }
      waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().isEmpty() }
      scenario.onActivity { activity ->
        assertEquals(View.GONE, activity.page.findByDescriptionPrefix("开始时间，").visibility)
        assertEquals(View.GONE, activity.page.findByDescriptionPrefix("结束时间，").visibility)
      }
    }
  }

  @Test
  fun `CAL-EDIT-TIME-001_saved_hierarchy_restores_endpoint_and_selection`() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      scenario.onActivity { it.page.findByDescriptionPrefix("结束日期，").performClick() }
      waitUntil(scenario) { it.page.descendants<CalendarEditTimePageView>().size == 1 }

      val selectedDescription = AtomicReference<String>()
      scenario.onActivity { activity ->
        val child = activity.timePage()
        val end = child.findByDescriptionPrefix("结束 区域")
        assertTrue(end.isSelected)
        assertTrue(
          child.visibleWheel("日期滚轮").performAccessibilityAction(
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,
            null,
          ),
        )
        selectedDescription.set(end.contentDescription.toString())
      }

      scenario.recreate()
      waitUntil(scenario, timeoutMs = 5_000L) { it.page.descendants<CalendarEditTimePageView>().size == 1 }
      scenario.onActivity { activity ->
        val end = activity.timePage().findByDescriptionPrefix("结束 区域")
        assertTrue(end.isSelected)
        assertEquals(selectedDescription.get(), end.contentDescription.toString())
        activity.onBackPressedDispatcher.onBackPressed()
      }
    }
  }

  private fun CalendarEditPageTestActivity.timePage(): CalendarEditTimePageView =
    page.descendants<CalendarEditTimePageView>().single()

  private fun CalendarEditTimePageView.visibleWheel(prefix: String): CalendarEditWheelView =
    descendants<CalendarEditWheelView>().single {
      it.isShown && it.contentDescription.toString().startsWith(prefix)
    }

  private fun View.findByDescriptionPrefix(prefix: String): View = descendants<View>().single {
    it.contentDescription?.toString()?.startsWith(prefix) == true
  }

  private fun View.findText(value: String): TextView = descendants<TextView>().single {
    it.text.toString() == value
  }

  private inline fun <reified T : View> View.descendants(): List<T> =
    allDescendants().filterIsInstance<T>()

  private fun View.allDescendants(): List<View> {
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

  private fun globalWindowRoots(activity: CalendarEditPageTestActivity): List<View> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      WindowInspector.getGlobalWindowViews()
    } else {
      listOf(activity.window.decorView.rootView)
    }

  private fun assertNoSystemPicker(roots: List<View>) {
    val allViews = roots.flatMap { it.descendants<View>() }
    assertTrue(allViews.none { it is DatePicker })
    assertTrue(allViews.none { it is TimePicker })
    assertTrue(allViews.none { it is NumberPicker })
  }

  private fun waitUntil(
    scenario: ActivityScenario<CalendarEditPageTestActivity>,
    timeoutMs: Long = 3_000L,
    condition: (CalendarEditPageTestActivity) -> Boolean,
  ) {
    val deadline = SystemClock.uptimeMillis() + timeoutMs
    while (SystemClock.uptimeMillis() < deadline) {
      val met = AtomicBoolean(false)
      scenario.onActivity { met.set(condition(it)) }
      if (met.get()) return
      Thread.sleep(25L)
    }
    val met = AtomicBoolean(false)
    scenario.onActivity { met.set(condition(it)) }
    assertTrue("condition was not met within ${timeoutMs}ms", met.get())
  }
}
