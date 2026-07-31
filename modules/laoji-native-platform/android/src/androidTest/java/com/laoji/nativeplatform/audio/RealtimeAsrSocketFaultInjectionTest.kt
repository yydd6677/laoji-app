package com.laoji.nativeplatform.audio

import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class RealtimeAsrSocketFaultInjectionTest {
  @Test
  fun reportsAckTimeoutWhenNegotiatedServerNeverAcknowledges() {
    runScenario(
      onStop = { _ -> Unit },
      expected = ReadyToStopOutcome.ACK_TIMEOUT,
      maxElapsedMs = 2_000,
    )
  }

  @Test
  fun reportsDrainTimeoutAfterAcknowledgementWithoutReady() {
    runScenario(
      onStop = { socket -> socket.send("{\"type\":\"stop_acknowledged\"}") },
      expected = ReadyToStopOutcome.DRAIN_TIMEOUT,
      maxElapsedMs = 4_500,
    )
  }

  @Test
  fun reportsClosedWhenServerClosesAfterAcknowledgement() {
    runScenario(
      onStop = { socket ->
        socket.send("{\"type\":\"stop_acknowledged\"}")
        socket.close(1011, "injected close")
      },
      expected = ReadyToStopOutcome.CLOSED,
      maxElapsedMs = 2_000,
    )
  }

  private fun runScenario(
    onStop: (WebSocket) -> Unit,
    expected: ReadyToStopOutcome,
    maxElapsedMs: Long,
  ) {
    ProxySelector.setDefault(object : ProxySelector() {
      override fun select(uri: URI?): List<Proxy> = listOf(Proxy.NO_PROXY)

      override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: java.io.IOException?) = Unit
    })
    val server = MockWebServer()
    server.enqueue(
      MockResponse().withWebSocketUpgrade(
        object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(
              "{\"type\":\"config\",\"stop_protocol\":\"ack_then_drain_v1\"," +
                "\"final_drain_timeout_ms\":1000}",
            )
          }

          override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (bytes.size == 0) onStop(webSocket)
          }
        },
      ),
    )
    server.start()
    val failures = CopyOnWriteArrayList<RecorderErrorCode>()
    val socket = RealtimeAsrSocket(
      RecorderStartConfig.create(
        sessionId = "svc03-fault-${expected.name.lowercase()}",
        purpose = "meeting",
        storageScope = "guest",
        websocketUrl = server.url("/ws").toString().replaceFirst("http://", "ws://"),
        accessToken = null,
        guestToken = "test-token",
        allowInsecureDevelopment = true,
        connectionTimeoutMs = 5_000.0,
        stopTimeoutMs = 1_000.0,
        levelIntervalMs = 100.0,
      ),
      object : RealtimeAsrSocketListener {
        override fun onTranscript(transcript: AsrServerEvent.Transcript) = Unit

        override fun onServerError(detail: String) = Unit

        override fun onTransportFailure(code: RecorderErrorCode, message: String) {
          failures += code
        }
      },
    )

    try {
      socket.connect().get(5, TimeUnit.SECONDS)
      Thread.sleep(100)
      assertTrue(socket.sendEndFrame())
      val started = System.nanoTime()
      val outcome = socket.awaitReadyToStop(1_000)
      val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
      assertEquals(expected, outcome)
      assertTrue("$expected took ${elapsedMs}ms", elapsedMs < maxElapsedMs)
    } finally {
      socket.cancel()
      server.shutdown()
    }
  }
}
