package com.laoji.nativeplatform.hardware

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.math.sqrt

internal data class HardwareRuntimeSnapshot(
  val phase: String, val transport: String? = null, val locator: String? = null,
  val deviceId: String? = null, val model: String? = null, val firmwareRevision: String? = null,
  val hardwareRevision: String? = null, val securityMode: String? = null,
  val capabilities: Map<String, Any?> = emptyMap(), val sessionId: String? = null,
  val streamId: Long? = null, val transferProgress: Double? = null,
  val errorCode: String? = null, val errorMessage: String? = null,
  val updatedAtMs: Long = System.currentTimeMillis(),
  val purpose: String? = null,
) {
  fun toMap(): Map<String, Any?> = mapOf("phase" to phase, "transport" to transport, "locator" to locator,
    "deviceId" to deviceId, "model" to model, "firmwareRevision" to firmwareRevision,
    "hardwareRevision" to hardwareRevision, "securityMode" to securityMode, "capabilities" to capabilities,
    "sessionId" to sessionId, "streamId" to streamId, "transferProgress" to transferProgress,
    "errorCode" to errorCode, "errorMessage" to errorMessage, "updatedAtMs" to updatedAtMs, "purpose" to purpose)
}
internal data class HardwareLevelEvent(val sessionId: String, val peak: Double, val rms: Double, val normalized: Double) {
  fun toMap(): Map<String, Any?> = mapOf("sessionId" to sessionId, "peak" to peak, "rms" to rms, "normalized" to normalized)
}
internal interface HardwareRuntimeListener {
  fun onState(snapshot: HardwareRuntimeSnapshot) = Unit
  fun onRecordingReady(recording: PendingHardwareRecording) = Unit
  fun onLevel(level: HardwareLevelEvent) = Unit
  fun onRealtimeChanged() = Unit
}
internal object HardwareRuntimeEvents {
  private val listeners = CopyOnWriteArraySet<HardwareRuntimeListener>()
  fun add(listener: HardwareRuntimeListener) = listeners.add(listener)
  fun remove(listener: HardwareRuntimeListener) = listeners.remove(listener)
  fun state(snapshot: HardwareRuntimeSnapshot) = listeners.forEach { it.onState(snapshot) }
  fun recording(recording: PendingHardwareRecording) = listeners.forEach { it.onRecordingReady(recording) }
  fun level(level: HardwareLevelEvent) = listeners.forEach { it.onLevel(level) }
  fun realtime() = listeners.forEach { it.onRealtimeChanged() }
}

/** One connection/session owner; neither the UI nor transport advances recording state. */
internal object HardwareRuntime {
  private val lock = Any()
  private val reader = Executors.newCachedThreadPool { Thread(it, "laoji-board-reader").apply { isDaemon = true } }
  private val keyControl = Executors.newSingleThreadExecutor { Thread(it, "laoji-board-key").apply { isDaemon = true } }
  private val transfers = Executors.newSingleThreadExecutor { Thread(it, "laoji-board-transfer").apply { isDaemon = true } }
  private val deadlines = Executors.newSingleThreadScheduledExecutor { Thread(it, "laoji-board-deadline").apply { isDaemon = true } }
  private val transferPermit = Semaphore(1)
  private data class Reply(val op: String, val future: CompletableFuture<JSONObject>, val before: ((JSONObject) -> Unit)?)
  private val replies = ConcurrentHashMap<String, Reply>()
  private val recordingMetadata = ConcurrentHashMap<String, HardwareDeviceRecording>()
  @Volatile private var context: Context? = null
  @Volatile private var transport: HardwareDuplexTransport? = null
  @Volatile private var snapshot = HardwareRuntimeSnapshot("disconnected")
  @Volatile private var epoch = 0L
  private var store: HardwareRecordingStore? = null
  private var live: HardwarePcmFile? = null
  private var liveRealtime: HardwareRealtimeSession? = null
  private var liveRecordingId: String? = null
  private var liveStartedAt = 0L
  private var liveSequence = 0
  private var liveBroken = false
  private var liveAssembler: HardwareLivePrefixAssembler? = null
  private var liveRepairLimit = 0
  private var liveRepairQueued: HardwareLivePrefixAssembler? = null
  private var activeLiveRepair: HardwareLiveRepairRead? = null
  private var liveGapDeadline = 0L
  private var liveGapSerial = 0L
  private var liveRequested = false
  private var startRequestSerial = 0L
  private var lastLevelAt = 0L
  private data class ReadRange(val stream: Int, val end: Long, val pcm: HardwarePcmFile,
    val completion: CompletableFuture<Unit> = CompletableFuture(), var sequence: Int = 0,
    var lastData: Long = android.os.SystemClock.elapsedRealtime())
  @Volatile private var activeRead: ReadRange? = null

  fun initialize(value: Context) = synchronized(lock) {
    context = value.applicationContext
    if (store == null) store = HardwareRecordingStore(value.applicationContext)
    HardwareRealtime.initialize(value.applicationContext)
  }
  fun getState(): HardwareRuntimeSnapshot = snapshot
  fun recordingMap(recording: HardwareDeviceRecording): Map<String, Any?> = recording.toMap() +
    ("requiresWifi" to HardwareBoardContract.preferWifi(recording.byteSize,
      (snapshot.capabilities["wifi"] as? Map<*, *>)?.get("bulk_transfer") == true))
  fun scanBleDevices(value: Context): List<HardwareBleDevice> { initialize(value); return BleHardwareDiscovery.scan(value) }

