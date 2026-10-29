package com.laoji.nativeplatform.minutes

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.laoji.nativeplatform.NativeThemePreference
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith

/** Production Views, test-only data. No gallery activity/fixture is shipped. */
@RunWith(AndroidJUnit4::class)
class MinutesExperienceTest {
  @Test fun navigationContrastRemainsOwnedByTheVisibleWindowSurface() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val previousTheme = NativeThemePreference.read(context)
    val host = instrumentation.startActivitySync(android.content.Intent(context, ExperienceHostActivity::class.java)
      .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    try {
      for (skin in listOf("midnight", "neutral")) {
        instrumentation.runOnMainSync {
          NativeThemePreference.write(context, skin)
          com.laoji.nativeplatform.ui.LaojiSystemBars.apply(host)
          host.setContentView(android.widget.FrameLayout(host))
        }
        instrumentation.waitForIdleSync()
        val controller = androidx.core.view.WindowCompat.getInsetsController(host.window, host.window.decorView)
        val expectedLightAppearance = skin != "midnight"
        for (scrim in listOf(false, true, false)) {
          val nextFrame = java.util.concurrent.CountDownLatch(1)
          instrumentation.runOnMainSync {
            com.laoji.nativeplatform.ui.LaojiSystemBars.setNavigationOverlayDark(host, scrim)
            // Reproduce the native-stack overwrite before the next actual draw.
            controller.isAppearanceLightNavigationBars = !(expectedLightAppearance && !scrim)
            host.window.decorView.viewTreeObserver.addOnDrawListener(object : android.view.ViewTreeObserver.OnDrawListener {
              override fun onDraw() {
                nextFrame.countDown()
                host.window.decorView.post { host.window.decorView.viewTreeObserver.removeOnDrawListener(this) }
              }
            })
            host.window.decorView.invalidate()
          }
          org.junit.Assert.assertTrue("Next frame was not drawn", nextFrame.await(5, java.util.concurrent.TimeUnit.SECONDS))
          instrumentation.runOnMainSync {
            assertEquals("$skin scrim=$scrim", expectedLightAppearance && !scrim,
              controller.isAppearanceLightNavigationBars)
          }
        }
      }
    } finally {
      instrumentation.runOnMainSync {
        NativeThemePreference.write(context, previousTheme)
        host.finish()
      }
    }
  }

  @Test fun playerClockLaneSeparatesTheTrackForBundledAppFontsAndLargeType() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val base = instrumentation.targetContext
    val appResources = base.createPackageContext("com.laoji.app", 0)
    val host = instrumentation.startActivitySync(android.content.Intent(base, ExperienceHostActivity::class.java)
      .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    try {
      for (scale in listOf(1f, 1.3f, 2f)) {
        val configuration = android.content.res.Configuration(host.resources.configuration).apply { fontScale = scale }
        val context = host.createConfigurationContext(configuration)
        var expectedSlots: List<Int>? = null
        for (skin in listOf("neutral", "vivid", "paper", "midnight")) {
          val fontId = appResources.resources.getIdentifier("laoji_theme_$skin", "font", "com.laoji.app")
          org.junit.Assert.assertTrue("Installed App font missing: $skin", fontId != 0)
          val font = requireNotNull(androidx.core.content.res.ResourcesCompat.getFont(appResources, fontId))
          instrumentation.runOnMainSync {
            val player = com.laoji.nativeplatform.media.MinutesPlayerView(context) {}
            host.setContentView(player)
            val clocks = descendants(player).filterIsInstance<android.widget.TextView>()
              .filter { it.text.matches(Regex("[0-9]+:[0-9]{2}")) }.toList()
            assertEquals(2, clocks.size)
            clocks.forEach { it.typeface = font }
            player.measure(View.MeasureSpec.makeMeasureSpec(context.dp(400), View.MeasureSpec.EXACTLY),
              View.MeasureSpec.makeMeasureSpec(context.dp(800), View.MeasureSpec.AT_MOST))
            player.layout(0, 0, player.measuredWidth, player.measuredHeight)
            fun bounds(view: View): Rect = Rect(0, 0, view.width, view.height).also {
              player.offsetDescendantRectToMyCoords(view, it)
            }
            val seek = descendants(player).filterIsInstance<android.widget.SeekBar>().single()
            val track = bounds(seek)
            clocks.forEach { clock ->
              org.junit.Assert.assertTrue("$skin fontScale=$scale clock intersects the track: ${bounds(clock)} / $track",
                bounds(clock).top >= track.centerY() + context.dp(8))
              val metrics = clock.paint.fontMetricsInt
              org.junit.Assert.assertTrue("$skin fontScale=$scale clock text is clipped",
                metrics.descent - metrics.ascent <= clock.height)
            }
            // Theme glyph advances may differ. The track, vertical lanes and outside anchors
            // must stay fixed; requiring identical text widths would freeze the font choice.
            val actual = listOf(track.left, track.top, track.right, track.bottom) + clocks.flatMap {
              val rect = bounds(it); listOf(rect.top, rect.bottom)
            }
            assertEquals(context.dp(20), bounds(clocks[0]).left)
            assertEquals(player.width - context.dp(20), bounds(clocks[1]).right)
            expectedSlots?.let { assertEquals("Skin must not change clock/track slots at scale=$scale", it, actual) }
            expectedSlots = actual
            val indicator = com.laoji.nativeplatform.calendar.CalendarIndicatorView(context)
            val calendarLabel = descendants(indicator).filterIsInstance<android.widget.TextView>().single { it.text == "日历" }
            calendarLabel.typeface = font
            indicator.measure(View.MeasureSpec.makeMeasureSpec(context.dp(400), View.MeasureSpec.EXACTLY),
              View.MeasureSpec.makeMeasureSpec(context.dp(50), View.MeasureSpec.EXACTLY))
            indicator.layout(0, 0, indicator.measuredWidth, indicator.measuredHeight)
            org.junit.Assert.assertFalse(calendarLabel.includeFontPadding)
            val labelMetrics = calendarLabel.paint.fontMetricsInt
            org.junit.Assert.assertTrue("$skin fontScale=$scale calendar indicator clips text",
              labelMetrics.descent - labelMetrics.ascent <= calendarLabel.height)
          }
        }
      }
    } finally { instrumentation.runOnMainSync { host.finish() } }
  }

