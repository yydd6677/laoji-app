package com.laoji.nativeplatform.hardware

import com.laoji.nativeplatform.audio.*
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CompletableFuture

class HardwareRealtimeSessionTest {
  private class Fake(private val offset: Long = 0, @Volatile var ready: Boolean = true,
    private val connection: CompletableFuture<Unit> = CompletableFuture.completedFuture(Unit)) : RealtimeAsrTransport {
    val bytes = ByteArrayOutputStream()
    @Volatile var ended = false
    @Volatile var closed = false
    @Volatile var ack = 0L
    override fun connect(): CompletableFuture<Unit> = connection
    override fun isOpen() = ready && !closed
    override fun nextSourceByteOffset() = offset
    override fun attachListener(next: RealtimeAsrSocketListener) = Unit
    override fun sendPcm(buffer: ByteArray, count: Int): Boolean { synchronized(bytes) { bytes.write(buffer, 0, count) }; return true }
    override fun sendEndFrame(): Boolean { ended = true; return true }
    override fun awaitReadyToStop(timeoutMs: Long) = ReadyToStopOutcome.READY
    override fun acknowledgePersistedTranscript(throughEventSequence: Long): Boolean { ack = throughEventSequence; return true }
    override fun close() { closed = true }
    override fun cancel() { closed = true }
    fun size() = synchronized(bytes) { bytes.size() }
  }
  private fun create(root: File = Files.createTempDirectory("hardware-asr").toFile(), capture: String = "capture-1") =
    HardwareRealtimeSession.create(root, "board-1", capture, "录音.wav", 1000L) {}
  private fun waitFor(timeoutMs: Long = 3000, test: () -> Boolean) {
    val until = System.nanoTime() + timeoutMs * 1_000_000L
    while (!test() && System.nanoTime() < until) Thread.sleep(10)
    assertTrue("condition did not settle", test())
  }
  private fun event(sequence: Long = 1) = AsrServerEvent.Transcript("真实转写结果", true, null, null, null,
    100L, 1100L, "device-v2", "meeting", sequence, "stable-$sequence", "revision-1")
  private fun listener(session: HardwareRealtimeSession, fake: Fake = Fake()): RealtimeAsrSocketListener {
    lateinit var result: RealtimeAsrSocketListener
    session.attach { result = it; fake }
    return result
  }

