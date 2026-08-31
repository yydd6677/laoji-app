package com.laoji.nativeplatform.hardware

import android.content.Context
import android.hardware.usb.UsbManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.sqrt

internal data class HardwareRuntimeSnapshot(
  val phase: String,
  val transport: String? = null,
  val locator: String? = null,
  val deviceId: String? = null,
  val model: String? = null,
  val firmwareRevision: String? = null,
  val hardwareRevision: String? = null,
  val securityMode: String? = null,
  val capabilities: Map<String, Any?> = emptyMap(),
  val sessionId: String? = null,
  val streamId: Long? = null,
  val transferProgress: Double? = null,
  val errorCode: String? = null,
  val errorMessage: String? = null,
  val updatedAtMs: Long = System.currentTimeMillis().coerceAtLeast(0L),
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "phase" to phase,
    "transport" to transport,
    "locator" to locator,
    "deviceId" to deviceId,
    "model" to model,
    "firmwareRevision" to firmwareRevision,
    "hardwareRevision" to hardwareRevision,
    "securityMode" to securityMode,
    "capabilities" to capabilities,
    "sessionId" to sessionId,
    "streamId" to streamId,
    "transferProgress" to transferProgress,
    "errorCode" to errorCode,
    "errorMessage" to errorMessage,
    "updatedAtMs" to updatedAtMs,
  )
}

internal data class HardwareLevelEvent(
  val sessionId: String,
  val peak: Double,
  val rms: Double,
  val normalized: Double,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "sessionId" to sessionId,
    "peak" to peak,
    "rms" to rms,
    "normalized" to normalized,
  )
}

internal interface HardwareRuntimeListener {
  fun onState(snapshot: HardwareRuntimeSnapshot) = Unit
  fun onRecordingReady(recording: PendingHardwareRecording) = Unit
  fun onLevel(level: HardwareLevelEvent) = Unit
}

internal object HardwareRuntimeEvents {
  private val listeners = CopyOnWriteArraySet<HardwareRuntimeListener>()

  fun add(listener: HardwareRuntimeListener) = listeners.add(listener)
  fun remove(listener: HardwareRuntimeListener) = listeners.remove(listener)
  fun state(snapshot: HardwareRuntimeSnapshot) = listeners.forEach { it.onState(snapshot) }
  fun recording(recording: PendingHardwareRecording) = listeners.forEach { it.onRecordingReady(recording) }
  fun level(value: HardwareLevelEvent) = listeners.forEach { it.onLevel(value) }
}

