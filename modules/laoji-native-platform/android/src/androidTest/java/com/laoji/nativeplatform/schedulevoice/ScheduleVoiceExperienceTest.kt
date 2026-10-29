package com.laoji.nativeplatform.schedulevoice

import android.content.res.Configuration
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.view.MotionEvent
import android.os.SystemClock
import android.widget.TextView
import android.widget.EditText
import android.graphics.Rect
import android.text.Spanned
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.laoji.nativeplatform.NativeThemePreference
import com.laoji.nativeplatform.ui.NativeUiTokens
import com.laoji.nativeplatform.minutes.ExperienceHostActivity
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.BridgeReactContext
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import java.lang.ref.WeakReference
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScheduleVoiceExperienceTest {
  @Test fun attachedVoiceKeepsDraftCompositionAndConfirmationAcrossSkins() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val base = instrumentation.targetContext
    val previous = NativeThemePreference.read(base)
    val host = instrumentation.startActivitySync(Intent(base, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val events = mutableListOf<Map<String, Any>>()
    lateinit var page: ScheduleVoiceHostView
    lateinit var input: EditText
    lateinit var answer: EditText
    var originalChildren = emptyList<View>()
    var originalBounds = emptyList<Rect>()
    val composition = Any()
    val text = "周三下午去图书馆还书"
    val draft = mapOf<String, Any?>("schemaVersion" to 2, "phase" to "input", "text" to text, "canParse" to true)
    try {
      instrumentation.runOnMainSync {
        NativeThemePreference.write(base, "neutral")
        val react: ReactApplicationContext = BridgeReactContext(base)
        val app = AppContext(object : ModulesProvider {
          override fun getModulesList(): List<Class<out Module>> = emptyList()
        }, expo.modules.core.ModuleRegistry(emptyList(), emptyList()), WeakReference(react))
        page = ScheduleVoiceHostView(host, app)
        page.setBridgeEventsEnabled(false)
        page.setActionListener(events::add)
        host.setContentView(page)
        page.setSnapshot(draft)
      }
      instrumentation.waitForIdleSync()
      // Wait for the existing entrance, not for a synthetic theme animation.
      android.os.SystemClock.sleep(350)
      instrumentation.runOnMainSync {
        input = field(page, "input")
        answer = field(page, "clarificationAnswer")
        input.requestFocus(); input.setSelection(2, 5)
        input.text.setSpan(composition, 1, 6, Spanned.SPAN_COMPOSING or Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        originalChildren = descendants(page)
        originalBounds = originalChildren.map(::bounds)
      }
      val editable = input.text
      for (theme in listOf("vivid", "paper", "midnight", "neutral")) {
        instrumentation.runOnMainSync { NativeThemePreference.write(base, theme) }
        instrumentation.waitForIdleSync()
        instrumentation.runOnMainSync {
          assertEquals(originalChildren, descendants(page))
          assertEquals(originalBounds, originalChildren.map(::bounds))
          assertSame(editable, input.text)
          assertEquals(text, input.text.toString())
          assertEquals(2, input.selectionStart); assertEquals(5, input.selectionEnd)
          assertEquals(1, input.text.getSpanStart(composition)); assertEquals(6, input.text.getSpanEnd(composition))
          assertTrue(input.hasFocus())
          assertEquals(NativeUiTokens.palette(host).textPrimary, input.currentTextColor)
          assertTrue(events.isEmpty())
        }
      }
      // A theme update between DOWN and UP must not restart capture or steal
      // the held gesture. This verifies action ownership, not real microphone ASR.
      instrumentation.runOnMainSync { page.setSnapshot(draft) }
      SystemClock.sleep(350)
      val down = SystemClock.uptimeMillis()
      instrumentation.runOnMainSync {
        val mic = field<View>(page, "mic")
        MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, mic.width / 2f, mic.height / 2f, 0).let {
          assertTrue(mic.dispatchTouchEvent(it)); it.recycle()
        }
        page.setSnapshot(draft + mapOf("phase" to "preparing"))
      }
      lateinit var pulse: Any
      instrumentation.runOnMainSync { pulse = field<Any>(field<View>(page, "mic"), "pulseAnimator") }
      for (theme in listOf("vivid", "paper", "midnight", "neutral")) {
        instrumentation.runOnMainSync {
          NativeThemePreference.write(base, theme)
          val mic = field<View>(page, "mic")
          assertTrue(field<Boolean>(mic, "recording"))
          assertSame(pulse, field<Any>(mic, "pulseAnimator"))
          assertEquals(listOf("record-start"), events.map { it["type"] })
        }
      }
      SystemClock.sleep(350)
      instrumentation.runOnMainSync {
        val mic = field<View>(page, "mic")
        MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, mic.width / 2f, mic.height / 2f, 0).let {
          assertTrue(mic.dispatchTouchEvent(it)); it.recycle()
        }
        assertEquals(listOf("record-start", "record-stop"), events.map { it["type"] })
        events.clear()
        page.setSnapshot(draft)
      }
      val confirm = draft + mapOf("phase" to "confirm", "title" to "还书", "canSave" to false,
        "needsClarification" to true, "clarificationQuestion" to "几点开始？", "clarificationAnswer" to "下午三点",
        "canClarify" to true, "fields" to listOf(mapOf("key" to "date", "label" to "日期", "value" to "2026年10月28日")))
      instrumentation.runOnMainSync { page.setSnapshot(confirm) }
      android.os.SystemClock.sleep(350)
      instrumentation.waitForIdleSync()
      instrumentation.runOnMainSync {
        answer.requestFocus(); answer.setSelection(1, 3)
        originalChildren = descendants(page)
        originalBounds = originalChildren.map(::bounds)
      }
      val answerEditable = answer.text
      for (theme in listOf("vivid", "paper", "midnight", "neutral")) {
        instrumentation.runOnMainSync { NativeThemePreference.write(base, theme) }
        instrumentation.waitForIdleSync()
        instrumentation.runOnMainSync {
          assertEquals(originalChildren, descendants(page))
          assertEquals(originalBounds, originalChildren.map(::bounds))
          assertSame(answerEditable, answer.text)
          assertEquals("下午三点", answer.text.toString())
          assertEquals(1, answer.selectionStart); assertEquals(3, answer.selectionEnd)
          assertTrue(answer.hasFocus())
          assertFalse(field<TextView>(page, "saveButton").isEnabled)
          assertTrue(events.isEmpty())
        }
      }
    } finally {
      instrumentation.runOnMainSync { NativeThemePreference.write(base, previous); host.finish() }
    }
  }

  private fun bounds(view: View) = Rect(view.left, view.top, view.right, view.bottom)
  @Suppress("UNCHECKED_CAST")
  private fun <T> field(owner: Any, name: String): T = owner.javaClass.getDeclaredField(name).let {
    it.isAccessible = true; it.get(owner) as T
  }

  @Test fun confirmationKeepsFieldsAcrossUpdatesAndWrapsAtLargeFont() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val original = NativeThemePreference.read(instrumentation.targetContext)
    val output = File(instrumentation.targetContext.filesDir, "voice-gallery").apply { mkdirs() }
    try {
      for (theme in listOf("neutral", "vivid", "paper", "midnight")) for (scale in listOf(1f, 2f)) {
        instrumentation.runOnMainSync {
          val configuration = Configuration(instrumentation.targetContext.resources.configuration).apply { fontScale = scale }
          val context = instrumentation.targetContext.createConfigurationContext(configuration)
          NativeThemePreference.write(context, theme)
          val view = ScheduleVoiceFields(context)
          val text = "在南校区图书馆三楼阅览室参加小组讨论并核对资料"
          val state = listOf(ScheduleVoiceField("date", "日期", "2026年10月28日"),
            ScheduleVoiceField("location", "地点", text))
          fun layout() {
            view.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
              View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.AT_MOST))
            view.layout(0, 0, 1080, view.measuredHeight)
          }
          view.render(state); layout()
          val field = descendants(view).filterIsInstance<TextView>().single { it.text.toString() == text }
          val row = field.parent as ViewGroup
          val label = row.getChildAt(0) as TextView
          assertEquals(label.top + label.baseline, field.top + field.baseline)
          assertNull(field.ellipsize)
          assertTrue(field.layout.lineCount > 1)
          for (update in 1..50) view.render(state.toList())
          assertSame(field, descendants(view).filterIsInstance<TextView>().single { it.text.toString() == text })
          val bitmap = Bitmap.createBitmap(1080, view.height, Bitmap.Config.ARGB_8888)
          val canvas = Canvas(bitmap)
          canvas.drawColor(NativeUiTokens.palette(context).surface)
          view.draw(canvas)
          File(output, "$theme-$scale.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
          bitmap.recycle()
        }
      }
    } finally {
      NativeThemePreference.write(instrumentation.targetContext, original)
    }
  }

  private fun descendants(view: View): List<View> = buildList {
    add(view)
    if (view is ViewGroup) for (index in 0 until view.childCount) addAll(descendants(view.getChildAt(index)))
  }
}