  @Test fun capturesBeforeNetworkAndDrainsTailOnce() {
    val session = create(); val fake = Fake()
    try {
      val data = ByteArray(7110) { (it % 251).toByte() }
      session.append(0, data); session.attach { fake }; session.finish(generation = "gen-1")
      waitFor { fake.closed }
      assertArrayEquals(data, fake.bytes.toByteArray()); assertTrue(fake.ended)
      assertEquals("complete", session.snapshot()["asrPhase"])
    } finally { session.retire() }
  }
  @Test fun gapDoesNotCompressFutureSpeechIntoPrefix() {
    val session = create(); val fake = Fake()
    try {
      session.append(0, byteArrayOf(1, 2)); session.gap(); session.append(4, byteArrayOf(3, 4))
      session.attach { fake }; session.finish()
      waitFor { fake.closed }; assertEquals(2, fake.size()); assertEquals(true, session.snapshot()["hasGap"])
    } finally { session.retire() }
  }
  @Test fun wrongOffsetSealsPrefixWithoutInventedSilence() {
    val session = create(); val fake = Fake()
    try {
      session.append(0, byteArrayOf(1, 2)); session.append(8, byteArrayOf(3, 4))
      session.attach { fake }; session.finish(); waitFor { fake.closed }
      assertArrayEquals(byteArrayOf(1, 2), fake.bytes.toByteArray())
    } finally { session.retire() }
  }
  @Test fun pauseDoesNotFinalizeAndResumeKeepsOffset() {
    val session = create(); val fake = Fake()
    try {
      session.attach { fake }; session.append(0, byteArrayOf(1, 2)); waitFor { fake.size() == 2 }
      session.capturePhase("paused"); assertFalse(fake.ended)
      session.capturePhase("recording"); session.append(2, byteArrayOf(3, 4)); session.finish()
      waitFor { fake.closed }; assertEquals(4, fake.size())
    } finally { session.retire() }
  }
  @Test fun transportCursorSkipsAlreadyDurableAudio() {
    val session = create(); val fake = Fake(offset = 2)
    try {
      session.append(0, byteArrayOf(1, 2, 3, 4)); session.attach { fake }; session.finish()
      waitFor { fake.closed }; assertArrayEquals(byteArrayOf(3, 4), fake.bytes.toByteArray())
    } finally { session.retire() }
  }
  @Test fun cursorBeyondSourceFailsClosed() {
    val session = create(); val fake = Fake(offset = 10)
    try {
      try { session.attach { fake }; fail("accepted nonexistent PCM") } catch (_: IllegalArgumentException) {}
      assertTrue(fake.closed)
    } finally { session.retire() }
  }
  @Test fun stableReplayIsDeduplicatedAndAckIsExplicit() {
    val session = create()
    try {
      val source = listener(session)
      source.onTranscript(event()); source.onTranscript(event())
      waitFor { (session.snapshot()["events"] as List<*>).size == 1 }
      session.acknowledge(1); source.onTranscript(event())
      Thread.sleep(80); assertTrue((session.snapshot()["events"] as List<*>).isEmpty())
    } finally { session.retire() }
  }
  @Test fun restoreKeepsUnacknowledgedTextAndIdentity() {
    val root = Files.createTempDirectory("hardware-restore").toFile(); val session = create(root)
    var restored: HardwareRealtimeSession? = null
    try {
      listener(session).onTranscript(event()); waitFor { (session.snapshot()["events"] as List<*>).size == 1 }
      restored = HardwareRealtimeSession.restore(root) {}.single()
      assertEquals(session.meetingId, restored.meetingId); assertEquals(session.sessionId, restored.sessionId)
      assertEquals("interrupted", restored.snapshot()["capturePhase"])
      assertEquals(true, restored.snapshot()["hasGap"])
      assertEquals(1, (restored.snapshot()["events"] as List<*>).size)
      assertEquals("waiting", restored.snapshot()["asrPhase"])
    } finally { session.retire(); restored?.retire() }
  }
  @Test fun associationRequiresDeviceAndFinalGeneration() {
    val session = create()
    try {
      assertFalse(session.matches("board-1", "录音.wav", "gen-1"))
      session.finish(generation = "gen-1")
      assertTrue(session.matches("board-1", "录音.wav", "gen-1"))
      assertFalse(session.matches("board-2", "录音.wav", "gen-1"))
      assertFalse(session.matches("board-1", "录音.wav", "gen-2"))
      session.rename("board-1", "录音.wav", "gen-1", "访谈.wav")
      assertTrue(session.matches("board-1", "访谈.wav", "gen-1"))
    } finally { session.retire() }
  }
  @Test fun distinctCapturesNeverShareMeetingOrPcm() {
    val root = Files.createTempDirectory("hardware-identities").toFile()
    val first = create(root); val second = create(root, "capture-2")
    try { assertNotEquals(first.meetingId, second.meetingId); assertNotEquals(first.sessionId, second.sessionId) }
    finally { first.retire(); second.retire() }
  }
  @Test fun resumedFinishNeedsTheOriginalDeviceAndCaptureNotJustTheFilename() {
    val root = Files.createTempDirectory("hardware-reconnect").toFile(); val session = create(root)
    var restored: HardwareRealtimeSession? = null
    try {
      session.finish(interrupted = true)
      restored = HardwareRealtimeSession.restore(root) {}.single()
      assertTrue(restored.matchesCapture("board-1", "capture-1", "录音.wav"))
      assertFalse(restored.matchesCapture("board-1", "capture-2", "录音.wav"))
      assertFalse(restored.matchesCapture("board-2", "capture-1", "录音.wav"))
      restored.finish(generation = "gen-final")
      assertTrue(restored.matches("board-1", "录音.wav", "gen-final"))
      assertEquals(true, restored.snapshot()["hasGap"])
    } finally { session.retire(); restored?.retire() }
  }
  @Test fun transportFailureDoesNotEndCaptureAndRetryStartsFromItsDurableCursor() {
    val session = create(); val first = Fake(); val next = Fake(offset = 2)
    try {
      val source = listener(session, first); session.append(0, byteArrayOf(1, 2)); waitFor { first.size() == 2 }
      source.onTransportFailure(RecorderErrorCode.SERVICE_UNAVAILABLE, "internal failure")
      waitFor { session.snapshot()["asrPhase"] == "unavailable" }
      assertEquals(false, session.snapshot()["inputEnded"])
      session.append(2, byteArrayOf(3, 4)); session.attach { next }; session.finish()
      waitFor { next.closed }; assertArrayEquals(byteArrayOf(3, 4), next.bytes.toByteArray())
    } finally { session.retire() }
  }
  @Test fun failedCheckpointStillReleasesTransportAndRetainsSourceForRetry() {
    repeat(12) {
    val root = Files.createTempDirectory("hardware-checkpoint-failure").toFile()
    val session = create(root); val first = Fake(); val next = Fake(offset = 2)
    val blocked = File(root, "${session.meetingId}.json.part")
    try {
      val source = listener(session, first)
      session.append(0, byteArrayOf(1, 2)); waitFor { first.size() == 2 }
      // Sending PCM does not imply the asynchronous connection checkpoint has
      // finished. snapshot() acquires its owner lock after that persist; inject
      // the filesystem failure only at the intended stable boundary.
      waitFor { session.snapshot()["asrPhase"] == "streaming" }
      assertTrue(blocked.mkdir())
      source.onTransportFailure(RecorderErrorCode.SERVICE_UNAVAILABLE, "failed network")
      waitFor { session.snapshot()["asrPhase"] == "unavailable" }
      waitFor { first.closed }
      assertEquals(false, session.snapshot()["inputEnded"])
      assertTrue(blocked.delete())
      session.append(2, byteArrayOf(3, 4)); session.attach { next }; session.finish()
      waitFor { next.closed }; assertArrayEquals(byteArrayOf(3, 4), next.bytes.toByteArray())
    } finally { blocked.delete(); session.retire(); root.deleteRecursively() }
    }
  }
  @Test fun backlogCatchesUpInBoundedBurstsWithoutChangingBytes() {
    val session = create(); val fake = Fake()
    try {
      val data = ByteArray(1024 * 1024) { (it % 251).toByte() }
      session.append(0, data); session.finish(); session.attach { fake }
      waitFor(6500) { fake.closed }
      assertArrayEquals(data, fake.bytes.toByteArray())
      assertTrue(fake.ended)
    } finally { session.retire() }
  }
  @Test fun backpressureNeverSkipsTheRejectedChunk() {
    val session = create(); val accepted = ByteArrayOutputStream(); var attempts = 0
    val fake = object : RealtimeAsrTransport {
      var closed = false
      override fun connect() = CompletableFuture.completedFuture(Unit)
      override fun isOpen() = !closed
      override fun nextSourceByteOffset() = 0L
      override fun attachListener(next: RealtimeAsrSocketListener) = Unit
      override fun sendPcm(buffer: ByteArray, count: Int): Boolean {
        if (++attempts % 3 == 1) return false
        accepted.write(buffer, 0, count); return true
      }
      override fun sendEndFrame() = true
      override fun awaitReadyToStop(timeoutMs: Long) = ReadyToStopOutcome.READY
      override fun acknowledgePersistedTranscript(throughEventSequence: Long) = true
      override fun close() { closed = true }
      override fun cancel() = close()
    }
    try {
      val data = ByteArray(37_110) { (it % 253).toByte() }
      session.append(0, data); session.attach { fake }; session.finish()
      waitFor { fake.closed }
      assertArrayEquals(data, accepted.toByteArray())
    } finally { session.retire() }
  }
  @Test fun obsoleteConnectionCallbacksCannotFailOrRewriteReplacement() {
    val session = create(); val firstConnection = CompletableFuture<Unit>()
    val first = Fake(connection = firstConnection); val replacement = Fake()
    lateinit var oldListener: RealtimeAsrSocketListener
    lateinit var nextListener: RealtimeAsrSocketListener
    try {
      session.attach { oldListener = it; first }
      oldListener.onTransportFailure(RecorderErrorCode.SERVICE_UNAVAILABLE, "first attempt")
      waitFor { session.snapshot()["asrPhase"] == "unavailable" }
      session.attach { nextListener = it; replacement }
      waitFor { session.snapshot()["asrPhase"] == "streaming" }
      firstConnection.completeExceptionally(IllegalStateException("late handshake failure"))
      oldListener.onTransportFailure(RecorderErrorCode.SERVICE_UNAVAILABLE, "late transport error")
      oldListener.onServerError(AsrServerEvent.Error("late server error", "late", true))
      oldListener.onTranscript(event(99))
      nextListener.onTranscript(event(1))
      waitFor { (session.snapshot()["events"] as List<*>).isNotEmpty() }
      val events = session.snapshot()["events"] as List<*>
      assertEquals(1, events.size)
      assertEquals(1L, (events.single() as Map<*, *>)["sequence"])
      assertEquals("streaming", session.snapshot()["asrPhase"])
      assertFalse(replacement.closed)
    } finally { session.retire() }
  }
  @Test fun synchronousConnectFailureReleasesTransportForRetry() {
    val session = create(); val good = Fake()
    var cancelled = false
    val broken = object : RealtimeAsrTransport by good {
      override fun connect(): CompletableFuture<Unit> = throw IllegalStateException("connect failed synchronously")
      override fun close() { cancelled = true }
    }
    try {
      try { session.attach { broken }; fail("accepted failed connection") } catch (_: IllegalStateException) { }
      assertTrue(cancelled)
      assertEquals("unavailable", session.snapshot()["asrPhase"])
      session.attach { good }
      waitFor { session.snapshot()["asrPhase"] == "streaming" }
    } finally { session.retire() }
  }
  @Test fun finalTextQueuedBeforeReadySurvivesSocketDrain() {
    repeat(20) {
      val session = create(); val fake = Fake()
      lateinit var listener: RealtimeAsrSocketListener
      val transport = object : RealtimeAsrTransport by fake {
        override fun awaitReadyToStop(timeoutMs: Long): ReadyToStopOutcome {
          listener.onTranscript(event(1))
          return ReadyToStopOutcome.READY
        }
      }
      try {
        session.append(0, byteArrayOf(1, 2)); session.finish()
        session.attach { listener = it; transport }
        waitFor { fake.closed }
        waitFor { (session.snapshot()["events"] as List<*>).size == 1 }
        assertEquals("complete", session.snapshot()["asrPhase"])
      } finally { session.retire() }
    }
  }
  @Test fun delayedConnectCompletionCannotRegressDrainPhase() {
    val session = create(); val connecting = CompletableFuture<Unit>(); val ready = CompletableFuture<ReadyToStopOutcome>()
    val fake = Fake(connection = connecting)
    val transport = object : RealtimeAsrTransport by fake {
      override fun awaitReadyToStop(timeoutMs: Long) = ready.get()
    }
    lateinit var source: RealtimeAsrSocketListener
    try {
      session.append(0, byteArrayOf(1, 2)); session.finish(); session.attach { source = it; transport }
      waitFor { session.snapshot()["asrPhase"] == "draining" }
      connecting.complete(Unit)
      // Barrier: a stable event is queued after the connect completion, so its
      // presence proves that completion has actually run, not just a sleep.
      source.onTranscript(event(1))
      waitFor { (session.snapshot()["events"] as List<*>).size == 1 }
      assertEquals("draining", session.snapshot()["asrPhase"])
      ready.complete(ReadyToStopOutcome.READY)
      waitFor { session.snapshot()["asrPhase"] == "complete" }
    } finally { ready.complete(ReadyToStopOutcome.CLOSED); session.retire() }
  }
}