internal object HardwareRuntime {
  private val lock = Any()
  private val reader = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "laoji-hardware-reader").apply { isDaemon = true }
  }
  private val pendingResponses = ConcurrentHashMap<Int, CompletableFuture<JSONObject>>()
  private val correlation = AtomicInteger(1)
  private val transmitSequence = AtomicInteger(1)
  private val decoder = HardwareFrameDecoder()
  private val receiveSequence = mutableMapOf<Int, Int>()

  @Volatile private var appContext: Context? = null
  @Volatile private var transport: HardwareDuplexTransport? = null
  @Volatile private var snapshot = HardwareRuntimeSnapshot(phase = "disconnected")
  private var generation = 0L
  private var connectedLocator: String? = null
  private var connectedUsbVendorId: Int? = null
  private var connectedUsbProductId: Int? = null
  private var recordingStore: HardwareRecordingStore? = null
  private var writer: HardwareRecordingWriter? = null
  private var recordingCompletion: CompletableFuture<PendingHardwareRecording?>? = null
  private var activeStreamId: Int? = null
  private var activeSessionId: String? = null
  private var lastLevelAtMs = 0L

  fun initialize(context: Context) = synchronized(lock) {
    val application = context.applicationContext
    appContext = application
    if (recordingStore == null) recordingStore = HardwareRecordingStore(application)
  }

  fun getState(): HardwareRuntimeSnapshot = snapshot

  fun listDevices(context: Context): List<HardwareUsbDevice> {
    initialize(context)
    val devices = UsbHardwareDiscovery.list(context.applicationContext)
    synchronized(lock) {
      if (transport == null && snapshot.phase !in setOf("retryable_error", "incompatible")) {
        val first = devices.firstOrNull()
        setStateLocked(
          if (first == null) HardwareRuntimeSnapshot(phase = "disconnected")
          else HardwareRuntimeSnapshot(
            phase = if (first.hasPermission) "discovered" else "permission_required",
            transport = "usb",
            locator = first.locator,
          ),
        )
      }
    }
    return devices
  }

  fun scanBleDevices(context: Context): List<HardwareBleDevice> {
    initialize(context)
    return BleHardwareDiscovery.scan(context.applicationContext)
  }

  suspend fun requestUsbPermission(context: Context, locator: String): Boolean {
    initialize(context)
    val device = UsbHardwareDiscovery.find(context.applicationContext, locator)
      ?: throw HardwareTransportException("USB 录音设备已断开。")
    if (!UsbHardwareDiscovery.isCompatible(device)) {
      throw HardwareIncompatibleException("这个 USB 设备不支持老记录音协议。")
    }
    val granted = UsbPermissionBroker.request(context.applicationContext, device)
    synchronized(lock) {
      if (transport == null) {
        setStateLocked(
          HardwareRuntimeSnapshot(
            phase = if (granted) "discovered" else "permission_required",
            transport = "usb",
            locator = locator,
            errorCode = if (granted) null else "permission_denied",
            errorMessage = if (granted) null else "未允许访问这个 USB 录音设备。",
          ),
        )
      }
    }
    return granted
  }

  fun connectUsb(context: Context, locator: String): HardwareRuntimeSnapshot {
    initialize(context)
    disconnectInternal(emitDisconnected = false)
    val application = context.applicationContext
    val device = UsbHardwareDiscovery.find(application, locator)
      ?: throw HardwareTransportException("USB 录音设备已断开。")
    if (!UsbHardwareDiscovery.isCompatible(device)) {
      val error = HardwareIncompatibleException("这个 USB 设备不支持老记录音协议。")
      failConnection(error, locator, "usb")
      throw error
    }
    val manager = application.getSystemService(Context.USB_SERVICE) as UsbManager
    if (!manager.hasPermission(device)) {
      val error = HardwarePermissionException()
      synchronized(lock) {
        setStateLocked(
          HardwareRuntimeSnapshot(
            phase = "permission_required",
            transport = "usb",
            locator = locator,
            errorCode = error.publicCode,
            errorMessage = error.message,
          ),
        )
      }
      throw error
    }
    synchronized(lock) {
      setStateLocked(HardwareRuntimeSnapshot(phase = "connecting", transport = "usb", locator = locator))
    }
    val opened = try {
      UsbCdcHardwareTransport.open(application, device)
    } catch (error: Throwable) {
      val public = publicError(error)
      failConnection(public, locator, "usb")
      throw public
    }
    connectedUsbVendorId = device.vendorId
    connectedUsbProductId = device.productId
    return activateTransport(opened, locator, startupDelayMs = 1_200L)
  }

  fun connectBle(context: Context, locator: String): HardwareRuntimeSnapshot {
    initialize(context)
    disconnectInternal(emitDisconnected = false)
    val application = context.applicationContext
    synchronized(lock) {
      setStateLocked(HardwareRuntimeSnapshot(phase = "connecting", transport = "ble", locator = locator))
    }
    val device = BleHardwareDiscovery.find(application, locator)
    val opened = try {
      BleHardwareTransport.open(application, device, locator)
    } catch (error: Throwable) {
      val public = publicError(error)
      failConnection(public, locator, "ble")
      throw public
    }
    connectedUsbVendorId = null
    connectedUsbProductId = null
    return activateTransport(opened, locator, startupDelayMs = 0L)
  }

  private fun activateTransport(
    opened: HardwareDuplexTransport,
    locator: String,
    startupDelayMs: Long,
  ): HardwareRuntimeSnapshot {
    val readerGeneration: Long
    synchronized(lock) {
      generation += 1
      readerGeneration = generation
      transport = opened
      connectedLocator = locator
      decoder.reset()
      receiveSequence.clear()
      transmitSequence.set(1)
      correlation.set(1)
      setStateLocked(
        HardwareRuntimeSnapshot(
          phase = "handshaking",
          transport = opened.transportName,
          locator = locator,
        ),
      )
    }
    reader.execute { readerLoop(readerGeneration, opened) }
    return try {
      // The native ESP32-S3 CDC endpoint can reset when a new host claims it.
      if (startupDelayMs > 0L) Thread.sleep(startupDelayMs)
      val hello = request(
        "hello",
        mapOf(
          "app" to mapOf("name" to "laoji-android", "version" to "1"),
          "supported_protocols" to listOf(mapOf("major" to 1, "minor" to 1)),
          "transports" to listOf(opened.transportName),
        ),
        8_000,
      )
      applyHello(hello, locator, opened.transportName)
      runCatching {
        request(
          "time.sync",
          mapOf(
            "epoch_ms" to System.currentTimeMillis().coerceAtLeast(0L),
            "elapsed_realtime_ms" to android.os.SystemClock.elapsedRealtime(),
            "time_zone" to java.util.TimeZone.getDefault().id,
          ),
          3_000,
        )
      }
      val status = runCatching { request("status.get", emptyMap(), 3_000) }.getOrNull()
      if (status != null) applyStatus(status) else synchronized(lock) {
        val ready = snapshot.copy(
          phase = "ready",
          errorCode = null,
          errorMessage = null,
          sessionId = null,
          streamId = null,
          transferProgress = null,
          updatedAtMs = now(),
        )
        setStateLocked(ready)
        ready
      }
    } catch (error: Throwable) {
      val public = publicError(error)
      runCatching { disconnectInternal(emitDisconnected = false) }
      failConnection(public, locator, opened.transportName)
      throw public
    }
  }

  fun disconnect(): HardwareRuntimeSnapshot {
    disconnectInternal(emitDisconnected = true)
    return snapshot
  }

  fun startCapture(): HardwareRuntimeSnapshot {
    val sessionId = UUID.randomUUID().toString()
    synchronized(lock) {
      if (snapshot.phase != "ready" || transport == null) {
        throw HardwareRuntimeException("invalid_state", "外接录音设备尚未就绪。")
      }
    }
    request(
      "capture.start",
      mapOf(
        "session_id" to sessionId,
        "audio" to mapOf(
          "codec" to "pcm_s16le",
          "sample_rate_hz" to 16_000,
          "channels" to 1,
        ),
      ),
      5_000,
    )
    waitForPhase("recording", 4_000)
    return snapshot
  }

  fun pauseCapture(): HardwareRuntimeSnapshot {
    val sessionId = synchronized(lock) {
      if (snapshot.phase != "recording") {
        throw HardwareRuntimeException("invalid_state", "外接录音当前没有在录制。")
      }
      activeSessionId ?: snapshot.sessionId
        ?: throw HardwareRuntimeException("invalid_state", "外接录音状态尚未就绪。")
    }
    request("capture.pause", mapOf("session_id" to sessionId), 5_000)
    waitForPhase("paused", 4_000)
    return snapshot
  }

  fun resumeCapture(): HardwareRuntimeSnapshot {
    val sessionId = synchronized(lock) {
      if (snapshot.phase != "paused") {
        throw HardwareRuntimeException("invalid_state", "外接录音当前没有暂停。")
      }
      activeSessionId ?: snapshot.sessionId
        ?: throw HardwareRuntimeException("invalid_state", "外接录音状态尚未就绪。")
    }
    request("capture.resume", mapOf("session_id" to sessionId), 5_000)
    waitForPhase("recording", 4_000)
    return snapshot
  }

  fun stopCapture(): PendingHardwareRecording? {
    val sessionId: String
    val completion: CompletableFuture<PendingHardwareRecording?>?
    synchronized(lock) {
      sessionId = activeSessionId ?: snapshot.sessionId
        ?: throw HardwareRuntimeException("invalid_state", "外接录音当前没有在录制。")
      if (snapshot.phase !in setOf("recording", "paused")) {
        throw HardwareRuntimeException("invalid_state", "外接录音当前没有在录制。")
      }
      completion = recordingCompletion
      setStateLocked(snapshot.copy(phase = "finalizing", updatedAtMs = now()))
    }
    request("capture.stop", mapOf("session_id" to sessionId), 5_000)
    if (completion == null) {
      val status = request("status.get", emptyMap(), 4_000)
      applyStatus(status)
      return null
    }
    return try {
      completion.get(8, TimeUnit.SECONDS)
    } catch (error: TimeoutException) {
      throw HardwareRuntimeException("transport_lost", "外接录音停止超时，可断开后导入已收到的内容。", error)
    }
  }

  fun listPendingRecordings(): List<PendingHardwareRecording> =
    requireNotNull(recordingStore) { "hardware runtime is not initialized" }.list()

  fun acknowledgeRecording(recordingId: String): Boolean =
    requireNotNull(recordingStore) { "hardware runtime is not initialized" }.acknowledge(recordingId)

  fun listDeviceRecordings(): List<HardwareDeviceRecording> {
    synchronized(lock) {
      if (transport == null || snapshot.phase in setOf("disconnected", "retryable_error", "incompatible")) {
        throw HardwareRuntimeException("invalid_state", "外接录音设备尚未连接。")
      }
    }
    val result = mutableListOf<HardwareDeviceRecording>()
    var cursor: String? = null
    repeat(86) {
      val response = request(
        "recording.list",
        buildMap {
          put("limit", 12)
          cursor?.let { put("cursor", it) }
        },
        5_000,
      )
      val items = response.optJSONArray("recordings")
        ?: throw HardwareProtocolException("recording.list has no recordings")
      for (index in 0 until items.length()) {
        result += parseDeviceRecording(
          items.optJSONObject(index) ?: throw HardwareProtocolException("recording.list item is invalid"),
        )
      }
      cursor = if (response.isNull("next_cursor")) {
        null
      } else {
        response.optString("next_cursor").trim().takeIf(String::isNotBlank)
      }
      if (cursor == null) return result.sortedByDescending { it.createdEpochMs ?: 0L }
    }
    throw HardwareProtocolException("recording.list pagination did not terminate")
  }

  fun renameDeviceRecording(recordingId: String, generation: String, title: String): HardwareDeviceRecording {
    val response = request(
      "recording.rename",
      mapOf(
        "recording_id" to requireSafeId(recordingId),
        "expected_generation" to requireSafeId(generation),
        "title" to title.trim().take(120),
      ),
      5_000,
    )
    return parseDeviceRecording(
      response.optJSONObject("recording") ?: throw HardwareProtocolException("recording.rename has no recording"),
    )
  }

  fun deleteDeviceRecording(recordingId: String, generation: String): Boolean {
    request(
      "recording.delete",
      mapOf(
        "recording_id" to requireSafeId(recordingId),
        "expected_generation" to requireSafeId(generation),
      ),
      5_000,
    )
    return true
  }

  fun receiveDeviceRecording(recording: HardwareDeviceRecording): PendingHardwareRecording {
    val context = requireNotNull(appContext) { "hardware runtime is not initialized" }
    val store = requireNotNull(recordingStore) { "hardware runtime is not initialized" }
    val identity = snapshot.deviceId
      ?: throw HardwareRuntimeException("invalid_state", "外接录音设备尚未连接。")
    val currentSnapshot = synchronized(lock) {
      if (snapshot.phase != "ready") {
        throw HardwareRuntimeException("invalid_state", "设备当前不能传输录音。")
      }
      snapshot
    }
    val response = request(
      "transport.wifi.offer",
      mapOf(
        "recording_id" to requireSafeId(recording.recordingId),
        "expected_generation" to requireSafeId(recording.generation),
      ),
      8_000,
    )
    val offer = parseWifiOffer(
      response.optJSONObject("wifi_offer") ?: throw HardwareProtocolException("Wi-Fi offer is missing"),
    )
    synchronized(lock) {
      setStateLocked(snapshot.copy(phase = "transferring", transferProgress = 0.0, updatedAtMs = now()))
    }
    return try {
      val pending = HardwareWifiTransfer.receive(
        context = context,
        deviceId = identity,
        recording = recording,
        offer = offer,
        store = store,
        allowDevelopmentHttp = currentSnapshot.model == "PD-AILAMP-D01-test" &&
          currentSnapshot.securityMode in setOf("development_usb", "development_ble"),
      ) { progress ->
        synchronized(lock) {
          if (snapshot.phase == "transferring") {
            setStateLocked(snapshot.copy(transferProgress = progress, updatedAtMs = now()))
          }
        }
      }
      runCatching {
        request(
          "recording.ack",
          mapOf(
            "recording_id" to recording.recordingId,
            "expected_generation" to recording.generation,
          ),
          5_000,
        )
      }
      HardwareRuntimeEvents.recording(pending)
      pending
    } finally {
      runCatching { request("transport.wifi.close", emptyMap(), 2_000) }
      synchronized(lock) {
        if (transport != null) {
          setStateLocked(snapshot.copy(
            phase = "ready",
            transferProgress = null,
            errorCode = null,
            errorMessage = null,
            updatedAtMs = now(),
          ))
        }
      }
    }
  }

  private fun request(operation: String, values: Map<String, Any?>, timeoutMs: Long): JSONObject {
    val currentTransport = transport ?: throw HardwareTransportException("外接录音设备未连接。")
    val requestId = nextPositive(correlation)
    val commandId = UUID.randomUUID().toString()
    val payload = HardwareProtocol.controlPayload(
      operation,
      mapOf("command_id" to commandId) + values,
    )
    val frame = HardwareFrame(
      kind = HardwareProtocol.KIND_CONTROL_REQUEST,
      flags = 0,
      streamId = 0,
      sequence = nextPositive(transmitSequence),
      correlationId = requestId,
      payload = payload,
    )
    val future = CompletableFuture<JSONObject>()
    pendingResponses[requestId] = future
    try {
      currentTransport.write(HardwareProtocol.encode(frame))
      val response = future.get(timeoutMs, TimeUnit.MILLISECONDS)
      if (!response.optBoolean("ok", false)) {
        val body = response.optJSONObject("error")
        val code = body?.optString("code")?.takeIf(String::isNotBlank) ?: "internal_error"
        throw HardwareRuntimeException(code, hardwareErrorMessage(code))
      }
      return response
    } catch (error: TimeoutException) {
      throw HardwareTransportException("外接录音设备响应超时。", error)
    } finally {
      pendingResponses.remove(requestId)
    }
  }

  private fun readerLoop(readerGeneration: Long, opened: HardwareDuplexTransport) {
    try {
      while (isCurrent(readerGeneration, opened)) {
        val bytes = opened.read()
        if (bytes.isEmpty()) {
          if (!opened.isAttached()) throw HardwareTransportException("外接录音设备已断开。")
          continue
        }
        decoder.feed(bytes).forEach(::handleFrame)
      }
    } catch (error: Throwable) {
      if (!isCurrent(readerGeneration, opened)) return
      var public = publicError(error)
      val recovered = try {
        synchronized(lock) { finalizeWriterLocked(interrupted = true) }
      } catch (finalizeError: Throwable) {
        public = publicError(finalizeError)
        null
      }
      recovered?.let(HardwareRuntimeEvents::recording)
      pendingResponses.values.forEach { it.completeExceptionally(public) }
      pendingResponses.clear()
      runCatching { opened.close() }
      synchronized(lock) {
        if (generation != readerGeneration) return@synchronized
        generation += 1
        transport = null
        setStateLocked(
          snapshot.copy(
            phase = "retryable_error",
            errorCode = public.publicCode,
            errorMessage = public.message,
            sessionId = null,
            streamId = null,
            updatedAtMs = now(),
          ),
        )
      }
    }
  }

  private fun handleFrame(frame: HardwareFrame) {
    synchronized(lock) {
      val previous = receiveSequence[frame.streamId]
      if (previous != null && unsignedLessOrEqual(frame.sequence, previous)) {
        throw HardwareProtocolException("hardware sequence moved backwards")
      }
      if (
        previous != null && frame.kind == HardwareProtocol.KIND_LIVE_AUDIO &&
        frame.sequence != previous + 1
      ) {
        throw HardwareProtocolException("hardware live audio sequence has a gap")
      }
      receiveSequence[frame.streamId] = frame.sequence
    }
    when (frame.kind) {
      HardwareProtocol.KIND_CONTROL_RESPONSE -> {
        pendingResponses.remove(frame.correlationId)?.complete(frame.json())
      }
      HardwareProtocol.KIND_EVENT -> handleEvent(frame.json())
      HardwareProtocol.KIND_LIVE_AUDIO -> handleAudio(frame)
      else -> Unit
    }
  }

  private fun handleEvent(event: JSONObject) {
    when (event.optString("op")) {
      "capture.started" -> {
        val sessionId = event.optString("session_id").trim()
        val streamId = event.optLong("stream_id", 0L)
        val audio = event.optJSONObject("audio")
          ?: throw HardwareProtocolException("capture.started has no audio profile")
        val codec = audio.optString("codec")
        val sampleRate = audio.optInt("sample_rate_hz", 0)
        val bits = audio.optInt("bits_per_sample", 0)
        val channels = audio.optInt("channels", 0)
        if (sessionId.isBlank() || streamId !in 1..0xffffffffL || codec != "pcm_s16le") {
          throw HardwareProtocolException("unsupported capture.started event")
        }
        val deviceId = snapshot.deviceId
          ?: throw HardwareProtocolException("capture started before hello")
        val recovered = synchronized(lock) {
          val previous = if (writer != null) finalizeWriterLocked(interrupted = true) else null
          val created = requireNotNull(recordingStore).createWriter(
            deviceId = deviceId,
            sessionId = sessionId,
            recordedAtMs = now(),
            sampleRateHz = sampleRate,
            bitsPerSample = bits,
            channels = channels,
          )
          writer = created
          recordingCompletion = CompletableFuture()
          activeStreamId = streamId.toInt()
          activeSessionId = sessionId
          lastLevelAtMs = 0L
          setStateLocked(
            snapshot.copy(
              phase = "recording",
              sessionId = sessionId,
              streamId = streamId,
              errorCode = null,
              errorMessage = null,
              updatedAtMs = now(),
            ),
          )
          previous
        }
        recovered?.let(HardwareRuntimeEvents::recording)
      }
      "capture.finished" -> {
        val completed = synchronized(lock) {
          setStateLocked(snapshot.copy(phase = "finalizing", updatedAtMs = now()))
          finalizeWriterLocked(interrupted = false)
        }
        completed?.let(HardwareRuntimeEvents::recording)
        synchronized(lock) {
          if (transport != null) {
            setStateLocked(
              snapshot.copy(
                phase = "ready",
                sessionId = null,
                streamId = null,
                errorCode = null,
                errorMessage = null,
                updatedAtMs = now(),
              ),
            )
          }
        }
      }
      "capture.paused" -> synchronized(lock) {
        val sessionId = event.optString("session_id").trim()
        if (sessionId.isNotBlank()) activeSessionId = sessionId
        setStateLocked(snapshot.copy(
          phase = "paused",
          sessionId = activeSessionId ?: snapshot.sessionId,
          updatedAtMs = now(),
        ))
      }
      "capture.resumed" -> synchronized(lock) {
        val sessionId = event.optString("session_id").trim()
        if (sessionId.isNotBlank()) activeSessionId = sessionId
        setStateLocked(snapshot.copy(
          phase = "recording",
          sessionId = activeSessionId ?: snapshot.sessionId,
          updatedAtMs = now(),
        ))
      }
      "capture.interrupted" -> {
        val recovered = synchronized(lock) {
          val pending = finalizeWriterLocked(interrupted = true)
          setStateLocked(snapshot.copy(
            phase = "ready",
            sessionId = null,
            streamId = null,
            errorCode = "storage_failed",
            errorMessage = "设备未能完成这段录音。",
            updatedAtMs = now(),
          ))
          pending
        }
        recovered?.let(HardwareRuntimeEvents::recording)
      }
      else -> Unit
    }
  }

  private fun handleAudio(frame: HardwareFrame) {
    synchronized(lock) {
      val expected = activeStreamId ?: return
      if (frame.streamId != expected) throw HardwareProtocolException("hardware audio stream changed")
      if (frame.payload.isNotEmpty()) {
        (writer ?: return).append(frame.payload)
      }
    }
    if (frame.payload.isNotEmpty()) publishLevel(frame.payload)
  }

  private fun publishLevel(payload: ByteArray) {
    val now = now()
    if (now - lastLevelAtMs < 180L) return
    lastLevelAtMs = now
    if (payload.size < 2) return
    var peak = 0
    var square = 0.0
    var samples = 0
    var index = 0
    while (index + 1 < payload.size) {
      val value = ((payload[index].toInt() and 0xff) or (payload[index + 1].toInt() shl 8)).toShort().toInt()
      val absolute = kotlin.math.abs(value)
      if (absolute > peak) peak = absolute
      square += value.toDouble() * value.toDouble()
      samples += 1
      index += 2
    }
    val rms = if (samples == 0) 0.0 else sqrt(square / samples)
    val sessionId = synchronized(lock) { activeSessionId } ?: return
    HardwareRuntimeEvents.level(
      HardwareLevelEvent(
        sessionId = sessionId,
        peak = peak / 32768.0,
        rms = rms / 32768.0,
        normalized = (sqrt(rms / 32768.0) * 1.6).coerceIn(0.0, 1.0),
      ),
    )
  }

  private fun applyHello(hello: JSONObject, locator: String, transportName: String) {
    if (hello.optInt("schema_version", -1) != 1 || hello.optString("op") != "hello") {
      throw HardwareIncompatibleException("设备返回了不兼容的握手信息。")
    }
    val protocol = hello.optJSONObject("protocol")
      ?: throw HardwareIncompatibleException("设备没有声明协议版本。")
    if (protocol.optInt("major", -1) != HardwareProtocol.MAJOR) {
      throw HardwareIncompatibleException("设备版本与当前老记不兼容。")
    }
    val device = hello.optJSONObject("device")
      ?: throw HardwareIncompatibleException("设备身份信息不完整。")
    val security = hello.optJSONObject("security")
      ?: throw HardwareIncompatibleException("设备安全信息不完整。")
    val capabilitiesJson = hello.optJSONObject("capabilities")
      ?: throw HardwareIncompatibleException("设备能力信息不完整。")
    val deviceId = device.optString("device_id").trim()
    val model = device.optString("model").trim()
    val firmware = device.optString("firmware_revision").trim()
    val securityMode = security.optString("mode").trim()
    if (deviceId.isBlank() || model.isBlank() || firmware.isBlank()) {
      throw HardwareIncompatibleException("设备身份信息不完整。")
    }
    if (securityMode == "development_usb") {
      val allowed = connectedUsbVendorId == 0x303a && connectedUsbProductId == 0x1001
      if (!allowed) throw HardwareIncompatibleException("未受信任的测试设备安全模式。")
    } else if (securityMode == "development_ble") {
      val allowed = transportName == "ble" && model == "PD-AILAMP-D01-test" &&
        deviceId.startsWith("esp32s3-")
      if (!allowed) throw HardwareIncompatibleException("未受信任的测试设备安全模式。")
    } else if (securityMode !in setOf("paired", "production_attested")) {
      throw HardwareIncompatibleException("设备使用了不受支持的安全模式。")
    }
    val capabilities = jsonMap(capabilitiesJson)
    val transports = capabilities["transports"] as? List<*>
    if (transportName !in transports.orEmpty()) {
      throw HardwareIncompatibleException("设备没有声明当前连接方式。")
    }
    val capture = capabilities["capture"] as? Map<*, *>
    val codecs = capture?.get("codecs") as? List<*>
    if (capture?.get("live_stream") != true || "pcm_s16le" !in codecs.orEmpty()) {
      throw HardwareIncompatibleException("设备暂不支持当前外接录音格式。")
    }
    synchronized(lock) {
      setStateLocked(
        HardwareRuntimeSnapshot(
          phase = "handshaking",
          transport = transportName,
          locator = locator,
          deviceId = deviceId,
          model = model,
          firmwareRevision = firmware,
          hardwareRevision = device.optString("hardware_revision").takeIf(String::isNotBlank),
          securityMode = securityMode,
          capabilities = capabilities,
        ),
      )
    }
  }

  private fun applyStatus(response: JSONObject): HardwareRuntimeSnapshot {
    if (response.optInt("schema_version", -1) != 1 || response.optString("op") != "status.get") {
      throw HardwareProtocolException("status.get response is invalid")
    }
    val status = response.optJSONObject("status")
      ?: throw HardwareProtocolException("status.get has no status")
    val phase = when (status.optString("state")) {
      "recording" -> "recording"
      "paused" -> "paused"
      "finalizing" -> "finalizing"
      "transferring" -> "ready"
      "ready" -> "ready"
      "storage_full", "error" -> "retryable_error"
      else -> throw HardwareProtocolException("device status state is unsupported")
    }
    val sessionId = status.optString("session_id").trim().takeIf(String::isNotBlank)
    return synchronized(lock) {
      if (phase in setOf("recording", "paused")) activeSessionId = sessionId
      else if (writer == null) activeSessionId = null
      val value = snapshot.copy(
        phase = phase,
        sessionId = sessionId,
        streamId = activeStreamId?.toLong()?.and(0xffffffffL),
        transferProgress = null,
        errorCode = if (phase == "retryable_error") "storage_failed" else null,
        errorMessage = if (phase == "retryable_error") "设备存储当前不可用。" else null,
        updatedAtMs = now(),
      )
      setStateLocked(value)
      value
    }
  }

  private fun parseDeviceRecording(value: JSONObject): HardwareDeviceRecording {
    val recordingId = requireSafeId(value.optString("recording_id"))
    val generation = requireSafeId(value.optString("generation"))
    val audio = value.optJSONObject("audio")
      ?: throw HardwareProtocolException("device recording audio is missing")
    if (
      audio.optString("codec") != "pcm_s16le" ||
      audio.optInt("sample_rate_hz", 0) != 16_000 ||
      audio.optInt("bits_per_sample", 0) != 16 ||
      audio.optInt("channels", 0) != 1
    ) {
      throw HardwareProtocolException("device recording audio profile is unsupported")
    }
    val byteSize = value.optLong("byte_size", -1L)
    val durationMs = value.optLong("duration_ms", -1L)
    val checksum = value.optString("checksum_sha256").trim().lowercase()
    val checksumScope = value.optString("checksum_scope").trim()
    if (
      byteSize <= 44L || durationMs < 0L ||
      !checksum.matches(Regex("^sha256:[0-9a-f]{64}$")) ||
      checksumScope !in setOf("whole_file", "audio_payload")
    ) {
      throw HardwareProtocolException("device recording metadata is invalid")
    }
    return HardwareDeviceRecording(
      recordingId = recordingId,
      generation = generation,
      title = value.optString("title").trim().take(120).takeIf(String::isNotBlank),
      byteSize = byteSize,
      durationMs = durationMs,
      checksumSha256 = checksum,
      checksumScope = checksumScope,
      createdEpochMs = value.optLong("created_epoch_ms", -1L).takeIf { it >= 0L },
      acknowledged = value.optBoolean("acknowledged", false),
      recovered = value.optBoolean("recovered", false),
    )
  }

  private fun parseWifiOffer(value: JSONObject): HardwareWifiOffer {
    val securityMode = value.optString("security_mode").trim()
    val baseUrl = value.optString("base_url").trim()
    val path = value.optString("path").trim()
    val token = value.optString("bearer_token").trim()
    val ssid = value.optString("ssid")
    val password = value.optString("password")
    if (
      ssid.isBlank() || ssid.length > 32 || password.length !in 8..63 ||
      token.length !in 24..192 || path.isBlank() || !path.startsWith('/') ||
      securityMode !in setOf("development_http", "tls_pinned")
    ) {
      throw HardwareProtocolException("Wi-Fi offer is invalid")
    }
    return HardwareWifiOffer(
      recordingId = requireSafeId(value.optString("recording_id")),
      generation = requireSafeId(value.optString("generation")),
      ssid = ssid,
      password = password,
      baseUrl = baseUrl,
      path = path,
      bearerToken = token,
      securityMode = securityMode,
      certificateSha256 = value.optString("certificate_sha256").trim().takeIf(String::isNotBlank),
      expiresEpochMs = value.optLong("expires_epoch_ms", 0L).coerceAtLeast(0L),
      expiresInMs = value.optLong("expires_in_ms", 0L).coerceAtLeast(0L),
    )
  }

  private fun requireSafeId(value: String): String {
    val normalized = value.trim()
    if (!normalized.matches(Regex("^[A-Za-z0-9._:-]{1,128}$"))) {
      throw HardwareProtocolException("hardware identifier is invalid")
    }
    return normalized
  }

  private fun finalizeWriterLocked(interrupted: Boolean): PendingHardwareRecording? {
    val activeWriter = writer ?: return null
    writer = null
    activeStreamId = null
    activeSessionId = null
    val completion = recordingCompletion
    recordingCompletion = null
    return try {
      activeWriter.finish(interrupted).also { completion?.complete(it) }
    } catch (error: Throwable) {
      completion?.completeExceptionally(error)
      throw error
    }
  }

  private fun disconnectInternal(emitDisconnected: Boolean) {
    val opened: HardwareDuplexTransport?
    var recovered: PendingHardwareRecording? = null
    var finalizeError: Throwable? = null
    synchronized(lock) {
      generation += 1
      opened = transport
      transport = null
      try {
        recovered = finalizeWriterLocked(interrupted = true)
      } catch (error: Throwable) {
        finalizeError = error
      }
      connectedLocator = null
      connectedUsbVendorId = null
      connectedUsbProductId = null
      receiveSequence.clear()
      decoder.reset()
      pendingResponses.values.forEach {
        it.completeExceptionally(HardwareTransportException("外接录音设备已断开。"))
      }
      pendingResponses.clear()
      if (emitDisconnected) setStateLocked(HardwareRuntimeSnapshot(phase = "disconnected"))
    }
    runCatching { opened?.close() }
    recovered?.let(HardwareRuntimeEvents::recording)
    finalizeError?.let { throw publicError(it) }
  }

  private fun failConnection(
    error: HardwareRuntimeException,
    locator: String,
    transportName: String,
  ) = synchronized(lock) {
    setStateLocked(
      HardwareRuntimeSnapshot(
        phase = if (error.publicCode == "incompatible") "incompatible" else "retryable_error",
        transport = transportName,
        locator = locator,
        errorCode = error.publicCode,
        errorMessage = error.message,
      ),
    )
  }

  private fun setStateLocked(value: HardwareRuntimeSnapshot) {
    snapshot = value
    HardwareRuntimeEvents.state(value)
  }

  private fun waitForPhase(phase: String, timeoutMs: Long) {
    val deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs
    while (android.os.SystemClock.elapsedRealtime() < deadline) {
      if (snapshot.phase == phase) return
      if (snapshot.phase in setOf("retryable_error", "incompatible")) {
        throw HardwareRuntimeException(
          snapshot.errorCode ?: "transport_lost",
          snapshot.errorMessage ?: "外接录音设备不可用。",
        )
      }
      Thread.sleep(20)
    }
    throw HardwareTransportException("外接录音状态更新超时。")
  }

  private fun isCurrent(readerGeneration: Long, opened: HardwareDuplexTransport): Boolean =
    synchronized(lock) { generation == readerGeneration && transport === opened }

  private fun publicError(error: Throwable): HardwareRuntimeException {
    var current = error
    while (current.cause != null && current !is HardwareRuntimeException) {
      current = requireNotNull(current.cause)
    }
    return when (current) {
      is HardwareRuntimeException -> current
      is HardwareProtocolException -> HardwareRuntimeException(
        "incompatible",
        "设备通信数据不符合老记协议。",
        current,
      )
      else -> HardwareTransportException("外接录音设备通信中断。", current)
    }
  }

  private fun hardwareErrorMessage(code: String): String = when (code) {
    "unsupported_protocol", "unsupported_operation" -> "设备版本与当前老记不兼容。"
    "invalid_state" -> "设备当前状态不允许这项操作。"
    "busy" -> "设备正在处理另一项录音。"
    "capture_unavailable" -> "设备当前无法开始录音。"
    "storage_full" -> "设备存储空间已满。"
    "storage_failed" -> "设备未能保存录音。"
    "wifi_unavailable" -> "未能连接录音设备的传输网络。"
    "permission_denied", "device_untrusted" -> "设备尚未获得可信连接。"
    "checksum_mismatch", "resume_mismatch" -> "录音校验未通过，请重新传输。"
    else -> "设备未能完成这项操作。"
  }

  private fun jsonMap(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { key ->
    jsonValue(value.opt(key))
  }

  private fun jsonValue(value: Any?): Any? = when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> jsonMap(value)
    is JSONArray -> (0 until value.length()).map { index -> jsonValue(value.opt(index)) }
    is Number, is Boolean, is String -> value
    else -> value.toString()
  }

  private fun nextPositive(counter: AtomicInteger): Int {
    while (true) {
      val current = counter.getAndUpdate { if (it == Int.MAX_VALUE) 1 else it + 1 }
      if (current > 0) return current
    }
  }

  private fun unsignedLessOrEqual(current: Int, previous: Int): Boolean =
    Integer.compareUnsigned(current, previous) <= 0

  private fun now(): Long = System.currentTimeMillis().coerceAtLeast(0L)
}
