package com.laoji.nativeplatform.hardware

import android.content.Context
import com.laoji.nativeplatform.audio.DeviceV2RealtimeAsrSocket
import com.laoji.nativeplatform.audio.RecorderStartConfig
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** External source sessions use the same v2 transport/binding as phone capture, not its microphone. */
internal object HardwareRealtime {
  private val sessions = ConcurrentHashMap<String, HardwareRealtimeSession>()
  private var root: File? = null
  private var context: Context? = null
  @Synchronized fun initialize(value: Context) {
    if (root != null) return
    context = value.applicationContext
    val directory = File(value.filesDir, "meeting-audio/hardware-realtime")
    directory.mkdirs(); root = directory
    HardwareRealtimeSession.restore(directory, ::changed).forEach { sessions[it.meetingId] = it }
  }
  fun begin(device: String, capture: String, recording: String, startedAt: Long): HardwareRealtimeSession {
    return HardwareRealtimeSession.create(requireNotNull(root), device, capture, recording, startedAt, ::changed)
      .also { sessions[it.meetingId] = it; changed() }
  }
  fun list(): List<Map<String, Any?>> = sessions.values.map { it.snapshot() }
  fun attach(meetingId: String, config: RecorderStartConfig) {
    val session = sessions[meetingId] ?: throw HardwareRuntimeException("invalid_state", "录音状态已变化。")
    require(config.sessionId == session.sessionId) { "hardware realtime session mismatch" }
    session.attach { listener -> DeviceV2RealtimeAsrSocket(requireNotNull(context), config, listener) }
  }
  fun acknowledge(meetingId: String, sequence: Long) { sessions[meetingId]?.acknowledge(sequence) }
  fun association(device: String, recording: String, generation: String): String? =
    sessions.values.firstOrNull { it.matches(device, recording, generation) }?.meetingId
  fun capture(device: String, captureId: String, recording: String): HardwareRealtimeSession? =
    sessions.values.firstOrNull { it.matchesCapture(device, captureId, recording) }
  fun audioReady(meetingId: String) { sessions[meetingId]?.audioReady() }
  fun rename(device: String, old: String, generation: String, next: String) {
    sessions.values.forEach { it.rename(device, old, generation, next) }
  }
  fun retire(meetingId: String) { sessions.remove(meetingId)?.retire(); changed() }
  fun clear() {
    val previous = sessions.values.toList()
    sessions.clear()
    previous.forEach { it.retire() }
    changed()
  }
  private fun changed() { HardwareRuntimeEvents.realtime() }
}
