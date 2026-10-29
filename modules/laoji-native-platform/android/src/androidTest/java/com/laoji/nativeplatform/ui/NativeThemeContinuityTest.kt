package com.laoji.nativeplatform.ui

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.MotionEvent
import android.widget.FrameLayout
import android.widget.TextView
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.BridgeReactContext
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import java.lang.ref.WeakReference
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.laoji.nativeplatform.NativeThemePreference
import com.laoji.nativeplatform.calendar.CalendarIndicatorView
import com.laoji.nativeplatform.calendar.CalendarMode
import com.laoji.nativeplatform.calendar.CalendarShellIcon
import com.laoji.nativeplatform.calendar.CalendarShellIconView
import com.laoji.nativeplatform.calendar.CalendarTitleExpandIconView
import com.laoji.nativeplatform.calendar.CalendarUi
import com.laoji.nativeplatform.calendar.CalendarDateMath
import com.laoji.nativeplatform.calendar.CalendarEvent
import com.laoji.nativeplatform.calendar.CalendarSnapshot
import com.laoji.nativeplatform.calendar.DayPageBinding
import com.laoji.nativeplatform.calendar.DayTimelineCanvasView
import com.laoji.nativeplatform.calendar.DayWeekHeaderView
import com.laoji.nativeplatform.calendar.ThreePageMonthPager
import com.laoji.nativeplatform.calendar.CalendarQuickChooseHostView
import com.laoji.nativeplatform.calendar.CalendarQuickChooseWheelView
import com.laoji.nativeplatform.calendar.CalendarPickerContentState
import com.laoji.nativeplatform.calendar.CalendarPickerExpandState
import com.laoji.nativeplatform.calendar.CalendarPickerListener
import com.laoji.nativeplatform.calendar.CalendarCreateFabView
import com.laoji.nativeplatform.calendar.CalendarCreateAction
import com.laoji.nativeplatform.calendar.CalendarShellContract
import com.laoji.nativeplatform.calendar.DayAllDaySectionView
import com.laoji.nativeplatform.calendar.DayAllDayPageView
import com.laoji.nativeplatform.minutes.ExperienceHostActivity
import com.laoji.nativeplatform.calendarpages.*
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Existing production controls: switch the preference, not their Activity. */
@RunWith(AndroidJUnit4::class)
class NativeThemeContinuityTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)

  @Test fun openNativeOverlaysKeepTheirActionsAndToastLifetimeAcrossSkins() {
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(Intent(base, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    lateinit var app: AppContext
    try {
      onMain {
        val react: ReactApplicationContext = BridgeReactContext(base)
        app = AppContext(object : ModulesProvider {
          override fun getModulesList(): List<Class<out Module>> = emptyList()
        }, expo.modules.core.ModuleRegistry(emptyList(), emptyList()), WeakReference(react))
      }
      for (kind in listOf("dialog", "sheet", "toast")) {
        lateinit var overlay: View
        val actions = mutableListOf<Map<String, Any?>>()
        val dismissals = mutableListOf<Map<String, Any?>>()
        onMain {
          NativeThemePreference.write(base, "neutral")
          overlay = when (kind) {
            "dialog" -> LaojiNativeDialogHostView(host, app).apply {
              setBridgeEventsEnabled(false); setActionListener(actions::add); setDismissListener(dismissals::add)
              setSnapshot(mapOf("visible" to true, "title" to "删除录音", "message" to "录音将移到回收站。",
                "tone" to "danger", "actions" to listOf(mapOf("text" to "删除", "role" to "destructive"),
                  mapOf("text" to "取消", "role" to "cancel"))))
            }
            "sheet" -> LaojiNativeActionSheetHostView(host, app).apply {
              setBridgeEventsEnabled(false); setItemListener(actions::add); setDismissListener(dismissals::add)
              setSnapshot(mapOf("visible" to true, "title" to "录音", "items" to listOf(
                mapOf("key" to "open", "label" to "打开"),
                mapOf("key" to "delete", "label" to "删除", "destructive" to true),
                mapOf("key" to "unavailable", "label" to "暂不可用", "disabled" to true))))
            }
            else -> NativeToastHostView(host, app).apply {
              setDismissListener(dismissals::add)
              setSnapshot(mapOf("visible" to true, "message" to "名称已保存", "durationMs" to null))
            }
          }
          host.setContentView(overlay)
        }
        SystemClock.sleep(350)
        instrumentation.waitForIdleSync()
        var children = emptyList<View>()
        var originalBounds = emptyList<Rect>()
        var shownAt = 0L
        var sequence = 0L
        onMain {
          children = descendants(overlay); originalBounds = children.map(::bounds)
          if (kind == "toast") {
            shownAt = field(overlay, "shownAtElapsedMs"); sequence = field(overlay, "activeSequence")
          }
        }
        for (skin in listOf("vivid", "paper", "midnight", "neutral")) {
          onMain { NativeThemePreference.write(base, skin) }
          instrumentation.waitForIdleSync()
          onMain {
            assertEquals(children, descendants(overlay))
            assertEquals(originalBounds, children.map(::bounds))
            assertTrue(actions.isEmpty()); assertTrue(dismissals.isEmpty())
            val palette = NativeUiTokens.palette(host)
            if (kind == "toast") {
              val message = children.filterIsInstance<TextView>().single()
              assertEquals("名称已保存", message.text.toString()); assertEquals(palette.onTips, message.currentTextColor)
              assertEquals(shownAt, field<Long>(overlay, "shownAtElapsedMs"))
              assertEquals(sequence, field<Long>(overlay, "activeSequence"))
            } else {
              val delete = children.filterIsInstance<TextView>().single { it.text.toString() == "删除" }
              assertEquals(palette.danger, delete.currentTextColor)
              if (kind == "sheet") {
                val disabled = children.filterIsInstance<TextView>().single { it.text.toString() == "暂不可用" }
                assertFalse(disabled.isEnabled); assertFalse(disabled.isClickable)
                assertEquals(palette.textDisabled, disabled.currentTextColor)
              }
            }
          }
        }
        onMain {
          if (kind == "toast") (overlay as NativeToastHostView).dismiss("test-finished")
          else children.filterIsInstance<TextView>().single { it.text.toString() == "删除" }.performClick()
          if (kind == "dialog") assertEquals(listOf(0), actions.map { it["index"] })
          if (kind == "sheet") assertEquals(listOf("delete"), actions.map { it["key"] })
        }
        SystemClock.sleep(350)
        instrumentation.waitForIdleSync()
        onMain { if (kind != "dialog") assertEquals(1, dismissals.size) }
      }
    } finally {
      onMain { NativeThemePreference.write(base, previous); host.finish() }
    }
  }

  @Test fun timeEditorKeepsItsEndpointSwitchesAndWheelPositionAcrossSkins() {
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(Intent(base, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val draft = CalendarEditDraft(title = "读书交流", startDate = "2026-10-28", endDate = "2026-10-28",
      startTime = "15:30", endTime = "17:45", notes = "带上读书笔记")
    val initial = CalendarEditTimeState.fromDraft(draft, CalendarEditEndpoint.END)
    val completions = mutableListOf<CalendarEditDraft>()
    lateinit var page: CalendarEditTimePageView
    var children = emptyList<View>()
    lateinit var wheel: CalendarEditWheelView
    lateinit var endSwitch: CalendarSourceSwitch
    var wheelBounds = Rect()
    var geometry: CalendarEditWheelGeometry? = null
    try {
      onMain {
        NativeThemePreference.write(base, "neutral")
        page = CalendarEditTimePageView(host, initial, {}, completions::add)
        host.setContentView(page)
      }
      instrumentation.waitForIdleSync()
      onMain {
        children = descendants(page)
        wheel = field(page, "hourWheel")
        endSwitch = field(page, "endTimeSwitch")
        wheelBounds = bounds(wheel); geometry = wheel.geometryForTest()
        assertEquals(17, wheel.selectedValue)
        assertTrue(endSwitch.isChecked)
      }
      for (skin in listOf("vivid", "paper", "midnight", "neutral")) {
        onMain { NativeThemePreference.write(base, skin) }
        instrumentation.waitForIdleSync()
        onMain {
          assertEquals(children, descendants(page))
          assertEquals(initial, page.currentState())
          assertEquals(17, wheel.selectedValue)
          assertEquals(wheelBounds, bounds(wheel)); assertEquals(geometry, wheel.geometryForTest())
          assertTrue(endSwitch.isChecked)
          val switchBitmap = Bitmap.createBitmap(endSwitch.width, endSwitch.height, Bitmap.Config.ARGB_8888)
          endSwitch.draw(Canvas(switchBitmap)); switchBitmap.recycle()
          val thumbColor = if (skin == "neutral") androidx.core.content.ContextCompat.getColor(host,
            com.laoji.nativeplatform.R.color.laoji_ud_switch_on_thumb) else CalendarPagePalette.primary
          assertEquals(thumbColor, field<android.graphics.Paint>(endSwitch, "paint").color)
          val paint = field<android.graphics.Paint>(wheel, "centerPaint")
          assertEquals(CalendarPagePalette.text, paint.color)
          assertEquals(LaojiThemeTypography.typeface(host), paint.typeface)
          val done = descendants(page).filterIsInstance<TextView>().single { it.text == "完成" }
          assertEquals(CalendarPagePalette.primary, done.currentTextColor)
          assertEquals(LaojiThemeTypography.typeface(host), done.typeface)
          assertTrue(completions.isEmpty())
        }
      }
      onMain {
        descendants(page).filterIsInstance<TextView>().single { it.text == "完成" }.performClick()
        assertEquals(listOf(initial.completedDraft()), completions)
      }
    } finally { onMain { page.dispose(); NativeThemePreference.write(base, previous); host.finish() } }
  }

  @Test fun repeatEndAndDisabledTitleActionKeepMeaningWithoutRebuildingThePage() {
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(Intent(base, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val draft = CalendarEditDraft(title = "每周读书", startDate = "2026-10-28", endDate = "2026-10-28",
      repeat = "weekly", recurrenceUntilDate = "2027-01-02")
    val completions = mutableListOf<CalendarEditDraft>()
    lateinit var page: CalendarRepeatEndPageView
    lateinit var titleBar: CalendarCommonTitleBar
    lateinit var save: TextView
    lateinit var year: CalendarEditWheelView
    var children = emptyList<View>()
    var clicks = 0
    try {
      onMain {
        NativeThemePreference.write(base, "neutral")
        val root = android.widget.LinearLayout(host).apply { orientation = android.widget.LinearLayout.VERTICAL }
        titleBar = CalendarCommonTitleBar(host)
        titleBar.setCenterTitle("新建日程")
        titleBar.setLeftTextAction("取消") {}
        save = titleBar.addRightTextAction("保存", { CalendarTitleSaveContract.color(CalendarTitleSaveType.DISABLE_SAVE_WITH_FEEDBACK) }, debounce = false) { clicks++ }
        page = CalendarRepeatEndPageView(host, CalendarRepeatEndState.fromDraft(draft), {}, completions::add)
        root.addView(titleBar, ViewGroup.LayoutParams(-1, host.resources.displayMetrics.density.times(44).toInt()))
        root.addView(page, ViewGroup.LayoutParams(-1, -1))
        host.setContentView(root)
      }
      instrumentation.waitForIdleSync()
      onMain { children = descendants(page); year = field(page, "yearWheel") }
      for (skin in listOf("paper", "midnight", "vivid", "neutral")) {
        onMain { NativeThemePreference.write(base, skin) }
        instrumentation.waitForIdleSync()
        onMain {
          assertEquals(children, descendants(page))
          assertEquals(2027, year.selectedValue)
          assertEquals(CalendarRepeatEndState.fromDraft(draft), field<CalendarRepeatEndState>(page, "state"))
          assertFalse(field<CalendarSourceSwitch>(page, "neverEndsSwitch").isChecked)
          assertEquals(CalendarPagePalette.disabled, save.currentTextColor)
          assertEquals(LaojiThemeTypography.typeface(host), save.typeface)
          assertEquals(0, clicks); assertTrue(completions.isEmpty())
        }
      }
      onMain { save.performClick(); assertEquals(1, clicks) }
    } finally { onMain { page.dispose(); NativeThemePreference.write(base, previous); host.finish() } }
  }

  @Test fun openDatePanelAndYearMonthWheelsKeepTheirStateAcrossSkins() {
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(Intent(base, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val day = CalendarDateMath.toEpochDay(2026, 10, 28)
    val commits = mutableListOf<Int>()
    lateinit var panel: CalendarQuickChooseHostView
    lateinit var root: FrameLayout
    lateinit var selected: TextView
    try {
      onMain {
        NativeThemePreference.write(base, "neutral")
        root = FrameLayout(host)
        panel = CalendarQuickChooseHostView(host)
        panel.setListener(object : CalendarPickerListener {
          override fun onPickerDateCommitted(epochDay: Int) { commits.add(epochDay) }
          override fun onPickerExpandStateChanged(state: CalendarPickerExpandState) = Unit
          override fun onPickerContentStateChanged(state: CalendarPickerContentState) = Unit
        })
        root.addView(panel, FrameLayout.LayoutParams(1080, 1800))
        host.setContentView(root)
        measure(root, 2000)
        panel.prepare(day, CalendarMode.DAY)
        panel.open(day, CalendarMode.DAY)
      }
      awaitMain("date panel not open") { panel.expandState == CalendarPickerExpandState.OPENED &&
        descendants(panel).filterIsInstance<TextView>().any { it.contentDescription == "2026年10月28日，已选择" } }
      onMain { selected = descendants(panel).filterIsInstance<TextView>()
        .single { it.contentDescription == "2026年10月28日，已选择" } }
      var selectedBounds = Rect()
      onMain { selectedBounds = bounds(selected) }
      for (skin in listOf("vivid", "paper", "midnight", "neutral")) {
        var selectionColor = 0
        onMain { NativeThemePreference.write(base, skin); selectionColor = CalendarUi.palette(host).accent }
        // Selected text is white in every skin; also wait for its changed circle,
        // otherwise a previous skin's already-presented white glyph is not proof.
        val frame = presentedLabelFrame(selected, selectionColor)
        val output = File(base.filesDir, "theme-continuity").apply { mkdirs() }
        File(output, "date-$skin.png").outputStream().use { frame.compress(Bitmap.CompressFormat.PNG, 100, it) }
        frame.recycle()
        onMain {
          assertTrue(descendants(panel).any { it === selected })
          assertEquals(selectedBounds, bounds(selected))
          assertEquals(CalendarPickerContentState.DATE_PANEL, panel.contentState)
          assertEquals(CalendarPickerExpandState.OPENED, panel.expandState)
          assertEquals(CalendarDateMath.monthStart(day), panel.datePageMonthForTest())
          assertEquals(CalendarUi.palette(host).accentText, selected.currentTextColor)
          assertEquals(LaojiThemeTypography.typeface(host), selected.typeface)
          assertTrue("theme must not commit a date", commits.isEmpty())
        }
      }
      onMain { panel.toggleContentForTest() }
      awaitMain("year-month panel not open") { panel.contentState == CalendarPickerContentState.YEAR_MONTH_PANEL }
      lateinit var wheels: List<CalendarQuickChooseWheelView>
      onMain {
        wheels = descendants(panel).filterIsInstance<CalendarQuickChooseWheelView>()
        panel.settleYearForTest(2027)
        panel.settleMonthForTest(2)
      }
      var wheelBounds = emptyList<Rect>()
      var committedCount = 0
      onMain { wheelBounds = wheels.map(::bounds); committedCount = commits.size }
      for (skin in listOf("paper", "midnight", "vivid", "neutral")) {
        onMain {
          NativeThemePreference.write(base, skin)
          assertEquals(listOf(2027, 2), wheels.map { it.selectedValue })
          assertEquals(wheelBounds, wheels.map(::bounds))
          assertEquals(CalendarPickerContentState.YEAR_MONTH_PANEL, panel.contentState)
          assertEquals(committedCount, commits.size)
          wheels.forEach { wheel ->
            val paint = field<android.graphics.Paint>(wheel, "centerPaint")
            assertEquals(CalendarUi.palette(host).textPrimary, paint.color)
            assertEquals(LaojiThemeTypography.typeface(host), paint.typeface)
          }
        }
      }
      onMain { panel.toggleContentForTest() }
      awaitMain("date panel did not return") { panel.contentState == CalendarPickerContentState.DATE_PANEL }
      onMain {
        assertEquals(CalendarDateMath.toEpochDay(2027, 2, 1), panel.datePageMonthForTest())
        panel.close()
      }
      awaitMain("date panel did not close") { panel.expandState == CalendarPickerExpandState.CLOSED }
    } finally { onMain { panel.dispose(); NativeThemePreference.write(base, previous); host.finish() } }
  }

  @Test fun expandedAllDayScrollAndHeldCreateGestureSurviveSkinChanges() {
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(Intent(base, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val day = CalendarDateMath.toEpochDay(2026, 10, 28)
    val events = (1..12).map { index -> CalendarEvent(sourceEventId = "all-$index", occurrenceDate = "2026-10-28",
      title = "读书安排$index", category = "学习", startEpochDay = day, endEpochDay = day + 1,
      startMinutes = null, endMinutes = null, timeZoneId = "Asia/Shanghai", allDay = true, editable = true, revision = 1) }
    lateinit var section: DayAllDaySectionView
    lateinit var page: DayAllDayPageView
    lateinit var layer: View
    lateinit var fab: CalendarCreateFabView
    val actions = mutableListOf<CalendarCreateAction>()
    var downTime = 0L
    var voiceX = 0f
    var voiceY = 0f
    try {
      onMain {
        NativeThemePreference.write(base, "neutral")
        val root = FrameLayout(host)
        section = DayAllDaySectionView(host).apply { bind(events, day, 47); setExpanded(true, false) }
        fab = CalendarCreateFabView(host).apply { setActionListener { actions.add(it) } }
        root.addView(section, FrameLayout.LayoutParams(1080, 600))
        root.addView(fab, FrameLayout.LayoutParams(700, 700).apply { topMargin = 800; leftMargin = 200 })
        host.setContentView(root)
        measure(root, 2000)
      }
      instrumentation.waitForIdleSync()
      onMain {
        page = descendants(section).filterIsInstance<DayAllDayPageView>().single { it.boundEpochDay == day }
        layer = page.instanceLayerForTest()!!
        val scroll = descendants(page).filterIsInstance<android.widget.ScrollView>().single()
        scroll.scrollTo(0, 90)
        assertEquals(90, page.currentScrollY())
        val x = fab.width - CalendarUi.dp(host, CalendarShellContract.FAB_SIZE_DP) / 2f
        val y = fab.height - CalendarUi.dp(host, CalendarShellContract.FAB_SIZE_DP) / 2f
        voiceX = x + CalendarUi.dp(host, CalendarShellContract.FAB_VOICE_OFFSET_X_DP)
        voiceY = y + CalendarUi.dp(host, CalendarShellContract.FAB_VOICE_OFFSET_Y_DP)
        downTime = SystemClock.uptimeMillis()
        sendTouch(fab, downTime, MotionEvent.ACTION_DOWN, x, y)
      }
      awaitMain("create long press did not open") { field<Boolean>(fab, "radialVisible") && field<Float>(fab, "expansionProgress") == 1f }
      onMain { sendTouch(fab, downTime, MotionEvent.ACTION_MOVE, voiceX, voiceY) }
      for (skin in listOf("vivid", "paper", "midnight", "neutral")) {
        onMain {
          NativeThemePreference.write(base, skin)
          assertTrue(section.isExpanded())
          assertEquals(12, section.stableEventCount())
          assertSame(layer, page.instanceLayerForTest())
          assertEquals(90, page.currentScrollY())
          assertEquals(47, page.boundGeneration)
          assertEquals(CalendarCreateAction.VOICE, field<CalendarCreateAction>(fab, "selectedAction"))
          assertTrue(field<Boolean>(fab, "dragSelecting"))
          assertEquals(1f, field<Float>(fab, "expansionProgress"), 0f)
          assertTrue(actions.isEmpty())
          val paint = field<android.graphics.Paint>(fab, "fabPaint")
          assertEquals(CalendarUi.palette(host).accent, paint.color)
          val bitmap = Bitmap.createBitmap(fab.width, fab.height, Bitmap.Config.ARGB_8888)
          fab.draw(Canvas(bitmap))
          val centerX = fab.width - (CalendarUi.dp(host, CalendarShellContract.FAB_SIZE_DP) / 2f).toInt()
          assertEquals(CalendarUi.palette(host).accent, bitmap.getPixel(centerX - 22, fab.height - 30))
          bitmap.recycle()
        }
      }
      onMain { sendTouch(fab, downTime, MotionEvent.ACTION_UP, voiceX, voiceY) }
      awaitMain("release did not commit the selected action") { actions == listOf(CalendarCreateAction.VOICE) }
      onMain { assertEquals(90, page.currentScrollY()); assertFalse(field<Boolean>(fab, "radialVisible")) }
    } finally { onMain { NativeThemePreference.write(base, previous); host.finish() } }
  }

  @Suppress("UNCHECKED_CAST")
  private fun <T> field(owner: Any, name: String): T = owner.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(owner) as T

  private fun sendTouch(view: View, downTime: Long, action: Int, x: Float, y: Float) {
    MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0).also { view.onTouchEvent(it); it.recycle() }
  }

  @Test fun monthAndDayKeepTheirDateEventAndScrollDuringSkinChanges() {
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(Intent(base, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val day = CalendarDateMath.toEpochDay(2026, 10, 28)
    val event = CalendarEvent(sourceEventId = "read", occurrenceDate = "2026-10-28", title = "读书讨论会",
      category = "学习", startEpochDay = day, endEpochDay = day, startMinutes = 900, endMinutes = 960,
      timeZoneId = "Asia/Shanghai", allDay = false, editable = true, revision = 1)
    val snapshot = CalendarSnapshot(rangeStartEpochDay = day - 40, rangeEndEpochDayExclusive = day + 40,
      selectedEpochDay = day, todayEpochDay = day, events = listOf(event))
    lateinit var root: FrameLayout
    lateinit var month: ThreePageMonthPager
    lateinit var header: DayWeekHeaderView
    lateinit var timeline: DayTimelineCanvasView
    try {
      onMain {
        NativeThemePreference.write(base, "neutral")
        root = FrameLayout(host)
        month = ThreePageMonthPager(host).apply { jumpToMonth(day); setSnapshot(snapshot) }
        header = DayWeekHeaderView(host).apply { bind(day, day) }
        timeline = DayTimelineCanvasView(host).apply { bind(DayPageBinding(41L, day), snapshot) }
        root.addView(month, FrameLayout.LayoutParams(1080, 1080))
        root.addView(header, FrameLayout.LayoutParams(1080, 140).apply { topMargin = 1100 })
        root.addView(timeline, FrameLayout.LayoutParams(1080, 700).apply { topMargin = 1300 })
        host.setContentView(root)
        measure(root, 2100)
      }
      awaitMain("month pages not attached") { descendants(month).any { it.javaClass.simpleName == "MonthWeekRowView" } }
      onMain { month.returnToToday(day) }
      awaitMain("date not expanded") { month.currentExpandedEpochDay() == day && descendants(month)
        .filterIsInstance<TextView>().any { it.text.toString() == event.title } }
      onMain {
        val title = descendants(month).filterIsInstance<TextView>().first { it.text.toString() == event.title }
        val selected = descendants(header).first { it.contentDescription == "2026年10月28日，三，今天，已选择" }
        val saturday = descendants(header).first { it.contentDescription == "2026年10月31日，六" }
        val saturdayNumber = descendants(saturday).filterIsInstance<TextView>().first { it.text.toString() == "31" }
        timeline.setSelectedEventIdentity(event.identity)
        timeline.setScrollOffset(350f)
        val category = CalendarUi.eventVisual(host, event.category).border
        for (skin in listOf("vivid", "paper", "midnight", "neutral")) {
          NativeThemePreference.write(base, skin)
          measure(root, 2100)
          assertEquals(day, month.currentExpandedEpochDay())
          assertTrue(descendants(month).any { it === title })
          assertTrue(descendants(header).any { it === selected })
          assertEquals(CalendarUi.palette(host).weekendDate, saturdayNumber.currentTextColor)
          assertEquals(GeneratedUiTokens.palette(skin).blue, CalendarUi.palette(host).weekendDate)
          assertEquals(event, timeline.selectedEvent())
          assertEquals(350f, timeline.scrollOffset(), 0.01f)
          assertEquals(category, CalendarUi.eventVisual(host, event.category).border)
          val image = Bitmap.createBitmap(1080, 700, Bitmap.Config.ARGB_8888)
          timeline.draw(Canvas(image))
          assertEquals(CalendarUi.palette(host).surface, image.getPixel(0, 0))
          image.recycle()
        }
      }
    } finally { onMain { NativeThemePreference.write(base, previous); host.finish() } }
  }

  @Test fun selectedNavigationAndCalendarChromeRestyleWithoutReplacingControls() {
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(Intent(base, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val output = File(base.filesDir, "theme-continuity").apply { mkdirs() }
    lateinit var root: FrameLayout
    lateinit var item: NativeBottomTabItemView
    lateinit var indicator: CalendarIndicatorView
    lateinit var expand: CalendarTitleExpandIconView
    lateinit var search: CalendarShellIconView
    lateinit var label: TextView
    lateinit var mode: View
    var frames = 0
    var taps = 0
    var initialAnimationCount = 0
    var before: List<Rect> = emptyList()
    try {
      onMain {
        NativeThemePreference.write(base, "neutral")
        root = FrameLayout(host)
        root.viewTreeObserver.addOnPreDrawListener { frames++; true }
        NativeUiTokens.bindTheme(root) { root.setBackgroundColor(it.surface) }
        item = NativeBottomTabItemView(host, NativeBottomTab.MEETINGS, NativeUiTokens.palette(host)) { taps++ }
        indicator = CalendarIndicatorView(host).apply { setMode(CalendarMode.DAY) }
        expand = CalendarTitleExpandIconView(host).apply { setExpandProgress(0.4f) }
        search = CalendarShellIconView(host, CalendarShellIcon.SEARCH)
        root.addView(item, FrameLayout.LayoutParams(540, 220))
        root.addView(indicator, FrameLayout.LayoutParams(1080, 130).apply { topMargin = 260 })
        root.addView(expand, FrameLayout.LayoutParams(80, 80).apply { topMargin = 430; leftMargin = 80 })
        root.addView(search, FrameLayout.LayoutParams(110, 110).apply { topMargin = 430; leftMargin = 300 })
        host.setContentView(root)
        item.setItemSelected(true)
        measure(root)
        label = descendants(item).filterIsInstance<TextView>().single()
        mode = descendants(indicator).single { it.contentDescription == "切换到月视图" }
      }
      awaitMain("navigation label has no drawn layout") { frames > 0 && label.layout != null }
      onMain {
        assertTrue("navigation label must be measured, got ${label.width} x ${label.height}", label.width > 0 && label.height > 0)
        before = listOf(item, indicator, mode, expand, search).map(::bounds)
        initialAnimationCount = item.selectionAnimationPlayCount()
      }
      for (skin in listOf("vivid", "paper", "midnight", "neutral")) {
        var priorFrame = 0
        onMain { priorFrame = frames; NativeThemePreference.write(base, skin) }
        awaitMain("skin did not reach a frame") { frames > priorFrame && !root.isLayoutRequested }
        val presented = presentedLabelFrame(label)
        onMain {
          assertSame(label, descendants(item).filterIsInstance<TextView>().single())
          assertSame(mode, descendants(indicator).single { it.contentDescription == "切换到月视图" })
          assertEquals(before, listOf(item, indicator, mode, expand, search).map(::bounds))
          assertTrue(item.isSelected)
          assertEquals(NativeUiTokens.palette(host).primary, label.currentTextColor)
          assertEquals(LaojiThemeTypography.typeface(host), label.typeface)
          assertEquals(initialAnimationCount, item.selectionAnimationPlayCount())
          assertEquals(72f, expand.rotation, 0.01f)
          assertEquals(CalendarUi.palette(host).textPrimary,
            descendants(indicator).filterIsInstance<TextView>().single().currentTextColor)
          val icon = Bitmap.createBitmap(80, 80, Bitmap.Config.ARGB_8888)
          expand.draw(Canvas(icon))
          assertEquals(CalendarUi.palette(host).textSecondary, icon.getPixel(40, 40))
          icon.recycle()
        }
        File(output, "$skin.png").outputStream().use { presented.compress(Bitmap.CompressFormat.PNG, 100, it) }
        presented.recycle()
      }
      onMain {
        item.performClick()
        assertEquals(1, taps)
        assertFalse(host.isFinishing)
      }
    } finally {
      onMain { NativeThemePreference.write(base, previous); host.finish() }
    }
  }

  @Test fun backgroundPreferenceChangeIsAppliedOnMainAndCachedViewsStayBound() {
    val context = instrumentation.targetContext
    val previous = NativeThemePreference.read(context)
    lateinit var cached: View
    val received = mutableListOf<Int>()
    try {
      onMain {
        NativeThemePreference.write(context, "neutral")
        cached = View(context)
        NativeUiTokens.bindTheme(cached) { palette ->
          assertEquals(Looper.getMainLooper(), Looper.myLooper())
          cached.setBackgroundColor(palette.surface)
          received.add(palette.primary)
        }
        assertThrows(IllegalStateException::class.java) { NativeUiTokens.bindTheme(cached) {} }
      }
      Thread { NativeThemePreference.write(context, "midnight") }.apply { start(); join() }
      onMain {
        assertEquals(listOf(GeneratedUiTokens.palette("neutral").primary,
          GeneratedUiTokens.palette("midnight").primary), received)
        assertFalse(cached.isAttachedToWindow)
        NativeThemePreference.write(context, "midnight")
        assertEquals("same preference does not replay the UI", 2, received.size)
      }
    } finally { onMain { NativeThemePreference.write(context, previous) } }
  }

  private fun awaitMain(message: String, condition: () -> Boolean) {
    val deadline = SystemClock.uptimeMillis() + 5000
    do {
      var passed = false
      onMain { passed = condition() }
      if (passed) return
      SystemClock.sleep(16)
    } while (SystemClock.uptimeMillis() < deadline)
    fail(message)
  }

  private fun presentedLabelFrame(label: TextView, expectedBackground: Int? = null): Bitmap {
    val rect = Rect()
    var expected = 0
    onMain { assertTrue(label.getGlobalVisibleRect(rect)); expected = label.currentTextColor }
    val deadline = SystemClock.uptimeMillis() + 2000
    do {
      val screen = instrumentation.uiAutomation.takeScreenshot()
      if (screen != null) {
        val visible = Rect(rect)
        if (visible.intersect(0, 0, screen.width, screen.height)) {
          val pixels = IntArray(visible.width() * visible.height())
          screen.getPixels(pixels, 0, visible.width(), visible.left, visible.top, visible.width(), visible.height())
          if (pixels.any { it == expected } &&
            (expectedBackground == null || pixels.any { it == expectedBackground })) return screen
        }
        screen.recycle()
      }
      SystemClock.sleep(16)
    } while (SystemClock.uptimeMillis() < deadline)
    throw AssertionError("navigation glyph with the current token did not reach the display")
  }

  private fun measure(view: View, height: Int = 700) {
    view.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
    view.layout(0, 0, 1080, height)
  }
  private fun bounds(view: View) = Rect(view.left, view.top, view.right, view.bottom)
  private fun descendants(view: View): List<View> = listOf(view) +
    if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
}
