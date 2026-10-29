package com.laoji.nativeplatform.hardware

import com.laoji.nativeplatform.audio.AsrProtocol
import com.laoji.nativeplatform.audio.AsrServerEvent
import com.laoji.nativeplatform.audio.ReadyToStopOutcome
import com.laoji.nativeplatform.audio.RealtimeAsrSocketListener
import com.laoji.nativeplatform.audio.RealtimeAsrTransport
import com.laoji.nativeplatform.audio.RecorderErrorCode
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** File-backed external PCM producer. Never owns AudioRecord or the board's SD file.
 * The ASR draft is deliberately incomplete; only the verified whole-file import is final.
 * A missing live packet seals the prefix, rather than shifting later speech in time.
 */
internal class HardwareRealtimeSession private constructor(
  private val root: File,
  private val state: JSONObject,
  private val changed: () -> Unit,
) {
  val meetingId: String = state.getString("meetingId")
  val sessionId: String = state.getString("sessionId")
  private val lock = Any()
  private val pcm = File(root, "$meetingId.pcm")
  private val metadata = File(root, "$meetingId.json")
  private val executor = Executors.newSingleThreadScheduledExecutor { Thread(it, "laoji-board-asr").apply { isDaemon = true } }
  private var output: RandomAccessFile? = if (!state.optBoolean("inputEnded")) RandomAccessFile(pcm, "rw") else null
  private var sourceReader: RandomAccessFile? = null
  private var pumpTask: ScheduledFuture<*>? = null
  private var transport: RealtimeAsrTransport? = null
  private var attachmentEpoch = 0L
  private var sent = 0L
  private var draining = false
  private var retired = false
  private var preview = ""
  private var lastNotifyAt = 0L

  fun snapshot(): Map<String, Any?> = synchronized(lock) {
    mapOf("meetingId" to meetingId, "sessionId" to sessionId, "deviceId" to state.getString("deviceId"),
      "recordedAtMs" to state.getLong("recordedAtMs"), "capturePhase" to state.getString("capturePhase"),
      "asrPhase" to state.optString("asrPhase", "waiting"), "inputEnded" to state.optBoolean("inputEnded"),
      "audioReady" to state.optBoolean("audioReady"),
      "hasGap" to state.optBoolean("hasGap"), "preview" to preview,
      "events" to (0 until events().length()).map { index ->
        val item = events().getJSONObject(index)
        item.keys().asSequence().associateWith { key -> item.opt(key).takeUnless { it == JSONObject.NULL } }
      })
  }

  /** Called after the runtime has accepted this exact contiguous source offset. */
  fun append(offset: Long, bytes: ByteArray) = synchronized(lock) {
    if (retired || state.optBoolean("inputEnded") || state.optBoolean("hasGap")) return@synchronized
    val file = output ?: return@synchronized
    if (offset != file.length() || bytes.size % 2 != 0) { sealGap(); return@synchronized }
    file.seek(offset); file.write(bytes)
  }

  fun gap() = synchronized(lock) { if (!state.optBoolean("hasGap")) sealGap() }
  private fun sealGap() { state.put("hasGap", true); output?.fd?.sync(); persist(); changed() }

  fun capturePhase(phase: String) = synchronized(lock) {
    if (state.optBoolean("inputEnded") || retired) return@synchronized
    state.put("capturePhase", phase); persist(); changed()
  }

  fun finish(interrupted: Boolean = false, generation: String? = null) = synchronized(lock) {
    if (retired) return@synchronized
    output?.fd?.sync(); output?.close(); output = null
    state.put("inputEnded", true).put("capturePhase", if (interrupted) "interrupted" else "finished")
    if (interrupted) state.put("hasGap", true)
    generation?.let { state.put("sourceGeneration", it) }
    persist(); changed()
  }

  fun matches(deviceId: String, recordingId: String, generation: String): Boolean = synchronized(lock) {
    state.optString("deviceId") == deviceId && state.optString("sourceRecordingId") == recordingId &&
      state.optString("sourceGeneration") == generation
  }
  fun matchesCapture(deviceId: String, captureId: String, recordingId: String): Boolean = synchronized(lock) {
    state.optString("deviceId") == deviceId && state.optString("captureSessionId") == captureId &&
      state.optString("sourceRecordingId") == recordingId
  }

  fun audioReady() = synchronized(lock) {
    if (!state.optBoolean("audioReady")) { state.put("audioReady", true); persist(); changed() }
  }

  fun rename(deviceId: String, old: String, generation: String, next: String) = synchronized(lock) {
    if (matches(deviceId, old, generation)) { state.put("sourceRecordingId", next); persist() }
  }

  fun attach(factory: (RealtimeAsrSocketListener) -> RealtimeAsrTransport) = synchronized(lock) {
    if (retired || transport != null || state.optString("asrPhase") == "complete") return@synchronized
    val epoch = ++attachmentEpoch
    // Each retry owns its callbacks. A closing/failed transport can report
    // after its replacement is open; it must not fail or rewrite that owner.
    val socket = factory(object : RealtimeAsrSocketListener {
      override fun onTranscript(transcript: AsrServerEvent.Transcript) = forAttachment(epoch, activeOnly = false) { acceptTranscript(transcript) }
      override fun onServerError(error: AsrServerEvent.Error) = forAttachment(epoch) { fail("service_unavailable") }
      override fun onTransportFailure(code: RecorderErrorCode, message: String) = forAttachment(epoch) { fail("connection_unavailable") }
    })
    // Spool and transport are independent durable owners; never replay from zero on recovery.
    try {
      sent = socket.nextSourceByteOffset()
      require(sent >= 0 && sent % 2L == 0L && sent <= pcm.length()) { "hardware ASR cursor exceeds source" }
    } catch (error: Throwable) {
      attachmentEpoch += 1
      runCatching { socket.cancel() }
      throw error
    }
    transport = socket
    state.put("asrPhase", "connecting"); persist()
    // Restored/offline sessions must not each wake a thread every 80 ms forever.
    // Only a live transport owns a pump; failure/finish cancels it for reuse.
    pumpTask = executor.scheduleWithFixedDelay(
      { runCatching { pump() }.onFailure { fail("spool_unavailable") } }, 0, 80, TimeUnit.MILLISECONDS)
    try {
      socket.connect().whenComplete { _, error -> forAttachment(epoch) {
        if (error != null) fail("connection_unavailable")
        else if (!draining) { state.put("asrPhase", "streaming"); persist(); changed() }
      } }
    } catch (error: Throwable) {
      fail("connection_unavailable")
      throw error
    }
  }

  private fun pump() = synchronized(lock) {
    val socket = transport ?: return@synchronized
    if (retired || draining || !socket.isOpen()) return@synchronized
    // Catch up after an outage without stretching seconds of input over many
    // timer turns. Bound work so capture/callbacks still get the lock promptly;
    // transport credit remains authoritative and a rejected write never advances.
    var turns = 0
    var available = pcm.length() - sent
    while (available > 0 && turns++ < 4) {
      val count = minOf(6400L, available).toInt() and -2
      val data = ByteArray(count)
      val input = sourceReader ?: RandomAccessFile(pcm, "r").also { sourceReader = it }
      input.seek(sent); input.readFully(data)
      if (!socket.sendPcm(data, data.size)) break
      sent += count
      available = pcm.length() - sent
    }
    if (state.optBoolean("inputEnded") && sent == pcm.length() && socket.sendEndFrame()) {
      draining = true
      stopPump()
      state.put("asrPhase", "draining"); persist(); changed()
      drainExecutor.execute {
        val result = runCatching { socket.awaitReadyToStop(125_000) }.getOrNull()
        synchronized(lock) {
          if (!retired && transport === socket) {
            state.put("asrPhase", if (result == ReadyToStopOutcome.READY) "complete" else "unavailable")
            persist(); socket.close(); transport = null; draining = false
            if (result == ReadyToStopOutcome.READY) executor.shutdown()
            cleanupPcm(); changed()
          }
        }
      }
    }
  }

  private fun acceptTranscript(transcript: AsrServerEvent.Transcript) = synchronized(lock) {
    if (retired) return@synchronized
    preview = transcript.text
    if (transcript.isFinal) {
      val sequence = transcript.eventSequence ?: return@synchronized
      if (sequence <= state.optLong("ackedSequence")) return@synchronized
      val items = events()
      if ((0 until items.length()).none { items.getJSONObject(it).getLong("sequence") == sequence }) {
        items.put(JSONObject().put("sequence", sequence).put("id", AsrProtocol.transcriptIdentity(sessionId, transcript))
          .put("text", transcript.text).put("startMs", transcript.startMs).put("endMs", transcript.endMs)
          .put("speaker", transcript.speakerName).put("revisionKey", transcript.revisionKey))
        persist()
      }
    }
    val now = System.currentTimeMillis()
    if (transcript.isFinal || now - lastNotifyAt >= 200) { lastNotifyAt = now; changed() }
  }

  /** Canonical SQLite commit must precede this cursor. Never acknowledge on UI receipt. */
  fun acknowledge(sequence: Long) = synchronized(lock) {
    if (retired || sequence <= state.optLong("ackedSequence")) return@synchronized
    require((0 until events().length()).any { events().getJSONObject(it).getLong("sequence") == sequence })
    val remaining = JSONArray()
    for (i in 0 until events().length()) events().getJSONObject(i).takeIf { it.getLong("sequence") > sequence }?.let { remaining.put(it) }
    state.put("events", remaining).put("ackedSequence", sequence); persist()
    transport?.acknowledgePersistedTranscript(sequence)
    cleanupPcm()
  }

  // Socket callbacks can run while the transport holds its own lock. Queue them;
  // never invert that lock with the source producer's lock in pump/sendPcm.
  private fun dispatch(action: () -> Unit) { if (!executor.isShutdown) runCatching { executor.execute(action) } }
  private fun forAttachment(epoch: Long, activeOnly: Boolean = true, action: () -> Unit) = dispatch { synchronized(lock) {
    // A final transcript already queued before READY must still commit after
    // drain closes the socket. Only state-changing callbacks require it open.
    if (!retired && epoch == attachmentEpoch && (!activeOnly || transport != null)) action()
  } }
  private fun fail(code: String) = synchronized(lock) {
    if (!retired) {
      state.put("asrPhase", "unavailable").put("errorCode", code)
      // Releasing a broken network/pump cannot depend on a writable optional
      // checkpoint. Keep the real source file and same identity for retry.
      val saved = runCatching { persist() }.isSuccess
      stopPump()
      val previous = transport; transport = null; draining = false
      runCatching { previous?.close() }
      if (!saved) runCatching { android.util.Log.w("LaojiHardware", "asr_checkpoint_unavailable") }
      changed()
    }
  }

  private fun cleanupPcm() {
    if (state.optString("asrPhase") == "complete" && events().length() == 0) pcm.delete()
  }

  /** Caller owns lock. Close readers before deleting files (also on Windows). */
  private fun stopPump() {
    pumpTask?.cancel(false); pumpTask = null
    val previous = sourceReader; sourceReader = null
    runCatching { previous?.close() }
  }

  fun retire() = synchronized(lock) {
    retired = true; attachmentEpoch += 1; output?.close(); output = null
    stopPump()
    transport?.close(); transport = null; executor.shutdown()
    pcm.delete(); metadata.delete()
  }

  private fun events(): JSONArray = state.getJSONArray("events")
  private fun persist() {
    val temp = File(root, "$meetingId.json.part")
    FileOutputStream(temp).use { it.write(state.toString().toByteArray(Charsets.UTF_8)); it.fd.sync() }
    check(temp.renameTo(metadata)) { "cannot checkpoint hardware realtime session" }
  }

  companion object {
    private val drainExecutor = Executors.newCachedThreadPool { Thread(it, "laoji-board-asr-drain").apply { isDaemon = true } }
    fun create(root: File, device: String, capture: String, recording: String, startedAt: Long, changed: () -> Unit): HardwareRealtimeSession {
      check(root.isDirectory || root.mkdirs())
      val id = UUID.nameUUIDFromBytes("hardware-live\u0000$device\u0000$capture".toByteArray(Charsets.UTF_8)).toString()
      val state = JSONObject().put("meetingId", id).put("sessionId", "hwrt-$id").put("deviceId", device)
        .put("captureSessionId", capture)
        .put("sourceRecordingId", recording).put("recordedAtMs", startedAt).put("capturePhase", "recording")
        .put("asrPhase", "waiting").put("inputEnded", false).put("hasGap", false).put("events", JSONArray())
      return HardwareRealtimeSession(root, state, changed).also { synchronized(it.lock) { it.persist() } }
    }
    fun restore(root: File, changed: () -> Unit): List<HardwareRealtimeSession> = root.listFiles { f -> f.name.endsWith(".json") }.orEmpty().mapNotNull { file ->
      runCatching {
        val state = JSONObject(file.readText())
        require(file.name == state.getString("meetingId") + ".json")
        // A process restart is not evidence that the board stopped or that its complete PCM arrived.
        if (!state.optBoolean("inputEnded")) state.put("inputEnded", true).put("hasGap", true).put("capturePhase", "interrupted")
        if (state.optString("asrPhase") != "complete") state.put("asrPhase", "waiting")
        HardwareRealtimeSession(root, state, changed).also { synchronized(it.lock) { it.persist() } }
      }.getOrNull()
    }
  }
}
