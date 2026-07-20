package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001: API35 lifecycle, race, fling and player regressions.

import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import androidx.core.view.ViewCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.laoji.nativeplatform.media.MinutesPlaybackRegistry
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MinutesDetailSurfaceInstrumentedTest {
  @After
  fun releasePlayerRegistry() {
    androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync {
      MinutesPlaybackRegistry.release()
    }
  }

  @Test
  fun detailOwnsPersistentPagesNonOverlayWarningAndExplicitNoAudioState() {
    ActivityScenario.launch(MinutesSurfaceTestActivity::class.java).use { scenario ->
      val surfaceRef = AtomicReference<MinutesDetailSurface>()
      scenario.onActivity { activity ->
        val surface = testSurface(activity)
        surface.render(
          detailState(
            meetingId = "geometry-meeting",
            activeTab = MinutesDetailTab.SUMMARY,
            summaryCount = 12,
            summaryPhase = MinutesContentPhase.ERROR,
            summaryCached = true,
            audioStatusMessage = "仅有转写，无录音文件",
          ),
        )
        activity.root.addView(surface, matchParent())
        surfaceRef.set(surface)
      }
      waitForLayout(scenario, surfaceRef)

      scenario.onActivity { activity ->
        val surface = surfaceRef.get()
        assertEquals(activity.dp(44), surface.titleBar.height)
        assertEquals(activity.dp(41), surface.detailPager.top - surface.audioHeader.bottom)
        assertEquals(3, requireNotNull(surface.detailPager.adapter).itemCount)
        assertEquals(3, surface.detailPager.offscreenPageLimit)
        assertSame(surface.stickyLayout, surface.getChildAt(1))
        assertSame(surface.audioNotice, surface.getChildAt(2))
        assertSame(surface.player, surface.getChildAt(3))
        assertEquals(ViewGroup.LayoutParams.WRAP_CONTENT, surface.player.layoutParams.height)
        assertFalse(surface.player.parent === surface.stickyLayout)

        val transcript = surface.pageFor(MinutesDetailTab.TRANSCRIPT)
        val summary = surface.pageFor(MinutesDetailTab.SUMMARY)
        val speakers = surface.pageFor(MinutesDetailTab.SPEAKERS)
        assertNotSame(transcript, summary)
        assertNotSame(summary, speakers)
        assertEquals(11, transcript.renderedGeneration)
        assertEquals(22, summary.renderedGeneration)
        assertEquals(33, speakers.renderedGeneration)
        assertTrue(summary.renderedPageState.cached)
        assertEquals(View.VISIBLE, summary.warningBanner.visibility)
        assertTrue(summary.contentContainer.top >= summary.warningBanner.bottom)
        assertEquals("仅有转写，无录音文件", surface.audioNotice.text.toString())
        assertEquals(View.VISIBLE, surface.audioNotice.visibility)
        assertEquals(View.GONE, surface.player.visibility)
        surface.render(
          detailState(
            meetingId = "geometry-meeting",
            activeTab = MinutesDetailTab.SUMMARY,
            summaryCount = 12,
            summaryPhase = MinutesContentPhase.ERROR,
            summaryCached = true,
            audioStatusMessage = "仅有转写，无录音文件",
            audioErrorMessage = "录音自动同步失败",
          ),
        )
        assertEquals("录音自动同步失败", surface.audioNotice.text.toString())
      }
    }
  }

  @Test
  fun pagerKeepsPageInstancesScrollAndIndependentStateAcrossSwitchAndRender() {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    MinutesDetailViewStateStore(context).clear("tab-race")
    ActivityScenario.launch(MinutesSurfaceTestActivity::class.java).use { scenario ->
      val actions = CopyOnWriteArrayList<Map<String, Any?>>()
      val surfaceRef = AtomicReference<MinutesDetailSurface>()
      scenario.onActivity { activity ->
        val surface = testSurface(activity, actions::add)
        surface.render(detailState(meetingId = "tab-race", tabGeneration = 10))
        activity.root.addView(surface, matchParent())
        surface.render(detailState(meetingId = "tab-race", activeTab = MinutesDetailTab.SUMMARY, tabGeneration = 11))
        surface.render(detailState(meetingId = "tab-race", activeTab = MinutesDetailTab.SPEAKERS, tabGeneration = 12))
        surfaceRef.set(surface)
      }
      waitUntil { pagerItem(scenario, surfaceRef.get()) == 2 }
      assertTrue(actions.none { it["type"] == "selectDetailTab" })

      scenario.onActivity { activity ->
        val surface = surfaceRef.get()
        surface.render(detailState(meetingId = "tab-race", activeTab = MinutesDetailTab.TRANSCRIPT, tabGeneration = 11))
        val transcriptTab = surface.descendants<View>().first { it.contentDescription == "文字记录" }
        val summaryTab = surface.descendants<View>().first { it.contentDescription == "纪要" }
        transcriptTab.performClick()
        summaryTab.performClick()
        assertEquals(activity, surface.context)
      }
      waitUntil { pagerItem(scenario, surfaceRef.get()) == 1 && actions.any { it["type"] == "selectDetailTab" } }

      val selections = actions.filter { it["type"] == "selectDetailTab" }
      assertEquals(1, selections.size)
      assertEquals("summary", selections.single()["tab"])
      assertTrue((selections.single()["selectionGeneration"] as Number).toInt() > 12)
    }
  }

  @Test
  fun activityRecreateRestoresMeetingScopedTabHeaderAndAllPageScrollPositions() {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    val meetingId = "recreate-${System.nanoTime()}"
    MinutesDetailViewStateStore(context).clear(meetingId)
    val intent = Intent(context, MinutesSurfaceTestActivity::class.java).apply {
      putExtra(MinutesSurfaceTestActivity.EXTRA_AUTO_DETAIL, true)
      putExtra(MinutesSurfaceTestActivity.EXTRA_MEETING_ID, meetingId)
    }

    ActivityScenario.launch<MinutesSurfaceTestActivity>(intent).use { scenario ->
      waitUntil { autoSurface(scenario)?.width ?: 0 > 0 }
      scenario.onActivity { activity ->
        val surface = requireNotNull(activity.detailSurface)
        val transcript = surface.pageFor(MinutesDetailTab.TRANSCRIPT) as MinutesTranscriptPage
        val summary = surface.pageFor(MinutesDetailTab.SUMMARY) as MinutesSummaryPage
        val consumed = intArrayOf(0, 0)
        surface.stickyLayout.onNestedPreScroll(
          transcript.list,
          0,
          activity.dp(36),
          consumed,
          ViewCompat.TYPE_TOUCH,
        )
        (transcript.list.layoutManager as androidx.recyclerview.widget.LinearLayoutManager)
          .scrollToPositionWithOffset(18, -activity.dp(7))
        surface.detailPager.setCurrentItem(1, false)
        summary.scroll.scrollTo(0, activity.dp(180))
        surface.persistViewStateNow()
      }
      waitUntil {
        MinutesDetailViewStateStore(context).read(meetingId)?.let {
          it.activeTab == MinutesDetailTab.SUMMARY && it.headerCollapseOffsetPx > 0
        } == true
      }

      scenario.recreate()
      waitUntil {
        val surface = autoSurface(scenario) ?: return@waitUntil false
        val transcript = surface.pageFor(MinutesDetailTab.TRANSCRIPT) as MinutesTranscriptPage
        val summary = surface.pageFor(MinutesDetailTab.SUMMARY) as MinutesSummaryPage
        surface.detailPager.currentItem == 1 &&
          surface.stickyLayout.headerCollapseOffsetPx > 0 &&
          (transcript.list.layoutManager as androidx.recyclerview.widget.LinearLayoutManager)
            .findFirstVisibleItemPosition() >= 17 &&
          summary.scroll.scrollY > 0
      }
    }
  }

  @Test
  fun stickyConsumesHeaderBeforePageAndOnlyExpandsForPageAtTop() {
    ActivityScenario.launch(MinutesSurfaceTestActivity::class.java).use { scenario ->
      val surfaceRef = AtomicReference<MinutesDetailSurface>()
      scenario.onActivity { activity ->
        val surface = testSurface(activity)
        surface.render(
          detailState(
            meetingId = "sticky-fling",
            activeTab = MinutesDetailTab.SUMMARY,
            summaryCount = 160,
          ),
        )
        activity.root.addView(surface, matchParent())
        surfaceRef.set(surface)
      }
      waitForLayout(scenario, surfaceRef)

      scenario.onActivity {
        val summary = surfaceRef.get().pageFor(MinutesDetailTab.SUMMARY) as MinutesSummaryPage
        summary.scroll.fling(7_000)
      }
      waitUntil(timeoutMs = 5_000) { stickyOffset(scenario, surfaceRef.get()) > 0 }

      val nonTouchBoundary = AtomicInteger(0)
      val collapseDirection = AtomicInteger(0)
      val expandDirection = AtomicInteger(0)
      scenario.onActivity { activity ->
        val sticky = surfaceRef.get().stickyLayout
        sticky.setListener(object : MinutesDetailStickyListener {
          override fun onNonTouchBoundary() { nonTouchBoundary.incrementAndGet() }
          override fun onCollapseDirection() { collapseDirection.incrementAndGet() }
          override fun onExpandDirection() { expandDirection.incrementAndGet() }
        })
        sticky.setForceHideTopView(true)
        val boundaryFrame = intArrayOf(0, 0)
        sticky.onNestedPreScroll(View(activity), 0, activity.dp(60), boundaryFrame, ViewCompat.TYPE_NON_TOUCH)
        assertEquals(0, boundaryFrame[1])
        sticky.setForceHideTopView(false)
        sticky.restoreHeaderCollapseOffset(0)
        repeat(3) {
          sticky.onNestedPreScroll(View(activity), 0, activity.dp(15), intArrayOf(0, 0), ViewCompat.TYPE_TOUCH)
        }
        repeat(3) {
          sticky.onNestedPreScroll(View(activity), 0, -activity.dp(15), intArrayOf(0, 0), ViewCompat.TYPE_TOUCH)
        }
      }
      assertTrue(nonTouchBoundary.get() >= 1)
      assertTrue(collapseDirection.get() >= 1)
      assertTrue(expandDirection.get() >= 1)
    }
  }

  @Test
  fun productionPlayerConnectsToMediaSessionLoadsLocalWavAndClearsOnDetach() {
    ActivityScenario.launch(MinutesSurfaceTestActivity::class.java).use { scenario ->
      val surfaceRef = AtomicReference<MinutesDetailSurface>()
      val audioFile = AtomicReference<File>()
      scenario.onActivity { activity ->
        MinutesPlaybackRegistry.release()
        val file = createSilentWav(activity.cacheDir)
        audioFile.set(file)
        val surface = MinutesDetailSurface(activity, {}, {})
        surface.render(
          detailState(
            meetingId = "player-meeting",
            audioStatusMessage = "仅有转写，无录音文件",
          ),
        )
        activity.root.addView(surface, matchParent())
        assertEquals(View.GONE, surface.player.visibility)
        assertEquals("仅有转写，无录音文件", surface.audioNotice.text.toString())
        surface.render(
          detailState(
            meetingId = "player-meeting",
            playerSource = MinutesPlayerSource(
              sourceId = "local-player-test",
              uri = Uri.fromFile(file).toString(),
              title = "播放器测试",
              retainForBackground = false,
            ),
          ),
        )
        surfaceRef.set(surface)
      }
      waitUntil(timeoutMs = 8_000) {
        MinutesPlaybackRegistry.backgroundState().hostAttached &&
          MinutesPlaybackRegistry.currentController()?.state?.sourceId == "local-player-test"
      }
      scenario.onActivity { activity ->
        assertEquals(View.VISIBLE, surfaceRef.get().player.visibility)
        activity.root.removeView(surfaceRef.get())
      }
      waitUntil(timeoutMs = 5_000) {
        MinutesPlaybackRegistry.backgroundState().surfaceAttachmentCount == 0 &&
          MinutesPlaybackRegistry.currentController()?.state?.sourceId == null
      }
      audioFile.get().delete()
    }
  }

  @Test
  fun unavailableRenderClosesTitleEditorAndRejectsDetachedSaveCallback() {
    ActivityScenario.launch(MinutesSurfaceTestActivity::class.java).use { scenario ->
      val actions = CopyOnWriteArrayList<Map<String, Any?>>()
      val surfaceRef = AtomicReference<MinutesDetailSurface>()
      val detachedSave = AtomicReference<View>()
      scenario.onActivity { activity ->
        val surface = testSurface(activity, actions::add)
        surface.render(detailState(meetingId = "unavailable-meeting"))
        activity.root.addView(surface, matchParent())
        surfaceRef.set(surface)
      }
      waitForLayout(scenario, surfaceRef)
      scenario.onActivity {
        surfaceRef.get().audioHeader.descendants<View>().first { it.contentDescription == "编辑会议标题" }.performClick()
      }
      waitUntil {
        val showing = AtomicReference(false)
        scenario.onActivity {
          showing.set(surfaceRef.get().titleEditorShowing && surfaceRef.get().activeTitleDialogSaveAction != null)
        }
        showing.get()
      }
      scenario.onActivity {
        detachedSave.set(requireNotNull(surfaceRef.get().activeTitleDialogSaveAction))
        surfaceRef.get().render(
          detailState(meetingId = "unavailable-meeting", available = false),
        )
        assertFalse(surfaceRef.get().titleEditorShowing)
        detachedSave.get().performClick()
      }
      assertTrue(actions.none { it["type"] == "saveTitle" })
    }
  }

  private fun detailState(
    meetingId: String,
    available: Boolean = true,
    activeTab: MinutesDetailTab = MinutesDetailTab.TRANSCRIPT,
    tabGeneration: Int = 0,
    transcriptCount: Int = 20,
    summaryCount: Int = 0,
    summaryPhase: MinutesContentPhase = MinutesContentPhase.READY,
    summaryCached: Boolean = false,
    playerSource: MinutesPlayerSource? = null,
    audioStatusMessage: String = "",
    audioErrorMessage: String = "",
  ) = MinutesDetailState(
    meetingId = meetingId,
    available = available,
    title = "产品方案讨论",
    dateTimeLabel = "7月17日 10:00 · 45分钟",
    activeTab = activeTab,
    tabGeneration = tabGeneration,
    transcript = List(transcriptCount) { index ->
      MinutesTranscriptLine(
        id = "line-$index",
        speakerId = "speaker-${index % 3}",
        speakerLabel = "发言人 ${(index % 3) + 1}",
        timestampLabel = "%02d:%02d".format(index / 60, index % 60),
        startMs = index * 1_000L,
        text = "这是第 $index 条会议转写，用于验证每页独立滚动状态。",
      )
    },
    summary = List(summaryCount) { index -> MinutesSummaryBlock("summary-$index", "bullet", "纪要条目 $index") },
    speakers = listOf(MinutesSpeaker("speaker-1", "发言人 1", 12, "18分钟", true)),
    canManageSpeakers = true,
    canGenerateSummary = true,
    playerSource = playerSource,
    audioStatusMessage = audioStatusMessage,
    audioErrorMessage = audioErrorMessage,
    pageStates = MinutesDetailPageStates(
      transcript = MinutesDetailPageState(MinutesContentPhase.READY, generation = 11),
      summary = MinutesDetailPageState(summaryPhase, "纪要同步失败", 22, summaryCached),
      speakers = MinutesDetailPageState(MinutesContentPhase.READY, generation = 33),
    ),
  )

  private fun testSurface(
    activity: MinutesSurfaceTestActivity,
    onAction: (Map<String, Any?>) -> Unit = {},
  ): MinutesDetailSurface = MinutesDetailSurface(
    context = activity,
    onAction = onAction,
    onPlaybackState = {},
    playerOwnerFactory = { context, _ -> TestPlayerOwner(context) },
  )

  private class TestPlayerOwner(context: android.content.Context) : MinutesDetailPlayerOwner {
    override val view: View = View(context).apply { minimumHeight = context.dp(48) }
    override fun setSource(source: MinutesPlayerSource?) {
      view.visibility = if (source == null) View.GONE else View.VISIBLE
    }
    override fun seekTo(positionMs: Long) = Unit
  }

  private fun waitForLayout(
    scenario: ActivityScenario<MinutesSurfaceTestActivity>,
    surface: AtomicReference<MinutesDetailSurface>,
  ) = waitUntil {
    val laidOut = AtomicReference(false)
    scenario.onActivity { laidOut.set(surface.get().width > 0 && surface.get().stickyLayout.height > 0) }
    laidOut.get()
  }

  private fun autoSurface(scenario: ActivityScenario<MinutesSurfaceTestActivity>): MinutesDetailSurface? {
    val value = AtomicReference<MinutesDetailSurface?>()
    scenario.onActivity { value.set(it.detailSurface) }
    return value.get()
  }

  private fun pagerItem(
    scenario: ActivityScenario<MinutesSurfaceTestActivity>,
    surface: MinutesDetailSurface,
  ): Int {
    val value = AtomicInteger()
    scenario.onActivity { value.set(surface.detailPager.currentItem) }
    return value.get()
  }

  private fun stickyOffset(
    scenario: ActivityScenario<MinutesSurfaceTestActivity>,
    surface: MinutesDetailSurface,
  ): Int {
    val value = AtomicInteger()
    scenario.onActivity { value.set(surface.stickyLayout.headerCollapseOffsetPx) }
    return value.get()
  }

  private fun matchParent() = ViewGroup.LayoutParams(
    ViewGroup.LayoutParams.MATCH_PARENT,
    ViewGroup.LayoutParams.MATCH_PARENT,
  )

  private fun createSilentWav(directory: File): File {
    val sampleRate = 16_000
    val dataSize = sampleRate * 2 / 4
    val buffer = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
    buffer.put("RIFF".toByteArray())
    buffer.putInt(36 + dataSize)
    buffer.put("WAVEfmt ".toByteArray())
    buffer.putInt(16)
    buffer.putShort(1)
    buffer.putShort(1)
    buffer.putInt(sampleRate)
    buffer.putInt(sampleRate * 2)
    buffer.putShort(2)
    buffer.putShort(16)
    buffer.put("data".toByteArray())
    buffer.putInt(dataSize)
    repeat(dataSize) { buffer.put(0) }
    return File(directory, "minutes-player-${System.nanoTime()}.wav").apply { writeBytes(buffer.array()) }
  }

  private inline fun <reified T : View> View.descendants(): List<T> {
    val matches = mutableListOf<T>()
    val pending = ArrayDeque<View>()
    pending.add(this)
    while (pending.isNotEmpty()) {
      val view = pending.removeFirst()
      if (view is T) matches += view
      if (view is ViewGroup) repeat(view.childCount) { index -> pending.addLast(view.getChildAt(index)) }
    }
    return matches
  }

  private fun waitUntil(timeoutMs: Long = 3_000L, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (condition()) return
      Thread.sleep(25L)
    }
    assertTrue("condition was not met within ${timeoutMs}ms", condition())
  }
}
