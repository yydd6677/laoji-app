package com.laoji.nativeplatform.audio

import android.content.Context
import com.laoji.nativeplatform.transfer.CredentialLeaseStore
import com.laoji.nativeplatform.transfer.DeviceV2LeaseRefresher
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Durable device-v2 realtime transport; local capture never waits for the network. */
internal class DeviceV2RealtimeAsrSocket(
  context: Context,
  private val config: RecorderStartConfig,
  listener: RealtimeAsrSocketListener,
) : RealtimeAsrTransport {
  private val v2 = requireNotNull(config.deviceV2)
  private val credentialStore = CredentialLeaseStore(context)
  private val cursorStore = DeviceV2RealtimeCursorStore(context)
  private val stateLock = Any()
  private val io: ScheduledExecutorService = ScheduledThreadPoolExecutor(1) { runnable ->
    Thread(runnable, "laoji-device-v2-realtime-io").apply { isDaemon = true }
  }.apply {
    removeOnCancelPolicy = true
    setExecuteExistingDelayedTasksAfterShutdownPolicy(false)
  }
  private val client = sharedClient.newBuilder()
    .connectTimeout(config.connectionTimeoutMs, TimeUnit.MILLISECONDS)
    .readTimeout(0L, TimeUnit.MILLISECONDS)
    .build()
  private val initialConnection = CompletableFuture<Unit>()
  private val terminal = CountDownLatch(1)
  private val clientClosing = AtomicBoolean(false)
  private val finalRequested = AtomicBoolean(false)
  private val readyToStop = AtomicBoolean(false)
  private val accepting = AtomicBoolean(false)
  private val networkReady = AtomicBoolean(false)
  private val reconnectScheduled = AtomicBoolean(false)
  @Volatile private var listener = listener
  private var cursor = cursorStore.load(config.sessionId, v2)
  private var durableNextChunkSequence = cursor.nextChunkSequence
  private var durableNextSourceByteOffset = cursor.nextSourceByteOffset
  private val durable = DeviceV2RealtimeDurableStore(
    context,
    config.sessionId,
    cursor.requestFingerprint,
  )
  @Volatile private var lastEventReceived = maxOf(
    cursor.lastEventAck,
    durable.eventsAfter(0L).maxOfOrNull { it.sequence } ?: 0L,
  )
  @Volatile private var socket: WebSocket? = null
  private var socketGeneration = 0L
  private var reconnectAttempts = 0
  private val pcmPacketizer = RealtimePcmPacketizer()

  init {
    val pending = durable.chunksAfter(cursor.lastChunkAck)
    var expected = cursor.lastChunkAck + 1L
    var recoveredOffset = cursor.nextSourceByteOffset
    pending.forEach { chunk ->
      val metadata = DeviceV2RealtimeFrameCodec.inspect(chunk.frame)
      require(chunk.sequence == expected && metadata.chunkSequence == chunk.sequence) {
        "device-v2 realtime durable chunk sequence is invalid"
      }
      recoveredOffset = maxOf(recoveredOffset, metadata.sourceEndByteOffset)
      expected += 1L
    }
    if (expected > cursor.nextChunkSequence) {
      cursor = cursor.copy(
        nextChunkSequence = expected,
        nextSourceByteOffset = recoveredOffset,
      )
      durableNextChunkSequence = expected
      durableNextSourceByteOffset = recoveredOffset
      cursorStore.save(config.sessionId, cursor)
    }
  }

  override fun connect(): CompletableFuture<Unit> {
    io.execute { guardedDurableWork {
      replayLocalEvents()
      connectSocket(refresh = false)
    } }
    return initialConnection
  }

  override fun isOpen(): Boolean = accepting.get()

  override fun nextSourceByteOffset(): Long = synchronized(stateLock) { cursor.nextSourceByteOffset }

  override fun attachListener(next: RealtimeAsrSocketListener) {
    listener = next
  }

  override fun sendPcm(buffer: ByteArray, count: Int): Boolean {
    val byteCount = count.coerceIn(0, buffer.size)
    return synchronized(stateLock) {
      if (!accepting.get() || finalRequested.get() || byteCount <= 0) return@synchronized false
      try {
        pcmPacketizer.append(buffer, byteCount).forEach(::queuePcm)
        true
      } catch (_: Exception) {
        failTransport("实时转写本机恢复缓存不可用")
        false
      }
    }
  }

  // Reservation and executor submission share one lock with finalization, so
  // the final partial packet cannot be overtaken by session.finalize.
  private fun queuePcm(payload: ByteArray) {
    val sequence = cursor.nextChunkSequence
    val offset = cursor.nextSourceByteOffset
    cursor = cursor.copy(nextChunkSequence = sequence + 1L, nextSourceByteOffset = offset + payload.size)
    io.execute {
      try {
        val frame = DeviceV2RealtimeFrameCodec.encode(sequence, offset, payload, payload.size)
        durable.writeChunk(sequence, frame)
        synchronized(stateLock) {
          durableNextChunkSequence = sequence + 1L
          durableNextSourceByteOffset = offset + payload.size
        }
        saveCursor()
        if (networkReady.get() && socket?.send(frame.toByteString()) != true) {
          scheduleReconnect(refresh = false)
        }
      } catch (_: Exception) {
        failTransport("实时转写本机恢复缓存不可用")
      }
    }
  }

  override fun sendEndFrame(): Boolean {
    return synchronized(stateLock) {
      if (finalRequested.get()) return@synchronized true
      if (!accepting.get()) return@synchronized false
      finalRequested.set(true)
      try {
        pcmPacketizer.finish()?.let(::queuePcm)
        io.execute {
          if (networkReady.get() && socket?.send(DeviceV2RealtimeProtocol.finalizeFrame()) != true) {
            scheduleReconnect(refresh = false)
          }
        }
        true
      } catch (_: Exception) {
        failTransport("实时转写末段音频无法安全保存")
        false
      }
    }
  }

  override fun awaitReadyToStop(timeoutMs: Long): ReadyToStopOutcome {
    val completed = terminal.await(timeoutMs.coerceAtLeast(1L), TimeUnit.MILLISECONDS)
    return when {
      readyToStop.get() -> ReadyToStopOutcome.READY
      clientClosing.get() -> ReadyToStopOutcome.CLOSED
      !completed -> ReadyToStopOutcome.DRAIN_TIMEOUT
      else -> ReadyToStopOutcome.CLOSED
    }
  }

  override fun acknowledgePersistedTranscript(throughEventSequence: Long): Boolean {
    if (throughEventSequence < 1L || throughEventSequence > lastEventReceived) return false
    return try {
      io.execute { guardedDurableWork {
        val current = synchronized(stateLock) { cursor }
        if (throughEventSequence < current.lastLocalEventAck || throughEventSequence > lastEventReceived) {
          return@guardedDurableWork
        }
        synchronized(stateLock) {
          cursor = cursor.copy(lastLocalEventAck = throughEventSequence)
        }
        saveCursor()
        durable.deleteEventsThrough(
          minOf(throughEventSequence, synchronized(stateLock) { cursor.lastEventAck }),
        )
      } }
      true
    } catch (_: Exception) {
      false
    }
  }

  override fun close() {
    if (!clientClosing.compareAndSet(false, true)) return
    accepting.set(false)
    networkReady.set(false)
    synchronized(stateLock) { pcmPacketizer.clear() }
    socket?.close(1000, "recording complete")
    terminal.countDown()
    io.shutdown()
  }

  override fun cancel() {
    if (!clientClosing.compareAndSet(false, true)) return
    accepting.set(false)
    networkReady.set(false)
    synchronized(stateLock) { pcmPacketizer.clear() }
    socket?.cancel()
    terminal.countDown()
    io.shutdownNow()
  }

  private fun connectSocket(refresh: Boolean) {
    if (clientClosing.get()) return
    try {
      var nextLease = credentialStore.get(v2.credentialScope, v2.credentialGeneration)
        ?: throw IllegalStateException("device-v2 credential lease is unavailable")
      if (refresh || (nextLease.expiresAtMs ?: 0L) <= System.currentTimeMillis() + 30_000L) {
        nextLease = DeviceV2LeaseRefresher(client, credentialStore).refresh(nextLease)
      }
      val deviceId = nextLease.deviceId ?: throw IllegalStateException("device-v2 identity is unavailable")
      val epochId = nextLease.deviceEpochId ?: throw IllegalStateException("device-v2 epoch is unavailable")
      val request = Request.Builder()
        .url(requireNotNull(config.websocketUrl))
        .header("Authorization", "Bearer ${nextLease.accessToken}")
        .header("X-Laoji-Device-Id", deviceId)
        .header("X-Laoji-Epoch-Id", epochId)
        .build()
      val generation = synchronized(stateLock) {
        socketGeneration += 1L
        socketGeneration
      }
      val opened = client.newWebSocket(request, SocketListener(generation))
      synchronized(stateLock) {
        // close/cancel can arrive while newWebSocket is returning. Do not
        // leave that just-created connection outside the terminal owner.
        if (clientClosing.get() || socketGeneration != generation) opened.cancel()
        else socket = opened
      }
    } catch (_: Exception) {
      scheduleReconnect(refresh = false)
    }
  }

  private fun onReady(event: DeviceV2RealtimeServerEvent.Ready, webSocket: WebSocket) {
    try {
      val current = persistedCursorSnapshot()
      if (
        event.lastChunkAck < current.lastChunkAck ||
        event.lastChunkAck >= current.nextChunkSequence ||
        event.lastEventSequence < current.lastEventAck
      ) {
        throw IllegalStateException("device-v2 realtime cursor regressed")
      }
      synchronized(stateLock) {
        cursor = cursor.copy(lastChunkAck = event.lastChunkAck)
      }
      saveCursor()
      durable.deleteChunksThrough(event.lastChunkAck)
      reconnectAttempts = 0
      reconnectScheduled.set(false)
      networkReady.set(true)
      accepting.set(true)
      val pending = durable.chunksAfter(event.lastChunkAck)
      var expectedSequence = event.lastChunkAck + 1L
      pending.forEach { chunk ->
        if (chunk.sequence != expectedSequence) {
          throw IllegalStateException("device-v2 realtime replay sequence is incomplete")
        }
        expectedSequence += 1L
        if (!networkReady.get() || webSocket.send(chunk.frame.toByteString()).not()) {
          throw IllegalStateException("device-v2 realtime replay was rejected")
        }
      }
      if (expectedSequence != current.nextChunkSequence) {
        throw IllegalStateException("device-v2 realtime replay payload is incomplete")
      }
      if (finalRequested.get() && !webSocket.send(DeviceV2RealtimeProtocol.finalizeFrame())) {
        throw IllegalStateException("device-v2 realtime finalize was rejected")
      }
      initialConnection.complete(Unit)
    } catch (_: Exception) {
      scheduleReconnect(refresh = false)
    }
  }

  private fun onAudioAck(event: DeviceV2RealtimeServerEvent.AudioAck) {
    val current = persistedCursorSnapshot()
    if (
      event.chunkSequence > event.lastChunkAck ||
      event.lastChunkAck < current.lastChunkAck ||
      event.lastChunkAck >= current.nextChunkSequence
    ) {
      failTransport("实时转写音频确认游标无效")
      return
    }
    synchronized(stateLock) { cursor = cursor.copy(lastChunkAck = event.lastChunkAck) }
    saveCursor()
    durable.deleteChunksThrough(event.lastChunkAck)
  }

  private fun onTranscript(raw: String, event: DeviceV2RealtimeServerEvent.Transcript) {
    try {
      if (event.eventKind == "partial") {
        require(event.eventSequence == 0L && event.outcome == "text" && event.text.isNotBlank())
        listener.onTranscript(AsrServerEvent.Transcript(
          text = event.text, isFinal = false, speakerId = null, speakerName = null,
          speakerConfidence = null, startMs = event.sourceStartMs, endMs = event.sourceEndMs,
          source = "device-v2", purpose = "meeting",
          revisionKey = "meeting-window:${event.sourceStartMs}",
        ))
        // Preview is intentionally not persisted or acknowledged. Only
        // stable/final events may move the recovery/acknowledgement cursor.
        return
      }
      val duplicate = synchronized(stateLock) {
        when {
          event.eventSequence <= lastEventReceived -> true
          event.eventSequence == lastEventReceived + 1L -> {
            lastEventReceived = event.eventSequence
            false
          }
          else -> throw IllegalStateException("device-v2 realtime event sequence gap")
        }
      }
      durable.writeEvent(event.eventSequence, raw)
      if (!duplicate && event.eventKind == "stable") {
        listener.onTranscript(
          AsrServerEvent.Transcript(
            text = event.text,
            isFinal = true,
            speakerId = null,
            speakerName = null,
            speakerConfidence = null,
            startMs = event.sourceStartMs,
            endMs = event.sourceEndMs,
            source = "device-v2",
            purpose = "meeting",
            eventSequence = event.eventSequence,
            stableSegmentKey = event.stableSegmentKey,
            revisionKey = "meeting-window:${event.sourceStartMs}",
          ),
        )
      }
      if (socket?.send(DeviceV2RealtimeProtocol.eventAckFrame(event.eventSequence)) != true) {
        scheduleReconnect(refresh = false)
      }
    } catch (_: Exception) {
      failTransport("实时转写事件无法安全保存")
    }
  }

  private fun onEventsAcked(event: DeviceV2RealtimeServerEvent.EventsAcked) {
    val current = synchronized(stateLock) { cursor }
    if (event.throughEventSequence < current.lastEventAck || event.throughEventSequence > lastEventReceived) {
      failTransport("实时转写事件确认游标无效")
      return
    }
    synchronized(stateLock) { cursor = cursor.copy(lastEventAck = event.throughEventSequence) }
    saveCursor()
    durable.deleteEventsThrough(
      minOf(event.throughEventSequence, synchronized(stateLock) { cursor.lastLocalEventAck }),
    )
  }

  private fun replayLocalEvents() {
    durable.eventsAfter(synchronized(stateLock) { cursor.lastLocalEventAck }).forEach { stored ->
      val event = DeviceV2RealtimeProtocol.parse(stored.payload)
      if (event is DeviceV2RealtimeServerEvent.Transcript && event.eventKind == "stable" && event.outcome == "text") {
        listener.onTranscript(
          AsrServerEvent.Transcript(
            text = event.text,
            isFinal = true,
            speakerId = null,
            speakerName = null,
            speakerConfidence = null,
            startMs = event.sourceStartMs,
            endMs = event.sourceEndMs,
            source = "device-v2-local-replay",
            purpose = "meeting",
            eventSequence = event.eventSequence,
            stableSegmentKey = event.stableSegmentKey,
          ),
        )
      }
    }
  }

  private fun scheduleReconnect(refresh: Boolean) {
    if (clientClosing.get()) return
    if (!reconnectScheduled.compareAndSet(false, true)) return
    networkReady.set(false)
    val previous = synchronized(stateLock) {
      socketGeneration += 1L
      val old = socket; socket = null
      old
    }
    previous?.cancel()
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      reconnectScheduled.set(false)
      failTransport("实时转写连接多次恢复失败")
      return
    }
    reconnectAttempts += 1
    val delay = minOf(4_000L, 250L shl (reconnectAttempts - 1).coerceAtMost(4))
    try {
      // A retry delay is not disk IO. Keep this same single owner free for
      // durable PCM/events instead of blocking it for up to four seconds.
      io.schedule({
        reconnectScheduled.set(false)
        connectSocket(refresh)
      }, delay, TimeUnit.MILLISECONDS)
    } catch (_: Exception) {
      reconnectScheduled.set(false)
      failTransport("实时转写连接无法恢复")
    }
  }

  private fun saveCursor() {
    cursorStore.save(config.sessionId, persistedCursorSnapshot())
  }

  private fun persistedCursorSnapshot(): DeviceV2RealtimeCursor = synchronized(stateLock) {
    cursor.copy(
      nextChunkSequence = durableNextChunkSequence,
      nextSourceByteOffset = durableNextSourceByteOffset,
    )
  }

  /** Executor failures do not complete their caller's future automatically.
   * A failed durable replay/ACK must release this transport, not leave capture
   * waiting forever or continue with an uncommitted recovery cursor. Keep all
   * source files intact for the existing same-identity recovery path. */
  private inline fun guardedDurableWork(action: () -> Unit) {
    try {
      action()
    } catch (_: Exception) {
      failTransport("实时转写本机恢复缓存不可用")
    }
  }

  private fun failTransport(message: String) {
    if (clientClosing.getAndSet(true)) return
    accepting.set(false)
    networkReady.set(false)
    socket?.cancel()
    if (!initialConnection.isDone) {
      initialConnection.completeExceptionally(
        RecorderRuntimeException(RecorderErrorCode.WEBSOCKET_CONNECT_FAILED, message),
      )
    } else {
      listener.onTransportFailure(RecorderErrorCode.WEBSOCKET_DISCONNECTED, message)
    }
    terminal.countDown()
    io.shutdown()
  }

  private inner class SocketListener(private val generation: Long) : WebSocketListener() {
    private fun isCurrent(): Boolean = synchronized(stateLock) { generation == socketGeneration }

    /** Generation changes and protocol/cursor effects share this existing IO
     * owner. A callback checked on OkHttp's thread can be obsolete by the time
     * its queued work runs; never let it acknowledge or fail the replacement. */
    private fun enqueue(webSocket: WebSocket, action: () -> Unit) {
      if (clientClosing.get() || !isCurrent()) return
      try {
        io.execute {
          val current = synchronized(stateLock) {
            !clientClosing.get() && generation == socketGeneration && socket === webSocket
          }
          if (current) guardedDurableWork(action)
        }
      } catch (_: RejectedExecutionException) {
        if (!clientClosing.get()) failTransport("实时转写连接无法恢复")
      }
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
      // Keep session.open off the disk replay queue, but fence its nonblocking
      // send atomically with generation assignment. onOpen may race the return
      // of newWebSocket, so pointer identity is checked only in queued work.
      val accepted = synchronized(stateLock) {
        if (clientClosing.get() || generation != socketGeneration) null
        else webSocket.send(DeviceV2RealtimeProtocol.openFrame(config, cursor))
      }
      if (accepted == null) webSocket.cancel()
      else if (!accepted) enqueue(webSocket) { scheduleReconnect(refresh = false) }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      enqueue(webSocket) {
        when (val event = DeviceV2RealtimeProtocol.parse(text)) {
          is DeviceV2RealtimeServerEvent.Ready -> onReady(event, webSocket)
          is DeviceV2RealtimeServerEvent.AudioAck -> onAudioAck(event)
          is DeviceV2RealtimeServerEvent.Transcript -> onTranscript(text, event)
          is DeviceV2RealtimeServerEvent.EventsAcked -> onEventsAcked(event)
          is DeviceV2RealtimeServerEvent.Error -> {
            if (event.code == "V2_AUTH_REQUIRED") {
              scheduleReconnect(refresh = true)
            } else if (event.code == "REALTIME_WORKER_FENCED") {
              scheduleReconnect(refresh = false)
            } else {
              listener.onServerError(AsrServerEvent.Error(event.message, event.code, true))
            }
          }
          DeviceV2RealtimeServerEvent.Complete -> {
            readyToStop.set(true)
            terminal.countDown()
          }
          DeviceV2RealtimeServerEvent.Finalizing,
          DeviceV2RealtimeServerEvent.Ignored,
          -> Unit
        }
      }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      if (clientClosing.get()) {
        webSocket.close(code, null)
      } else {
        enqueue(webSocket) {
          networkReady.set(false)
          scheduleReconnect(refresh = code == 4401)
        }
      }
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      enqueue(webSocket) {
        networkReady.set(false)
        if (!readyToStop.get()) scheduleReconnect(refresh = code == 4401)
      }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      val refresh = response?.code == 401
      enqueue(webSocket) {
        networkReady.set(false)
        scheduleReconnect(refresh)
      }
    }
  }

  private companion object {
    const val MAX_RECONNECT_ATTEMPTS = 6
    val sharedClient = OkHttpClient.Builder()
      .pingInterval(20L, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .followRedirects(false)
      .followSslRedirects(false)
      .build()
  }
}