  fun connectBle(value: Context, locator: String): HardwareRuntimeSnapshot {
    initialize(value)
    disconnectInternal(false)
    update(HardwareRuntimeSnapshot("connecting", "ble", locator))
    val opened = try { BleHardwareTransport.open(value, BleHardwareDiscovery.find(value, locator), locator) }
    catch (e: Throwable) { fail(e); throw publicError(e) }
    val token = synchronized(lock) { transport = opened; epoch += 1; epoch }
    update(snapshot.copy(phase = "handshaking"))
    reader.execute { readLoop(opened, token) }
    try {
      HardwareConnectionService.start(value.applicationContext, token)
      val version = value.packageManager.getPackageInfo(value.packageName, 0).versionName ?: "unknown"
      val hello = request("hello", mapOf("app" to mapOf("name" to "laoji-android", "version" to version),
        "supported_protocols" to listOf(mapOf("major" to 1, "minor" to 3)), "transports" to listOf("ble")))
      val protocol = hello.getJSONObject("protocol")
      val device = hello.getJSONObject("device")
      val capabilities = hello.getJSONObject("capabilities")
      val audio = capabilities.getJSONObject("capture")
      val security = hello.getJSONObject("security").getString("mode")
      if (protocol.optInt("major") != 1 || protocol.optInt("minor") != 3 || security != "development_ble" ||
        !audio.optBoolean("local_storage") || !audio.hasValue("codecs", "pcm_s16le") ||
        !audio.hasValue("sample_rates_hz", 16000) || !audio.hasValue("channels", 1) ||
        !capabilities.hasValue("transports", "ble") || !capabilities.getJSONObject("storage").optBoolean("ble_audio_read")) {
        throw HardwareIncompatibleException("设备版本与当前老记不兼容。")
      }
      // Current firmware uses the same self-reported ID on different boards. Scope local files to BLE identity.
      update(snapshot.copy(deviceId = device.getString("device_id") + "@" + locator.removePrefix("ble:"),
        model = "语音备忘录", firmwareRevision = device.getString("firmware_revision"),
        hardwareRevision = "ESP32S3-V1.0", securityMode = security, capabilities = jsonMap(capabilities)))
      // This board cannot create a dated WAV before clock sync. Failure is not silently ignored.
      request("time.sync", mapOf("epoch_ms" to System.currentTimeMillis(), "time_zone" to java.util.TimeZone.getDefault().id))
      val status = request("status.get").getJSONObject("status")
      val phase = status.getString("state")
      if (phase !in setOf("ready", "recording", "paused", "finalizing")) throw HardwareProtocolException("invalid initial state")
      update(snapshot.copy(phase = phase, sessionId = status.stringOrNull("session_id"), purpose =
        if (phase in setOf("recording", "paused", "finalizing")) HardwareBoardContract.purpose(status) else null))
      return snapshot
    } catch (e: Throwable) { failConnectionIfCurrent(opened, token, e); throw publicError(e) }
  }

  fun disconnect(): HardwareRuntimeSnapshot { disconnectInternal(true); return snapshot }
  fun serviceConnectionActive(token: Long): Boolean = epoch == token && transport != null
  fun serviceUnavailable(token: Long) = synchronized(lock) {
    if (serviceConnectionActive(token)) {
      disconnectInternal(false)
      fail(HardwareTransportException("设备连接已中断，请重新连接。"))
    }
  }

  fun startCapture(purpose: String = "meeting"): HardwareRuntimeSnapshot {
    require(purpose in setOf("meeting", "schedule"))
    if (purpose == "schedule" && ((snapshot.capabilities["capture"] as? Map<*, *>)?.get("purposes") as? List<*>)?.contains("schedule") != true)
      throw HardwareIncompatibleException("设备暂不支持日程录音。")
    synchronized(lock) {
      requireReady()
      if (liveRequested) throw HardwareRuntimeException("busy", "录音正在启动。")
      liveRequested = true
      expireStart(epoch)
    }
    try {
      request("capture.start", mapOf("session_id" to UUID.randomUUID().toString(), "purpose" to purpose,
        "audio" to mapOf("codec" to "pcm_s16le", "sample_rate_hz" to 16000, "channels" to 1, "live_stream" to true)))
      waitForPhase("recording")
      return snapshot
    } catch (e: Throwable) { synchronized(lock) { liveRequested = false }; throw e }
  }
  fun pauseCapture(): HardwareRuntimeSnapshot = changeCapture("capture.pause", "recording", "paused")
  fun resumeCapture(): HardwareRuntimeSnapshot = changeCapture("capture.resume", "paused", "recording")
  private fun changeCapture(op: String, from: String, to: String): HardwareRuntimeSnapshot {
    if (snapshot.phase != from) throw HardwareRuntimeException("invalid_state", "录音状态已变化。")
    request(op, mapOf("session_id" to requireNotNull(snapshot.sessionId)))
    waitForPhase(to)
    return snapshot
  }
  fun stopCapture(): PendingHardwareRecording? {
    if (snapshot.phase !in setOf("recording", "paused")) throw HardwareRuntimeException("invalid_state", "当前没有在录音。")
    request("capture.stop", mapOf("session_id" to requireNotNull(snapshot.sessionId)))
    if (snapshot.phase in setOf("recording", "paused")) update(snapshot.copy(phase = "finalizing"))
    // Completion and any gap repair remain event-owned; do not block the UI or invent a final result.
    return null
  }
  fun listPendingRecordings(): List<PendingHardwareRecording> = requireNotNull(store).list().also { items ->
    // Recover a crash between verified-index commit and capture projection.
    items.forEach { item -> item.captureMeetingId?.let { HardwareRealtime.audioReady(it) } }
  }
  fun acknowledgeRecording(id: String): Boolean {
    val meetingId = requireNotNull(store).list().firstOrNull { it.recordingId == id }?.captureMeetingId
    val removed = requireNotNull(store).acknowledge(id)
    if (removed && meetingId != null) HardwareRealtime.retire(meetingId)
    return removed
  }
  private fun associate(recording: PendingHardwareRecording): PendingHardwareRecording {
    if (recording.purpose != "meeting") return recording
    val meetingId = recording.sourceDeviceRecordingId?.let { id -> recording.sourceGeneration?.let { generation ->
      HardwareRealtime.association(recording.deviceId, id, generation)
    } } ?: return recording
    return requireNotNull(store).associate(recording, meetingId).also { HardwareRealtime.audioReady(meetingId) }
  }

