package com.laoji.nativeplatform.audio

// MIN-ASR-001 / MIN-AUDIO-001: Header-authenticated realtime ASR transports binary PCM directly.

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Dns
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val MAX_WEBSOCKET_QUEUE_BYTES = 4L * 1_048_576L

enum class ReadyToStopOutcome {
  READY,
  CLOSED,
  LEGACY_TIMEOUT,
  ACK_TIMEOUT,
  DRAIN_TIMEOUT,
  END_FRAME_REJECTED,
}

interface RealtimeAsrSocketListener {
  fun onTranscript(transcript: AsrServerEvent.Transcript)
  fun onServerError(error: AsrServerEvent.Error)
  fun onTransportFailure(code: RecorderErrorCode, message: String)
}

interface RealtimeAsrTransport {
  fun connect(): CompletableFuture<Unit>
  fun isOpen(): Boolean
  fun attachListener(next: RealtimeAsrSocketListener)
  fun sendPcm(buffer: ByteArray, count: Int): Boolean
  fun sendEndFrame(): Boolean
  fun awaitReadyToStop(timeoutMs: Long): ReadyToStopOutcome
  fun acknowledgePersistedTranscript(throughEventSequence: Long): Boolean = false
  /** Resume a file-backed producer at the durable transport cursor, never byte zero. */
  fun nextSourceByteOffset(): Long = 0L
  fun close()
  fun cancel()
}

