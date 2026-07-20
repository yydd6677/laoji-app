package com.laoji.nativeplatform.calendarpages

// UI-TITLE-COMMON-001 / CAL-REPEAT-RRULE-001: runtime geometry is checked against
// the source-derived CommonTitleBar contract and real calendar page variants.

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.laoji.nativeplatform.R
import com.laoji.nativeplatform.calendar.CalendarSurfaceTestActivity
import com.laoji.nativeplatform.evidence.EvidenceNodeContract
import com.laoji.nativeplatform.evidence.EvidenceTreeContract
import com.laoji.nativeplatform.evidence.FeishuEvidence
import com.laoji.nativeplatform.evidence.FeishuEvidenceRuntime
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@FeishuEvidence("UI-TITLE-COMMON-001", "CAL-REPEAT-RRULE-001")
class CalendarCommonTitleBarInstrumentedTest {
  @Test
  fun timeVariantUsesMeasuredSideCenteringAndSourceTypography() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val titleBarRef = AtomicReference<CalendarCommonTitleBar>()
      scenario.onActivity { activity ->
        val titleBar = CalendarCommonTitleBar(activity).apply {
          setCenterTitle("时间")
          setDividerVisible(false)
          setLeftTextAction("取消") {}
          addRightTextAction("完成", CalendarPagePalette.primary) {}
        }
        activity.root.addView(titleBar, matchWidthHeight(activity, 44f))
        titleBarRef.set(titleBar)
      }
      waitUntil(scenario) { titleBarRef.get().isLaidOut }

