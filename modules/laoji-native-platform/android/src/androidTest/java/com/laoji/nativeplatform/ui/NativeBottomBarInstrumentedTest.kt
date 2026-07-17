package com.laoji.nativeplatform.ui

import android.content.Context
import android.graphics.Color
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.animation.Animation
import android.view.animation.ScaleAnimation
import android.widget.ImageView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.laoji.nativeplatform.calendar.CalendarHostView
import com.laoji.nativeplatform.calendar.CalendarSurfaceTestActivity
import com.laoji.nativeplatform.evidence.EvidenceNodeContract
import com.laoji.nativeplatform.evidence.EvidenceTreeContract
import com.laoji.nativeplatform.evidence.FeishuEvidence
import com.laoji.nativeplatform.evidence.FeishuEvidenceRuntime
import com.laoji.nativeplatform.minutes.LaojiMinutesView
import com.laoji.nativeplatform.minutes.MinutesSurface
import expo.modules.core.ModuleRegistry
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import java.lang.ref.WeakReference
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@FeishuEvidence("UI-SHELL-BOTTOM-MAIN-001")
class NativeBottomBarInstrumentedTest {
  private val retainedReactContexts = mutableListOf<Any>()

  @Test
  fun sourceShapedTreeUsesPhysicalDividerRealSelectedStateAndIconOnlyMotion() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val barRef = AtomicReference<LaojiNativeBottomBarView>()
      val pressed = AtomicReference<NativeBottomTab?>()
      val pressCount = java.util.concurrent.atomic.AtomicInteger()
      scenario.onActivity { activity ->
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
        val bar = LaojiNativeBottomBarView(themedReactContext, appContext).apply {
          setBridgeEventsEnabled(false)
          setSelectedTab(NativeBottomTab.SCHEDULE.wireName)
          setTabPressListener {
            pressCount.incrementAndGet()
            pressed.set(it)
          }
        }
        activity.root.addView(
          bar,
          ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
        )
        barRef.set(bar)
      }
      waitUntil(scenario) { barRef.get().isLaidOut && barRef.get().width > 0 }

