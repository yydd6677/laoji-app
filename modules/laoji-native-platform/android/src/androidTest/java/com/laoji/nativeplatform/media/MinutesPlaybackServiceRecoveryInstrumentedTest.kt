package com.laoji.nativeplatform.media

// MIN-PLAYER-RECOVERY-001: API35 real-WAV production Service recreation route.

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Looper
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import com.laoji.nativeplatform.calendar.CalendarSurfaceTestActivity
import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumentation cannot force-stop its own target package without killing the test runner. This
 * suite therefore exercises a controlled stopService/reconnect recreation. The full-package route
 * gate remains external: force-stop target package, relaunch it, then reconnect to the session.
 */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 35)
class MinutesPlaybackServiceRecoveryInstrumentedTest {
  private lateinit var context: Context
  private lateinit var store: EncryptedMinutesPlaybackStore
  private lateinit var wav: File
  private lateinit var activityScenario: ActivityScenario<CalendarSurfaceTestActivity>

  @Before
  fun setUp() {
    context = InstrumentationRegistry.getInstrumentation().targetContext
    context.stopService(serviceIntent())
    SystemClock.sleep(300L)
    store = EncryptedMinutesPlaybackStore(context)
    store.resetForTest()
    MinutesPlaybackScopeStore(context).activate(STORAGE_SCOPE)
    wav = createPcmWav(context.filesDir, durationSeconds = 8)
    // Android 15 permits the initial audio-focus request while the user-facing activity is top.
    activityScenario = ActivityScenario.launch(CalendarSurfaceTestActivity::class.java)
  }

  @After
  fun tearDown() {
    runCatching {
      connectController().also { controller ->
        sendCommand(controller, MINUTES_CLEAR_SOURCE_COMMAND)
        onMain { controller.release() }
      }
    }
    context.stopService(serviceIntent())
    store.resetForTest()
    wav.delete()
    activityScenario.close()
  }

  @Test
  fun realLocalWavRestoresSourcePositionAndRatePausedAfterControlledServiceRecreation() {
    val first = connectController()
    assertEquals(
      SessionResult.RESULT_SUCCESS,
      sendCommand(
        first,
        MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND,
        minutesStorageScopeArguments(STORAGE_SCOPE),
      ),
    )
    val source = MinutesPlayerSource(
      sourceId = "local:api35-service-recreation",
      uri = wav.toURI().toString(),
      title = "API35 本地 WAV",
      durationMsHint = 8_000L,
      retainForBackground = true,
      storageScope = STORAGE_SCOPE,
    )
    assertEquals(
      SessionResult.RESULT_SUCCESS,
      sendCommand(first, MINUTES_SET_SOURCE_COMMAND, source.toSessionArguments()),
    )
    waitUntil { snapshot(first).mediaId == source.sourceId }
    waitUntil { snapshot(first).playbackState == Player.STATE_READY }

    onMain {
      first.seekTo(1_600L)
      first.setPlaybackSpeed(1.5f)
      first.play()
    }
    waitUntil { snapshot(first).isPlaying }
    waitUntil { snapshot(first).positionMs >= 1_750L }
    activityScenario.moveToState(Lifecycle.State.CREATED)
    waitUntil { snapshot(first).isPlaying }
    val persistedPosition = snapshot(first).positionMs
    waitUntil {
      store.load(STORAGE_SCOPE)?.let {
        it.wasPlaying && it.positionMs >= 1_600L && it.rate == 1.5f
      } == true
    }

    onMain { first.release() }
    context.stopService(serviceIntent())
    SystemClock.sleep(700L)

    val restored = connectController()
    waitUntil { snapshot(restored).mediaId == source.sourceId }
    waitUntil { snapshot(restored).playbackState == Player.STATE_READY }
    val state = snapshot(restored)
    assertEquals(source.sourceId, state.mediaId)
    assertNotNull(state.title)
    assertTrue(state.positionMs in (persistedPosition - 700L)..(persistedPosition + 700L))
    assertEquals(1.5f, state.rate, 0.001f)
    assertFalse("recovery must never auto-play", state.isPlaying)
    assertFalse("recovery must clear playWhenReady", state.playWhenReady)
    onMain { restored.release() }
  }

