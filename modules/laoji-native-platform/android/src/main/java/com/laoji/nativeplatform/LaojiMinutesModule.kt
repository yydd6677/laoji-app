package com.laoji.nativeplatform

// MIN-ROOT-001 / MIN-PLAYER-001: Minutes view and playback commands share one native module.

import com.laoji.nativeplatform.media.MINUTES_PLAYBACK_RATES
import com.laoji.nativeplatform.media.MinutesPlaybackListener
import com.laoji.nativeplatform.media.MinutesPlaybackRegistry
import com.laoji.nativeplatform.media.MinutesPlaybackScopeStore
import com.laoji.nativeplatform.media.MinutesStorageScopeController
import com.laoji.nativeplatform.media.normalizeMinutesActiveStorageScope
import com.laoji.nativeplatform.minutes.LaojiMinutesView
import com.laoji.nativeplatform.minutes.MINUTES_SNAPSHOT_SCHEMA_VERSION
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LaojiMinutesModule : Module() {
  private val playbackListener = MinutesPlaybackListener { state ->
    sendEvent(
      "onPlaybackStateChanged",
      state.toEventMap(MinutesPlaybackRegistry.backgroundState()),
    )
  }

  override fun definition() = ModuleDefinition {
    Name("LaojiMinutes")

    Constant("snapshotSchemaVersion") { MINUTES_SNAPSHOT_SCHEMA_VERSION }
    Constant("supportedPlaybackRates") { MINUTES_PLAYBACK_RATES.map(Float::toDouble) }
    Events("onPlaybackStateChanged")

    OnCreate {
      MinutesPlaybackRegistry.addListener(playbackListener)
    }

    OnDestroy {
      MinutesPlaybackRegistry.removeListener(playbackListener)
      MinutesPlaybackRegistry.release()
    }

    View(LaojiMinutesView::class) {
      Events("onMinutesAction", "onPlaybackStateChange", "onTabPress")

      Prop("surface", "list") { view: LaojiMinutesView, surface: String ->
        view.setSurface(surface)
      }

      Prop("snapshot") { view: LaojiMinutesView, snapshot: Map<String, Any?> ->
        view.setSnapshot(snapshot)
      }

      OnViewDidUpdateProps<LaojiMinutesView> { view ->
        view.commitProps()
      }
    }

    AsyncFunction("getPlaybackState") {
      val state = MinutesPlaybackRegistry.currentController()?.state
      (state ?: com.laoji.nativeplatform.media.MinutesPlaybackState())
        .toEventMap(MinutesPlaybackRegistry.backgroundState())
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("play") {
      MinutesPlaybackRegistry.currentController()?.play()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pause") {
      MinutesPlaybackRegistry.currentController()?.pause()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("seekTo") { positionMs: Double ->
      MinutesPlaybackRegistry.currentController()?.seekTo(positionMs.toLong())
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("seekBy") { deltaMs: Double ->
      MinutesPlaybackRegistry.currentController()?.seekBy(deltaMs.toLong())
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setPlaybackRate") { rate: Double ->
      MinutesPlaybackRegistry.currentController()?.setRate(rate.toFloat())
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("activatePlaybackStorageScope") { storageScope: String ->
      val normalized = requireNotNull(normalizeMinutesActiveStorageScope(storageScope)) {
        "Invalid Minutes playback storage scope"
      }
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("Android application context is unavailable")
      MinutesPlaybackScopeStore(context).activate(normalized)
      (MinutesPlaybackRegistry.controller(context) as? MinutesStorageScopeController)
        ?.activateStorageScope(normalized)
    }.runOnQueue(Queues.MAIN)
  }
}