  @Test fun mediaSessionSeekBeforeFirstPlayPersistsTheActualTarget() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val encrypted = com.laoji.nativeplatform.media.EncryptedMinutesPlaybackStore(context)
    val scope = com.laoji.nativeplatform.media.MinutesPlaybackScopeStore(context)
    val previousScope = scope.activeScope()
    val file = File(context.cacheDir, "session-seek-contract.wav").apply { writeBytes(ByteArray(44)) }
    var controller: com.laoji.nativeplatform.media.MediaSessionMinutesPlayerController? = null
    fun awaitState(predicate: (com.laoji.nativeplatform.media.MinutesPlaybackState) -> Boolean): Boolean {
      val until = android.os.SystemClock.uptimeMillis() + 3000
      do {
        var matched = false
        instrumentation.runOnMainSync {
          matched = controller?.let { it.sessionConnected && predicate(it.state) } == true
        }
        if (matched) return true
        android.os.SystemClock.sleep(20)
      } while (android.os.SystemClock.uptimeMillis() < until)
      return false
    }
    try {
      encrypted.clear(); scope.activate("guest")
      instrumentation.runOnMainSync {
        controller = com.laoji.nativeplatform.media.MediaSessionMinutesPlayerController(context)
        controller!!.activateStorageScope("guest")
        controller!!.setSource(MinutesPlayerSource("session-seek-contract", file.toURI().toString(),
          storageScope = "guest", durationMsHint = 5000))
      }
      org.junit.Assert.assertTrue(awaitState { it.sourceId == "session-seek-contract" && it.errorCode == null })
      instrumentation.runOnMainSync {
        controller!!.seekTo(2500); controller!!.setRate(1.5f)
      }
      val reachedPosition = awaitState { it.positionMs == 2500L }
      var observed = ""
      instrumentation.runOnMainSync { observed = controller!!.state.toString() }
      org.junit.Assert.assertTrue("Session seek must change the service-owned position before playback: $observed",
        reachedPosition)
      org.junit.Assert.assertTrue("Session speed must change before playback: $observed", awaitState { it.rate == 1.5f })
      // MediaSession state is not a disk receipt. Wait for the real ordered checkpoint, rather
      // than treating waitForIdleSync/stopService as an onDestroy acknowledgement with other
      // test Views still bound to the shared service.
      var durable = encrypted.load("guest")
      val deadline = android.os.SystemClock.uptimeMillis() + 3000
      while ((durable?.positionMs != 2500L || durable.rate != 1.5f)
        && android.os.SystemClock.uptimeMillis() < deadline) {
        android.os.SystemClock.sleep(20)
        durable = encrypted.load("guest")
      }
      assertEquals(2500L, requireNotNull(durable).positionMs)
      assertEquals(1.5f, durable.rate)
      instrumentation.runOnMainSync { controller?.release() }
      context.stopService(android.content.Intent(context, com.laoji.nativeplatform.media.LaojiMinutesPlaybackService::class.java))
      instrumentation.waitForIdleSync()
      val recovered = requireNotNull(encrypted.load("guest"))
      assertEquals(2500L, recovered.positionMs); assertEquals(1.5f, recovered.rate)
      org.junit.Assert.assertFalse(recovered.wasPlaying)
    } finally {
      instrumentation.runOnMainSync { controller?.release() }
      context.stopService(android.content.Intent(context, com.laoji.nativeplatform.media.LaojiMinutesPlaybackService::class.java))
      instrumentation.waitForIdleSync()
      encrypted.clear(); scope.activate(previousScope); file.delete()
    }
  }

  @Test fun productionPlayerSavesOffMainAndFlushesTheFinalPositionOnServiceRelease() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val file = File(context.cacheDir, "playback-recovery-contract.wav").apply { writeBytes(ByteArray(44)) }
    val encrypted = com.laoji.nativeplatform.media.EncryptedMinutesPlaybackStore(context)
    val threads = java.util.concurrent.CopyOnWriteArrayList<Thread>()
    val store = object : com.laoji.nativeplatform.media.MinutesPlaybackRecoveryStore {
      override fun load(scope: String) = encrypted.load(scope)
      override fun save(record: com.laoji.nativeplatform.media.MinutesPlaybackRecoveryRecord): Boolean {
        threads.add(Thread.currentThread())
        return encrypted.save(record)
      }
      override fun clear() = encrypted.clear()
    }
    var adapter: com.laoji.nativeplatform.media.Media3MinutesPlayerAdapter? = null
    try {
      encrypted.clear()
      instrumentation.runOnMainSync {
        val player = com.laoji.nativeplatform.media.Media3MinutesPlayerAdapter(context, store, "guest")
        adapter = player
        player.setSource(MinutesPlayerSource("recovery-contract", file.toURI().toString(),
          storageScope = "guest", durationMsHint = 5000))
        player.seekTo(2500)
        player.setRate(1.5f)
        player.release()
      }
      org.junit.Assert.assertTrue(threads.isNotEmpty())
      org.junit.Assert.assertTrue(threads.all { it != android.os.Looper.getMainLooper().thread })
      val recovered = requireNotNull(encrypted.load("guest"))
      assertEquals(2500L, recovered.positionMs)
      assertEquals(1.5f, recovered.rate)
      org.junit.Assert.assertFalse(recovered.wasPlaying)
    } finally {
      instrumentation.runOnMainSync { adapter?.release() }
      encrypted.clear(); file.delete()
    }
  }

  @Test fun productionPlayerScopeClearCannotBeUndoneByQueuedRecoveryWrites() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val file = File(context.cacheDir, "playback-scope-contract.wav").apply { writeBytes(ByteArray(44)) }
    val encrypted = com.laoji.nativeplatform.media.EncryptedMinutesPlaybackStore(context)
    var adapter: com.laoji.nativeplatform.media.Media3MinutesPlayerAdapter? = null
    try {
      encrypted.clear()
      instrumentation.runOnMainSync {
        val player = com.laoji.nativeplatform.media.Media3MinutesPlayerAdapter(context, encrypted, "guest")
        adapter = player
        player.setSource(MinutesPlayerSource("scope-contract", file.toURI().toString(), storageScope = "guest"))
        player.seekTo(500)
        org.junit.Assert.assertFalse(player.seekToChecked("other-source", "guest", 2500))
        org.junit.Assert.assertFalse(player.seekToChecked("scope-contract", "signed_out", 2500))
        assertEquals(500L, player.state.positionMs)
        player.activateStorageScope("signed_out")
        player.release()
      }
      org.junit.Assert.assertNull(encrypted.load("guest"))
    } finally {
      instrumentation.runOnMainSync { adapter?.release() }
      encrypted.clear(); file.delete()
    }
  }

  @Test fun attachedTranscriptSearchAndSelectionKeepTheSameTextWhileHighlightPaintChanges() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(android.content.Intent(base, ExperienceHostActivity::class.java)
      .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val events = mutableListOf<Map<String, Any?>>()
    lateinit var page: MinutesTranscriptPage
    lateinit var search: android.widget.EditText
    lateinit var body: android.widget.TextView
    lateinit var originalText: CharSequence
    val line = "先核对资料范围，再核对本周安排。"
    fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)
    try {
      onMain {
        NativeThemePreference.write(base, "neutral"); MinutesPalette.configure(host)
        page = MinutesTranscriptPage(host, events::add)
        host.setContentView(page)
        page.render(MinutesDetailState(meetingId = "theme-search-contract", activeTab = MinutesDetailTab.TRANSCRIPT,
          transcript = listOf(MinutesTranscriptLine("line", text = line))))
        page.setSearchVisible(true)
        search = descendants(page).filterIsInstance<android.widget.EditText>().single()
        search.setText("核对")
      }
      instrumentation.waitForIdleSync()
      onMain {
        body = descendants(page).filterIsInstance<android.widget.TextView>().single { it.text.toString() == line }
        originalText = body.text
        android.text.Selection.setSelection(body.text as android.text.Spannable, 2, 5)
        // The normal search-entry post has now focused the field and placed
        // the caret at the end. Establish the edited caret after that owner.
        search.setSelection(1)
      }
      for (skin in listOf("paper", "midnight", "vivid", "neutral")) {
        onMain { NativeThemePreference.write(base, skin) }
        instrumentation.waitForIdleSync()
        onMain {
          assertSame(originalText, body.text)
          assertEquals(2, body.selectionStart); assertEquals(5, body.selectionEnd)
          assertEquals("核对", search.text.toString()); assertEquals(1, search.selectionStart)
          assertEquals(MinutesPalette.text, body.currentTextColor)
          assertEquals(MinutesPalette.faint, search.currentHintTextColor)
          val spans = (body.text as android.text.Spanned).getSpans(0, line.length, android.text.style.CharacterStyle::class.java)
          val paints = spans.map { span -> android.text.TextPaint().also(span::updateDrawState).bgColor }
          org.junit.Assert.assertTrue(paints.contains(MinutesPalette.primaryTransparent))
          org.junit.Assert.assertTrue(paints.contains(MinutesPalette.primaryTransparentStrong))
          org.junit.Assert.assertTrue(events.isEmpty())
        }
      }
    } finally { onMain { NativeThemePreference.write(base, previous); host.finish() } }
  }

  @Test fun attachedReadingDraftPlayerAndStatusKeepTheirOwnersAcrossSkins() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(android.content.Intent(base, ExperienceHostActivity::class.java)
      .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val events = mutableListOf<Map<String, Any?>>()
    val bindings = mutableListOf<MinutesPlayerSource?>()
    lateinit var surface: MinutesDetailSurface
    lateinit var player: com.laoji.nativeplatform.media.MinutesPlayerView
    lateinit var lead: MinutesSummaryLeadView
    lateinit var editor: android.widget.EditText
    lateinit var seek: android.widget.SeekBar
    lateinit var thumb: android.graphics.drawable.Drawable
    lateinit var summary: MinutesSummaryPage
    val source = MinutesPlayerSource("theme-source", "file:///theme-contract-only.wav", localOnly = true)
    val state = MinutesDetailState(meetingId = "theme-reading-contract", title = "项目讨论", dateTimeLabel = "10月26日 09:30",
      activeTab = MinutesDetailTab.SUMMARY, activeTabIsExplicit = true, manualNoteEnabled = true,
      manualNote = "仍在编辑的笔记", playerSource = source, canShare = true,
      summary = listOf(MinutesSummarySection("lead", "overview", title = "概述", text = "先核对资料范围，再确认本周安排。".repeat(30))),
      processingStatusLabel = "正在整理会议记录")
    fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)
    try {
      onMain {
        NativeThemePreference.write(base, "neutral")
        MinutesPalette.configure(host)
        surface = MinutesDetailSurface(host, events::add, {}, playerOwnerFactory = { context, callback ->
          player = com.laoji.nativeplatform.media.MinutesPlayerView(context, callback)
          // Count the real detail source boundary without opening a media file.
          // Actual decoding/playback is exercised separately in the release app.
          object : MinutesDetailPlayerOwner {
            override val view: View = player
            override fun bindSource(source: MinutesPlayerSource?) { bindings.add(source) }
            override fun seekTo(positionMs: Long) = Unit
          }
        })
        host.setContentView(surface)
        surface.render(state)
      }
      instrumentation.waitForIdleSync()
      onMain {
        summary = surface.pageFor(MinutesDetailTab.SUMMARY) as MinutesSummaryPage
        lead = descendants(summary).filterIsInstance<MinutesSummaryLeadView>().single()
        lead.disclosure.performClick()
        descendants(surface).single { it.contentDescription == "编辑会议标题" }.performClick()
        editor = descendants(surface).filterIsInstance<android.widget.EditText>().single { it.text.toString() == state.title }
        editor.setText("尚未保存的标题"); editor.setSelection(3)
        seek = descendants(player).filterIsInstance<android.widget.SeekBar>().single()
        seek.progress = 420
        thumb = seek.thumb
      }
      instrumentation.waitForIdleSync()
      var playerBounds = Rect()
      var chromeBounds = Rect()
      var eventCount = 0
      onMain { playerBounds = localBounds(player); chromeBounds = localBounds(surface.titleBar); eventCount = events.size }
      for (skin in listOf("vivid", "paper", "midnight", "neutral")) {
        onMain { NativeThemePreference.write(base, skin) }
        instrumentation.waitForIdleSync()
        onMain {
          assertSame(summary, surface.pageFor(MinutesDetailTab.SUMMARY))
          assertSame(lead, descendants(summary).filterIsInstance<MinutesSummaryLeadView>().single())
          org.junit.Assert.assertTrue(lead.expanded)
          assertEquals(state.summary.single().text, lead.body.text.toString())
          assertEquals(MinutesPalette.text, lead.body.currentTextColor)
          assertEquals(com.laoji.nativeplatform.ui.LaojiThemeTypography.typeface(host), lead.body.typeface)
          assertEquals("尚未保存的标题", editor.text.toString()); assertEquals(3, editor.selectionStart)
          assertEquals(MinutesPalette.text, editor.currentTextColor)
          assertEquals(playerBounds, localBounds(player)); assertEquals(chromeBounds, localBounds(surface.titleBar))
          assertEquals(420, seek.progress); assertSame(thumb, seek.thumb)
          assertEquals(MinutesPalette.recordGradientStart, seek.progressTintList!!.defaultColor)
          assertEquals(listOf(source), bindings)
          assertEquals(eventCount, events.size)
          assertEquals("正在整理会议记录", surface.processingNotice.message.text.toString())
          assertEquals(statusToneColor("neutral"), surface.processingNotice.message.currentTextColor)
          assertEquals(MinutesDetailTab.SUMMARY, field<MinutesDetailState>(surface, "renderedState").activeTab)
        }
        // Idle means the callback ran, not that the new skin was presented.
        // Wait for the actual window gutter rather than saving a prior frame.
        var expectedSurface = 0
        val rootRect = Rect()
        onMain { expectedSurface = MinutesPalette.surface; surface.getGlobalVisibleRect(rootRect) }
        var bitmap = instrumentation.uiAutomation.takeScreenshot()
        val deadline = android.os.SystemClock.uptimeMillis() + 2000
        while (bitmap.getPixel(rootRect.left + 2, rootRect.centerY()) != expectedSurface && android.os.SystemClock.uptimeMillis() < deadline) {
          bitmap.recycle(); android.os.SystemClock.sleep(16)
          bitmap = instrumentation.uiAutomation.takeScreenshot()
        }
        assertEquals("the saved frame must contain the current skin", expectedSurface,
          bitmap.getPixel(rootRect.left + 2, rootRect.centerY()))
        val output = File(base.filesDir, "minutes-gallery").apply { mkdirs() }
        File(output, "live-reading-$skin.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
      }
      onMain {
        surface.processingNotice.render("整理未完成", "", "danger", true)
        NativeThemePreference.write(base, "midnight")
        assertEquals(MinutesPalette.danger, surface.processingNotice.message.currentTextColor)
        surface.processingNotice.render("", "", "neutral", false)
        NativeThemePreference.write(base, "paper")
        assertEquals(View.GONE, surface.processingNotice.visibility)
        org.junit.Assert.assertNull(surface.processingNotice.background)
        assertEquals(1, bindings.size)
      }
    } finally {
      onMain { MinutesDetailViewStateStore(base).clear(state.meetingId); NativeThemePreference.write(base, previous); host.finish() }
    }
  }

  @Test fun attachedMeetingCoversAndOpenMenuChangeAppearanceWithoutRebindingTheirContent() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(android.content.Intent(base, ExperienceHostActivity::class.java)
      .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val actions = mutableListOf<Map<String, Any?>>()
    lateinit var list: androidx.recyclerview.widget.RecyclerView
    lateinit var adapter: MinutesMeetingAdapter
    lateinit var menu: MinutesMainMenu
    var holders = emptyList<View>()
    lateinit var menuRow: View
    val meetings = listOf(MinutesMeeting("reading", title = "项目讨论", dateTimeLabel = "今天", coverType = MinutesListCoverType.SUMMARY,
      coverTitle = "整理结果", coverText = "核对资料范围，然后确认本周安排。"),
      MinutesMeeting("voice", title = "读书交流", dateTimeLabel = "昨天", coverType = MinutesListCoverType.SPEAKER_SUMMARY,
        coverTitle = "讲话人一", coverText = "先把各自的观点记下来。"))
    fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)
    try {
      onMain {
        NativeThemePreference.write(base, "neutral"); MinutesPalette.configure(host)
        list = androidx.recyclerview.widget.RecyclerView(host)
        list.layoutManager = androidx.recyclerview.widget.LinearLayoutManager(host)
        adapter = MinutesMeetingAdapter(actions::add, { _, _ -> })
        adapter.setViewMode(MinutesHomeViewMode.GRID)
        list.adapter = adapter
        host.setContentView(list)
        adapter.submitList(meetings)
        menu = MinutesMainMenu(host, actions::add)
      }
      instrumentation.waitForIdleSync()
      onMain {
        holders = (0 until list.childCount).map(list::getChildAt)
        assertEquals(2, holders.size)
        menu.show(holders.first(), true)
        menuRow = descendants(host.window.decorView).filterIsInstance<android.widget.TextView>().single { it.text == "回收站" }.parent as View
      }
      instrumentation.waitForIdleSync()
      for (skin in listOf("paper", "midnight", "vivid", "neutral")) {
        onMain { NativeThemePreference.write(base, skin) }
        instrumentation.waitForIdleSync()
        onMain {
          assertEquals(holders, (0 until list.childCount).map(list::getChildAt))
          assertEquals(meetings.map { it.id }, adapter.orderedTargetMeetingIds())
          assertEquals(meetings.map { it.coverText }, holders.map { holder -> descendants(holder).filterIsInstance<android.widget.TextView>()
            .single { text -> meetings.any { it.coverText == text.text.toString() } }.text.toString() })
          val label = descendants(menuRow).filterIsInstance<android.widget.TextView>().single()
          assertEquals(MinutesPalette.text, label.currentTextColor)
          assertEquals(com.laoji.nativeplatform.ui.LaojiThemeTypography.typeface(host), label.typeface)
          val background = menuRow.background as android.graphics.drawable.StateListDrawable
          assertEquals(MinutesPalette.surface, (background.current as android.graphics.drawable.GradientDrawable).color!!.defaultColor)
          org.junit.Assert.assertTrue(actions.isEmpty())
        }
      }
      onMain { menuRow.performClick(); assertEquals(1, actions.size); assertEquals("openRecycleBin", actions.single()["type"]) }
    } finally { onMain { menu.dismiss(); NativeThemePreference.write(base, previous); host.finish() } }
  }

  private fun localBounds(view: View) = Rect(view.left, view.top, view.right, view.bottom)
  @Suppress("UNCHECKED_CAST")
  private fun <T> field(owner: Any, name: String): T = owner.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(owner) as T

  @Test fun recordingButtonsCarryCaptureIdentityInsteadOfContentRevisions() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val context = instrumentation.targetContext
      MinutesPalette.configure(context)
      val events = mutableListOf<Map<String, Any?>>()
      val surface = MinutesRecordingSurface(context, events::add)
      val first = MinutesSnapshotParser.parse(mapOf(
        "surface" to "recording",
        "recording" to mapOf("meetingId" to "same-meeting", "phase" to "recording", "canPause" to true, "canStop" to true,
          "control" to mapOf("surfaceId" to "current-page", "sessionStartedAtMs" to 1000L)),
      )).recording
      surface.render(first)
      val pause = descendants(surface).single { it.contentDescription == "暂停录音" }
      val stop = descendants(surface).single { it.contentDescription == "结束并保存会议录音" }
      for (tick in 1..100) {
        surface.render(first.copy(elapsedMs = tick * 1000L,
          transcript = listOf(MinutesTranscriptLine("live", text = "这是一段正在更新的文字 $tick"))))
        assertSame(pause, descendants(surface).single { it.contentDescription == "暂停录音" })
      }
      pause.performClick()
      val pauseEvent = events.last()
      assertEquals(false, pauseEvent["resume"])
      assertEquals(first.control!!.toMap(), pauseEvent["recordingControl"])
      surface.render(first.copy(phase = MinutesRecordingPhase.PAUSED))
      pause.performClick()
      assertEquals(true, events.last()["resume"])
      stop.performClick()
      assertEquals("stopRecording", events.last()["type"])
      val replacement = first.copy(control = MinutesRecordingControlIdentity("current-page", 2000L))
      surface.render(replacement)
      stop.performClick()
      assertEquals(replacement.control!!.toMap(), events.last()["recordingControl"])
      assertEquals("already queued events retain the old capture", requireNotNull(first.control).toMap(), pauseEvent["recordingControl"])
      descendants(surface).single { it.contentDescription == "返回" }.performClick()
      assertEquals(requireNotNull(replacement.control).toMap(), events.last()["recordingControl"])
    }
  }

  @Test fun explicitSkinOwnsNativeColorsEvenWhenSystemNightModeChanges() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val base = instrumentation.targetContext
    val original = NativeThemePreference.read(base)
    val output = File(base.filesDir, "minutes-gallery").apply { mkdirs() }
    try {
      instrumentation.runOnMainSync {
        for (theme in listOf("neutral", "vivid", "paper", "midnight")) {
          NativeThemePreference.write(base, theme)
          val selected = com.laoji.nativeplatform.ui.GeneratedUiTokens.palette(theme)
          var prior: com.laoji.nativeplatform.calendar.CalendarPalette? = null
          var priorEvent: com.laoji.nativeplatform.calendar.CalendarEventVisual? = null
          for (night in listOf(false, true)) {
            val configuration = android.content.res.Configuration(base.resources.configuration).apply {
              uiMode = (uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK.inv()) or
                (if (night) android.content.res.Configuration.UI_MODE_NIGHT_YES else android.content.res.Configuration.UI_MODE_NIGHT_NO)
            }
            val context = base.createConfigurationContext(configuration)
            val shared = com.laoji.nativeplatform.ui.NativeUiTokens.palette(context)
            val calendar = com.laoji.nativeplatform.calendar.CalendarUi.palette(context)
            val event = com.laoji.nativeplatform.calendar.CalendarUi.eventVisual(context, "工作")
            assertEquals(selected.appBg, shared.body)
            assertEquals(selected.text, shared.textPrimary)
            assertEquals(selected.primary, shared.primary)
            assertEquals(selected.body.takeIf { theme == "paper" || theme == "midnight" } ?: selected.card, calendar.surface)
            assertEquals(selected.primary, calendar.accent)
            assertEquals(selected.calendarGridDivider, calendar.monthGridDivider)
            assertEquals(selected.blue, calendar.weekendDate)
            if (prior != null) assertEquals(prior, calendar)
            if (priorEvent != null) assertEquals(priorEvent, event)
            prior = calendar; priorEvent = event
            MinutesPalette.configure(context)
            assertEquals(selected.primary, MinutesPalette.primary)
            assertEquals(selected.text, MinutesPalette.text)
            val recording = MinutesRecordingSurface(context, {})
            recording.render(MinutesRecordingState(title = "读书讨论会"))
            recording.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
              View.MeasureSpec.makeMeasureSpec(2100, View.MeasureSpec.EXACTLY))
            recording.layout(0, 0, 1080, 2100)
            val bitmap = Bitmap.createBitmap(1080, 2100, Bitmap.Config.ARGB_8888)
            recording.draw(Canvas(bitmap))
            File(output, "recording-$theme-${if (night) "night" else "day"}.png").outputStream().use {
              bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            bitmap.recycle()
          }
        }
      }
    } finally {
      instrumentation.runOnMainSync { NativeThemePreference.write(base, original); MinutesPalette.configure(base) }
    }
  }

  @Test fun longLeadDisclosesBeforeFirstDrawWithoutDiscardingText() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val context = instrumentation.targetContext
      MinutesPalette.configure(context)
      val text = "讨论先确认资料的范围，再核对每个阶段的安排。存在分歧的部分保留来源，下一次讨论再确认。".repeat(8)
      val lead = MinutesSummaryLeadView(context, text)
      fun measure() {
        lead.measure(View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY),
          View.MeasureSpec.makeMeasureSpec(4000, View.MeasureSpec.AT_MOST))
        lead.layout(0, 0, 800, lead.measuredHeight)
      }
      measure()
      assertEquals(View.VISIBLE, lead.disclosure.visibility)
      assertEquals(4, lead.body.maxLines)
      assertEquals(text, lead.body.text.toString())
      val collapsedHeight = lead.height
      lead.disclosure.performClick(); measure()
      org.junit.Assert.assertTrue(lead.height > collapsedHeight)
      assertEquals("收起概述", lead.disclosure.text.toString())
      lead.disclosure.performClick(); measure()
      assertEquals(collapsedHeight, lead.height)
      val short = MinutesSummaryLeadView(context, "下一次讨论再确认。")
      short.measure(View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(4000, View.MeasureSpec.AT_MOST))
      assertEquals(View.GONE, short.disclosure.visibility)
      val shortened = MinutesSummaryLeadView(context, "下一次讨论再确认。", initiallyExpanded = true)
      shortened.measure(View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(4000, View.MeasureSpec.AT_MOST))
      assertEquals(View.GONE, shortened.disclosure.visibility)
    }
  }
  @Test
  fun detailChromeAndSummaryInstancesSurviveStatusAndTabChangesInEveryTheme() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val originalTheme = NativeThemePreference.read(context)
    val output = File(context.filesDir, "minutes-gallery").apply { mkdirs() }
    try {
      for (theme in listOf("neutral", "vivid", "paper", "midnight")) {
        instrumentation.runOnMainSync {
          NativeThemePreference.write(context, theme)
          MinutesPalette.configure(context)
          val surface = MinutesDetailSurface(context, {}, {})
          val initial = MinutesDetailState(
            meetingId = "gallery-$theme",
            title = "项目进展讨论",
            dateTimeLabel = "10月25日 09:30",
            activeTab = MinutesDetailTab.SUMMARY,
            activeTabIsExplicit = true,
            canGenerateSummary = true,
            summaryActionLabel = "重新整理",
            summary = listOf(
              MinutesSummarySection("overview", "overview", title = "概述",
                text = "资料准备已经完成，下一阶段先核对范围，再确认交付安排。"),
              MinutesSummarySection("topics", "topics", title = "主题与要点",
                text = "保留已经确认的内容。\n有分歧的部分单独复核，不覆盖原始记录。"),
            ),
            transcript = listOf(MinutesTranscriptLine("line", text = "资料已准备完成，先核对范围。")),
          )
          fun layout() {
            surface.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
              View.MeasureSpec.makeMeasureSpec(2100, View.MeasureSpec.EXACTLY))
            surface.layout(0, 0, 1080, 2100)
          }
          surface.render(initial)
          layout()
          val titleBar = surface.titleBar
          val player = surface.player
          val titleBounds = Rect(titleBar.left, titleBar.top, titleBar.right, titleBar.bottom)
          val playerBounds = Rect(player.left, player.top, player.right, player.bottom)
          val summary = surface.pageFor(MinutesDetailTab.SUMMARY)
          val summaryChildren = descendants(summary)
          for (generation in 1..50) {
            val state = initial.copy(
              activeTab = if (generation % 2 == 0) MinutesDetailTab.SUMMARY else MinutesDetailTab.TRANSCRIPT,
              tabGeneration = generation,
              summaryGenerating = generation % 3 == 0,
              processingStatusLabel = if (generation % 3 == 0) "正在整理会议记录" else "",
            )
            surface.render(state)
            layout()
            assertSame(titleBar, surface.titleBar)
            assertSame(player, surface.player)
            assertEquals(titleBounds, Rect(titleBar.left, titleBar.top, titleBar.right, titleBar.bottom))
            assertEquals(playerBounds, Rect(player.left, player.top, player.right, player.bottom))
            assertSame(summary, surface.pageFor(MinutesDetailTab.SUMMARY))
            assertEquals(summaryChildren, descendants(summary))
          }
          surface.render(initial.copy(tabGeneration = 51))
          layout()
          // A focused production-component sample, not an unattached-window
          // imitation of the complete app (IME/system chrome are tested there).
          val sample = MinutesSummaryPage(context, {})
          sample.render(initial)
          sample.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(1600, View.MeasureSpec.EXACTLY))
          sample.layout(0, 0, 1080, 1600)
          val bitmap = Bitmap.createBitmap(1080, 1600, Bitmap.Config.ARGB_8888)
          sample.draw(Canvas(bitmap))
          File(output, "$theme.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
          bitmap.recycle()
        }
      }
    } finally {
      instrumentation.runOnMainSync { NativeThemePreference.write(context, originalTheme) }
    }
  }

  private fun descendants(view: View): List<View> = buildList {
    add(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) addAll(descendants(view.getChildAt(index)))
  }
}
