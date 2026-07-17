package com.laoji.nativeplatform.media

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

object MinutesPlaybackRegistry {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val listeners = CopyOnWriteArraySet<MinutesPlaybackListener>()
  private var controller: MinutesPlayerController? = null
  private var backgroundHost: MinutesBackgroundPlaybackHost? = null
  private var surfaceAttachmentCount = 0
  private var foregroundPlaybackRequested = false

  private val relay = MinutesPlaybackListener { state ->
    updateBackgroundHost(state)
    listeners.forEach { it.onPlaybackStateChanged(state) }
  }

  @Synchronized
  fun controller(context: Context): MinutesPlayerController {
    val current = controller
    if (current != null) return current
    return MediaSessionMinutesPlayerController(context.applicationContext).also {
      controller = it
      it.addListener(relay)
    }
  }

  @Synchronized
  fun currentController(): MinutesPlayerController? = controller

  @Synchronized
  fun attachSurface() {
    surfaceAttachmentCount += 1
  }

  @Synchronized
  fun detachSurface() {
    surfaceAttachmentCount = (surfaceAttachmentCount - 1).coerceAtLeast(0)
    val current = controller ?: return
    if (surfaceAttachmentCount == 0 && !current.state.retainForBackground) {
      runOnMain {
        current.pause()
        current.setSource(null)
      }
    }
  }

  @Synchronized
  fun setBackgroundHost(host: MinutesBackgroundPlaybackHost?) {
    backgroundHost = host
    val state = controller?.state ?: MinutesPlaybackState()
    foregroundPlaybackRequested = state.isPlaying && state.retainForBackground
    if (host != null) {
      if (foregroundPlaybackRequested) host.requestForegroundPlayback(state) else host.clearForegroundPlayback()
    }
  }

  @Synchronized
  fun backgroundState(): MinutesBackgroundPlaybackState = MinutesBackgroundPlaybackState(
    surfaceAttachmentCount = surfaceAttachmentCount,
    hostAttached = backgroundHost != null || (controller as? MinutesSessionConnection)?.sessionConnected == true,
    foregroundPlaybackRequested = foregroundPlaybackRequested,
  )

  fun addListener(listener: MinutesPlaybackListener) {
    listeners.add(listener)
    controller?.state?.let(listener::onPlaybackStateChanged)
  }

  fun removeListener(listener: MinutesPlaybackListener) {
    listeners.remove(listener)
  }

  @Synchronized
  fun release() {
    val current = controller ?: return
    controller = null
    current.removeListener(relay)
    // Releasing the in-process MediaController does not release the service-owned player. Media3
    // keeps an ongoing MIN-PLAYER-001 session alive for lock-screen and notification controls.
    runOnMain { current.release() }
    foregroundPlaybackRequested = false
    backgroundHost?.clearForegroundPlayback()
  }

  @Synchronized
  private fun updateBackgroundHost(state: MinutesPlaybackState) {
    val shouldRequestForeground = state.isPlaying && state.retainForBackground
    if (foregroundPlaybackRequested == shouldRequestForeground) return
    foregroundPlaybackRequested = shouldRequestForeground
    val host = backgroundHost ?: return
    if (shouldRequestForeground) host.requestForegroundPlayback(state) else host.clearForegroundPlayback()
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
  }
}