  fun getDeviceRecording(id: String, refresh: Boolean = false): HardwareDeviceRecording =
    (if (refresh) null else recordingMetadata[HardwareBoardContract.fileName(id)]) ?: getRecording(id)
  private fun getRecording(id: String): HardwareDeviceRecording {
    val value = HardwareBoardContract.recording(
      request("recording.get", mapOf("recording_id" to HardwareBoardContract.fileName(id))).getJSONObject("recording"))
    recordingMetadata[id] = value
    return value
  }

  fun listDeviceRecordings(): List<HardwareRecordingPreview> {
    val token = epoch
    val identity = requireNotNull(snapshot.deviceId)
    val started = android.os.SystemClock.elapsedRealtime()
    val result = mutableListOf<HardwareRecordingPreview>()
    val seen = mutableSetOf<String>()
    var cursor: String? = null
    do {
      if (epoch != token || snapshot.phase != "ready") throw HardwareRuntimeException("invalid_state", "设备状态已变化。")
      val reply = request("recording.list", buildMap { put("limit", 4); put("include_previews", true); cursor?.let { put("cursor", it) } })
      if (epoch != token || snapshot.phase != "ready") throw HardwareRuntimeException("invalid_state", "设备状态已变化。")
      val ids = reply.getJSONArray("recordings")
      val previews = reply.optJSONArray("previews")
      for (i in 0 until ids.length()) {
        val id = HardwareBoardContract.fileName(ids.getString(i))
        val preview = previews?.let { items -> (0 until items.length()).map { items.getJSONObject(it) }
          .firstOrNull { it.optString("recording_id") == id } }
        val entry = HardwareBoardContract.preview(id, preview)
        result += entry.copy(localRecordingId = entry.generation?.let {
          HardwareBoardContract.localRecordingId(identity, id, it)
        })
      }
      cursor = reply.stringOrNull("next_cursor")
      if (cursor != null && !seen.add(cursor)) throw HardwareProtocolException("cyclic recording cursor")
    } while (cursor != null)
    recordingMetadata.keys.retainAll(result.map { it.recordingId }.toSet())
    Log.i("LaojiHardware", "catalog_ready count=${result.size} elapsed_ms=${android.os.SystemClock.elapsedRealtime() - started}")
    return result.distinctBy { it.recordingId }.sortedByDescending { it.createdEpochMs ?: 0 }
  }
  fun renameDeviceRecording(id: String, generation: String, title: String): HardwareDeviceRecording {
    requireReady()
    val newId = HardwareBoardContract.fileName(title.trim().removeSuffix(".wav") + ".wav")
    request("recording.rename", mapOf("recording_id" to HardwareBoardContract.fileName(id),
      "expected_generation" to HardwareBoardContract.generation(generation), "new_recording_id" to newId))
    snapshot.deviceId?.let { HardwareRealtime.rename(it, id, generation, newId) }
    val renamed = recordingMetadata.remove(id)?.takeIf { it.generation == generation }
      ?.copy(recordingId = newId, title = newId.removeSuffix(".wav"))
    if (renamed != null) { recordingMetadata[newId] = renamed; return renamed }
    return getRecording(newId)
  }
  fun deleteDeviceRecording(id: String, generation: String): Boolean {
    requireReady()
    request("recording.delete", mapOf("recording_id" to HardwareBoardContract.fileName(id),
      "expected_generation" to HardwareBoardContract.generation(generation)))
    recordingMetadata.remove(id)
    return true
  }

