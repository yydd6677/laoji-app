package com.laoji.nativeplatform.audio

import android.content.SharedPreferences
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Delayed
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Exercise the actual SocketListener and IO queue, not a second policy model.
 * Constructor bypass is host-test-only: the exercised stale/preview/complete
 * paths need no Android context, credentials, audio files or network service. */
class DeviceV2SocketCallbackOwnerTest {
  private class Socket : WebSocket {
    var cancels = 0
    var closes = 0
    val sent = mutableListOf<String>()
    override fun request(): Request = Request.Builder().url("http://127.0.0.1/").build()
    override fun queueSize() = 0L
    override fun send(text: String): Boolean { sent += text; return true }
    override fun send(bytes: ByteString) = true
    override fun close(code: Int, reason: String?): Boolean { closes++; return true }
    override fun cancel() { cancels++ }
  }
  private class Harness {
    val executor = ScheduledThreadPoolExecutor(1)
    val release = CountDownLatch(1)
    val transcripts = mutableListOf<String>()
    val errors = mutableListOf<String>()
    val old = Socket(); val replacement = Socket()
    val subject: DeviceV2RealtimeAsrSocket
    val callback: WebSocketListener
    fun field(name: String) = DeviceV2RealtimeAsrSocket::class.java.getDeclaredField(name).also { it.isAccessible = true }
    fun set(name: String, value: Any) { field(name).set(subject, value) }
    fun flag(name: String) = field(name).get(subject) as AtomicBoolean
    fun <T> withoutConstructor(type: Class<T>): T {
      val unsafeClass = Class.forName("sun.misc.Unsafe")
      val unsafe = unsafeClass.getDeclaredField("theUnsafe").also { it.isAccessible = true }.get(null)
      return type.cast(unsafeClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, type))
    }
    init {
      subject = withoutConstructor(DeviceV2RealtimeAsrSocket::class.java)
      set("io", executor); set("stateLock", Any()); set("socketGeneration", 1L); set("socket", old)
      set("clientClosing", AtomicBoolean(false)); set("accepting", AtomicBoolean(true))
      set("networkReady", AtomicBoolean(true)); set("readyToStop", AtomicBoolean(false))
      set("reconnectScheduled", AtomicBoolean(false)); set("finalRequested", AtomicBoolean(false))
      set("initialConnection", CompletableFuture<Unit>()); set("terminal", CountDownLatch(1))
      set("pcmPacketizer", RealtimePcmPacketizer())
      set("config", RecorderStartConfig.createLocalMeeting("socket-io-host-test", "guest", 100.0))
      set("cursor", DeviceV2RealtimeCursor("host-test-only", lastChunkAck = 8, lastEventAck = 8,
        lastLocalEventAck = 4, nextChunkSequence = 10))
      set("durableNextChunkSequence", 10L); set("durableNextSourceByteOffset", 0L); set("lastEventReceived", 10L)
      set("listener", object : RealtimeAsrSocketListener {
        override fun onTranscript(transcript: AsrServerEvent.Transcript) { transcripts += transcript.text }
        override fun onServerError(error: AsrServerEvent.Error) { errors += error.detail }
        override fun onTransportFailure(code: RecorderErrorCode, message: String) { errors += message }
      })
      val listenerClass = DeviceV2RealtimeAsrSocket::class.java.declaredClasses.single { it.simpleName == "SocketListener" }
      callback = listenerClass.declaredConstructors.single().also { it.isAccessible = true }
        .newInstance(subject, 1L) as WebSocketListener
      val entered = CountDownLatch(1)
      executor.execute { entered.countDown(); release.await() }
      assertTrue(entered.await(2, TimeUnit.SECONDS))
    }
    fun queueReplacement() { executor.execute { set("socketGeneration", 2L); set("socket", replacement) } }
    fun drain() { val barrier = executor.submit {}; release.countDown(); barrier.get(2, TimeUnit.SECONDS) }
    fun dispose() { flag("clientClosing").set(true); executor.shutdownNow(); release.countDown(); executor.awaitTermination(2, TimeUnit.SECONDS) }
    fun reconnect() {
      DeviceV2RealtimeAsrSocket::class.java.getDeclaredMethod("scheduleReconnect", java.lang.Boolean.TYPE)
        .also { it.isAccessible = true }.invoke(subject, false)
    }
    fun failCursorCommit() {
      // Exercise the real cursor serializer/commit, not a fake ACK handler.
      val editor = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { self, method, _ ->
        when (method.name) {
          "putString" -> self
          "commit" -> false
          else -> error("Unexpected preferences editor call: ${method.name}")
        }
      }
      val preferences = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, _ ->
        if (method.name == "edit") editor else error("Unexpected preferences call: ${method.name}")
      }
      val store = withoutConstructor(DeviceV2RealtimeCursorStore::class.java)
      store.javaClass.getDeclaredField("preferences").also { it.isAccessible = true }.set(store, preferences)
      set("cursorStore", store)
    }
    fun corruptReplay(root: File) {
      File(root, "event-5.bin").writeBytes(byteArrayOf(0, 1, 2, 3))
      val store = withoutConstructor(DeviceV2RealtimeDurableStore::class.java)
      store.javaClass.getDeclaredField("root").also { it.isAccessible = true }.set(store, root)
      store.javaClass.getDeclaredField("sessionId").also { it.isAccessible = true }.set(store, "socket-io-host-test")
      store.javaClass.getDeclaredField("index\$delegate").also { it.isAccessible = true }
        .set(store, lazy { RealtimeSpoolIndex(root) })
      set("durable", store)
    }
  }
  private fun isolated(work: (Harness) -> Unit) {
    val harness = Harness()
    try { work(harness) } finally { harness.dispose() }
  }
  private val partial = """{"contract_revision":"transcript.stream.v2","event_sequence":0,"event_kind":"partial","outcome":"text","text":"预览片段","source_start_ms":0,"source_end_ms":2000}"""

  @Test fun queuedOldPreviewCannotReplaceNewConnectionText() = isolated { h ->
    h.queueReplacement(); h.callback.onMessage(h.old, partial); h.drain()
    assertEquals(emptyList<String>(), h.transcripts)
  }
  @Test fun queuedOldCompleteCannotFinishTheReplacement() = isolated { h ->
    h.queueReplacement(); h.callback.onMessage(h.old, """{"type":"session.complete"}"""); h.drain()
    assertFalse(h.flag("readyToStop").get())
    assertEquals(1L, (h.field("terminal").get(h.subject) as CountDownLatch).count)
  }
  @Test fun queuedOldAudioAckCannotFailTheReplacement() = isolated { h ->
    h.queueReplacement()
    h.callback.onMessage(h.old, """{"type":"audio.ack","chunk_seq":3,"last_contiguous_chunk_seq":3}""")
    h.drain(); assertFalse(h.flag("clientClosing").get()); assertEquals(0, h.replacement.cancels)
  }
  @Test fun queuedOldEventAckCannotFailTheReplacement() = isolated { h ->
    h.queueReplacement(); h.callback.onMessage(h.old, """{"type":"events.acked","acked_through":3}""")
    h.drain(); assertFalse(h.flag("clientClosing").get()); assertEquals(0, h.replacement.cancels)
  }
  @Test fun queuedOldReadyCannotReconnectTheReplacement() = isolated { h ->
    h.queueReplacement()
    h.callback.onMessage(h.old, """{"type":"session.ready","last_contiguous_chunk_seq":3,"last_durable_event_seq":3,"state":"recording"}""")
    h.drain(); assertEquals(0, h.replacement.cancels); assertTrue(h.flag("networkReady").get())
  }
  @Test fun queuedPreviewDoesNotEscapeAfterClose() = isolated { h ->
    h.callback.onMessage(h.old, partial); h.subject.close(); h.release.countDown()
    assertTrue(h.executor.awaitTermination(2, TimeUnit.SECONDS)); assertTrue(h.transcripts.isEmpty())
  }
  @Test fun currentPreviewStillReachesTheConsumer() = isolated { h ->
    h.callback.onMessage(h.old, partial); h.drain(); assertEquals(listOf("预览片段"), h.transcripts)
  }
  @Test fun currentCompleteStillFinishesTheSession() = isolated { h ->
    h.callback.onMessage(h.old, """{"type":"session.complete"}"""); h.drain()
    assertTrue(h.flag("readyToStop").get())
    assertEquals(0L, (h.field("terminal").get(h.subject) as CountDownLatch).count)
  }
  @Test fun aRetiredSocketLosesOwnershipBeforeTheBackoffEnds() = isolated { h ->
    h.reconnect()
    assertNull(h.field("socket").get(h.subject))
    assertTrue(h.field("socketGeneration").getLong(h.subject) > 1L)
    assertEquals(1, h.old.cancels); assertFalse(h.flag("clientClosing").get())
  }
  @Test fun backoffIsScheduledRatherThanOccupyingTheDurableIoQueue() = isolated { h ->
    h.set("reconnectAttempts", 4) // Existing fifth retry delay is four seconds.
    h.reconnect()
    assertTrue(h.executor.queue.any { it is Delayed && it.getDelay(TimeUnit.MILLISECONDS) > 0 })
  }
  @Test fun currentRegressiveAckStillFailsClosedRatherThanDroppingAllMessages() = isolated { h ->
    h.callback.onMessage(h.old, """{"type":"audio.ack","chunk_seq":3,"last_contiguous_chunk_seq":3}""")
    h.drain(); assertTrue(h.flag("clientClosing").get()); assertEquals(1, h.old.cancels)
  }
  @Test fun currentAudioAckCommitFailureCannotLeaveTheTransportAccepting() = isolated { h ->
    h.failCursorCommit()
    h.callback.onMessage(h.old, """{"type":"audio.ack","chunk_seq":9,"last_contiguous_chunk_seq":9}""")
    h.drain()
    assertTrue(h.flag("clientClosing").get()); assertFalse(h.subject.isOpen()); assertEquals(1, h.old.cancels)
    assertTrue((h.field("initialConnection").get(h.subject) as CompletableFuture<*>).isCompletedExceptionally)
  }
  @Test fun currentEventAckCommitFailureNotifiesTheActiveConsumer() = isolated { h ->
    (h.field("initialConnection").get(h.subject) as CompletableFuture<*>).complete(null)
    h.failCursorCommit()
    h.callback.onMessage(h.old, """{"type":"events.acked","acked_through":9}""")
    h.drain()
    assertTrue(h.flag("clientClosing").get()); assertFalse(h.subject.isOpen()); assertEquals(1, h.errors.size)
  }
  @Test fun localCanonicalAckCommitFailureCannotSilentlyContinue() = isolated { h ->
    h.failCursorCommit(); assertTrue(h.subject.acknowledgePersistedTranscript(6)); h.drain()
    assertTrue(h.flag("clientClosing").get()); assertEquals(1, h.old.cancels)
    assertEquals(0L, (h.field("terminal").get(h.subject) as CountDownLatch).count)
  }
  @Test fun corruptLocalReplayCompletesThePendingConnectAndPreservesTheEnvelope() = isolated { h ->
    val root = Files.createTempDirectory("socket-corrupt-replay").toFile()
    try {
      h.corruptReplay(root)
      val pending = h.subject.connect(); h.drain()
      assertTrue("Connect must not hang after IO failure", pending.isCompletedExceptionally)
      assertFalse(h.subject.isOpen()); assertEquals(1, h.old.cancels)
      assertArrayEquals(byteArrayOf(0, 1, 2, 3), File(root, "event-5.bin").readBytes())
    } finally { root.deleteRecursively() }
  }
}