  @Test
  fun sameScopeReconnectKeepsServiceStateButUserSwitchAndSignOutClearImmediately() {
    val first = connectController()
    assertEquals(
      SessionResult.RESULT_SUCCESS,
      sendCommand(first, MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND, minutesStorageScopeArguments(STORAGE_SCOPE)),
    )
    val source = MinutesPlayerSource(
      sourceId = "local:scope-reconnect",
      uri = wav.toURI().toString(),
      title = "Scope 重连 WAV",
      durationMsHint = 8_000L,
      retainForBackground = true,
      storageScope = STORAGE_SCOPE,
    )
    assertEquals(
      SessionResult.RESULT_SUCCESS,
      sendCommand(first, MINUTES_SET_SOURCE_COMMAND, source.toSessionArguments()),
    )
    waitUntil { snapshot(first).mediaId == source.sourceId }
    onMain { first.seekTo(1_100L) }
    waitUntil { store.load(STORAGE_SCOPE)?.positionMs == 1_100L }
    onMain { first.release() }

    val reconnected = connectController()
    waitUntil { snapshot(reconnected).mediaId == source.sourceId }
    assertEquals(
      SessionResult.RESULT_SUCCESS,
      sendCommand(
        reconnected,
        MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND,
        minutesStorageScopeArguments(STORAGE_SCOPE),
      ),
    )
    assertEquals(source.sourceId, snapshot(reconnected).mediaId)

    assertEquals(
      SessionResult.RESULT_SUCCESS,
      sendCommand(
        reconnected,
        MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND,
        minutesStorageScopeArguments("user:switched"),
      ),
    )
    waitUntil { snapshot(reconnected).mediaId == null }
    assertFalse(store.encryptedFileForTest().exists())
    assertEquals(
      SessionResult.RESULT_ERROR_BAD_VALUE,
      sendCommand(reconnected, MINUTES_SET_SOURCE_COMMAND, source.toSessionArguments()),
    )

    assertEquals(
      SessionResult.RESULT_SUCCESS,
      sendCommand(
        reconnected,
        MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND,
        minutesStorageScopeArguments(MINUTES_SIGNED_OUT_SCOPE),
      ),
    )
    assertEquals(null, snapshot(reconnected).mediaId)
    assertFalse(store.encryptedFileForTest().exists())
    onMain { reconnected.release() }
  }

  private fun connectController(): MediaController {
    val future = MediaController.Builder(
      context,
      SessionToken(context, ComponentName(context, LaojiMinutesPlaybackService::class.java)),
    )
      .setApplicationLooper(Looper.getMainLooper())
      .buildAsync()
    return future.get(15, TimeUnit.SECONDS)
  }

  private fun sendCommand(
    controller: MediaController,
    command: androidx.media3.session.SessionCommand,
    arguments: android.os.Bundle = android.os.Bundle.EMPTY,
  ): Int {
    val future = onMain { controller.sendCustomCommand(command, arguments) }
    return future.get(10, TimeUnit.SECONDS).resultCode
  }

  private data class ControllerState(
    val mediaId: String?,
    val title: CharSequence?,
    val playbackState: Int,
    val positionMs: Long,
    val rate: Float,
    val isPlaying: Boolean,
    val playWhenReady: Boolean,
  )

  private fun snapshot(controller: MediaController): ControllerState = onMain {
    ControllerState(
      mediaId = controller.currentMediaItem?.mediaId,
      title = controller.currentMediaItem?.mediaMetadata?.title,
      playbackState = controller.playbackState,
      positionMs = controller.currentPosition,
      rate = controller.playbackParameters.speed,
      isPlaying = controller.isPlaying,
      playWhenReady = controller.playWhenReady,
    )
  }

  private fun waitUntil(timeoutMs: Long = 12_000L, condition: () -> Boolean) {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      if (condition()) return
      SystemClock.sleep(50L)
    }
    throw AssertionError("condition was not met within ${timeoutMs}ms")
  }

  private fun serviceIntent() = Intent(context, LaojiMinutesPlaybackService::class.java)

  private fun <T> onMain(block: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    val value = AtomicReference<T>()
    val failure = AtomicReference<Throwable>()
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      try {
        value.set(block())
      } catch (error: Throwable) {
        failure.set(error)
      }
    }
    failure.get()?.let { throw it }
    return value.get()
  }

  private fun createPcmWav(directory: File, durationSeconds: Int): File {
    val sampleRate = 8_000
    val pcmBytes = sampleRate * durationSeconds * 2
    val buffer = ByteBuffer.allocate(44 + pcmBytes).order(ByteOrder.LITTLE_ENDIAN)
    buffer.put("RIFF".toByteArray(Charsets.US_ASCII))
    buffer.putInt(36 + pcmBytes)
    buffer.put("WAVE".toByteArray(Charsets.US_ASCII))
    buffer.put("fmt ".toByteArray(Charsets.US_ASCII))
    buffer.putInt(16)
    buffer.putShort(1)
    buffer.putShort(1)
    buffer.putInt(sampleRate)
    buffer.putInt(sampleRate * 2)
    buffer.putShort(2)
    buffer.putShort(16)
    buffer.put("data".toByteArray(Charsets.US_ASCII))
    buffer.putInt(pcmBytes)
    repeat(pcmBytes / 2) { sample ->
      buffer.putShort((if (sample % 80 < 40) 1_200 else -1_200).toShort())
    }
    return File(directory, "minutes-recovery-${System.nanoTime()}.wav").apply {
      writeBytes(buffer.array())
    }
  }

  companion object {
    private const val STORAGE_SCOPE = "user:api35-recovery"
  }
}