  fun receiveDeviceRecording(selected: HardwareDeviceRecording): PendingHardwareRecording {
    // Reject locally before starting a board hotspot or entering transfer state.
    if (recordingMap(selected)["requiresWifi"] == true) {
      HardwareWifiTransfer.requireWifiEnabled(requireNotNull(context))
    }
    synchronized(lock) {
      requireReady()
      if (!transferPermit.tryAcquire()) throw HardwareRuntimeException("busy", "另一段录音正在接收。")
      update(snapshot.copy(phase = "transferring", transferProgress = 0.0, errorCode = null, errorMessage = null))
    }
    val token = epoch
    try {
      // Metadata is scoped to this connection. Each read response, or Wi-Fi
      // If-Match, and the final SHA verify this pinned version again.
      val recording = selected
      val identity = requireNotNull(snapshot.deviceId)
      val result = if (recordingMap(recording)["requiresWifi"] == true) {
        val offer = HardwareBoardContract.wifiOffer(request("transport.wifi.offer").getJSONObject("wifi_offer"), recording)
        try { HardwareWifiTransfer.receive(requireNotNull(context), identity, recording, offer, requireNotNull(store), true) { progress(it, token) } }
        finally { if (epoch == token) runCatching { request("transport.wifi.close") } }
      } else {
        val part = requireNotNull(store).deviceDownloadPart(identity, recording.recordingId, recording.generation).second
        val pcm = File(part.path + ".pcm")
        receivePcm(recording, pcm, token)
      }
      if (epoch != token) throw HardwareTransportException("设备连接已变化，请重新接收。")
      val associated = associate(result)
      HardwareRuntimeEvents.recording(associated)
      return associated
    } finally { transferPermit.release(); if (epoch == token) update(snapshot.copy(phase = "ready", transferProgress = null)) }
  }

  private fun receivePcm(recording: HardwareDeviceRecording, file: File, token: Long): PendingHardwareRecording {
    val identity = requireNotNull(snapshot.deviceId)
    // A contiguous live mirror can still differ from the SD source. On a hash
    // mismatch discard that prefix and refetch once; never accept or pad it.
    for (integrityAttempt in 0..1) {
      if (file.length() > recording.audioBytes) file.delete()
      HardwarePcmFile(file).use { pcm ->
        var failures = 0
        while (pcm.size() < recording.audioBytes) {
          if (epoch != token) throw HardwareTransportException("录音设备已断开。")
          try { readSuffix(recording, pcm, token); failures = 0 }
          catch (e: Throwable) { pcm.sync(); if (++failures >= 3 || epoch != token) throw e }
        }
      }
      if (epoch != token) throw HardwareTransportException("录音设备已断开。")
      try { return HardwarePcmFile.verifyAndCommit(file, requireNotNull(store), identity, recording) }
      catch (error: HardwareRuntimeException) {
        if (error.publicCode != "checksum_mismatch" || integrityAttempt != 0) throw error
        // verifyAndCommit deletes the untrusted PCM before this retry.
        Log.i("LaojiHardware", "pcm_integrity_refetch expected_bytes=${recording.audioBytes}")
      }
    }
    throw HardwareRuntimeException("checksum_mismatch", "录音校验未通过，请重新接收。")
  }

  private fun readSuffix(recording: HardwareDeviceRecording, pcm: HardwarePcmFile, token: Long) {
    var range: ReadRange? = null
    try {
      request("recording.audio.read", mapOf("recording_id" to recording.recordingId,
        "expected_generation" to recording.generation, "offset" to pcm.size()), before = { reply ->
        val data = reply.getJSONObject("transfer")
        val stream = data.getLong("stream_id")
        if (stream !in 1..0xffffffffL || data.getString("recording_id") != recording.recordingId ||
          data.getString("generation") != recording.generation || data.getLong("offset") != pcm.size() ||
          data.getString("offset_scope") != "audio_payload" || data.getLong("total_audio_bytes") != recording.audioBytes ||
          data.getLong("length") != recording.audioBytes - pcm.size() || data.getString("checksum_sha256") != recording.checksumSha256 ||
          data.optInt("chunk_size_bytes") !in 2..492) throw HardwareProtocolException("invalid PCM transfer contract")
        range = ReadRange(stream.toInt(), recording.audioBytes, pcm)
        activeRead = range
      })
      val transfer = requireNotNull(range)
      while (!transfer.completion.isDone) {
        if (epoch != token || android.os.SystemClock.elapsedRealtime() - transfer.lastData > 12_000) throw HardwareTransportException("录音传输中断，可重试。")
        try { transfer.completion.get(1, TimeUnit.SECONDS) } catch (_: TimeoutException) { }
      }
      transfer.completion.get()
    } finally {
      if (activeRead === range) activeRead = null
      range?.let { if (epoch == token) runCatching { request("recording.audio.read.cancel", mapOf("stream_id" to (it.stream.toLong() and 0xffffffffL))) } }
    }
  }

