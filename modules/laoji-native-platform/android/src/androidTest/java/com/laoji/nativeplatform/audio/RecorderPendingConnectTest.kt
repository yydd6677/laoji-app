package com.laoji.nativeplatform.audio

import android.Manifest
import android.content.Intent
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.laoji.nativeplatform.minutes.ExperienceHostActivity
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Actual AudioRecord/engine/socket lifecycle. The local server supplies only
 * transport ACKs; silence is not evidence of ASR or semantic quality. */
@RunWith(AndroidJUnit4::class)
class RecorderPendingConnectTest {
  private fun exercise(delayMs: Long, timeoutMs: Long, completed: Boolean) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
    val activity = instrumentation.startActivitySync(Intent(context, ExperienceHostActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as ExperienceHostActivity
    val server = MockWebServer()
    val received = AtomicLong()
    server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (bytes.size > 0) received.addAndGet(bytes.size.toLong())
        else webSocket.send("""{"type":"ready_to_stop"}""")
      }
    }).setHeadersDelay(delayMs, TimeUnit.MILLISECONDS))
    server.start()
    val id = "pending-connect-${UUID.randomUUID()}"
    val engine = RecorderEngine(context, RecorderStartConfig(
      sessionId = id, purpose = AudioPurpose.SCHEDULE, mode = RecorderMode.REALTIME,
      storageScope = null, websocketUrl = server.url("/").toString().replace("http:", "ws:"),
      credentials = RecorderCredentials.create(null, "local-test"), allowInsecureDevelopment = true,
      connectionTimeoutMs = timeoutMs, stopTimeoutMs = 1000, levelIntervalMs = 120,
      deviceV2 = null, realtimeAttachPending = false,
    ), RecordingRepository(context), object : RecorderEngineHost {
      override fun onSnapshotChanged(snapshot: RecorderSnapshot) = Unit
      override fun onUnexpectedStop(result: RecorderStopResult) = Unit
    })
    try {
      instrumentation.waitForIdleSync()
      assertEquals(RecorderState.RECORDING, engine.start().get(5, TimeUnit.SECONDS).state)
      SystemClock.sleep(350)
      val before = SystemClock.elapsedRealtime()
      val stopped = engine.stop().get(5, TimeUnit.SECONDS)
      val elapsed = SystemClock.elapsedRealtime() - before
      assertTrue(stopped.localSaved)
      assertTrue(stopped.snapshot.bytesRecorded > 0)
      assertTrue("Stop must stay within the original connect budget", elapsed < timeoutMs + 1800)
      assertEquals(completed, stopped.readyToStop)
      assertEquals(!completed, stopped.snapshot.transcriptRecoveryRequired)
      if (completed) {
        assertNull(stopped.errorCode)
        assertEquals("Buffered PCM must precede end-of-stream", stopped.snapshot.bytesRecorded, received.get())
      }
    } finally {
      engine.shutdownForServiceDestroy()
      server.close()
      File(context.filesDir, "laoji-recordings").listFiles()?.filter { it.name.startsWith(id) }
        ?.forEach { it.delete() }
      instrumentation.runOnMainSync { activity.finish() }
    }
  }

  @Test fun shortCaptureDrainsTheSamePendingConnection() = exercise(1400, 3000, true)
  @Test fun stalledHandshakeKeepsTheFileAndHonorsTheDeadline() = exercise(3500, 1000, false)
}
