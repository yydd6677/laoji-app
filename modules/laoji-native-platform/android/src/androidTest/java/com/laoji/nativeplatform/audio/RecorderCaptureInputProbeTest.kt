package com.laoji.nativeplatform.audio

import android.Manifest
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.laoji.nativeplatform.minutes.ExperienceHostActivity
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in ingress evidence, not a mocked recorder or an ASR quality test.
 * Only the test APK receives microphone permission or keeps a probe WAV.
 */
@RunWith(AndroidJUnit4::class)
class RecorderCaptureInputProbeTest {
  @Test fun captureSchedulePcmAtTheRealAudioRecordBoundary() {
    assumeTrue(InstrumentationRegistry.getArguments().getString("capturePcmProbe") == "true")
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
    val host = instrumentation.startActivitySync(Intent(context, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val id = "pcm-probe-${UUID.randomUUID()}"
    val engine = RecorderEngine(context, RecorderStartConfig(
      sessionId = id, purpose = AudioPurpose.SCHEDULE, mode = RecorderMode.LOCAL_ONLY,
      storageScope = null, websocketUrl = null, credentials = null, allowInsecureDevelopment = false,
      connectionTimeoutMs = 8000, stopTimeoutMs = 10000, levelIntervalMs = 120,
      deviceV2 = null, realtimeAttachPending = false,
    ), RecordingRepository(context), object : RecorderEngineHost {
      override fun onSnapshotChanged(snapshot: RecorderSnapshot) = Unit
      override fun onUnexpectedStop(result: RecorderStopResult) = Unit
    })
    try {
      instrumentation.waitForIdleSync()
      val started = engine.start().get(10, TimeUnit.SECONDS)
      assertEquals(RecorderState.RECORDING, started.state)
      Log.i("LaoJiPcmProbe", "CAPTURE_STARTED")
      SystemClock.sleep(12000)
      val stopped = engine.stop().get(15, TimeUnit.SECONDS)
      assertTrue(stopped.localSaved)
      val wav = File(android.net.Uri.parse(requireNotNull(stopped.snapshot.localUri)).path!!)
      assertTrue(wav.length() > AudioRuntimeContract.BYTES_PER_SECOND)
      wav.copyTo(File(context.filesDir, "schedule-capture-probe.wav"), overwrite = true)
      Log.i("LaoJiPcmProbe", "CAPTURE_FILE_READY bytes=${stopped.snapshot.bytesRecorded}")
    } finally {
      engine.shutdownForServiceDestroy()
      File(context.filesDir, "laoji-recordings").listFiles()?.filter { it.name.startsWith(id) }
        ?.forEach { it.delete() }
      instrumentation.runOnMainSync { host.finish() }
    }
  }
}