  private fun request(op: String, values: Map<String, Any?> = emptyMap(), before: ((JSONObject) -> Unit)? = null,
    timeoutMs: Long? = null, abort: CompletableFuture<Unit>? = null): JSONObject {
    val opened = transport ?: throw HardwareTransportException("录音设备未连接。")
    val requestEpoch = epoch
    val id = UUID.randomUUID().toString()
    val future = CompletableFuture<JSONObject>()
    replies[id] = Reply(op, future, before)
    try {
      val message = JSONObject().put("schema_version", 1).put("op", op).put("command_id", id)
      values.forEach { (key, value) -> message.put(key, JSONObject.wrap(value)) }
      abort?.whenComplete { _, error -> if (error != null) future.completeExceptionally(error) }
      if (!future.isDone) opened.write(message)
      // Metadata may require firmware to inspect a large SD file. Keep the UI
      // asynchronous and interactive commands short; this is not an audio-size gate.
      val timeoutSeconds = if (op in setOf("status.get", "recording.get", "recording.list", "recording.rename", "recording.audio.read")) 900L else 8L
      val waitingAt = android.os.SystemClock.elapsedRealtime()
      val response = future.get(timeoutMs?.coerceAtLeast(1L) ?: timeoutSeconds * 1000, TimeUnit.MILLISECONDS)
      val elapsed = android.os.SystemClock.elapsedRealtime() - waitingAt
      if (elapsed > 3000) Log.i("LaojiHardware", "control_slow op=$op elapsed_ms=$elapsed")
      if (!response.getBoolean("ok")) {
        val code = response.optJSONObject("error")?.optString("code") ?: "internal_error"
        throw HardwareRuntimeException(code, when (code) {
          "busy", "invalid_state" -> "设备当前无法执行这项操作。"
          "resume_mismatch" -> "设备录音已变化，请刷新后重试。"
          "recording_already_exists" -> "这个录音名称已存在。"
          "storage_full" -> "设备存储空间已满。"
          else -> "设备未能完成操作，请重试。"
        })
      }
      return response
    } catch (e: HardwareTransportException) {
      // A synchronous control-write failure is already terminal at the GATT
      // layer. Publish its connection outcome before rejecting the operation;
      // do not wait for the polling reader to discover the closed transport.
      failConnectionIfCurrent(opened, requestEpoch, e)
      throw e
    } catch (e: TimeoutException) { throw HardwareTransportException("录音设备响应超时。", e) }
    finally { replies.remove(id) }
  }

  private fun readLoop(opened: HardwareDuplexTransport, token: Long) {
    try {
      while (transport === opened && epoch == token) {
        val frame = opened.read() ?: continue
        if (epoch != token || transport !== opened) break
        when (frame.kind) {
          HardwareProtocol.KIND_CONTROL_RESPONSE -> {
            val json = frame.json()
            replies[json.getString("command_id")]?.let { pending ->
              if (pending.op != json.getString("op")) throw HardwareProtocolException("response operation mismatch")
              try { if (json.getBoolean("ok")) pending.before?.invoke(json); pending.future.complete(json) }
              catch (e: Throwable) { pending.future.completeExceptionally(e) }
            }
          }
          HardwareProtocol.KIND_EVENT -> onEvent(frame.json(), token)
          HardwareProtocol.KIND_LIVE_AUDIO -> onLiveAudio(frame, token)
          HardwareProtocol.KIND_FILE_CHUNK -> onStoredAudio(frame, token)
        }
      }
    } catch (e: Throwable) { failConnectionIfCurrent(opened, token, e) }
  }

  private fun failConnectionIfCurrent(opened: HardwareDuplexTransport, token: Long, error: Throwable) = synchronized(lock) {
    // Checking before acquiring the lock leaves a window in which a new
    // connection can take ownership and then be closed by this old callback.
    if (transport === opened && epoch == token) {
      disconnectInternal(false)
      fail(error)
    }
  }