      scenario.onActivity { activity ->
        val bar = barRef.get()
        assertTrue(
          FeishuEvidenceRuntime.validate(bar, bottomBarContract()).joinToString().isEmpty(),
        )
        val divider = node(bar, "bottom-bar-divider")
        val schedule = node(bar, "bottom-tab-schedule")
        val meetings = node(bar, "bottom-tab-meetings")
        val scheduleIcon = node(bar, "bottom-tab-schedule-icon") as ImageView
        val meetingsIcon = node(bar, "bottom-tab-meetings-icon") as ImageView
        val scheduleLabel = node(bar, "bottom-tab-schedule-label") as TextView

        assertEquals(NativeBottomBarContract.DIVIDER_HEIGHT_PX, divider.height)
        assertEquals(NativeBottomBarContract.dpToPx(65f, activity.resources.displayMetrics.density), schedule.height)
        assertTrue(kotlin.math.abs(schedule.width - meetings.width) <= 1)
        assertTrue(schedule.isSelected)
        assertFalse(meetings.isSelected)
        assertEquals(Color.rgb(20, 86, 240), scheduleLabel.currentTextColor)
        assertEquals(12f, scheduleLabel.textSize / activity.resources.displayMetrics.scaledDensity, 0.1f)
        assertTrue(scheduleLabel.isSingleLine)
        assertEquals(NativeBottomBarContract.dpToPx(22f, activity.resources.displayMetrics.density), scheduleIcon.width)

        assertTrue(schedule.performClick())
        assertEquals(1, pressCount.get())
        assertEquals(NativeBottomTab.SCHEDULE, pressed.get())
        assertNull(scheduleIcon.animation)

        assertTrue(meetings.performClick())
        assertEquals(2, pressCount.get())
        assertEquals(NativeBottomTab.MEETINGS, pressed.get())
        assertTrue(schedule.isSelected)
        assertFalse(meetings.isSelected)
        assertNull(meetings.animation)
        assertNull(meetingsIcon.animation)
        bar.setSelectedTab(NativeBottomTab.MEETINGS.wireName)
        bar.setSelectionAnimationCommand(1)
      }
      waitUntil(scenario) { barRef.get().selectedAnimationPlayCount() == 1 }
      scenario.onActivity {
        val bar = barRef.get()
        val schedule = node(bar, "bottom-tab-schedule")
        val meetings = node(bar, "bottom-tab-meetings")
        assertFalse(schedule.isSelected)
        assertTrue(meetings.isSelected)
        assertEquals(1, bar.selectedAnimationPlayCount())
        bar.setSelectionAnimationCommand(1)
        assertEquals(1, bar.selectedAnimationPlayCount())
      }
    }
  }

  @Test
  fun realCalendarAndMinutesRootReplacementReplaysSelectionMotionExactlyOnce() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val firstCalendarRef = AtomicReference<CalendarHostView>()
      val minutesRef = AtomicReference<LaojiMinutesView>()
      val secondCalendarRef = AtomicReference<CalendarHostView>()
      val minutesProbeRef = AtomicReference<SelectionMotionProbe>()
      val calendarProbeRef = AtomicReference<SelectionMotionProbe>()
      scenario.onActivity { activity ->
        val (reactApplicationContext, themedReactContext) = createReactContexts(activity)
        val appContext = testAppContext(reactApplicationContext)
        firstCalendarRef.set(CalendarHostView(themedReactContext, appContext))
        activity.root.addView(firstCalendarRef.get(), matchParentLayoutParams())
      }
      waitUntil(scenario) {
        val firstCalendar = firstCalendarRef.get()
        firstCalendar.isLaidOut && bottomBar(firstCalendar).isLaidOut
      }

      scenario.onActivity { activity ->
        val firstCalendar = firstCalendarRef.get()
        val firstBar = bottomBar(firstCalendar)
        assertTrue(node(firstBar, "bottom-tab-meetings").performClick())
        assertTrue(node(firstBar, "bottom-tab-schedule").isSelected)
        assertFalse(node(firstBar, "bottom-tab-meetings").isSelected)
        assertEquals(0, firstBar.selectedAnimationPlayCount())

        activity.root.removeView(firstCalendar)
        val (reactApplicationContext, themedReactContext) = createReactContexts(activity)
        val appContext = testAppContext(reactApplicationContext)
        val minutes = LaojiMinutesView(themedReactContext, appContext).apply {
          setSurface(MinutesSurface.LIST.wireName)
        }
        minutesRef.set(minutes)
        activity.root.addView(minutes, matchParentLayoutParams())
      }
      waitUntil(scenario) {
        val minutes = minutesRef.get()
        minutes.isLaidOut && bottomBar(minutes).isLaidOut &&
          node(bottomBar(minutes), "bottom-tab-meetings-icon").isLaidOut
      }
      scenario.onActivity {
        val minutes = minutesRef.get()
        val minutesBar = bottomBar(minutes)
        assertEquals(0, minutesBar.selectedAnimationPlayCount())
        assertNull((node(minutesBar, "bottom-tab-meetings-icon") as ImageView).animation)
        minutesProbeRef.set(
          SelectionMotionProbe(selectionAnimation(minutesBar, "bottom-tab-meetings")),
        )
        minutes.setBottomBarSelectionCommand(1)
      }
      awaitCompletedSelectionMotion(scenario, minutesProbeRef.get())

      scenario.onActivity {
        val firstBar = bottomBar(firstCalendarRef.get())
        val minutes = minutesRef.get()
        val minutesBar = bottomBar(minutes)
        assertEquals(0, firstBar.selectedAnimationPlayCount())
        assertTrue(node(firstBar, "bottom-tab-schedule").isSelected)
        assertFalse(node(firstBar, "bottom-tab-meetings").isSelected)
        assertFalse(node(minutesBar, "bottom-tab-schedule").isSelected)
        assertTrue(node(minutesBar, "bottom-tab-meetings").isSelected)

        minutes.setBottomBarSelectionCommand(1)
        assertEquals(1, minutesBar.selectedAnimationPlayCount())
        assertTrue(node(minutesBar, "bottom-tab-meetings").performClick())
        assertEquals(1, minutesBar.selectedAnimationPlayCount())
        assertTrue(node(minutesBar, "bottom-tab-schedule").performClick())
        assertFalse(node(minutesBar, "bottom-tab-schedule").isSelected)
        assertTrue(node(minutesBar, "bottom-tab-meetings").isSelected)
      }
      assertNoDelayedSelectionReplay(
        scenario,
        root = { minutesRef.get() },
        probe = minutesProbeRef.get(),
        expectedPlayCount = 1,
      )

      scenario.onActivity { activity ->
        val minutes = minutesRef.get()
        activity.root.removeView(minutes)
        val (reactApplicationContext, themedReactContext) = createReactContexts(activity)
        val secondCalendar = CalendarHostView(
          themedReactContext,
          testAppContext(reactApplicationContext),
        )
        secondCalendarRef.set(secondCalendar)
        activity.root.addView(secondCalendar, matchParentLayoutParams())
      }
      waitUntil(scenario) {
        val secondCalendar = secondCalendarRef.get()
        secondCalendar.isLaidOut && bottomBar(secondCalendar).isLaidOut &&
          node(bottomBar(secondCalendar), "bottom-tab-schedule-icon").isLaidOut
      }
      scenario.onActivity {
        val secondCalendar = secondCalendarRef.get()
        val secondBar = bottomBar(secondCalendar)
        assertEquals(0, secondBar.selectedAnimationPlayCount())
        assertNull((node(secondBar, "bottom-tab-schedule-icon") as ImageView).animation)
        calendarProbeRef.set(
          SelectionMotionProbe(selectionAnimation(secondBar, "bottom-tab-schedule")),
        )
        secondCalendar.setBottomBarSelectionCommand(2)
      }
      awaitCompletedSelectionMotion(scenario, calendarProbeRef.get())

      scenario.onActivity {
        val minutesBar = bottomBar(minutesRef.get())
        val secondCalendar = secondCalendarRef.get()
        val secondBar = bottomBar(secondCalendar)
        assertEquals(1, minutesBar.selectedAnimationPlayCount())
        assertFalse(node(minutesBar, "bottom-tab-schedule").isSelected)
        assertTrue(node(minutesBar, "bottom-tab-meetings").isSelected)
        assertTrue(node(secondBar, "bottom-tab-schedule").isSelected)
        assertFalse(node(secondBar, "bottom-tab-meetings").isSelected)

        secondCalendar.setBottomBarSelectionCommand(2)
        assertEquals(1, secondBar.selectedAnimationPlayCount())
        assertTrue(node(secondBar, "bottom-tab-schedule").performClick())
        assertEquals(1, secondBar.selectedAnimationPlayCount())
      }
      assertNoDelayedSelectionReplay(
        scenario,
        root = { secondCalendarRef.get() },
        probe = calendarProbeRef.get(),
        expectedPlayCount = 1,
      )
    }
  }

  private fun bottomBarContract() = EvidenceTreeContract(
    evidenceId = "UI-SHELL-BOTTOM-MAIN-001",
    nodes = listOf(
      EvidenceNodeContract("bottom-bar", "navigation", null, "LaojiNativeBottomBarView"),
      EvidenceNodeContract("bottom-bar-divider", "divider", "bottom-bar", "View"),
      EvidenceNodeContract("bottom-tab-schedule", "tab", "bottom-bar", "NativeBottomTabItemView", heightDp = 65f),
      EvidenceNodeContract("bottom-tab-schedule-icon-container", "icon-container", "bottom-tab-schedule", "FrameLayout", widthDp = 38f, heightDp = 30f),
      EvidenceNodeContract("bottom-tab-schedule-icon", "icon", "bottom-tab-schedule-icon-container", "ImageView", widthDp = 22f, heightDp = 22f),
      EvidenceNodeContract("bottom-tab-schedule-label", "label", "bottom-tab-schedule", "TextView"),
      EvidenceNodeContract("bottom-tab-meetings", "tab", "bottom-bar", "NativeBottomTabItemView", heightDp = 65f),
      EvidenceNodeContract("bottom-tab-meetings-icon-container", "icon-container", "bottom-tab-meetings", "FrameLayout", widthDp = 38f, heightDp = 30f),
      EvidenceNodeContract("bottom-tab-meetings-icon", "icon", "bottom-tab-meetings-icon-container", "ImageView", widthDp = 22f, heightDp = 22f),
      EvidenceNodeContract("bottom-tab-meetings-label", "label", "bottom-tab-meetings", "TextView"),
    ),
    dimensionToleranceDp = 0.6f,
    rejectUnmappedVisibleOrActionable = true,
  )

  private fun node(root: View, semanticKey: String): View = root.descendants().single {
    FeishuEvidenceRuntime.ref(it)?.semanticKey == semanticKey
  }

  private fun bottomBar(root: View): LaojiNativeBottomBarView =
    root.descendants().filterIsInstance<LaojiNativeBottomBarView>().single()

  private fun testAppContext(reactApplicationContext: Any): AppContext {
    val modulesProvider = object : ModulesProvider {
      override fun getModulesList() = emptyList<Class<out expo.modules.kotlin.modules.Module>>()
    }
    return AppContext::class.java.constructors
      .single { it.parameterTypes.size == 3 }
      .newInstance(
        modulesProvider,
        ModuleRegistry(emptyList(), emptyList()),
        WeakReference(reactApplicationContext),
      ) as AppContext
  }

  private fun matchParentLayoutParams() = ViewGroup.LayoutParams(
    ViewGroup.LayoutParams.MATCH_PARENT,
    ViewGroup.LayoutParams.MATCH_PARENT,
  )

  private fun selectionAnimation(bar: LaojiNativeBottomBarView, tabSemanticKey: String): Animation {
    val tab = node(bar, tabSemanticKey)
    return tab.javaClass.getDeclaredField("selectAnimation").apply { isAccessible = true }
      .get(tab) as Animation
  }

  private fun awaitCompletedSelectionMotion(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    probe: SelectionMotionProbe,
  ) {
    val animation = probe.animation
    assertTrue(animation is ScaleAnimation)
    assertEquals(NativeBottomBarContract.PRESS_LEG_DURATION_MS, animation.duration)
    assertEquals(1, animation.repeatCount)
    assertEquals(Animation.REVERSE, animation.repeatMode)
    waitUntil(scenario) { probe.startCount.get() == 1 }
    waitUntil(scenario, timeoutMs = 1_500L) { probe.endCount.get() == 1 }
    val minimumElapsed =
      NativeBottomBarContract.PRESS_LEG_DURATION_MS * (animation.repeatCount + 1) - 34L
    assertTrue(
      "selection motion ended before both source legs completed",
      probe.firstEndAt.get() - probe.firstStartAt.get() >= minimumElapsed,
    )
    assertEquals(1, probe.startCount.get())
    assertEquals(1, probe.endCount.get())
    assertTrue(animation.hasStarted())
    assertTrue(animation.hasEnded())
  }

  private fun assertNoDelayedSelectionReplay(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    root: () -> View,
    probe: SelectionMotionProbe,
    expectedPlayCount: Int,
  ) {
    SystemClock.sleep(NativeBottomBarContract.PRESS_LEG_DURATION_MS * 2 + 50L)
    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    scenario.onActivity {
      assertEquals(expectedPlayCount, bottomBar(root()).selectedAnimationPlayCount())
      assertEquals(1, probe.startCount.get())
      assertEquals(1, probe.endCount.get())
      assertTrue(probe.animation.hasEnded())
    }
  }

  private class SelectionMotionProbe(val animation: Animation) : Animation.AnimationListener {
    val startCount = AtomicInteger()
    val endCount = AtomicInteger()
    val firstStartAt = AtomicLong(-1L)
    val firstEndAt = AtomicLong(-1L)

    init {
      animation.setAnimationListener(this)
    }

    override fun onAnimationStart(animation: Animation?) {
      if (startCount.incrementAndGet() == 1) firstStartAt.set(SystemClock.uptimeMillis())
    }

    override fun onAnimationEnd(animation: Animation?) {
      if (endCount.incrementAndGet() == 1) firstEndAt.set(SystemClock.uptimeMillis())
    }

    override fun onAnimationRepeat(animation: Animation?) = Unit
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
        .newInstance(bridgeContext, activity, "NativeBottomBarInstrumentedTest", -1) as? Context,
    )
    val catalystClass = Class.forName("com.facebook.react.bridge.CatalystInstance")
    val catalyst = Proxy.newProxyInstance(catalystClass.classLoader, arrayOf(catalystClass)) { proxy, method, args ->
      when (method.name) {
        "equals" -> proxy === args?.firstOrNull()
        "hashCode" -> System.identityHashCode(proxy)
        "toString" -> "NativeBottomBarNoOpCatalystInstance"
        "getNativeModules" -> emptyList<Any>()
        "hasNativeModule", "isDestroyed" -> false
        else -> primitiveDefault(method.returnType)
      }
    }
    bridgeContextClass.getDeclaredField("mCatalystInstance").apply { isAccessible = true }
      .set(bridgeContext, catalyst)
    retainedReactContexts.addAll(listOf(bridgeContext, themedContext, catalyst))
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
    assertTrue("condition was not met within ${timeoutMs}ms", condition())
  }

  private fun View.descendants(): List<View> = buildList {
    fun visit(view: View) {
      add(view)
      if (view is ViewGroup) repeat(view.childCount) { visit(view.getChildAt(it)) }
    }
    visit(this@descendants)
  }
}