class RealtimeAsrSocket(
  private val config: RecorderStartConfig,
  listener: RealtimeAsrSocketListener,
) : RealtimeAsrTransport {
  @Volatile
  private var listener = listener
  private val opened = AtomicBoolean(false)
  private val clientClosing = AtomicBoolean(false)
  private val stopHandshake = AsrStopHandshake()
  private val connection = CompletableFuture<Unit>()
  @Volatile private var connectStage = "queued"
  private var connectStartedNanos = 0L
  private val client = sharedClient.newBuilder()
    .dns(object : Dns {
      override fun lookup(hostname: String): List<java.net.InetAddress> {
        connectStage = "dns"
        return sharedClient.dns.lookup(hostname).also { connectStage = "connect_tls_upgrade" }
      }
    })
    .connectTimeout(config.connectionTimeoutMs, TimeUnit.MILLISECONDS)
    .readTimeout(0L, TimeUnit.MILLISECONDS)
    .build()

  @Volatile
  private var webSocket: WebSocket? = null

  override fun connect(): CompletableFuture<Unit> {
    val websocketUrl = config.websocketUrl
      ?: throw RecorderRuntimeException(RecorderErrorCode.INVALID_OPTIONS, "realtime websocketUrl is required")
    val credentials = config.credentials
      ?: throw RecorderRuntimeException(RecorderErrorCode.INVALID_OPTIONS, "realtime credentials are required")
    val requestBuilder = Request.Builder().url(websocketUrl)
    credentials.headers.forEach { (name, value) -> requestBuilder.header(name, value) }
    val request = requestBuilder.build()
    connectStartedNanos = System.nanoTime()
    webSocket = client.newWebSocket(request, SocketListener())
    return connection
  }

  override fun isOpen(): Boolean = opened.get()

  override fun attachListener(next: RealtimeAsrSocketListener) {
    listener = next
  }

  override fun sendPcm(buffer: ByteArray, count: Int): Boolean {
    val socket = webSocket ?: return false
    val byteCount = count.coerceIn(0, buffer.size) and -2
    if (!opened.get() || stopHandshake.hasStopStarted() || byteCount == 0) return false
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

  override fun sendEndFrame(): Boolean {
    if (!stopHandshake.beginStop()) return true
    val socket = webSocket ?: return false
    if (!opened.get()) return false
    return socket.send(ByteString.EMPTY)
  }

  override fun awaitReadyToStop(timeoutMs: Long): ReadyToStopOutcome {
    return stopHandshake.awaitCompletion(timeoutMs)
  }

  override fun close() {
    closePendingConnection("close")
    val socket = webSocket
    if (socket != null && !socket.close(1000, "recording complete")) {
      socket.cancel()
    }
  }

  override fun cancel() {
    closePendingConnection("cancel")
    webSocket?.cancel()
    stopHandshake.markClosed()
  }

  private fun closePendingConnection(reason: String) {
    synchronized(connection) {
      if (!connection.isDone) {
        if (connectStartedNanos != 0L) Log.i("LaojiAsrTransport",
          "connect_cancel stage=$connectStage reason=$reason elapsed_ms=${connectElapsedMs()}")
        connection.completeExceptionally(RecorderRuntimeException(
          RecorderErrorCode.WEBSOCKET_CONNECT_FAILED, "realtime transcription connection closed before opening"))
      }
      clientClosing.set(true)
      opened.set(false)
    }
  }

  private fun connectElapsedMs(): Long = if (connectStartedNanos == 0L) 0L
    else TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - connectStartedNanos).coerceAtLeast(0L)

  private inner class SocketListener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      synchronized(connection) {
        if (clientClosing.get()) {
          webSocket.cancel()
          return
        }
        connectStage = "open"
        opened.set(true)
        connection.complete(Unit)
      }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      if (clientClosing.get()) return
      when (val event = AsrProtocol.parse(text)) {
        is AsrServerEvent.Config -> {
          stopHandshake.observeConfig(event.stopCapability)
        }
        is AsrServerEvent.Transcript -> listener.onTranscript(event)
        is AsrServerEvent.Error -> listener.onServerError(event)
        AsrServerEvent.StopAcknowledged -> stopHandshake.acknowledgeStop()
        AsrServerEvent.ReadyToStop -> stopHandshake.markReadyToStop()
        AsrServerEvent.Ignored -> Unit
      }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      if (!connection.isDone && !clientClosing.get() && connectStartedNanos != 0L) Log.i("LaojiAsrTransport",
        "connect_closed stage=$connectStage close_code=$code elapsed_ms=${connectElapsedMs()}")
      opened.set(false)
      signalClosed()
      webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      opened.set(false)
      signalClosed()
      if (!stopHandshake.isReadyToStop() && !clientClosing.get()) {
        listener.onTransportFailure(
          RecorderErrorCode.WEBSOCKET_DISCONNECTED,
          "realtime transcription connection closed before completion",
        )
      }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      val connecting = !connection.isDone
      opened.set(false)
      signalClosed()
      if (!clientClosing.get()) {
        // Keep the cause at the native transport boundary: JS intentionally
        // receives a stable Chinese error, not platform exception prose.
        Log.i("LaojiAsrTransport", "failure phase=${if (connecting) "connect" else "stream"} stage=$connectStage" +
          " kind=${asrTransportFailureKind(t)} http_status=${response?.code ?: 0} elapsed_ms=${connectElapsedMs()}")
      }
      if (!connecting && !clientClosing.get()) {
        listener.onTransportFailure(
          RecorderErrorCode.WEBSOCKET_DISCONNECTED,
          "realtime transcription connection failed",
        )
      }
    }

    private fun signalClosed() {
      stopHandshake.markClosed()
      connection.completeExceptionally(RecorderRuntimeException(
        RecorderErrorCode.WEBSOCKET_CONNECT_FAILED, "realtime transcription connection closed before opening"))
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

object RealtimeAsrWarmPool {
  private object WarmListener : RealtimeAsrSocketListener {
    override fun onTranscript(transcript: AsrServerEvent.Transcript) = Unit
    override fun onServerError(error: AsrServerEvent.Error) = Unit
    override fun onTransportFailure(code: RecorderErrorCode, message: String) = Unit
  }

  private data class Entry(
    val sessionId: String,
    val websocketUrl: String,
    val socket: RealtimeAsrSocket,
    val connection: CompletableFuture<Unit>,
  )

  private val lock = Any()
  private var entry: Entry? = null

  fun prewarm(config: RecorderStartConfig): CompletableFuture<Unit> {
    require(config.mode == RecorderMode.REALTIME) { "only realtime recording can be prewarmed" }
    val socket = RealtimeAsrSocket(config, WarmListener)
    val connection = try {
      socket.connect()
    } catch (error: Exception) {
      CompletableFuture<Unit>().also { it.completeExceptionally(error) }
    }
    val created = Entry(
      sessionId = config.sessionId,
      websocketUrl = requireNotNull(config.websocketUrl),
      socket = socket,
      connection = connection,
    )
    val previous = synchronized(lock) {
      entry.also { entry = created }
    }
    previous?.socket?.close()
    connection.whenComplete { _, error ->
      if (error != null) {
        synchronized(lock) {
          if (entry === created) entry = null
        }
        socket.cancel()
      }
    }
    return connection
  }

  fun claim(
    config: RecorderStartConfig,
    listener: RealtimeAsrSocketListener,
  ): Pair<RealtimeAsrSocket, CompletableFuture<Unit>>? {
    var stale: Entry? = null
    val claimed = synchronized(lock) {
      val current = entry
      if (
        current == null ||
        current.sessionId != config.sessionId ||
        current.websocketUrl != config.websocketUrl
      ) {
        null
      } else if (current.connection.isDone && !current.socket.isOpen()) {
        entry = null
        stale = current
        null
      } else {
        entry = null
        current
      }
    }
    stale?.socket?.cancel()
    claimed ?: return null
    claimed.socket.attachListener(listener)
    return claimed.socket to claimed.connection
  }

  fun discard(sessionId: String) {
    val discarded = synchronized(lock) {
      entry?.takeIf { it.sessionId == sessionId }?.also { entry = null }
    }
    discarded?.socket?.close()
  }
}
