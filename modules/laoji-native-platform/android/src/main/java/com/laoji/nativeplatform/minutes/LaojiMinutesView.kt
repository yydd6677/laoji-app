package com.laoji.nativeplatform.minutes

// MIN-ROOT-001 / MIN-DETAIL-001 / UI-ANDROID-COMPOSITION-001: one exported host owns each surface tree.

import android.content.Context
import android.os.Trace
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.recyclerview.widget.RecyclerView
import com.laoji.nativeplatform.media.MinutesPlaybackRegistry
import com.laoji.nativeplatform.media.MinutesPlaybackState
import com.laoji.nativeplatform.projection.ProjectionEnvelope
import com.laoji.nativeplatform.ui.LaojiNativeBottomBarView
import com.laoji.nativeplatform.ui.NativeBottomTab
import com.laoji.nativeplatform.ui.installStatusBarInsetPadding
import com.laoji.nativeplatform.ui.requestInsetsWhenAttached
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class LaojiMinutesView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  private val onMinutesAction by EventDispatcher<Map<String, Any?>>()
  private val onPlaybackStateChange by EventDispatcher<Map<String, Any?>> { 0.toShort() }
  private val onTabPress by EventDispatcher<Map<String, Any?>>()
  private val store = MinutesStateStore()
  private val content = FrameLayout(context)
  private var bottomBar: LaojiNativeBottomBarView? = null
  private var bottomBarSelectionCommand: Int? = null
  private var surfaceName = MinutesSurface.LIST.wireName
  private var snapshot: Map<String, Any?> = emptyMap()
  private var profileEntrySnapshot: Map<String, Any?> = emptyMap()
  private var surfaceView: View? = null
  private var renderedSurface: MinutesSurface? = null

  init {
    // MIN-ROOT-001: Let the Android-owned surface render its complete child hierarchy.
    MinutesPalette.configure(context)
    setWillNotDraw(false)
    clipToPadding = false
    orientation = VERTICAL
    clipChildren = true
    minutesBackgroundColor { MinutesPalette.surface }
    installStatusBarInsetPadding()
    addView(content, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
  }

  fun setSurface(value: String) {
    surfaceName = value
    updateBottomBar(value == MinutesSurface.LIST.wireName)
    requestInsetsWhenAttached()
  }

  fun setSnapshot(value: Map<String, Any?>) {
    snapshot = value
  }

  fun setProfileEntrySnapshot(value: Map<String, Any?>) {
    profileEntrySnapshot = value
    (surfaceView as? MinutesListSurface)?.setProfileEntrySnapshot(value)
  }

  fun setBottomBarSelectionCommand(command: Int?) {
    bottomBarSelectionCommand = command
    bottomBar?.setSelectionAnimationCommand(command)
  }

  fun commitProps() {
    val parsed = traceMinutes("LaoJi/minutes.parse") { MinutesSnapshotParser.parse(snapshot, surfaceName) }
    val previous = store.state
    val next = store.dispatch(MinutesStateMutation.Replace(parsed))
    // Projection-only commits and rejected stale snapshots do not change the
    // visible surface. Rendering them used to make a tab selection traverse
    // all five mounted detail pages twice: once for the native selection and
    // again when React returned the same body with a projection envelope.
    // Keep the new envelope in the store for action fencing, but do no view
    // work unless the selected surface's actual render state changed.
    if (
      surfaceView != null
      && renderedSurface == next.surface
      && sameVisibleSurface(previous, next)
    ) return
    traceMinutes("LaoJi/minutes.render") { render(next) }
  }

  private fun updateBottomBar(visible: Boolean) {
    if (visible && bottomBar == null) {
      bottomBar = LaojiNativeBottomBarView(context, appContext).apply {
        setBridgeEventsEnabled(false)
        setSelectedTab(NativeBottomTab.MEETINGS.wireName)
        setSelectionAnimationCommand(bottomBarSelectionCommand)
        setTabPressListener { tab -> onTabPress(mapOf("type" to "tabPress", "tab" to tab.wireName)) }
        this@LaojiMinutesView.addView(this,
          LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      }
    }
    bottomBar?.visibility = if (visible) View.VISIBLE else View.GONE
  }

  private fun sameVisibleSurface(previous: MinutesUiState, next: MinutesUiState): Boolean {
    if (previous.surface != next.surface) return false
    return when (next.surface) {
      MinutesSurface.LIST -> previous.list == next.list
      MinutesSurface.RECORDING -> previous.recording == next.recording
      MinutesSurface.DETAIL -> previous.detail == next.detail
    }
  }

  private fun render(state: MinutesUiState) {
    if (renderedSurface != state.surface || surfaceView == null) {
      // Recording finalization can publish the reconciled transcript and switch
      // surfaces in the same React commit. Detach RecyclerView adapters before
      // removing the old native tree so an in-flight DiffUtil result cannot try
      // to recycle a row that is still attached to the disappearing surface.
      prepareForSurfaceReplacement(surfaceView)
      content.removeAllViews()
      renderedSurface = state.surface
      surfaceView = traceMinutes("LaoJi/minutes.create.${state.surface.wireName}") {
        when (state.surface) {
          MinutesSurface.LIST -> MinutesListSurface(context, appContext, ::handleAction)
          MinutesSurface.RECORDING -> MinutesRecordingSurface(context, ::handleAction)
          MinutesSurface.DETAIL -> MinutesDetailSurface(context, ::handleAction, ::handlePlaybackState)
        }
      }
      content.addView(
        surfaceView,
        FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
      )
    }
    updateBottomBar(state.surface == MinutesSurface.LIST)
    when (val view = surfaceView) {
      is MinutesListSurface -> {
        view.setProfileEntrySnapshot(profileEntrySnapshot)
        view.render(state.list)
      }
      is MinutesRecordingSurface -> view.render(state.recording)
      is MinutesDetailSurface -> view.render(state.detail)
    }
  }

  private fun prepareForSurfaceReplacement(view: View?) {
    when (view) {
      is RecyclerView -> {
        view.stopScroll()
        view.itemAnimator?.endAnimations()
        view.itemAnimator = null
        view.adapter = null
      }
      is ViewGroup -> {
        for (index in 0 until view.childCount) {
          prepareForSurfaceReplacement(view.getChildAt(index))
        }
      }
    }
  }

  private fun handleAction(action: Map<String, Any?>) {
    val currentProjection = store.state.projection
    val actionProjection = (action["projection"] as? Map<*, *>)
      ?.entries
      ?.mapNotNull { (key, value) -> (key as? String)?.let { it to value } }
      ?.toMap()
      ?.let(ProjectionEnvelope::fromMap)
    if (currentProjection != null && action.containsKey("projection")
      && action["projection"] != null && actionProjection == null) return
    if (currentProjection != null && actionProjection != null
      && !currentProjection.sameIdentity(actionProjection)) return
    if (action["type"] == "search" && surfaceView is MinutesDetailSurface) {
      val transcriptPage = (surfaceView as MinutesDetailSurface).pageFor(MinutesDetailTab.TRANSCRIPT)
        as MinutesTranscriptPage
      transcriptPage.setSearchVisible(true)
      return
    }
    when (action["type"]) {
      "selectDetailTab" -> {
        val tab = MinutesDetailTab.fromWireName(action["tab"] as? String)
        val generation = (action["selectionGeneration"] as? Number)?.toInt() ?: 0
        if (!store.dispatchIfAccepted(MinutesStateMutation.SelectDetailTab(tab, generation))) return
      }
      "setFollowLatest" -> {
        store.dispatch(MinutesStateMutation.SetFollowLatest(action["followLatest"] as? Boolean ?: true))
      }
    }
    val projectionPayload = currentProjection?.let {
      mapOf(
        "deviceEpoch" to it.deviceEpoch,
        "entityId" to it.entityId,
        "entityRevision" to it.entityRevision,
        "viewRevision" to it.viewRevision,
        "surfaceInstanceId" to it.surfaceInstanceId,
        "payloadSha256" to it.payloadSha256,
      )
    }
    onMinutesAction(action + buildMap {
      put("surface", store.state.surface.wireName)
      if (projectionPayload != null) put("projection", projectionPayload)
    })
  }

  private fun handlePlaybackState(state: MinutesPlaybackState) {
    onPlaybackStateChange(state.toEventMap(MinutesPlaybackRegistry.backgroundState()))
  }

}

internal inline fun <T> traceMinutes(name: String, block: () -> T): T {
  Trace.beginSection(name)
  return try { block() } finally { Trace.endSection() }
}
