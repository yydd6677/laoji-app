package com.laoji.nativeplatform.media

import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import kotlin.math.abs

const val MIN_PLAYER_EVIDENCE_ID = "MIN-PLAYER-001"
const val MINUTES_SKIP_INTERVAL_MS = 15_000L
val MINUTES_PLAYBACK_RATES = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f, 3f)

enum class MinutesPlaybackPhase(val wireName: String) {
  IDLE("idle"),
  PREPARING("preparing"),
  READY("ready"),
  PLAYING("playing"),
  PAUSED("paused"),
  ENDED("ended"),
  FAILED("failed"),
}

data class MinutesPlaybackState(
  val sourceId: String? = null,
  val phase: MinutesPlaybackPhase = MinutesPlaybackPhase.IDLE,
  val isPlaying: Boolean = false,
  val positionMs: Long = 0L,
  val bufferedPositionMs: Long = 0L,
  val durationMs: Long = 0L,
  val rate: Float = 1f,
  val retainForBackground: Boolean = true,
  val errorCode: String? = null,
  val errorMessage: String? = null,
) {
  fun toEventMap(background: MinutesBackgroundPlaybackState? = null): Map<String, Any?> = buildMap {
    put("sourceId", sourceId)
    put("phase", phase.wireName)
    put("isPlaying", isPlaying)
    put("positionMs", positionMs)
    put("bufferedPositionMs", bufferedPositionMs)
    put("durationMs", durationMs)
    put("rate", rate.toDouble())
    put("retainForBackground", retainForBackground)
    put("errorCode", errorCode)
    put("errorMessage", errorMessage)
    if (background != null) {
      put("surfaceAttached", background.surfaceAttachmentCount > 0)
      put("surfaceAttachmentCount", background.surfaceAttachmentCount)
      put("backgroundHostAttached", background.hostAttached)
      put("foregroundPlaybackRequested", background.foregroundPlaybackRequested)
    }
  }
}

data class MinutesBackgroundPlaybackState(
  val surfaceAttachmentCount: Int = 0,
  val hostAttached: Boolean = false,
  val foregroundPlaybackRequested: Boolean = false,
)

fun interface MinutesPlaybackListener {
  fun onPlaybackStateChanged(state: MinutesPlaybackState)
}

interface MinutesPlayerController {
  val state: MinutesPlaybackState

  fun setSource(source: MinutesPlayerSource?)
  fun play()
  fun pause()
  fun toggle()
  fun seekTo(positionMs: Long)
  fun seekBy(deltaMs: Long)
  fun setRate(rate: Float)
  fun addListener(listener: MinutesPlaybackListener)
  fun removeListener(listener: MinutesPlaybackListener)
  fun release()
}

interface MinutesBackgroundPlaybackHost {
  fun requestForegroundPlayback(state: MinutesPlaybackState)
  fun clearForegroundPlayback()
}

internal interface MinutesSessionConnection {
  val sessionConnected: Boolean
}

internal interface MinutesStorageScopeController {
  fun activateStorageScope(storageScope: String)
}

internal data class MinutesPlaybackFacts(
  val hasSource: Boolean,
  val isBuffering: Boolean = false,
  val isEnded: Boolean = false,
  val isPlaying: Boolean = false,
  val isReady: Boolean = false,
  val positionMs: Long = 0L,
  val hasError: Boolean = false,
)

internal fun resolveMinutesPlaybackPhase(facts: MinutesPlaybackFacts): MinutesPlaybackPhase = when {
  facts.hasError -> MinutesPlaybackPhase.FAILED
  !facts.hasSource -> MinutesPlaybackPhase.IDLE
  facts.isBuffering -> MinutesPlaybackPhase.PREPARING
  facts.isEnded -> MinutesPlaybackPhase.ENDED
  facts.isPlaying -> MinutesPlaybackPhase.PLAYING
  facts.isReady && facts.positionMs > 0L -> MinutesPlaybackPhase.PAUSED
  facts.isReady -> MinutesPlaybackPhase.READY
  else -> MinutesPlaybackPhase.PREPARING
}

internal fun resolveMinutesPlaybackRate(requestedRate: Float): Float =
  MINUTES_PLAYBACK_RATES.minByOrNull { abs(it - requestedRate) } ?: 1f

internal fun clampMinutesSeek(positionMs: Long, durationMs: Long): Long =
  if (durationMs > 0L) positionMs.coerceIn(0L, durationMs) else positionMs.coerceAtLeast(0L)
