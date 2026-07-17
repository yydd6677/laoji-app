package com.laoji.nativeplatform.calendar

import android.os.SystemClock
import android.content.Context
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.viewpager2.widget.ViewPager2
import expo.modules.core.ModuleRegistry
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import java.lang.ref.WeakReference
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// CAL-PICKER-001 / CAL-PICKER-HOST-001: all gestures enter the production CalendarHostView tree.
@RunWith(AndroidJUnit4::class)
class CalendarQuickChooseInstrumentedTest {
  private val retainedReactContexts = mutableListOf<Any>()

  @Test
  fun productionHostTitleTracksContinuousProgressAndInvalidOpenedDragStaysOpen() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val hostRef = AtomicReference<CalendarHostView>()
      scenario.onActivity { activity ->
        hostRef.set(attachProductionHost(activity, populatedSnapshot(), CalendarMode.DAY))
      }
      waitForHost(scenario, hostRef)

      val renderedIntermediateFrame = AtomicBoolean(false)
      scenario.onActivity {
        val icon = hostRef.get().descendants<CalendarTitleExpandIconView>().single()
        icon.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
          override fun onPreDraw(): Boolean {
            if (icon.rotation > 0f && icon.rotation < 180f) renderedIntermediateFrame.set(true)
            if (icon.rotation >= 180f && icon.viewTreeObserver.isAlive) {
              icon.viewTreeObserver.removeOnPreDrawListener(this)
            }
            return true
          }
        })
        tap(outerTitle(hostRef.get()))
      }
      SystemClock.sleep(120L)
      assertTrue("opening must render at least one intermediate title frame", renderedIntermediateFrame.get())
      waitUntil(scenario) { picker(hostRef.get()).expandState == CalendarPickerExpandState.OPENED }

      scenario.onActivity { activity ->
        val host = hostRef.get()
        val panel = picker(host)
        val icon = host.descendants<CalendarTitleExpandIconView>().single()
        assertEquals(180f, icon.rotation, 0.5f)
        assertEquals(host.width, panel.width)
        assertFalse(panel.isFocusable)
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, panel.importantForAccessibility)
        assertNotEquals(activity.dp(298f), panel.measuredPanelHeight())

        val dragBar = panel.descendants<QuickChooseDragBarView>().single()
        dispatchDrag(
          dragBar,
          dragBar.width / 2f,
          dragBar.height / 2f,
          dragBar.height / 2f + activity.dp(80f),
          durationMs = 180L,
        )
      }
      SystemClock.sleep(250L)
      scenario.onActivity {
        assertEquals(CalendarPickerExpandState.OPENED, picker(hostRef.get()).expandState)
        assertEquals(180f, hostRef.get().descendants<CalendarTitleExpandIconView>().single().rotation, 0.5f)
      }

      scenario.onActivity { activity ->
        val dragBar = picker(hostRef.get()).descendants<QuickChooseDragBarView>().single()
        dispatchDrag(
          dragBar,
          dragBar.width / 2f,
          dragBar.height / 2f,
          dragBar.height / 2f - activity.dp(90f),
          durationMs = 180L,
        )
      }
      waitUntil(scenario) { picker(hostRef.get()).expandState == CalendarPickerExpandState.CLOSED }
      scenario.onActivity {
        assertEquals(0f, hostRef.get().descendants<CalendarTitleExpandIconView>().single().rotation, 0.5f)
      }
    }
  }

  @Test
  fun productionHostInternalTitlePagerTodayAndEventDotsUseRealViews() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val hostRef = AtomicReference<CalendarHostView>()
      scenario.onActivity { activity ->
        hostRef.set(attachProductionHost(activity, populatedSnapshot(), CalendarMode.DAY))
      }
      waitForHost(scenario, hostRef)
      openPicker(scenario, hostRef)

      val initialPage = AtomicInteger()
      scenario.onActivity {
        val panel = picker(hostRef.get())
        val pager = panel.descendants<ViewPager2>().single()
        initialPage.set(pager.currentItem)
        assertEquals(CalendarQuickChooseContract.DATE_PAGER_ITEM_COUNT, pager.adapter?.itemCount)
        assertTrue(
          panel.descendants<TextView>().any {
            it.contentDescription?.toString() == "2026年7月21日，今天，有2个日程"
          },
        )

        val arrow = panel.descendants<QuickChooseChevronView>()
          .single { it.contentDescription?.toString() == "切换日期或年月选择" }
        assertFalse(arrow.isFocusable)
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, arrow.importantForAccessibility)
        tap(arrow)
      }
      waitUntil(scenario) { picker(hostRef.get()).contentState == CalendarPickerContentState.YEAR_MONTH_PANEL }

      scenario.onActivity {
        val titleText = picker(hostRef.get()).descendants<TextView>()
          .single { it.text.toString() == "2026年7月" && it.isClickable }
        tap(titleText)
      }
      waitUntil(scenario) { picker(hostRef.get()).contentState == CalendarPickerContentState.DATE_PANEL }

      scenario.onActivity {
        val pager = picker(hostRef.get()).descendants<ViewPager2>().single()
        dispatchHorizontalSwipe(pager, pager.width * 0.82f, pager.width * 0.18f, 260L)
      }
      waitUntil(scenario, timeoutMs = 4_000L) {
        picker(hostRef.get()).descendants<ViewPager2>().single().currentItem == initialPage.get() + 1
      }
      scenario.onActivity {
        val panel = picker(hostRef.get())
        assertTrue(panel.descendants<TextView>().any { it.text.toString() == "2026年8月" })
        assertEquals(100L, panel.lastDateHeightAnimationDurationMs())
      }
    }
  }

  @Test
  fun productionHostWheelFlingContinuesThenNewDragCancelsAndCommitsSettledValue() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val hostRef = AtomicReference<CalendarHostView>()
      scenario.onActivity { activity ->
        hostRef.set(attachProductionHost(activity, populatedSnapshot(), CalendarMode.DAY))
      }
      waitForHost(scenario, hostRef)
      openPicker(scenario, hostRef)
      switchToYearMonth(scenario, hostRef)

      val valueAtRelease = AtomicInteger()
      scenario.onActivity {
        val monthWheel = monthWheel(hostRef.get())
        dispatchVerticalFling(monthWheel, monthWheel.height * 0.76f, monthWheel.height * 0.24f)
        valueAtRelease.set(monthWheel.selectedValue)
      }
      waitUntil(scenario) { monthWheel(hostRef.get()).selectedValue != valueAtRelease.get() }

      val cancelDownTime = AtomicReference<Long>()
      val cancelledValue = AtomicInteger()
      scenario.onActivity {
        val wheel = monthWheel(hostRef.get())
        cancelDownTime.set(dispatchDown(wheel, wheel.width / 2f, wheel.height / 2f))
        cancelledValue.set(wheel.selectedValue)
      }
      SystemClock.sleep(140L)
      scenario.onActivity {
        assertEquals(cancelledValue.get(), monthWheel(hostRef.get()).selectedValue)
        assertEquals("2026年7月", outerTitleText(hostRef.get()).text.toString())
      }

      scenario.onActivity { activity ->
        val wheel = monthWheel(hostRef.get())
        val x = wheel.width / 2f
        val startY = wheel.height / 2f
        dispatchMove(wheel, cancelDownTime.get(), x, startY + activity.dp(60f), 900L)
        dispatchUp(wheel, cancelDownTime.get(), x, startY + activity.dp(60f), 1_800L)
      }
      waitUntil(scenario) {
        val wheels = picker(hostRef.get()).descendants<CalendarQuickChooseWheelView>().sortedBy { it.left }
        val settledTitle = CalendarUi.monthTitle(
          CalendarDateMath.toEpochDay(wheels.first().selectedValue, wheels.last().selectedValue, 1),
        )
        wheels.last().selectedValue != cancelledValue.get() &&
          outerTitleText(hostRef.get()).text.toString() == settledTitle
      }
      scenario.onActivity {
        val wheels = picker(hostRef.get()).descendants<CalendarQuickChooseWheelView>().sortedBy { it.left }
        val settledTitle = CalendarUi.monthTitle(
          CalendarDateMath.toEpochDay(wheels.first().selectedValue, wheels.last().selectedValue, 1),
        )
        assertEquals(settledTitle, outerTitleText(hostRef.get()).text.toString())
      }
    }
  }

  @Test
  fun productionHostWheelVisibleItemTapCommitsAndToolbarExposesOneModeToggle() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val hostRef = AtomicReference<CalendarHostView>()
      scenario.onActivity { activity ->
        hostRef.set(attachProductionHost(activity, populatedSnapshot(), CalendarMode.MONTH))
      }
      waitForHost(scenario, hostRef)

      scenario.onActivity {
        val toolbar = hostRef.get().descendants<CalendarToolbarView>().single()
        val toggles = toolbar.descendants<View>().filter {
          it.contentDescription?.toString()?.startsWith("切换到") == true
        }
        assertEquals(1, toggles.size)
        assertEquals("切换到单日视图", toggles.single().contentDescription?.toString())
        tap(toggles.single())
      }
      waitUntil(scenario) {
        hostRef.get().descendants<SingleDayCalendarView>().single().visibility == View.VISIBLE
      }
      scenario.onActivity {
        val toolbar = hostRef.get().descendants<CalendarToolbarView>().single()
        val toggles = toolbar.descendants<View>().filter {
          it.contentDescription?.toString()?.startsWith("切换到") == true
        }
        assertEquals(1, toggles.size)
        assertEquals("切换到月视图", toggles.single().contentDescription?.toString())
      }

      openPicker(scenario, hostRef)
      switchToYearMonth(scenario, hostRef)
      scenario.onActivity {
        val wheel = monthWheel(hostRef.get())
        assertEquals(7, wheel.selectedValue)
        tap(
          wheel,
          x = wheel.width / 2f,
          y = wheel.height / 2f + wheel.itemHeightPx,
        )
      }
      waitUntil(scenario, timeoutMs = 2_000L) {
        monthWheel(hostRef.get()).selectedValue == 8 &&
          outerTitleText(hostRef.get()).text.toString() == "2026年8月"
      }
    }
  }

  @Test
  fun productionHostBlocksThroughDragBarActionClosesAndActivityRecreationRestoresSelection() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val hostRef = AtomicReference<CalendarHostView>()
      val snapshot = populatedSnapshot()
      val july24 = CalendarDateMath.toEpochDay(2026, 7, 24)
      scenario.onActivity { activity ->
        hostRef.set(attachProductionHost(activity, snapshot, CalendarMode.DAY))
      }
      waitForHost(scenario, hostRef)
      openPicker(scenario, hostRef)

      val underlyingTouches = AtomicInteger()
      scenario.onActivity { activity ->
        val host = hostRef.get()
        host.descendants<ThreePageDayPager>().single().setOnTouchListener { _, _ ->
          underlyingTouches.incrementAndGet()
          true
        }
        val panel = picker(host)
        val panelLocation = IntArray(2).also(panel::getLocationOnScreen)
        val hostLocation = IntArray(2).also(host::getLocationOnScreen)
        val outsideY = (panelLocation[1] - hostLocation[1] + panel.measuredPanelHeight() + activity.dp(40f))
          .coerceAtMost(host.height - activity.dp(80f))
          .toFloat()
        tap(host, host.width / 2f, outsideY)
      }
      waitUntil(scenario) { picker(hostRef.get()).expandState == CalendarPickerExpandState.CLOSED }
      assertEquals(0, underlyingTouches.get())

      openPicker(scenario, hostRef)
      scenario.onActivity {
        val date = picker(hostRef.get()).descendants<TextView>()
          .single { it.contentDescription?.toString() == "2026年7月24日" }
        tap(date)
      }
      waitUntil(scenario) {
        picker(hostRef.get()).descendants<TextView>().any {
          it.contentDescription?.toString() == "2026年7月24日，已选择"
        }
      }

      scenario.onActivity {
        val panel = picker(hostRef.get())
        val dragBar = panel.descendants<QuickChooseDragBarView>().single()
        val node = dragBar.createAccessibilityNodeInfo()
        assertTrue(node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK })
        assertTrue(dragBar.performAccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, null))
      }
      waitUntil(scenario) { picker(hostRef.get()).expandState == CalendarPickerExpandState.CLOSED }

      scenario.onActivity { hostRef.get().dispose() }
      scenario.recreate()
      scenario.onActivity { activity ->
        hostRef.set(
          attachProductionHost(
            activity,
            snapshot.copy(selectedEpochDay = july24),
            CalendarMode.DAY,
          ),
        )
      }
      waitForHost(scenario, hostRef)
      openPicker(scenario, hostRef)
      scenario.onActivity {
        assertTrue(
          picker(hostRef.get()).descendants<TextView>().any {
            it.contentDescription?.toString() == "2026年7月24日，已选择"
          },
        )
      }
    }
  }

  private fun attachProductionHost(
    activity: CalendarSurfaceTestActivity,
    snapshot: CalendarSnapshot,
    mode: CalendarMode,
  ): CalendarHostView {
    val (reactApplicationContext, themedReactContext) = createReactContexts(activity)
    val modulesProvider = object : ModulesProvider {
      override fun getModulesList() = emptyList<Class<out expo.modules.kotlin.modules.Module>>()
    }
    val appContext = AppContext::class.java.constructors
      .single { it.parameterTypes.size == 3 }
      .newInstance(
        modulesProvider,
        ModuleRegistry(emptyList(), emptyList()),
        WeakReference(reactApplicationContext),
      ) as AppContext
    return CalendarHostView(themedReactContext, appContext).apply {
      setMode(mode.bridgeValue)
      setSnapshot(snapshot)
      activity.root.addView(
        this,
        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
      )
    }
  }

  private fun createReactContexts(activity: CalendarSurfaceTestActivity): Pair<Any, Context> {
    val reactApplicationContextClass = Class.forName("com.facebook.react.bridge.ReactApplicationContext")
    val bridgeContextClass = Class.forName("com.facebook.react.bridge.BridgeReactContext")
    val bridgeContext = requireNotNull(
      bridgeContextClass.getConstructor(Context::class.java).newInstance(activity.applicationContext),
    )
    val themedContext = requireNotNull(
      Class.forName("com.facebook.react.uimanager.ThemedReactContext")
        .getConstructor(
          reactApplicationContextClass,
          Context::class.java,
          String::class.java,
          Int::class.javaPrimitiveType,
        )
        .newInstance(bridgeContext, activity, "CalendarQuickChooseInstrumentedTest", -1) as? Context,
    )

    val catalystClass = Class.forName("com.facebook.react.bridge.CatalystInstance")
    val catalyst = Proxy.newProxyInstance(catalystClass.classLoader, arrayOf(catalystClass)) { proxy, method, args ->
      when (method.name) {
        "equals" -> proxy === args?.firstOrNull()
        "hashCode" -> System.identityHashCode(proxy)
        "toString" -> "CalendarQuickChooseNoOpCatalystInstance"
        "getNativeModules" -> emptyList<Any>()
        "hasNativeModule", "isDestroyed" -> false
        else -> primitiveDefault(method.returnType)
      }
    }
    bridgeContextClass.getDeclaredField("mCatalystInstance").apply { isAccessible = true }
      .set(bridgeContext, catalyst)
    retainedReactContexts.add(bridgeContext)
    retainedReactContexts.add(themedContext)
    retainedReactContexts.add(catalyst)
    return bridgeContext to themedContext
  }

  private fun primitiveDefault(type: Class<*>): Any? = when (type) {
    Boolean::class.javaPrimitiveType -> false
    Byte::class.javaPrimitiveType -> 0.toByte()
    Short::class.javaPrimitiveType -> 0.toShort()
    Int::class.javaPrimitiveType -> 0
    Long::class.javaPrimitiveType -> 0L
    Float::class.javaPrimitiveType -> 0f
    Double::class.javaPrimitiveType -> 0.0
    Char::class.javaPrimitiveType -> '\u0000'
    else -> null
  }

  private fun populatedSnapshot(): CalendarSnapshot {
    val july1 = CalendarDateMath.toEpochDay(2026, 7, 1)
    val july17 = CalendarDateMath.toEpochDay(2026, 7, 17)
    val july20 = CalendarDateMath.toEpochDay(2026, 7, 20)
    val july21 = CalendarDateMath.toEpochDay(2026, 7, 21)
    return CalendarSnapshot(
      generation = 7,
      rangeStartEpochDay = july1,
      rangeEndEpochDayExclusive = CalendarDateMath.toEpochDay(2026, 9, 1),
      selectedEpochDay = july17,
      todayEpochDay = july21,
      events = listOf(
        CalendarEvent(
          sourceEventId = "all-day",
          occurrenceDate = "2026-07-20",
          title = "跨日事项",
          startEpochDay = july20,
          endEpochDay = july21,
          endEpochDayExclusive = july21 + 1,
          startMinutes = null,
          endMinutes = null,
          timeZoneId = "Asia/Shanghai",
          allDay = true,
          editable = true,
          revision = 1,
        ),
        CalendarEvent(
          sourceEventId = "timed",
          occurrenceDate = "2026-07-21",
          title = "定时事项",
          startEpochDay = july21,
          endEpochDay = july21,
          startMinutes = 600,
          endMinutes = 660,
          timeZoneId = "Asia/Shanghai",
          allDay = false,
          editable = true,
          revision = 1,
        ),
      ),
    )
  }

  private fun waitForHost(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    hostRef: AtomicReference<CalendarHostView>,
  ) {
    try {
      waitUntil(scenario) {
        hostRef.get().isLaidOut && hostRef.get().hasWindowFocus() && outerTitle(hostRef.get()).width > 0
      }
    } catch (failure: AssertionError) {
      val details = AtomicReference<String>()
      scenario.onActivity { activity ->
        val host = hostRef.get()
        val panel = picker(host)
        val title = outerTitle(host)
        details.set(
          "root=${activity.root.width}x${activity.root.height}, " +
            "host=${host.width}x${host.height}/laidOut=${host.isLaidOut}, " +
            "picker=${panel.width}x${panel.height}/laidOut=${panel.isLaidOut}, " +
            "title=${title.width}x${title.height}",
        )
      }
      throw AssertionError("production CalendarHostView did not lay out: ${details.get()}", failure)
    }
  }

  private fun openPicker(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    hostRef: AtomicReference<CalendarHostView>,
  ) {
    scenario.onActivity { tap(outerTitle(hostRef.get())) }
    waitUntil(scenario) { picker(hostRef.get()).expandState == CalendarPickerExpandState.OPENED }
  }

  private fun switchToYearMonth(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    hostRef: AtomicReference<CalendarHostView>,
  ) {
    scenario.onActivity {
      val arrow = picker(hostRef.get()).descendants<QuickChooseChevronView>()
        .single { it.contentDescription?.toString() == "切换日期或年月选择" }
      tap(arrow)
    }
    waitUntil(scenario) { picker(hostRef.get()).contentState == CalendarPickerContentState.YEAR_MONTH_PANEL }
  }

  private fun picker(host: CalendarHostView): CalendarQuickChooseHostView =
    host.descendants<CalendarQuickChooseHostView>().single()

  private fun outerTitle(host: CalendarHostView): View = host.descendants<View>().single {
    it.contentDescription?.toString()?.endsWith("，选择年月") == true
  }

  private fun outerTitleText(host: CalendarHostView): TextView =
    host.descendants<CalendarToolbarView>().single().descendants<TextView>()
      .single { it.text.toString().contains("年") }

  private fun monthWheel(host: CalendarHostView): CalendarQuickChooseWheelView =
    picker(host).descendants<CalendarQuickChooseWheelView>().maxBy { it.left }

  private fun tap(view: View, x: Float = view.width / 2f, y: Float = view.height / 2f) {
    val downTime = SystemClock.uptimeMillis()
    dispatch(view, MotionEvent.ACTION_DOWN, downTime, downTime, x, y)
    dispatch(view, MotionEvent.ACTION_UP, downTime, downTime + 48L, x, y)
  }

  private fun dispatchDrag(
    view: View,
    x: Float,
    startY: Float,
    endY: Float,
    durationMs: Long,
  ) {
    val downTime = SystemClock.uptimeMillis()
    dispatch(view, MotionEvent.ACTION_DOWN, downTime, downTime, x, startY)
    repeat(4) { index ->
      val fraction = (index + 1) / 5f
      dispatch(
        view,
        MotionEvent.ACTION_MOVE,
        downTime,
        downTime + (durationMs * fraction).toLong(),
        x,
        startY + (endY - startY) * fraction,
      )
    }
    dispatch(view, MotionEvent.ACTION_UP, downTime, downTime + durationMs, x, endY)
  }

  private fun dispatchHorizontalSwipe(view: View, startX: Float, endX: Float, durationMs: Long) {
    val downTime = SystemClock.uptimeMillis()
    val y = view.height / 2f
    dispatch(view, MotionEvent.ACTION_DOWN, downTime, downTime, startX, y)
    repeat(6) { index ->
      val fraction = (index + 1) / 7f
      dispatch(
        view,
        MotionEvent.ACTION_MOVE,
        downTime,
        downTime + (durationMs * fraction).toLong(),
        startX + (endX - startX) * fraction,
        y,
      )
    }
    dispatch(view, MotionEvent.ACTION_UP, downTime, downTime + durationMs, endX, y)
  }

  private fun dispatchVerticalFling(view: View, startY: Float, endY: Float) {
    val downTime = SystemClock.uptimeMillis()
    val x = view.width / 2f
    dispatch(view, MotionEvent.ACTION_DOWN, downTime, downTime, x, startY)
    dispatch(view, MotionEvent.ACTION_MOVE, downTime, downTime + 8L, x, (startY + endY) / 2f)
    dispatch(view, MotionEvent.ACTION_UP, downTime, downTime + 16L, x, endY)
  }

  private fun dispatchDown(view: View, x: Float, y: Float): Long {
    val downTime = SystemClock.uptimeMillis()
    dispatch(view, MotionEvent.ACTION_DOWN, downTime, downTime, x, y)
    return downTime
  }

  private fun dispatchMove(view: View, downTime: Long, x: Float, y: Float, elapsedMs: Long) {
    dispatch(view, MotionEvent.ACTION_MOVE, downTime, downTime + elapsedMs, x, y)
  }

  private fun dispatchUp(view: View, downTime: Long, x: Float, y: Float, elapsedMs: Long) {
    dispatch(view, MotionEvent.ACTION_UP, downTime, downTime + elapsedMs, x, y)
  }

  private fun dispatch(
    view: View,
    action: Int,
    downTime: Long,
    eventTime: Long,
    x: Float,
    y: Float,
  ) {
    MotionEvent.obtain(downTime, eventTime, action, x, y, 0).also { event ->
      event.source = InputDevice.SOURCE_TOUCHSCREEN
      view.dispatchTouchEvent(event)
      event.recycle()
    }
  }

  private fun CalendarSurfaceTestActivity.dp(value: Float): Int =
    (value * resources.displayMetrics.density).roundToInt()

  private fun waitUntil(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    timeoutMs: Long = 3_000L,
    condition: () -> Boolean,
  ) {
    val deadline = SystemClock.uptimeMillis() + timeoutMs
    while (SystemClock.uptimeMillis() < deadline) {
      val met = AtomicBoolean(false)
      scenario.onActivity { met.set(condition()) }
      if (met.get()) return
      Thread.sleep(10L)
    }
    val met = AtomicBoolean(false)
    scenario.onActivity { met.set(condition()) }
    assertTrue("condition was not met within ${timeoutMs}ms", met.get())
  }

  private inline fun <reified T : View> View.descendants(): List<T> = descendants(T::class.java)

  private fun <T : View> View.descendants(type: Class<T>): List<T> = buildList {
    fun visit(view: View) {
      if (type.isInstance(view)) add(requireNotNull(type.cast(view)))
      if (view is ViewGroup) repeat(view.childCount) { visit(view.getChildAt(it)) }
    }
    visit(this@descendants)
  }
}