      scenario.onActivity { activity ->
        val titleBar = titleBarRef.get()
        assertTrue(FeishuEvidenceRuntime.validate(titleBar, contract(actionCount = 1)).isEmpty())
        val centerContainer = node(titleBar, "calendar-title-center-container")
        val center = node(titleBar, "calendar-title-center") as TextView
        val leading = node(titleBar, "calendar-title-leading") as TextView
        val trailing = node(titleBar, "calendar-title-action-0") as TextView
        val divider = node(titleBar, "calendar-title-divider")

        assertEquals(LinearLayout::class.java, titleBar.javaClass.superclass)
        assertEquals(
          listOf(
            "calendar-title-leading",
            "calendar-title-secondary",
            "calendar-title-leading-container",
            "calendar-title-center-container",
            "calendar-title-actions",
            "calendar-title-divider",
          ),
          (0 until titleBar.childCount).map { index ->
            requireNotNull(FeishuEvidenceRuntime.ref(titleBar.getChildAt(index))).semanticKey
          },
        )
        assertEquals(dp(activity, 44f), titleBar.height)
        assertEquals(18f, center.textSize / activity.resources.displayMetrics.scaledDensity, 0.1f)
        assertEquals(17f, leading.textSize / activity.resources.displayMetrics.scaledDensity, 0.1f)
        assertEquals(17f, trailing.textSize / activity.resources.displayMetrics.scaledDensity, 0.1f)
        assertFalse(center.typeface.isBold)
        assertFalse(leading.typeface.isBold)
        assertFalse(trailing.typeface.isBold)
        assertTrue(center.includeFontPadding)
        assertTrue(leading.includeFontPadding)
        assertTrue(trailing.includeFontPadding)
        assertEquals(titleBar.width / 2f, (centerContainer.left + centerContainer.right) / 2f, 1f)
        assertEquals(View.GONE, divider.visibility)
        assertEquals(Color.argb(38, 31, 35, 41), (divider.background as ColorDrawable).color)
      }
    }
  }

  @Test
  fun ordinaryEditHasNoInventedCenterOrSavingLabel() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val titleBarRef = AtomicReference<CalendarCommonTitleBar>()
      val callbackCount = AtomicInteger()
      scenario.onActivity { activity ->
        val titleBar = CalendarCommonTitleBar(activity).apply {
          setCenterTitle("")
          setLeftTextAction("取消") {}
          addRightTextAction(
            "保存",
            CalendarTitleSaveContract.color(CalendarTitleSaveType.DISABLE_SAVE_TOTALLY),
          ) { callbackCount.incrementAndGet() }
        }
        activity.root.addView(titleBar, matchWidthHeight(activity, 44f))
        titleBarRef.set(titleBar)
      }
      waitUntil(scenario) { titleBarRef.get().isLaidOut }

      scenario.onActivity {
        val titleBar = titleBarRef.get()
        val centerContainer = node(titleBar, "calendar-title-center-container")
        val save = node(titleBar, "calendar-title-action-0") as TextView
        val center = node(titleBar, "calendar-title-center") as TextView
        assertEquals(View.VISIBLE, centerContainer.visibility)
        assertEquals("", center.text.toString())
        assertEquals("保存", save.text.toString())
        assertEquals("保存", save.contentDescription.toString())
        assertTrue(save.isClickable)
        assertTrue(save.performClick())
        assertTrue(save.performClick())
        assertEquals(1, callbackCount.get())
      }
    }
  }

  @Test
  fun detailVariantUsesTransparentSecondaryTitleAndSmallActionSlots() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val titleBarRef = AtomicReference<CalendarCommonTitleBar>()
      scenario.onActivity { activity ->
        val titleBar = CalendarCommonTitleBar(activity).apply {
          setTransparentBackground()
          setSecondaryLeftTitle("项目评审", CalendarPagePalette.primaryHeader, 0.5f)
          setLeftIconAction(
            R.drawable.laoji_ic_arrow_back,
            "返回",
            Color.BLACK,
            CalendarTitleIconSize.SMALL,
            trailingPaddingDp = 0f,
          ) {}
          addRightIconAction(
            R.drawable.laoji_ic_edit_outline,
            "编辑日程",
            Color.BLACK,
            CalendarTitleIconSize.SMALL,
          ) {}
          addRightIconAction(
            R.drawable.laoji_ic_delete_outline,
            "删除日程",
            Color.BLACK,
            CalendarTitleIconSize.SMALL,
          ) {}
        }
        activity.root.addView(titleBar, matchWidthHeight(activity, 44f))
        titleBarRef.set(titleBar)
      }
      waitUntil(scenario) { titleBarRef.get().isLaidOut }

      scenario.onActivity { activity ->
        val titleBar = titleBarRef.get()
        assertTrue(FeishuEvidenceRuntime.validate(titleBar, contract(actionCount = 2)).isEmpty())
        val background = titleBar.background as ColorDrawable
        val leading = node(titleBar, "calendar-title-leading") as TextView
        val secondary = node(titleBar, "calendar-title-secondary") as TextView
        val centerContainer = node(titleBar, "calendar-title-center-container")
        val edit = node(titleBar, "calendar-title-action-0") as ImageView
        val delete = node(titleBar, "calendar-title-action-1") as ImageView
        val leadingDrawable = requireNotNull(leading.compoundDrawables[0])

        assertEquals(Color.TRANSPARENT, background.color)
        assertEquals(dp(activity, 20f), leadingDrawable.bounds.width())
        assertEquals(dp(activity, 20f), leadingDrawable.bounds.height())
        assertEquals(dp(activity, 44f), edit.width)
        assertEquals(dp(activity, 44f), delete.width)
        assertEquals(dp(activity, 9f), edit.paddingLeft)
        assertEquals(dp(activity, 15f), edit.paddingRight)
        assertEquals(0, edit.paddingTop)
        assertEquals(0, edit.paddingBottom)
        assertEquals(dp(activity, 9f), delete.paddingLeft)
        assertEquals(dp(activity, 15f), delete.paddingRight)
        assertEquals(0, delete.paddingTop)
        assertEquals(0, delete.paddingBottom)
        assertEquals(dp(activity, 42f) + dp(activity, 44f) + dp(activity, 44f), secondary.paddingRight)
        assertEquals(0.5f, secondary.alpha, 0.01f)
        assertEquals(View.VISIBLE, centerContainer.visibility)
        assertTrue(secondary.width < titleBar.width - leading.width)
        assertTrue(secondary.right <= titleBar.right)
      }
    }
  }

  @Test
  fun productionEditPageKeepsSourceCancelSaveTreeWithoutCenterTitle() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      scenario.onActivity { activity ->
        val titleBar = activity.page.descendants().filterIsInstance<CalendarCommonTitleBar>().single()
        assertTrue(FeishuEvidenceRuntime.validate(titleBar, contract(actionCount = 1)).isEmpty())
        val leading = node(titleBar, "calendar-title-leading") as TextView
        val centerContainer = node(titleBar, "calendar-title-center-container")
        val save = node(titleBar, "calendar-title-action-0") as TextView

        assertEquals("取消", leading.text.toString())
        val center = node(titleBar, "calendar-title-center") as TextView
        assertEquals(View.VISIBLE, centerContainer.visibility)
        assertEquals("", center.text.toString())
        assertEquals("保存", save.text.toString())
        assertEquals(CalendarPagePalette.primary, save.currentTextColor)
        assertTrue(titleBar.descendants().filterIsInstance<TextView>().none {
          it.text.toString() in setOf("新建日程", "编辑日程", "保存中")
        })
      }
    }
  }

  @Test
  fun productionDetailPageUsesSecondaryTitleAndTwoSmallIconActions() {
    ActivityScenario.launch(CalendarDetailPageTestActivity::class.java).use { scenario ->
      scenario.onActivity { activity ->
        val titleBar = activity.page.descendants().filterIsInstance<CalendarCommonTitleBar>().single()
        assertTrue(FeishuEvidenceRuntime.validate(titleBar, contract(actionCount = 2)).isEmpty())
        val leading = node(titleBar, "calendar-title-leading") as TextView
        val secondary = node(titleBar, "calendar-title-secondary") as TextView
        val centerContainer = node(titleBar, "calendar-title-center-container")
        val edit = node(titleBar, "calendar-title-action-0") as ImageView
        val delete = node(titleBar, "calendar-title-action-1") as ImageView

        assertEquals("源码标题栏评审", secondary.text.toString())
        assertEquals(Color.rgb(4, 66, 210), secondary.currentTextColor)
        val center = node(titleBar, "calendar-title-center") as TextView
        assertEquals(View.VISIBLE, centerContainer.visibility)
        assertEquals("", center.text.toString())
        assertEquals(dp(activity, 20f), requireNotNull(leading.compoundDrawables[0]).bounds.width())
        assertEquals(dp(activity, 44f), edit.width)
        assertEquals(dp(activity, 44f), delete.width)
        assertEquals("编辑日程", edit.contentDescription.toString())
        assertEquals("删除日程", delete.contentDescription.toString())
      }
    }
  }

  @Test
  fun productionRepeatEndRouteUsesCommonTitleAndCommitsTheSourceDefaultDate() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      scenario.onActivity { activity ->
        activity.page.setSnapshot(mapOf(
          "schemaVersion" to 1,
          "state" to "ready",
          "editing" to false,
          "saving" to false,
          "draft" to mapOf(
            "title" to "重复标题栏评审",
            "startDate" to "2026-07-17",
            "endDate" to "2026-07-17",
            "startTime" to "10:00",
            "endTime" to "11:00",
            "isAllDay" to false,
            "repeat" to "daily",
            "recurrenceUntilDate" to null,
            "reminderMinutes" to null,
            "location" to "",
            "notes" to "",
          ),
        ))
        activity.page.commitProps()
        val row = activity.page.descendants().single { it.contentDescription == "截止时间，永不截止" }
        assertTrue(row.performClick())
      }

      scenario.onActivity { activity ->
        val repeatPage = activity.page.descendants().filterIsInstance<CalendarRepeatEndPageView>().single()
        val titleBar = repeatPage.descendants().filterIsInstance<CalendarCommonTitleBar>().single()
        assertTrue(FeishuEvidenceRuntime.validate(titleBar, contract(actionCount = 1)).isEmpty())
        val leading = node(titleBar, "calendar-title-leading") as TextView
        val center = node(titleBar, "calendar-title-center") as TextView
        val done = node(titleBar, "calendar-title-action-0") as TextView
        val neverEnds = node(repeatPage, "calendar-repeat-end-never-switch") as CalendarSourceSwitch
        val picker = node(repeatPage, "calendar-repeat-end-date-picker")

        assertEquals("取消", leading.text.toString())
        assertEquals("选择截止时间", center.text.toString())
        assertEquals("完成", done.text.toString())
        assertTrue(neverEnds.isChecked)
        assertEquals(View.GONE, picker.visibility)
        neverEnds.setChecked(false)
        assertFalse(neverEnds.isChecked)
        assertEquals(View.VISIBLE, picker.visibility)
        assertEquals(3, repeatPage.descendants().filterIsInstance<CalendarEditWheelView>().count())
        val enabledDone = node(titleBar, "calendar-title-action-0") as TextView
        assertTrue(enabledDone.performClick())

        assertTrue(activity.page.descendants().none { it is CalendarRepeatEndPageView })
        assertTrue(activity.page.descendants().any {
          it.contentDescription?.toString()?.startsWith("截止时间，2026年8月17日") == true
        })
      }
    }
  }

  @Test
  fun repeatEndRouteRestoresAcrossActivityRecreationAndBackCancelsToEntryDraft() {
    ActivityScenario.launch(CalendarEditPageTestActivity::class.java).use { scenario ->
      scenario.onActivity { activity ->
        activity.page.setSnapshot(mapOf(
          "schemaVersion" to 1,
          "state" to "ready",
          "editing" to false,
          "saving" to false,
          "draft" to mapOf(
            "title" to "重复截止恢复",
            "startDate" to "2026-07-17",
            "endDate" to "2026-07-17",
            "startTime" to "10:00",
            "endTime" to "11:00",
            "isAllDay" to false,
            "repeat" to "weekly",
            "recurrenceUntilDate" to "2026-09-01",
            "reminderMinutes" to null,
            "location" to "",
            "notes" to "",
          ),
        ))
        activity.page.commitProps()
        val row = activity.page.descendants().single {
          it.contentDescription == "截止时间，2026年9月1日 周二"
        }
        assertTrue(row.performClick())
      }

      scenario.recreate()

      scenario.onActivity { activity ->
        val page = activity.page.descendants().filterIsInstance<CalendarRepeatEndPageView>().single()
        assertFalse(page.currentState().neverEnds)
        assertEquals("2026-09-01", page.currentState().selectedDate.toString())

        activity.onBackPressedDispatcher.onBackPressed()

        assertTrue(activity.page.descendants().none { it is CalendarRepeatEndPageView })
        assertTrue(activity.page.descendants().any {
          it.contentDescription == "截止时间，2026年9月1日 周二"
        })
      }
    }
  }

  private fun contract(actionCount: Int): EvidenceTreeContract {
    val nodes = mutableListOf(
      EvidenceNodeContract("calendar-common-titlebar", "titlebar", null, "CalendarCommonTitleBar", heightDp = 44f),
      EvidenceNodeContract("calendar-title-leading", "leading-action", "calendar-common-titlebar", "TextView"),
      EvidenceNodeContract("calendar-title-secondary", "secondary-title", "calendar-common-titlebar", "TextView"),
      EvidenceNodeContract("calendar-title-leading-container", "leading-container", "calendar-common-titlebar", "LinearLayout"),
      EvidenceNodeContract("calendar-title-center-container", "title-container", "calendar-common-titlebar", "LinearLayout"),
      EvidenceNodeContract("calendar-title-center", "title", "calendar-title-center-container", "TextView"),
      EvidenceNodeContract("calendar-title-subtitle", "subtitle", "calendar-title-center-container", "TextView"),
      EvidenceNodeContract("calendar-title-actions", "actions", "calendar-common-titlebar", "LinearLayout"),
      EvidenceNodeContract("calendar-title-divider", "divider", "calendar-common-titlebar", "View"),
    )
    repeat(actionCount) { index ->
      nodes += EvidenceNodeContract(
        "calendar-title-action-$index",
        if (actionCount == 1) "text-action" else "icon-action",
        "calendar-title-actions",
      )
    }
    return EvidenceTreeContract(
      evidenceId = "UI-TITLE-COMMON-001",
      nodes = nodes,
      dimensionToleranceDp = 0.6f,
      rejectUnmappedVisibleOrActionable = true,
    )
  }

  private fun node(root: View, semanticKey: String): View = root.descendants().single {
    FeishuEvidenceRuntime.ref(it)?.semanticKey == semanticKey
  }

  private fun View.descendants(): Sequence<View> = sequence {
    yield(this@descendants)
    if (this@descendants is ViewGroup) {
      for (index in 0 until childCount) yieldAll(getChildAt(index).descendants())
    }
  }

  private fun matchWidthHeight(activity: CalendarSurfaceTestActivity, heightDp: Float) =
    FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(activity, heightDp))

  private fun dp(activity: android.app.Activity, value: Float): Int =
    CalendarCommonTitleBarContract.dpToPx(value, activity.resources.displayMetrics.density)

  private fun waitUntil(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    timeoutMs: Long = 5_000L,
    predicate: () -> Boolean,
  ) {
    val deadline = SystemClock.uptimeMillis() + timeoutMs
    while (SystemClock.uptimeMillis() < deadline) {
      InstrumentationRegistry.getInstrumentation().waitForIdleSync()
      var matched = false
      scenario.onActivity { matched = predicate() }
      if (matched) return
      SystemClock.sleep(16L)
    }
    throw AssertionError("Timed out waiting for title-bar condition")
  }
}
