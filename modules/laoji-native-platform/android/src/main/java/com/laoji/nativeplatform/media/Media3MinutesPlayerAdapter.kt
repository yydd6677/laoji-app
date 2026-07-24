package com.laoji.nativeplatform.media

// MIN-PLAYER-001 / MIN-PLAYER-RECOVERY-001: sole ExoPlayer owner and durable paused recovery.

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import java.util.concurrent.CopyOnWriteArraySet

/** The only concrete player owner. Production creates it only inside [LaojiMinutesPlaybackService]. */
internal class Media3MinutesPlayerAdapter(
  context: Context,
  private val recoveryStore: MinutesPlaybackRecoveryStore = EncryptedMinutesPlaybackStore(context),
  initialStorageScope: String = MinutesPlaybackScopeStore(context).activeScope(),
  private val nowEpochMs: () -> Long = System::currentTimeMillis,
  private val elapsedRealtimeMs: () -> Long = SystemClock::elapsedRealtime,
) : MinutesPlayerController, MinutesStorageScopeController {
  private val applicationContext = context.applicationContext
  private val mainHandler = Handler(Looper.getMainLooper())
  private val listeners = CopyOnWriteArraySet<MinutesPlaybackListener>()
  private val httpDataSourceFactory = DefaultHttpDataSource.Factory()
    .setUserAgent("LaoJi-Minutes/1")
    .setAllowCrossProtocolRedirects(false)
  private val mediaSourceFactory = DefaultMediaSourceFactory(
    DefaultDataSource.Factory(applicationContext, httpDataSourceFactory),
  )
  private val recoveryPolicy = MinutesPlaybackRecoveryPolicy(
    AndroidMinutesLocalSourceAccess(applicationContext),
  )
  private val progressThrottle = MinutesPlaybackProgressThrottle()
  private val player = ExoPlayer.Builder(applicationContext)
    .setMediaSourceFactory(mediaSourceFactory)
    .setSeekBackIncrementMs(MINUTES_SKIP_INTERVAL_MS)
    .setSeekForwardIncrementMs(MINUTES_SKIP_INTERVAL_MS)
    .setAudioAttributes(
      AudioAttributes.Builder()
        .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
        .setUsage(C.USAGE_MEDIA)
        .build(),
      true,
    )
    .setHandleAudioBecomingNoisy(true)
    .setWakeMode(C.WAKE_MODE_LOCAL)
    .build()
  internal val sessionPlayer: Player
    get() = player
  private var source: MinutesPlayerSource? = null
  private var activeStorageScope = normalizeMinutesActiveStorageScope(initialStorageScope)
    ?: MINUTES_SIGNED_OUT_SCOPE
  private var released = false
  private var restoring = false
  private var lastPublished = MinutesPlaybackState()

  override val state: MinutesPlaybackState
    get() = snapshot()

  private val progressTicker = object : Runnable {
    override fun run() {
      if (released) return
      publish(force = false)
      persist(force = false)
      if (player.isPlaying) mainHandler.postDelayed(this, POSITION_UPDATE_INTERVAL_MS)
    }
  }

  private val playerListener = object : Player.Listener {
    override fun onPlaybackStateChanged(playbackState: Int) {
      publish(force = true)
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      mainHandler.removeCallbacks(progressTicker)
      publish(force = true)
      persist(force = true)
      if (isPlaying) mainHandler.post(progressTicker)
    }

    override fun onPlayerError(error: PlaybackException) {
      publish(force = true, error = error)
    }

    override fun onPlaybackParametersChanged(playbackParameters: androidx.media3.common.PlaybackParameters) {
      publish(force = true)
      persist(force = true)
    }

    override fun onPositionDiscontinuity(
      oldPosition: Player.PositionInfo,
      newPosition: Player.PositionInfo,
      reason: Int,
    ) {
      publish(force = true)
      persist(force = true, positionOverrideMs = newPosition.positionMs)
    }
  }

  init {
    player.addListener(playerListener)
    restorePersistedPlayback()
  }

  override fun setSource(source: MinutesPlayerSource?) {
    setSourceChecked(source)
  }

  internal fun setSourceChecked(nextSource: MinutesPlayerSource?): Boolean {
    checkMainThread()
    if (released) return false
    if (nextSource == null) {
      clearSource()
      return true
    }
    if (!recoveryPolicy.canPersist(nextSource, activeStorageScope, nowEpochMs())) {
      clearSource()
      return false
    }
    if (source == nextSource && player.mediaItemCount > 0) {
      persist(force = true)
      return true
    }

    val previous = source
    val preserveState = canPreserveMinutesPlaybackState(
      previousSource = previous,
      nextSource = nextSource,
      hasMediaItem = player.mediaItemCount > 0,
    )
    val preservedPositionMs = if (preserveState) player.currentPosition.coerceAtLeast(0L) else 0L
    val preservePlaying = preserveState && player.isPlaying
    source = nextSource
    configureRequestHeaders(nextSource)
    player.setMediaItem(mediaItem(nextSource), preservedPositionMs)
    player.playWhenReady = preservePlaying
    player.prepare()
    if (!preservePlaying) player.pause()
    persist(force = true, positionOverrideMs = preservedPositionMs)
    publish(force = true)
    return true
  }

  override fun activateStorageScope(storageScope: String) {
    checkMainThread()
    if (released) return
    val normalized = requireNotNull(normalizeMinutesActiveStorageScope(storageScope)) {
      "Invalid Minutes playback storage scope"
    }
    if (normalized == activeStorageScope) {
      if (normalized == MINUTES_SIGNED_OUT_SCOPE && source != null) clearSource()
      return
    }
    activeStorageScope = normalized
    clearSource()
  }

  override fun play() {
    checkMainThread()
    if (released || source == null) return
    if (player.playbackState == Player.STATE_ENDED) player.seekTo(0L)
    if (player.playbackState == Player.STATE_IDLE) player.prepare()
    player.play()
    persist(force = true)
  }

  override fun pause() {
    checkMainThread()
    if (released) return
    player.pause()
    persist(force = true)
  }

  override fun toggle() {
    checkMainThread()
    if (player.isPlaying) pause() else play()
  }

  override fun seekTo(positionMs: Long) {
    checkMainThread()
    if (released || source == null) return
    val target = clampMinutesSeek(positionMs, effectiveDurationMs())
    player.seekTo(target)
    persist(force = true, positionOverrideMs = target)
    publish(force = true)
  }

  override fun seekBy(deltaMs: Long) {
    seekTo(player.currentPosition + deltaMs)
  }

  override fun setRate(rate: Float) {
    checkMainThread()
    if (released) return
    player.setPlaybackSpeed(resolveMinutesPlaybackRate(rate))
    persist(force = true)
    publish(force = true)
  }

  override fun addListener(listener: MinutesPlaybackListener) {
    listeners.add(listener)
    listener.onPlaybackStateChanged(snapshot())
  }

  override fun removeListener(listener: MinutesPlaybackListener) {
    listeners.remove(listener)
  }

  override fun release() {
    checkMainThread()
    if (released) return
    released = true
    mainHandler.removeCallbacks(progressTicker)
    player.removeListener(playerListener)
    player.release()
    listeners.clear()
    source = null
  }

  private fun restorePersistedPlayback() {
    if (activeStorageScope == MINUTES_SIGNED_OUT_SCOPE) {
      recoveryStore.clear()
      return
    }
    val record = recoveryStore.load(activeStorageScope) ?: return
    restoring = true
    try {
      source = record.source
      configureRequestHeaders(record.source)
      player.setMediaItem(mediaItem(record.source), record.positionMs.coerceAtLeast(0L))
      player.setPlaybackSpeed(resolveMinutesPlaybackRate(record.rate))
      player.playWhenReady = false
      player.prepare()
      player.pause()
      progressThrottle.markPersisted(elapsedRealtimeMs(), record.positionMs)
      lastPublished = snapshot()
    } catch (_: Exception) {
      source = null
      player.stop()
      player.clearMediaItems()
      recoveryStore.clear()
      progressThrottle.reset()
    } finally {
      restoring = false
    }
  }

  private fun clearSource() {
    player.pause()
    source = null
    player.stop()
    player.clearMediaItems()
    recoveryStore.clear()
    progressThrottle.reset()
    publish(force = true)
  }

  private fun persist(force: Boolean, positionOverrideMs: Long? = null) {
    if (released || restoring) return
    val currentSource = source ?: return
    if (currentSource.storageScope != activeStorageScope) {
      clearSource()
      return
    }
    val elapsedNow = elapsedRealtimeMs()
    val positionMs = (positionOverrideMs ?: player.currentPosition).coerceAtLeast(0L)
    if (!force && !progressThrottle.shouldPersist(elapsedNow, positionMs)) return
    val saved = recoveryStore.save(
      MinutesPlaybackRecoveryRecord(
        source = currentSource,
        positionMs = positionMs,
        rate = resolveMinutesPlaybackRate(player.playbackParameters.speed),
        wasPlaying = player.isPlaying,
        savedAtEpochMs = nowEpochMs(),
      ),
    )
    if (saved) progressThrottle.markPersisted(elapsedNow, positionMs)
  }

  private fun configureRequestHeaders(source: MinutesPlayerSource) {
    httpDataSourceFactory.setDefaultRequestProperties(source.headers)
  }

  private fun mediaItem(source: MinutesPlayerSource): MediaItem = MediaItem.Builder()
    .setMediaId(source.sourceId)
    .setUri(source.uri)
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setTitle(source.title.ifBlank { "会议录音" })
        .setArtist("老记")
        .setExtras(source.toPlaybackMetadataExtras())
        .build(),
    )
    .build()

  private fun publish(force: Boolean, error: PlaybackException? = player.playerError) {
    val next = snapshot(error)
    if (!force && next == lastPublished) return
    lastPublished = next
    listeners.forEach { it.onPlaybackStateChanged(next) }
  }

  private fun snapshot(error: PlaybackException? = player.playerError): MinutesPlaybackState {
    if (released) return MinutesPlaybackState()
    val currentSource = source
    val phase = resolveMinutesPlaybackPhase(
      MinutesPlaybackFacts(
        hasSource = currentSource != null,
        isBuffering = player.playbackState == Player.STATE_BUFFERING,
        isEnded = player.playbackState == Player.STATE_ENDED,
        isPlaying = player.isPlaying,
        isReady = player.playbackState == Player.STATE_READY,
        positionMs = player.currentPosition,
        hasError = error != null,
      ),
    )
    return MinutesPlaybackState(
      sourceId = currentSource?.sourceId,
      phase = phase,
      isPlaying = player.isPlaying,
      positionMs = player.currentPosition.coerceAtLeast(0L),
      bufferedPositionMs = player.bufferedPosition.coerceAtLeast(0L),
      durationMs = effectiveDurationMs(),
      rate = player.playbackParameters.speed,
      retainForBackground = currentSource?.retainForBackground ?: true,
      errorCode = error?.errorCodeName,
      errorMessage = if (error == null) null else "录音播放失败，请重试",
    )
  }

  private fun effectiveDurationMs(): Long {
    val reported = player.duration
    return when {
      reported != C.TIME_UNSET && reported > 0L -> reported
      else -> source?.durationMsHint?.coerceAtLeast(0L) ?: 0L
    }
  }

  private fun checkMainThread() {
    check(Looper.myLooper() == Looper.getMainLooper()) {
      "Minutes player commands must run on the Android main thread"
    }
  }

  companion object {
    private const val POSITION_UPDATE_INTERVAL_MS = 500L
  }
}