  private fun onEvent(event: JSONObject, token: Long): Unit = synchronized(lock) {
    if (epoch != token) return
    when (event.getString("op")) {
      "capture.requested" -> {
        val accept = synchronized(lock) {
          val can = snapshot.phase == "ready" && !liveRequested && transferPermit.availablePermits() == 1
          if (can) { liveRequested = true; expireStart(token) }
          can
        }
        keyControl.execute {
          if (epoch == token) try { request("capture.request.resolve", mapOf("request_id" to event.getString("request_id"), "live_stream" to accept)) }
          catch (_: Throwable) { synchronized(lock) { liveRequested = false } }
        }
      }
      "capture.started" -> synchronized(lock) {
        val audio = event.getJSONObject("audio")
        if (audio.optString("codec") != "pcm_s16le" || audio.optInt("sample_rate_hz") != 16000 ||
          audio.optInt("bits_per_sample") != 16 || audio.optInt("channels") != 1) throw HardwareProtocolException("invalid live profile")
        cancelLiveRepairLocked()
        live?.close(); live?.file?.delete()
        live = if (liveRequested) HardwarePcmFile(File(requireNotNull(context).cacheDir, "hardware-live/${UUID.randomUUID()}.pcm")) else null
        liveRecordingId = HardwareBoardContract.fileName(event.getString("recording_id"))
        liveStartedAt = System.currentTimeMillis()
        liveRealtime?.finish(interrupted = true)
        val purpose = HardwareBoardContract.purpose(event)
        liveRealtime = if (live != null && purpose == "meeting") runCatching { HardwareRealtime.begin(requireNotNull(snapshot.deviceId),
          event.getString("session_id"), requireNotNull(liveRecordingId), liveStartedAt) }.getOrNull() else null
        liveSequence = 0; liveBroken = false; liveRequested = false
        val repair = (snapshot.capabilities["capture"] as? Map<*, *>)?.get("live_range_repair") as? Map<*, *>
        val maxBytes = (repair?.get("max_bytes") as? Number)?.toLong() ?: 0
        val retention = (repair?.get("retention_bytes") as? Number)?.toLong() ?: 0
        liveRepairLimit = if (maxBytes >= 2 && maxBytes % 2 == 0L && retention >= maxBytes)
          minOf(maxBytes, 32768L).toInt() else 0
        liveAssembler = if (live != null && liveRepairLimit > 0) HardwareLivePrefixAssembler() else null
        update(snapshot.copy(phase = "recording", purpose = purpose, sessionId = event.getString("session_id"), streamId = event.getLong("stream_id"), errorCode = null, errorMessage = null))
      }
      "capture.paused", "capture.resumed" -> if (event.optString("session_id") == snapshot.sessionId) {
        liveRealtime?.capturePhase(if (event.getString("op") == "capture.paused") "paused" else "recording")
        update(snapshot.copy(phase = if (event.getString("op") == "capture.paused") "paused" else "recording"))
      }
      "capture.finished" -> if (event.optString("session_id") == snapshot.sessionId) {
        val pcm = synchronized(lock) { cancelLiveRepairLocked(); val p = live; live = null; p?.close(); p }
        val id = liveRecordingId
        if (id != null && event.getString("recording_id") != id ||
          snapshot.streamId != null && event.getLong("stream_id") != snapshot.streamId) {
          throw HardwareProtocolException("finished session identity mismatch")
        }
        val finished = HardwareBoardContract.finishedRecording(event,
          liveStartedAt.takeIf { it > 0 } ?: System.currentTimeMillis())
        // Reconnect/status.get can recover the same capture without a new
        // started event. Bind its finish by the original session, never name alone.
        val realtime = liveRealtime ?: snapshot.deviceId?.let {
          HardwareRealtime.capture(it, event.getString("session_id"), finished.recordingId)
        }
        realtime?.finish(generation = finished.generation); liveRealtime = null
        recordingMetadata[finished.recordingId] = finished
        if (pcm == null) update(snapshot.copy(phase = "ready", sessionId = null, streamId = null))
        else {
          update(snapshot.copy(phase = "finalizing"))
          transfers.execute {
            if (!transferPermit.tryAcquire()) {
              pcm.file.delete()
              if (epoch == token) update(snapshot.copy(phase = "ready", sessionId = null, streamId = null,
                errorCode = "busy", errorMessage = "录音仍在设备中，可稍后接收。"))
              return@execute
            }
            var stage = "metadata"
            try {
              if (epoch != token) return@execute
              stage = "receive_commit"
              val result = associate(receivePcm(finished, pcm.file, token))
              if (epoch == token) { HardwareRuntimeEvents.recording(result); update(snapshot.copy(phase = "ready", sessionId = null, streamId = null, transferProgress = null)) }
            } catch (e: Throwable) {
              Log.w("LaojiHardware", "finalize_failed stage=$stage type=${e.javaClass.simpleName} code=${(e as? HardwareRuntimeException)?.publicCode ?: "contract_or_storage"}")
              if (epoch == token) update(snapshot.copy(phase = "ready", sessionId = null, streamId = null,
                transferProgress = null, errorCode = "transfer_incomplete", errorMessage = "录音仍在设备中，可重新接收。")) }
            finally { pcm.file.delete(); transferPermit.release() }
          }
        }
      }
      "capture.interrupted" -> if (event.optString("session_id") == snapshot.sessionId) synchronized(lock) {
        val failure = HardwareBoardContract.captureInterruption(event.optString("reason"))
        Log.w("LaojiHardware", "capture_interrupted code=${failure.publicCode}")
        cancelLiveRepairLocked()
        liveRealtime?.finish(interrupted = true); liveRealtime = null
        live?.close(); live?.file?.delete(); live = null; liveRequested = false
        update(snapshot.copy(phase = "ready", sessionId = null, streamId = null,
          errorCode = failure.publicCode, errorMessage = failure.message))
      }
    }
    Unit
  }

