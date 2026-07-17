package com.laoji.nativeplatform.audio

// MIN-ASR-001 / MIN-AUDIO-001: Header-authenticated realtime ASR transports binary PCM directly.

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val MAX_WEBSOCKET_QUEUE_BYTES = 4L * 1_048_576L

enum class ReadyToStopOutcome {
  READY,
  CLOSED,
  TIMEOUT,
  END_FRAME_REJECTED,
}

interface RealtimeAsrSocketListener {
  fun onTranscript(transcript: AsrServerEvent.Transcript)
  fun onServerError(detail: String)
  fun onTransportFailure(code: RecorderErrorCode, message: String)
}

class RealtimeAsrSocket(
  private val config: RecorderStartConfig,
  private val listener: RealtimeAsrSocketListener,
) {
  private val opened = AtomicBoolean(false)
  private val readyToStop = AtomicBoolean(false)
  private val endFrameSent = AtomicBoolean(false)
  private val clientClosing = AtomicBoolean(false)
  private val terminalSignal = CountDownLatch(1)
  private val connection = CompletableFuture<Unit>()
  private val client = sharedClient.newBuilder()
    .connectTimeout(config.connectionTimeoutMs, TimeUnit.MILLISECONDS)
    .readTimeout(0L, TimeUnit.MILLISECONDS)
    .build()

  @Volatile
  private var webSocket: WebSocket? = null

  fun connect(): CompletableFuture<Unit> {
    val websocketUrl = config.websocketUrl
      ?: throw RecorderRuntimeException(RecorderErrorCode.INVALID_OPTIONS, "realtime websocketUrl is required")
    val credentials = config.credentials
      ?: throw RecorderRuntimeException(RecorderErrorCode.INVALID_OPTIONS, "realtime credentials are required")
    val request = Request.Builder()
      .url(websocketUrl)
      .header(credentials.headerName, credentials.headerValue)
      .build()
    webSocket = client.newWebSocket(request, SocketListener())
    return connection
  }

  fun isOpen(): Boolean = opened.get()

  fun sendPcm(buffer: ByteArray, count: Int): Boolean {
    val socket = webSocket ?: return false
    val byteCount = count.coerceIn(0, buffer.size) and -2
    if (!opened.get() || endFrameSent.get() || byteCount == 0) return false
    if (socket.queueSize() > MAX_WEBSOCKET_QUEUE_BYTES) {
      listener.onTransportFailure(
        RecorderErrorCode.WEBSOCKET_SEND_FAILED,
        "realtime transcription connection is not accepting audio",
      )
      return false
    }
    val accepted = socket.send(buffer.toByteString(0, byteCount))
    if (!accepted) {
      opened.set(false)
      listener.onTransportFailure(
        RecorderErrorCode.WEBSOCKET_SEND_FAILED,
        "realtime transcription audio send failed",
      )
    }
    return accepted
  }

  fun sendEndFrame(): Boolean {
    if (!endFrameSent.compareAndSet(false, true)) return true
    val socket = webSocket ?: return false
    if (!opened.get()) return false
    return socket.send(ByteString.EMPTY)
  }

  fun awaitReadyToStop(timeoutMs: Long): ReadyToStopOutcome {
    if (!endFrameSent.get()) return ReadyToStopOutcome.END_FRAME_REJECTED
    if (readyToStop.get()) return ReadyToStopOutcome.READY
    val signaled = terminalSignal.await(timeoutMs, TimeUnit.MILLISECONDS)
    return when {
      readyToStop.get() -> ReadyToStopOutcome.READY
      signaled -> ReadyToStopOutcome.CLOSED
      else -> ReadyToStopOutcome.TIMEOUT
    }
  }

  fun close() {
    clientClosing.set(true)
    opened.set(false)
    val socket = webSocket
    if (socket != null && !socket.close(1000, "recording complete")) {
      socket.cancel()
    }
  }

  fun cancel() {
    clientClosing.set(true)
    opened.set(false)
    webSocket?.cancel()
    terminalSignal.countDown()
  }

  private inner class SocketListener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      opened.set(true)
      connection.complete(Unit)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      when (val event = AsrProtocol.parse(text)) {
        is AsrServerEvent.Transcript -> listener.onTranscript(event)
        is AsrServerEvent.Error -> listener.onServerError(event.detail)
        AsrServerEvent.ReadyToStop -> {
          if (endFrameSent.get()) {
            readyToStop.set(true)
            terminalSignal.countDown()
          }
        }
        AsrServerEvent.Ignored -> Unit
      }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      opened.set(false)
      webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      opened.set(false)
      terminalSignal.countDown()
      if (!readyToStop.get() && !clientClosing.get()) {
        listener.onTransportFailure(
          RecorderErrorCode.WEBSOCKET_DISCONNECTED,
          "realtime transcription connection closed before completion",
        )
      }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      opened.set(false)
      terminalSignal.countDown()
      if (!connection.isDone) {
        connection.completeExceptionally(
          RecorderRuntimeException(
            RecorderErrorCode.WEBSOCKET_CONNECT_FAILED,
            "unable to connect to realtime transcription",
          ),
        )
      } else if (!clientClosing.get()) {
        listener.onTransportFailure(
          RecorderErrorCode.WEBSOCKET_DISCONNECTED,
          "realtime transcription connection failed",
        )
      }
    }
  }

  companion object {
    private val sharedClient = OkHttpClient.Builder()
      .pingInterval(20L, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .followRedirects(false)
      .followSslRedirects(false)
      .build()
  }
}
