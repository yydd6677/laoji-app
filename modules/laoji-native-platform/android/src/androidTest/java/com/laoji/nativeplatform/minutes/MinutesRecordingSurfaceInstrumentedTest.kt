package com.laoji.nativeplatform.minutes

// MIN-REC-BRIDGE-001: exercise session-scoped native level collection on a mounted Android surface.

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.laoji.nativeplatform.audio.RecorderLevelHub
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MinutesRecordingSurfaceInstrumentedTest {
  @Before
  fun setUp() = RecorderLevelHub.clearAllForTest()

  @After
  fun tearDown() = RecorderLevelHub.clearAllForTest()

  @Test
  fun currentSessionDrivesNativeTimerAndWaveformUntilPausedOrDetached() {
    ActivityScenario.launch(MinutesSurfaceTestActivity::class.java).use { scenario ->
      val surfaceRef = AtomicReference<MinutesRecordingSurface>()
      scenario.onActivity { activity ->
        val surface = MinutesRecordingSurface(activity) {}
        surface.render(recordingState(elapsedMs = 0L))
        activity.root.addView(
          surface,
          ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        surfaceRef.set(surface)
      }

      publish("other-session", normalized = 1f, durationMs = 9_000L)
      Thread.sleep(180L)
      assertEquals("00:00", timerText(scenario, surfaceRef.get()))
      assertEquals(0f, waveformValue(scenario, surfaceRef.get()), 0.0001f)

      publish(CURRENT_SESSION, normalized = 0.8f, durationMs = 1_000L)
      waitUntil { timerText(scenario, surfaceRef.get()) == "00:01" }
      waitUntil { waveformValue(scenario, surfaceRef.get()) > 0f }

      publish("other-session", normalized = 1f, durationMs = 12_000L)
      Thread.sleep(120L)
      assertEquals("00:01", timerText(scenario, surfaceRef.get()))

      scenario.onActivity { surfaceRef.get().render(recordingState(MinutesRecordingPhase.PAUSED, elapsedMs = 500L)) }
      publish(CURRENT_SESSION, normalized = 1f, durationMs = 2_000L)
      Thread.sleep(180L)
      assertEquals("00:01", timerText(scenario, surfaceRef.get()))
      assertEquals(0f, waveformValue(scenario, surfaceRef.get()), 0.0001f)

      scenario.onActivity { surfaceRef.get().render(recordingState(elapsedMs = 500L)) }
      publish(CURRENT_SESSION, normalized = 0.7f, durationMs = 3_000L)
      waitUntil { timerText(scenario, surfaceRef.get()) == "00:03" }

      scenario.onActivity { surfaceRef.get().render(recordingState(sessionId = NEXT_SESSION, elapsedMs = 0L)) }
      publish(CURRENT_SESSION, normalized = 1f, durationMs = 7_000L)
      Thread.sleep(150L)
      assertEquals("00:00", timerText(scenario, surfaceRef.get()))
      publish(NEXT_SESSION, normalized = 0.6f, durationMs = 1_000L)
      waitUntil { timerText(scenario, surfaceRef.get()) == "00:01" }
      waitUntil { waveformValue(scenario, surfaceRef.get()) > 0f }

      scenario.onActivity { activity -> activity.root.removeView(surfaceRef.get()) }
      publish(NEXT_SESSION, normalized = 1f, durationMs = 6_000L)
      Thread.sleep(180L)
      assertEquals("00:01", timerText(scenario, surfaceRef.get()))
    }
  }

  private fun recordingState(
    phase: MinutesRecordingPhase = MinutesRecordingPhase.RECORDING,
    elapsedMs: Long,
    sessionId: String = CURRENT_SESSION,
  ) = MinutesRecordingState(
    meetingId = sessionId,
    phase = phase,
    elapsedMs = elapsedMs,
    statusLabel = if (phase == MinutesRecordingPhase.PAUSED) "录音已暂停" else "实时转写中",
    canPause = phase == MinutesRecordingPhase.RECORDING || phase == MinutesRecordingPhase.PAUSED,
    canStop = true,
    canStart = false,
  )

  private fun publish(sessionId: String, normalized: Float, durationMs: Long) {
    RecorderLevelHub.publish(
      sessionId = sessionId,
      normalized = normalized,
      peak = 1_000,
      rms = 500,
      durationMs = durationMs,
      capturedAtElapsedMs = durationMs,
    )
  }

  private fun timerText(
    scenario: ActivityScenario<MinutesSurfaceTestActivity>,
    surface: MinutesRecordingSurface,
  ): String {
    val result = AtomicReference("")
    scenario.onActivity {
      result.set(surface.descendants<TextView>().first { view -> view.text?.matches(CLOCK_PATTERN) == true }.text.toString())
    }
    return result.get()
  }

  private fun waveformValue(
    scenario: ActivityScenario<MinutesSurfaceTestActivity>,
    surface: MinutesRecordingSurface,
  ): Float {
    val result = AtomicReference(0f)
    scenario.onActivity {
      val waveform = surface.descendants<MinutesRecordingWaveformView>().single()
      val processorField = MinutesRecordingWaveformView::class.java.getDeclaredField("processor").apply {
        isAccessible = true
      }
      val processor = processorField.get(waveform)
      val displayedField = WaveformSignalProcessor::class.java.getDeclaredField("displayedValue").apply {
        isAccessible = true
      }
      result.set(displayedField.getFloat(processor))
    }
    return result.get()
  }

  private inline fun <reified T : View> View.descendants(): List<T> = descendants(T::class.java)

  private fun <T : View> View.descendants(type: Class<T>): List<T> {
    val matches = mutableListOf<T>()
    val pending = ArrayDeque<View>()
    pending.add(this)
    while (pending.isNotEmpty()) {
      val view = pending.removeFirst()
      if (type.isInstance(view)) matches += requireNotNull(type.cast(view))
      if (view is ViewGroup) repeat(view.childCount) { index -> pending.addLast(view.getChildAt(index)) }
    }
    return matches
  }

  private fun waitUntil(timeoutMs: Long = 2_000L, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (condition()) return
      Thread.sleep(25L)
    }
    assertTrue("condition was not met within ${timeoutMs}ms", condition())
  }

  companion object {
    private const val CURRENT_SESSION = "meeting-current"
    private const val NEXT_SESSION = "meeting-next"
    private val CLOCK_PATTERN = Regex("\\d{2}:\\d{2}")
  }
}
