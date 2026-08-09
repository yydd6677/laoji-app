package com.laoji.nativeplatform.audio

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Optional Android-to-candidate runtime proof.
 *
 * Run with adb reverse and the instrumentation argument
 * `laojiBaseUrl=http://127.0.0.1:28135`. Without that argument the test is
 * skipped, so ordinary connected tests remain independent of a local server.
 */
@RunWith(AndroidJUnit4::class)
class RealtimeAsrCandidateRuntimeTest {
  @Test
  fun realAndroidSocketUsesGuestHeaderAndCompletesStopDrain() {
    val arguments: Bundle = InstrumentationRegistry.getArguments()
    val baseUrl = arguments.getString("laojiBaseUrl")?.trim()?.trimEnd('/')
    assumeTrue("laojiBaseUrl instrumentation argument is required", !baseUrl.isNullOrBlank())
    requireNotNull(baseUrl)

    // The development emulator may inherit a host proxy even after its global
    // proxy setting is cleared. The candidate endpoint is reached through adb
    // reverse, so this proof must bypass all proxy selection explicitly.
    val previousProxySelector = ProxySelector.getDefault()
    ProxySelector.setDefault(object : ProxySelector() {
      override fun select(uri: URI?): List<Proxy> = listOf(Proxy.NO_PROXY)

      override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: java.io.IOException?) = Unit
    })

