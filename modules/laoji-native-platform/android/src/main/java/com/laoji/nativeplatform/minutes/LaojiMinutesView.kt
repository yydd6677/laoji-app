package com.laoji.nativeplatform.minutes

// MIN-ROOT-001 / MIN-DETAIL-001 / UI-ANDROID-COMPOSITION-001: one exported host owns each surface tree.

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import com.laoji.nativeplatform.media.MinutesPlaybackRegistry
import com.laoji.nativeplatform.media.MinutesPlaybackState
import com.laoji.nativeplatform.evidence.FeishuEvidence
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
  @FeishuEvidence("UI-SHELL-BOTTOM-MAIN-001")
  private val bottomBar = LaojiNativeBottomBarView(context, appContext).apply {
    visibility = View.GONE
    setBridgeEventsEnabled(false)
    setSelectedTab(NativeBottomTab.MEETINGS.wireName)
    setTabPressListener { tab ->
      onTabPress(mapOf("type" to "tabPress", "tab" to tab.wireName))
    }
  }
  private var surfaceName = MinutesSurface.LIST.wireName
  private var snapshot: Map<String, Any?> = emptyMap()
  private var profileEntrySnapshot: Map<String, Any?> = emptyMap()
  private var surfaceView: View? = null
  private var renderedSurface: MinutesSurface? = null

  init {
    // MIN-ROOT-001: Let the Android-owned surface render its complete child hierarchy.
    setWillNotDraw(false)
    clipToPadding = false
    orientation = VERTICAL
    clipChildren = true
    setBackgroundColor(MinutesPalette.surface)
    installStatusBarInsetPadding { surfaceName == MinutesSurface.LIST.wireName }
    addView(content, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    addView(bottomBar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
  }

  fun setSurface(value: String) {
    surfaceName = value
    bottomBar.visibility = if (value == MinutesSurface.LIST.wireName) View.VISIBLE else View.GONE
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
    bottomBar.setSelectionAnimationCommand(command)
  }

  fun commitProps() {
    val parsed = MinutesSnapshotParser.parse(snapshot, surfaceName)
    render(store.dispatch(MinutesStateMutation.Replace(parsed)))
  }

  private fun render(state: MinutesUiState) {
    if (renderedSurface != state.surface || surfaceView == null) {
      content.removeAllViews()
      renderedSurface = state.surface
      surfaceView = when (state.surface) {
        MinutesSurface.LIST -> MinutesListSurface(context, appContext, ::handleAction)
        MinutesSurface.RECORDING -> MinutesRecordingSurface(context, ::handleAction)
        MinutesSurface.DETAIL -> MinutesDetailSurface(context, ::handleAction, ::handlePlaybackState)
      }
      content.addView(
        surfaceView,
        FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
      )
    }
    bottomBar.visibility = if (state.surface == MinutesSurface.LIST) View.VISIBLE else View.GONE
    when (val view = surfaceView) {
      is MinutesListSurface -> {
        view.setProfileEntrySnapshot(profileEntrySnapshot)
        view.render(state.list)
      }
      is MinutesRecordingSurface -> view.render(state.recording)
      is MinutesDetailSurface -> view.render(state.detail)
    }
  }

  private fun handleAction(action: Map<String, Any?>) {
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
    onMinutesAction(action + mapOf("surface" to store.state.surface.wireName))
  }

  private fun handlePlaybackState(state: MinutesPlaybackState) {
    onPlaybackStateChange(state.toEventMap(MinutesPlaybackRegistry.backgroundState()))
  }

}