  private fun onLiveAudio(frame: HardwareFrame, token: Long) {
    val capture = synchronized(lock) {
      if (epoch != token || (frame.streamId.toLong() and 0xffffffffL) != snapshot.streamId) return
      val expected = HardwareProtocol.nextSequence(liveSequence)
      val wasBroken = liveBroken
      val assembler = liveAssembler
      if (assembler != null) {
        appendLiveRangesLocked(assembler, assembler.accept(frame.pcmOffset, frame.payload))
        if (!liveBroken) queueLiveRepairLocked(assembler)
      } else {
        if (frame.sequence != expected) liveBroken = true
        if (!liveBroken && live?.append(frame.pcmOffset, frame.payload) == false) liveBroken = true
        // Optional ASR failure never interrupts the board's SD recording.
        runCatching {
          if (liveBroken) liveRealtime?.gap() else liveRealtime?.append(frame.pcmOffset, frame.payload)
        }
      }
      liveSequence = frame.sequence
      if (!wasBroken && liveBroken) Log.i("LaojiHardware", "live_prefix_sealed expected_sequence=$expected actual_sequence=${frame.sequence} source_offset=${frame.pcmOffset}")
      snapshot.sessionId
    }
    val now = android.os.SystemClock.elapsedRealtime()
    if (frame.payload.isEmpty() || now - lastLevelAt < 180) return
    lastLevelAt = now
    var peak = 0; var squares = 0.0
    for (i in frame.payload.indices step 2) {
      val sample = ((frame.payload[i].toInt() and 255) or (frame.payload[i + 1].toInt() shl 8)).toShort().toInt()
      peak = maxOf(peak, kotlin.math.abs(sample)); squares += sample.toDouble() * sample
    }
    val rms = sqrt(squares / (frame.payload.size / 2)) / 32768
    synchronized(lock) {
      if (epoch == token && capture != null && snapshot.sessionId == capture)
        HardwareRuntimeEvents.level(HardwareLevelEvent(capture, peak / 32768.0, rms, (sqrt(rms) * 1.6).coerceIn(0.0, 1.0)))
    }
  }
  /** Caller holds lock. Only an exact contiguous assembler prefix is emitted. */
  private fun appendLiveRangesLocked(assembler: HardwareLivePrefixAssembler, ranges: List<HardwarePcmRange>) {
    if (liveAssembler !== assembler || liveBroken) return
    for (range in ranges) {
      if (live?.append(range.offset, range.bytes) == false) { assembler.seal(); break }
      runCatching { liveRealtime?.append(range.offset, range.bytes) }
    }
    if (assembler.sealed) sealLiveRepairLocked(assembler)
  }
  private fun sealLiveRepairLocked(assembler: HardwareLivePrefixAssembler) {
    if (liveAssembler !== assembler) return
    assembler.seal()
    if (!liveBroken) { liveBroken = true; runCatching { liveRealtime?.gap() } }
    activeLiveRepair?.completion?.completeExceptionally(HardwareTransportException("实时录音范围无法恢复。"))
  }
  private fun cancelLiveRepairLocked() {
    liveAssembler?.let { if (it.missing() != null) sealLiveRepairLocked(it) }
    liveAssembler = null; liveRepairQueued = null; liveGapDeadline = 0; liveGapSerial += 1
    activeLiveRepair?.completion?.completeExceptionally(HardwareTransportException("实时录音已结束。"))
    activeLiveRepair = null
  }
  private fun queueLiveRepairLocked(assembler: HardwareLivePrefixAssembler) {
    if (assembler.missing(liveRepairLimit) == null) { liveGapDeadline = 0; return }
    if (liveBroken) return
    if (liveGapDeadline == 0L) {
      liveGapDeadline = android.os.SystemClock.elapsedRealtime() + 3000
      val serial = ++liveGapSerial
      deadlines.schedule({ synchronized(lock) {
        if (liveAssembler === assembler && liveGapSerial == serial && assembler.missing() != null)
          sealLiveRepairLocked(assembler)
      } }, 3000, TimeUnit.MILLISECONDS)
    }
    if (liveRepairQueued === assembler) return
    val token = epoch; val capture = snapshot.sessionId ?: return; val source = snapshot.streamId ?: return
    liveRepairQueued = assembler
    transfers.execute { runLiveRepair(assembler, token, capture, source) }
  }
  private fun runLiveRepair(assembler: HardwareLivePrefixAssembler, token: Long, capture: String, source: Long) {
    fun current() = epoch == token && liveAssembler === assembler && !liveBroken &&
      snapshot.sessionId == capture && snapshot.streamId == source && snapshot.phase in setOf("recording", "paused")
    try {
      while (true) {
        val operation = synchronized(lock) {
          if (!current()) return
          val missing = assembler.missing(liveRepairLimit) ?: return
          if (android.os.SystemClock.elapsedRealtime() >= liveGapDeadline) { sealLiveRepairLocked(assembler); return }
          HardwareLiveRepairRead(missing, capture, source).also { activeLiveRepair = it }
        }
        try {
          val remaining = synchronized(lock) { liveGapDeadline - android.os.SystemClock.elapsedRealtime() }
          request("capture.audio.read", mapOf("session_id" to capture, "stream_id" to source,
            "offset" to operation.range.offset, "length" to operation.range.length), before = { reply -> synchronized(lock) {
            if (!current() || activeLiveRepair !== operation || operation.completion.isDone)
              throw HardwareTransportException("实时录音状态已变化。")
            operation.open(reply.getJSONObject("transfer"))
          } }, timeoutMs = remaining, abort = operation.completion)
          val wait = synchronized(lock) { liveGapDeadline - android.os.SystemClock.elapsedRealtime() }
          operation.completion.get(wait.coerceAtLeast(1), TimeUnit.MILLISECONDS)
        } catch (_: Throwable) {
          synchronized(lock) {
            // Live may itself have delivered a delayed range. A failed obsolete
            // repair must not seal a different, newer hole in that capture.
            if (current() && assembler.nextOffset < operation.range.offset + operation.range.length)
              sealLiveRepairLocked(assembler)
          }
        } finally {
          synchronized(lock) { if (activeLiveRepair === operation) activeLiveRepair = null }
          if (operation.streamId != 0 && epoch == token) runCatching {
            request("capture.audio.read.cancel", mapOf("stream_id" to (operation.streamId.toLong() and 0xffffffffL)), timeoutMs = 500)
          }
        }
      }
    } finally { synchronized(lock) { if (liveRepairQueued === assembler) liveRepairQueued = null } }
  }
  private fun onStoredAudio(frame: HardwareFrame, token: Long) {
    val repairHandled = synchronized(lock) {
      if (epoch != token) return
      val repair = activeLiveRepair
      if (repair == null || repair.streamId == 0 || frame.streamId != repair.streamId) false
      else {
        try {
          val assembler = liveAssembler
          if (assembler != null && !liveBroken) repair.accept(frame)?.let { bytes ->
            appendLiveRangesLocked(assembler, assembler.accept(repair.range.offset, bytes))
            if (assembler.missing(liveRepairLimit) == null) liveGapDeadline = 0
            if (!liveBroken) {
              Log.i("LaojiHardware", "live_prefix_repaired bytes=${bytes.size}")
              repair.completion.complete(Unit)
            }
          }
        } catch (error: Throwable) { repair.completion.completeExceptionally(error) }
        true
      }
    }
    if (repairHandled) return
    val transfer = activeRead ?: return
    if (frame.streamId != transfer.stream || transfer.completion.isDone) return
    try {
      if (frame.sequence != HardwareProtocol.nextSequence(transfer.sequence) || frame.pcmOffset + frame.payload.size > transfer.end ||
        !transfer.pcm.append(frame.pcmOffset, frame.payload)) throw HardwareProtocolException("stored PCM gap")
      transfer.sequence = frame.sequence
      transfer.lastData = android.os.SystemClock.elapsedRealtime()
      progress(transfer.pcm.size().toDouble() / transfer.end, token)
      if (frame.flags and HardwareProtocol.FLAG_FINAL != 0 || transfer.pcm.size() == transfer.end) {
        if (transfer.pcm.size() != transfer.end) throw HardwareProtocolException("truncated PCM range")
        transfer.pcm.sync(); transfer.completion.complete(Unit)
      }
    } catch (e: Throwable) { transfer.completion.completeExceptionally(e) }
  }
  private fun progress(value: Double, token: Long) {
    if (epoch == token && value.isFinite()) {
      val previous = snapshot.transferProgress ?: -1.0
      if (value == 1.0 || value - previous >= .01) update(snapshot.copy(transferProgress = value.coerceIn(0.0, 1.0)))
    }
  }
  private fun disconnectInternal(emit: Boolean) = synchronized(lock) {
    epoch += 1
    cancelLiveRepairLocked()
    recordingMetadata.clear()
    val opened = transport; transport = null
    liveRealtime?.finish(interrupted = true); liveRealtime = null
    live?.close(); live?.file?.delete(); live = null; liveRecordingId = null; liveRequested = false; liveStartedAt = 0L
    val error = HardwareTransportException("录音设备已断开。")
    activeRead?.completion?.completeExceptionally(error); activeRead = null
    replies.values.forEach { it.future.completeExceptionally(error) }; replies.clear()
    runCatching { opened?.close() }
    context?.let { HardwareConnectionService.stop(it) }
    if (emit) update(HardwareRuntimeSnapshot("disconnected"))
  }
  private fun requireReady() { if (snapshot.phase != "ready" || transport == null) throw HardwareRuntimeException("invalid_state", "录音设备尚未就绪。") }
  private fun expireStart(token: Long) {
    val serial = ++startRequestSerial
    deadlines.schedule({ synchronized(lock) {
      if (epoch == token && startRequestSerial == serial && liveRequested && snapshot.phase == "ready") {
        liveRequested = false
        update(snapshot.copy(errorCode = "capture_unavailable", errorMessage = "录音未启动，请重试。"))
      }
    } }, 10, TimeUnit.SECONDS)
  }
  private fun waitForPhase(phase: String) {
    val end = android.os.SystemClock.elapsedRealtime() + 5000
    while (android.os.SystemClock.elapsedRealtime() < end) { if (snapshot.phase == phase) return; Thread.sleep(10) }
    throw HardwareTransportException("录音状态确认超时。")
  }
  private fun update(value: HardwareRuntimeSnapshot) = synchronized(lock) {
    snapshot = value.copy(updatedAtMs = maxOf(System.currentTimeMillis(), snapshot.updatedAtMs + 1))
    HardwareRuntimeEvents.state(snapshot)
  }
  private fun fail(e: Throwable) { val error = publicError(e); update(snapshot.copy(phase = "retryable_error", sessionId = null, streamId = null, errorCode = error.publicCode, errorMessage = error.message)) }
  private fun publicError(e: Throwable): HardwareRuntimeException {
    var current = e
    while (current.cause != null && current !is HardwareRuntimeException) current = requireNotNull(current.cause)
    return if (current is HardwareRuntimeException) current else HardwareTransportException("设备通信异常，请重新连接。", current)
  }
  private fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
  private fun JSONObject.hasValue(key: String, expected: Any): Boolean = optJSONArray(key)?.let { values ->
    (0 until values.length()).any { values.opt(it) == expected }
  } ?: false
  private fun jsonMap(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { jsonValue(value.opt(it)) }
  private fun jsonValue(value: Any?): Any? = when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> jsonMap(value)
    is JSONArray -> (0 until value.length()).map { jsonValue(value.opt(it)) }
    else -> value
  }
}
