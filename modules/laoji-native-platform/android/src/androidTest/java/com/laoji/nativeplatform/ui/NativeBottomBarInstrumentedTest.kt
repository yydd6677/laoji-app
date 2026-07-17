package com.laoji.nativeplatform.ui

import android.content.Context
import android.graphics.Color
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.laoji.nativeplatform.calendar.CalendarSurfaceTestActivity
import com.laoji.nativeplatform.evidence.EvidenceNodeContract
import com.laoji.nativeplatform.evidence.EvidenceTreeContract
import com.laoji.nativeplatform.evidence.FeishuEvidenceRuntime
import expo.modules.core.ModuleRegistry
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import java.lang.ref.WeakReference
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
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