    try {
      val client = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    val createBody = "{\"title\":\"Android 候选握手验证\"}"
      .toRequestBody("application/json".toMediaType())
    val createRequest = Request.Builder()
      .url("$baseUrl/api/laoji/meetings/guest-sessions")
      .post(createBody)
      .build()
    val sessionResponse = client.newCall(createRequest).execute()
    assertEquals(201, sessionResponse.code)
    val sessionPayload = JSONObject(requireNotNull(sessionResponse.body).string())
    val meetingId = sessionPayload.getString("meeting_id")
    val guestToken = sessionPayload.getString("guest_token")
    val wsBase = baseUrl.replaceFirst("http://", "ws://").replaceFirst("https://", "wss://")

    val transcripts = CopyOnWriteArrayList<AsrServerEvent.Transcript>()
    val serverErrors = CopyOnWriteArrayList<String>()
    val failures = CopyOnWriteArrayList<RecorderErrorCode>()
    val socket = RealtimeAsrSocket(
      RecorderStartConfig.create(
        sessionId = "android-candidate-$meetingId",
        purpose = "meeting",
        storageScope = "guest",
        websocketUrl = "$wsBase/ws/meeting/$meetingId/qwen",
        accessToken = null,
        guestToken = guestToken,
        allowInsecureDevelopment = true,
        connectionTimeoutMs = 10_000.0,
        stopTimeoutMs = 120_000.0,
        levelIntervalMs = 100.0,
      ),
      object : RealtimeAsrSocketListener {
        override fun onTranscript(transcript: AsrServerEvent.Transcript) {
          transcripts += transcript
        }

        override fun onServerError(error: AsrServerEvent.Error) {
          serverErrors += error.detail
        }

        override fun onTransportFailure(code: RecorderErrorCode, message: String) {
          failures += code
        }
      },
    )

      try {
        socket.connect().get(15, TimeUnit.SECONDS)
      val pcm = InstrumentationRegistry.getInstrumentation().context
        .assets.open("meeting_001.pcm").use { it.readBytes() }
      var offset = 0
      while (offset < pcm.size) {
        val end = minOf(offset + AudioRuntimeContract.FRAME_BYTES, pcm.size)
        val frame = pcm.copyOfRange(offset, end)
        assertTrue(socket.sendPcm(frame, frame.size))
        offset = end
        Thread.sleep(100)
      }
      assertTrue(socket.sendEndFrame())
      assertEquals(ReadyToStopOutcome.READY, socket.awaitReadyToStop(120_000))
      assertTrue("native transport failures: $failures", failures.isEmpty())
      assertTrue("server errors: $serverErrors", serverErrors.isEmpty())
      assertTrue("no transcript reached Android", transcripts.isNotEmpty())

      val transcriptRequest = Request.Builder()
        .url("$baseUrl/api/laoji/meetings/guest-sessions/$meetingId/transcripts")
        .header("X-Guest-Session-Token", guestToken)
        .get()
        .build()
      val transcriptResponse = client.newCall(transcriptRequest).execute()
      assertEquals(200, transcriptResponse.code)
      val transcriptPayload = JSONObject(requireNotNull(transcriptResponse.body).string())
      assertTrue(transcriptPayload.getJSONArray("items").length() >= transcripts.size)
      } finally {
        socket.cancel()
        val deleteRequest = Request.Builder()
          .url("$baseUrl/api/laoji/meetings/guest-sessions/$meetingId")
          .header("X-Guest-Session-Token", guestToken)
          .delete()
          .build()
        client.newCall(deleteRequest).execute().close()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
      }
    } finally {
      ProxySelector.setDefault(previousProxySelector)
    }
  }

  @Test
  fun realAndroidSocketCancelDoesNotReportTransportFailureAndSessionCanBeRevoked() {
    val arguments: Bundle = InstrumentationRegistry.getArguments()
    val baseUrl = arguments.getString("laojiBaseUrl")?.trim()?.trimEnd('/')
    assumeTrue("laojiBaseUrl instrumentation argument is required", !baseUrl.isNullOrBlank())
    requireNotNull(baseUrl)

    val previousProxySelector = ProxySelector.getDefault()
    ProxySelector.setDefault(object : ProxySelector() {
      override fun select(uri: URI?): List<Proxy> = listOf(Proxy.NO_PROXY)

      override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: java.io.IOException?) = Unit
    })

    try {
      val client = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
      val createRequest = Request.Builder()
        .url("$baseUrl/api/laoji/meetings/guest-sessions")
        .post("{\"title\":\"Android 候选取消验证\"}".toRequestBody("application/json".toMediaType()))
        .build()
      val sessionResponse = client.newCall(createRequest).execute()
      assertEquals(201, sessionResponse.code)
      val sessionPayload = JSONObject(requireNotNull(sessionResponse.body).string())
      val meetingId = sessionPayload.getString("meeting_id")
      val guestToken = sessionPayload.getString("guest_token")
      val failures = CopyOnWriteArrayList<RecorderErrorCode>()
      val serverErrors = CopyOnWriteArrayList<String>()
      val wsBase = baseUrl.replaceFirst("http://", "ws://").replaceFirst("https://", "wss://")
      val socket = RealtimeAsrSocket(
      RecorderStartConfig.create(
        sessionId = "android-cancel-$meetingId",
        purpose = "meeting",
        storageScope = "guest",
        websocketUrl = "$wsBase/ws/meeting/$meetingId/qwen",
        accessToken = null,
        guestToken = guestToken,
        allowInsecureDevelopment = true,
        connectionTimeoutMs = 10_000.0,
        stopTimeoutMs = 10_000.0,
        levelIntervalMs = 100.0,
      ),
      object : RealtimeAsrSocketListener {
        override fun onTranscript(transcript: AsrServerEvent.Transcript) = Unit

        override fun onServerError(error: AsrServerEvent.Error) {
          serverErrors += error.detail
        }

        override fun onTransportFailure(code: RecorderErrorCode, message: String) {
          failures += code
        }
      },
      )

      try {
        socket.connect().get(15, TimeUnit.SECONDS)
        val pcm = InstrumentationRegistry.getInstrumentation().context
          .assets.open("meeting_001.pcm").use { it.readBytes() }
        var offset = 0
        repeat(8) {
          val end = minOf(offset + AudioRuntimeContract.FRAME_BYTES, pcm.size)
          val frame = pcm.copyOfRange(offset, end)
          assertTrue(socket.sendPcm(frame, frame.size))
          offset = end
          Thread.sleep(50)
        }
        socket.cancel()
        Thread.sleep(500)
        assertTrue("native transport failures after client cancel: $failures", failures.isEmpty())
        assertTrue("server errors after client cancel: $serverErrors", serverErrors.isEmpty())

        val transcriptRequest = Request.Builder()
          .url("$baseUrl/api/laoji/meetings/guest-sessions/$meetingId/transcripts")
          .header("X-Guest-Session-Token", guestToken)
          .get()
          .build()
        assertEquals(200, client.newCall(transcriptRequest).execute().code)
      } finally {
        socket.cancel()
        val deleteRequest = Request.Builder()
          .url("$baseUrl/api/laoji/meetings/guest-sessions/$meetingId")
          .header("X-Guest-Session-Token", guestToken)
          .delete()
          .build()
        assertEquals(204, client.newCall(deleteRequest).execute().code)
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
      }
    } finally {
      ProxySelector.setDefault(previousProxySelector)
    }
  }
}
