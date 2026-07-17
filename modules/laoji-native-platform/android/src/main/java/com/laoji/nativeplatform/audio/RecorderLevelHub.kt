package com.laoji.nativeplatform.audio

// MIN-REC-BRIDGE-001: meeting levels stay in-process and never require a JS render loop.

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.floor
import kotlin.math.max

object RecorderLevelHub : RecorderLevelSource {
  private const val MAX_SAMPLES = 160
  private const val DEFAULT_BAR_COUNT = 50
  private const val MIN_BAR_HEIGHT = 0.04f

  private class SessionState {
    val frames = MutableStateFlow<RecorderLevelFrame?>(null)
    val samples = ArrayDeque<Float>(MAX_SAMPLES)
    var sequence = 0L
  }

  private val lock = Any()
  private val sessions = mutableMapOf<String, SessionState>()

  override fun observe(sessionId: String): StateFlow<RecorderLevelFrame?> = synchronized(lock) {
    stateFor(sessionId).frames
  }

  override fun latest(sessionId: String): RecorderLevelFrame? = synchronized(lock) {
    sessions[sessionId]?.frames?.value
  }

  fun publish(
    sessionId: String,
    normalized: Float,
    peak: Int,
    rms: Int,
    durationMs: Long,
    capturedAtElapsedMs: Long,
  ): RecorderLevelFrame = synchronized(lock) {
    val state = stateFor(sessionId)
    val level = normalized.takeIf(Float::isFinite)?.coerceIn(0f, 1f) ?: 0f
    state.sequence += 1L
    val frame = RecorderLevelFrame(
      sessionId = sessionId,
      sequence = state.sequence,
      normalized = level,
      peak = peak.coerceAtLeast(0),
      rms = rms.coerceAtLeast(0),
      durationMs = durationMs.coerceAtLeast(0L),
      capturedAtElapsedMs = capturedAtElapsedMs.coerceAtLeast(0L),
    )
    if (state.samples.size == MAX_SAMPLES) state.samples.removeFirst()
    state.samples.addLast(level)
    state.frames.value = frame
    frame
  }

  fun summary(sessionId: String, count: Int = DEFAULT_BAR_COUNT): List<Float> = synchronized(lock) {
    samplesToBars(sessions[sessionId]?.samples.orEmpty(), count)
  }

  fun captureSummaryAndClear(sessionId: String, count: Int = DEFAULT_BAR_COUNT): List<Float> = synchronized(lock) {
    val state = sessions.remove(sessionId) ?: return@synchronized emptyList()
    val bars = samplesToBars(state.samples, count)
    state.samples.clear()
    state.frames.value = null
    bars
  }

  fun reset(sessionId: String) = synchronized(lock) {
    val state = stateFor(sessionId)
    state.sequence = 0L
    state.samples.clear()
    state.frames.value = null
  }

  internal fun clearAllForTest() = synchronized(lock) {
    sessions.values.forEach { state ->
      state.samples.clear()
      state.frames.value = null
    }
    sessions.clear()
  }

  private fun stateFor(sessionId: String): SessionState {
    require(sessionId.isNotBlank()) { "sessionId must not be blank" }
    return sessions.getOrPut(sessionId) { SessionState() }
  }

  internal fun samplesToBars(samples: Collection<Float>, count: Int = DEFAULT_BAR_COUNT): List<Float> {
    val usable = samples.filter { it.isFinite() && it >= 0f }
    if (usable.isEmpty() || count <= 0) return emptyList()

    val outputCount = minOf(count, usable.size)
    val bars = List(outputCount) { index ->
      val start = floor(index.toDouble() * usable.size / outputCount).toInt()
      val end = max(
        start + 1,
        floor((index + 1).toDouble() * usable.size / outputCount).toInt(),
      )
      usable.subList(start, end.coerceAtMost(usable.size)).maxOrNull() ?: 0f
    }
    val peak = max(1f, bars.maxOrNull() ?: 1f)
    return bars.map { value -> (value / peak).coerceIn(MIN_BAR_HEIGHT, 1f) }
  }
}
