package com.laoji.nativeplatform.media

// MIN-PLAYER-001: notification, lock-screen, and in-page controls share one session.

import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executor

/** A single MediaController connection shared by the Expo module and every native surface. */
@UnstableApi
internal class MediaSessionMinutesPlayerController(context: Context) :
  MinutesPlayerController,
  MinutesSessionConnection,
  MinutesStorageScopeController {
  private val applicationContext = context.applicationContext
  private val mainHandler = Handler(Looper.getMainLooper())
  private val mainExecutor = Executor { command -> mainHandler.post(command) }
  private val listeners = CopyOnWriteArraySet<MinutesPlaybackListener>()
  private var mediaController: MediaController? = null
  private var desiredSource: MinutesPlayerSource? = null
  private var sourceWasExplicitlySet = false
  private var sourceGeneration = 0L
  private var activeSourceGeneration = 0L
  private var sourceCommandInFlight = false
  private var scopeCommandInFlight = false
  private var pendingStorageScope: String? = null
  private var storageScopeGeneration = 0L
  private var pendingPlayWhenReady: Boolean? = null
  private var pendingSeekMs: Long? = null
  private var pendingRate: Float? = null
  private var failureCode: String? = null
  private var failureMessage: String? = null
  private var released = false
  private var lastPublished = MinutesPlaybackState()

  override val state: MinutesPlaybackState
    get() = lastPublished

  override val sessionConnected: Boolean
    get() = mediaController != null && !released

  private val progressTicker = object : Runnable {
    override fun run() {
      if (released) return
      publish(force = false)
      if (lastPublished.isPlaying) mainHandler.postDelayed(this, POSITION_UPDATE_INTERVAL_MS)
    }
  }

  private val playerListener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      publish(force = true)
    }

    override fun onPlayerError(error: PlaybackException) {
      failureCode = error.errorCodeName
      failureMessage = "录音播放失败，请重试"
      publish(force = true)
    }
  }

  private val controllerListener = object : MediaController.Listener {
    override fun onDisconnected(controller: MediaController) {
      if (released) return
      controller.removeListener(playerListener)
      mediaController = null
      failureCode = "media_session_disconnected"
      failureMessage = "系统播放器连接已断开，请重试"
      restartProgressTicker(false)
      publish(force = true)
    }
  }

  private val controllerFuture = MediaController.Builder(
    applicationContext,
    SessionToken(
      applicationContext,
      ComponentName(applicationContext, LaojiMinutesPlaybackService::class.java),
    ),
  )
    .setApplicationLooper(Looper.getMainLooper())
    .setListener(controllerListener)
    .buildAsync()

  init {
    controllerFuture.addListener(
      {
        if (released) return@addListener
        try {
          val connectedController = controllerFuture.get()
          mediaController = connectedController
          connectedController.addListener(playerListener)
          failureCode = null
          failureMessage = null
          if (pendingStorageScope != null) {
            sendStorageScopeCommand(connectedController, pendingStorageScope!!, storageScopeGeneration)
          } else if (sourceWasExplicitlySet) {
            sendSourceCommand(connectedController, desiredSource, sourceGeneration)
          } else {
            applyPendingCommands(connectedController)
          }
          publish(force = true)
        } catch (_: Exception) {
          failureCode = "media_session_unavailable"
          failureMessage = "系统播放器暂时不可用，请重试"
          publish(force = true)
        }
      },
      mainExecutor,
    )
  }

  override fun setSource(source: MinutesPlayerSource?) {
    checkMainThread()
    if (released) return
    if (!shouldDispatchMinutesSourceCommand(
        desiredSource = desiredSource,
        nextSource = source,
        sourceWasExplicitlySet = sourceWasExplicitlySet,
        sourceCommandInFlight = sourceCommandInFlight,
        hasFailure = failureCode != null,
      )) {
      return
    }
    desiredSource = source
    sourceWasExplicitlySet = true
    sourceGeneration += 1L
    failureCode = null
    failureMessage = null
    if (!scopeCommandInFlight) mediaController?.let { sendSourceCommand(it, source, sourceGeneration) }
    publish(force = true)
  }

  override fun activateStorageScope(storageScope: String) {
    checkMainThread()
    if (released) return
    val normalized = requireNotNull(normalizeMinutesActiveStorageScope(storageScope)) {
      "Invalid Minutes playback storage scope"
    }
    pendingStorageScope = normalized
    storageScopeGeneration += 1L
    if (desiredSource?.storageScope != normalized) {
      desiredSource = null
      sourceWasExplicitlySet = false
      sourceGeneration += 1L
      // The storage-scope command now owns the transition. A result from the invalidated source
      // command must not leave pending play/seek/rate commands blocked forever.
      activeSourceGeneration = sourceGeneration
      sourceCommandInFlight = false
    }
    mediaController?.let { sendStorageScopeCommand(it, normalized, storageScopeGeneration) }
  }

  override fun play() {
    checkMainThread()
    if (released) return
    pendingPlayWhenReady = true
    mediaController?.let(::applyPendingCommands)
  }

  override fun pause() {
    checkMainThread()
    if (released) return
    pendingPlayWhenReady = false
    mediaController?.let(::applyPendingCommands)
  }

  override fun toggle() {
    checkMainThread()
    if (state.isPlaying) pause() else play()
  }

  override fun seekTo(positionMs: Long) {
    checkMainThread()
    if (released) return
    pendingSeekMs = clampMinutesSeek(positionMs, state.durationMs)
    mediaController?.let(::applyPendingCommands)
  }

  override fun seekBy(deltaMs: Long) {
    seekTo(state.positionMs + deltaMs)
  }

  override fun setRate(rate: Float) {
    checkMainThread()
    if (released) return
    pendingRate = resolveMinutesPlaybackRate(rate)
    mediaController?.let(::applyPendingCommands)
  }

  override fun addListener(listener: MinutesPlaybackListener) {
    listeners.add(listener)
    listener.onPlaybackStateChanged(lastPublished)
  }

  override fun removeListener(listener: MinutesPlaybackListener) {
    listeners.remove(listener)
  }

  override fun release() {
    checkMainThread()
    if (released) return
    released = true
    restartProgressTicker(false)
    mediaController?.removeListener(playerListener)
    mediaController = null
    MediaController.releaseFuture(controllerFuture)
    listeners.clear()
  }

  private fun sendSourceCommand(
    controller: MediaController,
    source: MinutesPlayerSource?,
    generation: Long,
  ) {
    if (scopeCommandInFlight) return
    activeSourceGeneration = generation
    sourceCommandInFlight = true
    val command = if (source == null) MINUTES_CLEAR_SOURCE_COMMAND else MINUTES_SET_SOURCE_COMMAND
    val resultFuture = controller.sendCustomCommand(command, source?.toSessionArguments() ?: Bundle.EMPTY)
    resultFuture.addListener(
      {
        if (released || !isCurrentMinutesSourceCommandResult(
            resultGeneration = generation,
            desiredGeneration = sourceGeneration,
            activeGeneration = activeSourceGeneration,
          )) {
          return@addListener
        }
        sourceCommandInFlight = false
        val result = runCatching { resultFuture.get() }.getOrNull()
        if (result?.resultCode == SessionResult.RESULT_SUCCESS) {
          failureCode = null
          failureMessage = null
          publish(force = true)
          applyPendingCommands(controller)
        } else {
          failureCode = "media_source_rejected"
          failureMessage = "录音文件无法加载，请重试"
          publish(force = true)
        }
      },
      mainExecutor,
    )
  }

  private fun sendStorageScopeCommand(
    controller: MediaController,
    storageScope: String,
    generation: Long,
  ) {
    scopeCommandInFlight = true
    val resultFuture = controller.sendCustomCommand(
      MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND,
      minutesStorageScopeArguments(storageScope),
    )
    resultFuture.addListener(
      {
        if (released || storageScopeGeneration != generation) return@addListener
        scopeCommandInFlight = false
        val result = runCatching { resultFuture.get() }.getOrNull()
        if (result?.resultCode == SessionResult.RESULT_SUCCESS) {
          pendingStorageScope = null
          failureCode = null
          failureMessage = null
          if (sourceWasExplicitlySet) {
            sendSourceCommand(controller, desiredSource, sourceGeneration)
          } else {
            applyPendingCommands(controller)
          }
          publish(force = true)
        } else {
          failureCode = "media_scope_rejected"
          failureMessage = "播放器账号状态无法确认，请重新登录"
          publish(force = true)
        }
      },
      mainExecutor,
    )
  }

  private fun applyPendingCommands(controller: MediaController) {
    if (released || sourceCommandInFlight || scopeCommandInFlight) return
    pendingRate?.let {
      controller.setPlaybackSpeed(it)
      pendingRate = null
    }
    pendingSeekMs?.let {
      controller.seekTo(clampMinutesSeek(it, effectiveDurationMs(controller)))
      pendingSeekMs = null
    }
    pendingPlayWhenReady?.let { shouldPlay ->
      if (shouldPlay) {
        if (controller.playbackState == Player.STATE_ENDED) controller.seekTo(0L)
        if (controller.playbackState == Player.STATE_IDLE) controller.prepare()
        controller.play()
      } else {
        controller.pause()
      }
      pendingPlayWhenReady = null
    }
  }

  private fun publish(force: Boolean) {
    if (released) return
    val next = snapshot()
    if (!force && next == lastPublished) return
    val playbackActivityChanged = next.isPlaying != lastPublished.isPlaying
    lastPublished = next
    if (playbackActivityChanged) restartProgressTicker(next.isPlaying)
    listeners.forEach { it.onPlaybackStateChanged(next) }
  }

  private fun snapshot(): MinutesPlaybackState {
    val controller = mediaController
    if (controller == null) {
      val source = desiredSource
      return MinutesPlaybackState(
        sourceId = source?.sourceId,
        phase = when {
          failureCode != null -> MinutesPlaybackPhase.FAILED
          source != null -> MinutesPlaybackPhase.PREPARING
          else -> MinutesPlaybackPhase.IDLE
        },
        durationMs = source?.durationMsHint?.coerceAtLeast(0L) ?: 0L,
        rate = pendingRate ?: 1f,
        retainForBackground = source?.retainForBackground ?: true,
        errorCode = failureCode,
        errorMessage = failureMessage,
      )
    }

    val mediaItem = controller.currentMediaItem
    val explicitClearPending = sourceWasExplicitlySet && desiredSource == null && sourceCommandInFlight
    val transitioningToSource = sourceCommandInFlight && desiredSource != null &&
      mediaItem?.mediaId != desiredSource?.sourceId
    val sourceId = if (explicitClearPending) null else mediaItem?.mediaId ?: desiredSource?.sourceId
    val metadataExtras = mediaItem?.mediaMetadata?.extras
    val durationMs = effectiveDurationMs(controller)
    val phase = resolveMinutesPlaybackPhase(
      MinutesPlaybackFacts(
        hasSource = sourceId != null,
        isBuffering = transitioningToSource || controller.playbackState == Player.STATE_BUFFERING,
        isEnded = controller.playbackState == Player.STATE_ENDED,
        isPlaying = controller.isPlaying,
        isReady = controller.playbackState == Player.STATE_READY,
        positionMs = controller.currentPosition,
        hasError = failureCode != null || controller.playerError != null,
      ),
    )
    return MinutesPlaybackState(
      sourceId = sourceId,
      phase = phase,
      isPlaying = controller.isPlaying,
      positionMs = controller.currentPosition.coerceAtLeast(0L),
      bufferedPositionMs = controller.bufferedPosition.coerceAtLeast(0L),
      durationMs = durationMs,
      rate = controller.playbackParameters.speed,
      retainForBackground = desiredSource
        ?.takeIf { it.sourceId == sourceId }
        ?.retainForBackground
        ?: metadataExtras.retainForBackground(),
      errorCode = failureCode ?: controller.playerError?.errorCodeName,
      errorMessage = failureMessage ?: controller.playerError?.let { "录音播放失败，请重试" },
    )
  }

  private fun effectiveDurationMs(controller: MediaController): Long {
    val reportedDuration = controller.duration
    if (reportedDuration != C.TIME_UNSET && reportedDuration > 0L) return reportedDuration
    val mediaHint = controller.currentMediaItem?.mediaMetadata?.extras.durationMsHint()
    if (mediaHint > 0L) return mediaHint
    return desiredSource?.durationMsHint?.coerceAtLeast(0L) ?: 0L
  }

  private fun restartProgressTicker(isPlaying: Boolean) {
    mainHandler.removeCallbacks(progressTicker)
    if (isPlaying && !released) mainHandler.postDelayed(progressTicker, POSITION_UPDATE_INTERVAL_MS)
  }

  private fun checkMainThread() {
    check(Looper.myLooper() == Looper.getMainLooper()) {
      "Minutes media-session commands must run on the Android main thread"
    }
  }

  companion object {
    private const val POSITION_UPDATE_INTERVAL_MS = 500L
  }
}
