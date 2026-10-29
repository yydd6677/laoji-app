package com.laoji.nativeplatform.minutes

import android.app.Activity
import android.content.Intent
import android.graphics.Rect
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.MotionEvent
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Attached, production Views. The host and data exist only in androidTest. */
class ExperienceHostActivity : Activity()

@RunWith(AndroidJUnit4::class)
class MinutesSummaryRecyclerTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()

  private fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)
  private fun awaitMain(message: String, condition: () -> Boolean) {
    val deadline = SystemClock.uptimeMillis() + 4000
    do {
      var passed = false
      onMain { passed = condition() }
      if (passed) return
      SystemClock.sleep(16)
    } while (SystemClock.uptimeMillis() < deadline)
    fail(message)
  }

  @Test fun onlyVisibleChaptersMountAndReadingStateSurvivesRecyclingAndActionUpdates() {
    val context = instrumentation.targetContext
    val host = instrumentation.startActivitySync(Intent(context, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val actions = mutableListOf<Map<String, Any?>>()
    lateinit var page: MinutesSummaryPage
    lateinit var layout: LinearLayoutManager
    val initial = MinutesDetailState(
      meetingId = "recycler-experience", activeTab = MinutesDetailTab.SUMMARY,
      canGenerateSummary = true,
      summary = (0 until 40).map { index -> MinutesSummarySection(
        "chapter-$index", if (index == 0) "overview" else "topic-$index",
        title = if (index == 0) "概述" else "讨论范围 $index",
        text = "先核对当前资料，再确认范围和后续安排；存在分歧的内容保留原始依据。".repeat(12),
      ) },
      actions = listOf(MinutesActionItem("followup", "核对资料并确认下一次讨论时间")),
    )
    try {
      onMain {
        MinutesPalette.configure(host)
        page = MinutesSummaryPage(host, actions::add)
        // Force actual recycling rather than satisfying expansion retention
        // by RecyclerView's small offscreen cache.
        page.scroll.setItemViewCacheSize(0)
        layout = page.scroll.layoutManager as LinearLayoutManager
        host.setContentView(page)
        page.render(initial)
      }
      awaitMain("summary did not mount its first chapter") { page.scroll.childCount > 0 }
      lateinit var lead: MinutesSummaryLeadView
      onMain {
        assertEquals("reading starts directly below the tabs, without a regenerate row", 0, page.scroll.top)
        assertEquals(41, page.scroll.adapter!!.itemCount)
        assertTrue("offscreen chapters must not all mount", page.scroll.childCount < 10)
        lead = descendants(page).filterIsInstance<MinutesSummaryLeadView>().single()
        assertEquals(View.VISIBLE, lead.disclosure.visibility)
        lead.disclosure.performClick()
      }
      awaitMain("lead did not expand") { lead.expanded && lead.body.maxLines == Int.MAX_VALUE }
      onMain { layout.scrollToPositionWithOffset(25, -40) }
      awaitMain("chapter 25 did not become the anchor") { layout.findFirstVisibleItemPosition() == 25 }
      lateinit var saved: MinutesDetailPageScrollPosition
      onMain {
        saved = page.captureScrollPosition()
        assertEquals(2, saved.formatRevision)
        assertEquals(-40, saved.offsetPx)
        layout.scrollToPositionWithOffset(0, 0)
      }
      awaitMain("overview did not remount") { layout.findFirstVisibleItemPosition() == 0 }
      val actionDiffCommitted = java.util.concurrent.atomic.AtomicBoolean(false)
      onMain {
        val restoredLead = descendants(page).filterIsInstance<MinutesSummaryLeadView>().single()
        assertNotSame(lead, restoredLead)
        assertTrue("explicit expansion must survive recycling", restoredLead.expanded)
        lead = restoredLead
        page.scroll.adapter!!.registerAdapterDataObserver(object : androidx.recyclerview.widget.RecyclerView.AdapterDataObserver() {
          override fun onItemRangeChanged(positionStart: Int, itemCount: Int, payload: Any?) {
            actionDiffCommitted.set(true)
          }
        })
        page.render(initial.copy(actions = initial.actions.map { it.copy(status = "completed") }))
      }
      awaitMain("action diff did not commit") { actionDiffCommitted.get() }
      onMain {
        assertSame("action updates must not rebuild the article", lead,
          descendants(page).filterIsInstance<MinutesSummaryLeadView>().single())
        page.restoreScrollPosition(saved)
      }
      awaitMain("reading anchor was not restored") {
        val actual = page.captureScrollPosition()
        layout.findFirstVisibleItemPosition() == 25 && actual.offsetPx == -40
      }
      lateinit var draggedPosition: MinutesDetailPageScrollPosition
      onMain {
        val downTime = SystemClock.uptimeMillis()
        fun touch(action: Int, y: Float, elapsed: Long) {
          val event = MotionEvent.obtain(downTime, downTime + elapsed, action, 300f, y, 0)
          try { page.scroll.onTouchEvent(event) } finally { event.recycle() }
        }
        touch(MotionEvent.ACTION_DOWN, 700f, 0)
        touch(MotionEvent.ACTION_MOVE, 500f, 30)
        assertEquals(androidx.recyclerview.widget.RecyclerView.SCROLL_STATE_DRAGGING, page.scroll.scrollState)
        page.render(initial.copy(actions = initial.actions.map { it.copy(status = "completed", dueLabel = "周三") }))
        // Main-thread delivery of the real async diff cannot run until this
        // gesture finishes. The later commit must not restore its old anchor.
        page.scroll.scrollBy(0, 180)
        draggedPosition = page.captureScrollPosition()
        touch(MotionEvent.ACTION_CANCEL, 500f, 60)
      }
      instrumentation.waitForIdleSync()
      onMain { assertEquals("a diff commit must not undo a newer user scroll", draggedPosition, page.captureScrollPosition()) }
      onMain { page.render(initial.copy(focusActionId = "followup", focusActionRequestId = 1)) }
      awaitMain("action focus did not reveal the actual action") {
        descendants(page).any { it.contentDescription == "完成待办事项：核对资料并确认下一次讨论时间" &&
          it.getGlobalVisibleRect(Rect()) }
      }
      onMain {
        descendants(page).single { it.contentDescription == "完成待办事项：核对资料并确认下一次讨论时间" }.performClick()
        assertEquals("toggleAction", actions.single()["type"])
        assertEquals("followup", actions.single()["actionId"])
        // Version 1 was an absolute NestedScrollView offset, not a Recycler
        // anchor. Restore it once without clearing any persisted user state.
        page.restoreScrollPosition(MinutesDetailPageScrollPosition(offsetPx = 600))
      }
      awaitMain("legacy reading offset was not applied") {
        val actual = page.captureScrollPosition()
        actual.formatRevision == 2 && (actual.anchorIndex > 0 || actual.offsetPx < 0)
      }
    } finally { onMain { host.finish() } }
  }

  @Test fun firstGenerationRemainsOnTheEmptyPageWithoutAddingAReadingToolbar() {
    val context = instrumentation.targetContext
    val host = instrumentation.startActivitySync(Intent(context, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val actions = mutableListOf<Map<String, Any?>>()
    lateinit var page: MinutesSummaryPage
    val initial = MinutesDetailState(meetingId = "first-generation", activeTab = MinutesDetailTab.SUMMARY,
      canGenerateSummary = true)
    try {
      onMain {
        MinutesPalette.configure(host)
        page = MinutesSummaryPage(host, actions::add)
        host.setContentView(page)
        page.render(initial)
      }
      awaitMain("first generation is not visible") {
        descendants(page).filterIsInstance<android.widget.TextView>().any { it.text == "生成整理结果" && it.isShown }
      }
      onMain {
        descendants(page).filterIsInstance<android.widget.TextView>().single { it.text == "生成整理结果" }.performClick()
        assertEquals("generateSummary", actions.single()["type"])
        page.render(initial.copy(summaryGenerating = true))
        assertFalse(descendants(page).filterIsInstance<android.widget.TextView>().any { it.text == "生成整理结果" && it.isShown })
        page.render(initial.copy(summary = listOf(MinutesSummarySection("lead", "overview", title = "概述", text = "核对讨论范围。"))))
      }
      awaitMain("generated reading did not mount") { page.scroll.childCount > 0 }
      onMain {
        assertEquals(0, page.scroll.top)
        assertFalse(descendants(page).filterIsInstance<android.widget.TextView>().any { it.text == "生成整理结果" && it.isShown })
      }
    } finally { onMain { host.finish() } }
  }

  @Test fun restoreBeforeFirstResultWaitsForTheSameDocumentAndPersistsItsFormat() {
    val context = instrumentation.targetContext
    val host = instrumentation.startActivitySync(Intent(context, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val store = MinutesDetailViewStateStore(context)
    val id = "experience-only-scroll-format"
    lateinit var page: MinutesSummaryPage
    lateinit var layout: LinearLayoutManager
    try {
      onMain {
        MinutesPalette.configure(host)
        page = MinutesSummaryPage(host, {})
        layout = page.scroll.layoutManager as LinearLayoutManager
        host.setContentView(page)
        val position = MinutesDetailPageScrollPosition(15, -28, 2)
        store.write(id, MinutesDetailPersistedViewState(summary = position), synchronous = true)
        page.restoreScrollPosition(requireNotNull(store.read(id)).summary)
        assertEquals(position, page.captureScrollPosition())
        page.render(MinutesDetailState(meetingId = id, summary = (0 until 30).map {
          MinutesSummarySection("s-$it", "s-$it", title = "讨论 $it", text = "核对本次讨论范围与资料。".repeat(20))
        }))
      }
      awaitMain("restore was lost while the first document was pending") {
        layout.findFirstVisibleItemPosition() == 15 && page.captureScrollPosition().offsetPx == -28
      }
    } finally { onMain { store.clear(id); host.finish() } }
  }

  private fun descendants(view: View): List<View> = buildList {
    add(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) addAll(descendants(view.getChildAt(index)))
  }
}
