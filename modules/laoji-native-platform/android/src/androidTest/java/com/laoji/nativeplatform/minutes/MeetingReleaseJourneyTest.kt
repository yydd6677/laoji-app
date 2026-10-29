package com.laoji.nativeplatform.minutes

import android.app.UiAutomation
import android.content.pm.ApplicationInfo
import android.graphics.Rect
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in black-box journey of the installed production-mode app, not this test host. */
@RunWith(AndroidJUnit4::class)
class MeetingReleaseJourneyTest {
  private val automation: UiAutomation get() = InstrumentationRegistry.getInstrumentation().uiAutomation
  private val appPackage = "com.laoji.app"

  @Test(timeout = 300_000)
  fun repeatedMeetingEntry() {
    val args = InstrumentationRegistry.getArguments()
    assumeTrue(args.getString("laoji.release_journey") == "1")
    val sampleTitle = requireNotNull(args.getString("sample_title"))
    val phase = args.getString("phase", "baseline").also { require(it.matches(Regex("[a-z0-9-]+"))) }
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val info = context.packageManager.getPackageInfo(appPackage, 0)
    assertFalse("Must measure a real release, not a Metro/debug build",
      requireNotNull(info.applicationInfo).flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
    val output = File(context.filesDir, "release-journey").apply { mkdirs() }
    toList()
    awaitText("会议记录")
    tap(clickable(awaitText(sampleTitle)))
    val contentText = awaitReadingContent().text.toString()
    automation.waitForIdle(100, 2000)
    tap(findDescription("返回") ?: error("Detail back action missing"))
    awaitText("会议记录")
    automation.waitForIdle(100, 2000)

    val rows = JSONArray()
    for (index in 0 until 55) {
      val start = tap(clickable(awaitText(sampleTitle)))
      assertTrue("Same persisted summary must remain readable", awaitReadingContent().text.toString() == contentText)
      val accessible = SystemClock.uptimeMillis() - start
      // Readiness timing ends above. Do not issue the next gesture while the
      // entering route is still producing accessibility events.
      automation.waitForIdle(100, 2000)
      val back = tap(findDescription("返回") ?: error("Detail back action missing"))
      awaitText("会议记录")
      val returned = SystemClock.uptimeMillis() - back
      automation.waitForIdle(100, 2000)
      if (index >= 5) rows.put(JSONObject().put("iteration", index - 5)
        .put("content_accessible_ms", accessible).put("return_accessible_ms", returned))
      File(output, "$phase-partial.json").writeText(JSONObject().put("phase", phase)
        .put("version", info.versionName).put("measured", rows.length()).put("samples", rows).toString(2))
    }
    val result = JSONObject().put("version", info.versionName).put("phase", phase)
      .put("warmups", 5).put("measured", rows.length()).put("samples", rows)
      .put("metric", "injected-up to accessible persisted paragraph / meeting list")
      .put("visual_readiness", "not_measured: pixel reference method failed; retained as failed evidence")
      .put("limits", "Accessibility is not first paint. Frame deadlines are collected separately; not a physical-device benchmark")
    File(output, "$phase.json").writeText(result.toString(2))
    assertTrue(rows.length() == 50)
  }

  private fun awaitReadingContent(): AccessibilityNodeInfo {
    fun detail(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
      if (node.packageName == appPackage && node.viewIdResourceName == "meeting-detail-native-root"
        && node.isVisibleToUser) return node
      for (index in 0 until node.childCount) node.getChild(index)?.let { detail(it)?.let { found -> return found } }
      return null
    }
    fun content(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
      val bounds = Rect().also(node::getBoundsInScreen)
      if (node.packageName == appPackage && node.className == "android.widget.TextView"
        && node.isVisibleToUser && (node.text?.length ?: 0) >= 32 && bounds.height() >= 64) return node
      for (index in 0 until node.childCount) node.getChild(index)?.let { content(it)?.let { found -> return found } }
      return null
    }
    val deadline = SystemClock.uptimeMillis() + 8000
    while (SystemClock.uptimeMillis() < deadline) {
      // The meeting-list cover can contain the same paragraph. Only the real
      // detail host qualifies; a readable cover is not a completed navigation.
      automation.rootInActiveWindow?.let(::detail)?.let(::content)?.let { return it }
      SystemClock.sleep(10)
    }
    error("Expected readable meeting content missing")
  }

  private fun findText(text: String): AccessibilityNodeInfo? = automation.rootInActiveWindow
    ?.findAccessibilityNodeInfosByText(text)?.firstOrNull {
      it.packageName == appPackage && it.text?.toString() == text && it.isVisibleToUser
    }

  private fun findDescription(description: String): AccessibilityNodeInfo? {
    fun search(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
      if (node.packageName == appPackage && node.contentDescription?.toString() == description
        && node.isVisibleToUser && node.isClickable) return node
      for (index in 0 until node.childCount) node.getChild(index)?.let { search(it)?.let { found -> return found } }
      return null
    }
    return automation.rootInActiveWindow?.let(::search)
  }

  private fun awaitText(text: String): AccessibilityNodeInfo {
    val deadline = SystemClock.uptimeMillis() + 8000
    while (SystemClock.uptimeMillis() < deadline) {
      findText(text)?.let { return it }
      SystemClock.sleep(10)
    }
    error("Expected release content missing")
  }

  private fun clickable(node: AccessibilityNodeInfo): AccessibilityNodeInfo {
    var current = node
    while (!current.isClickable) current = current.parent ?: error("Action has no clickable owner")
    require(current.packageName == appPackage)
    return current
  }

  private fun tap(node: AccessibilityNodeInfo): Long {
    val bounds = Rect().also(node::getBoundsInScreen)
    val down = SystemClock.uptimeMillis()
    fun send(action: Int) {
      val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action,
        bounds.exactCenterX(), bounds.exactCenterY(), 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }
      try { check(automation.injectInputEvent(event, true)) } finally { event.recycle() }
    }
    send(MotionEvent.ACTION_DOWN)
    SystemClock.sleep(16)
    val up = SystemClock.uptimeMillis()
    send(MotionEvent.ACTION_UP)
    return up
  }

  private fun toList() {
    val deadline = SystemClock.uptimeMillis() + 10000
    var actions = 0
    while (SystemClock.uptimeMillis() < deadline) {
      if (findText("会议记录") != null) return
      val meetings = findDescription("会议")
      val back = findDescription("返回")
      when {
        meetings != null && actions < 3 -> { tap(meetings); actions++ }
        back != null && actions < 3 -> { tap(back); actions++ }
        else -> { SystemClock.sleep(10); continue }
      }
      automation.waitForIdle(100, 2000)
    }
    awaitText("会议记录")
  }
}
