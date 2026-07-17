package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001: source-mapped native detail surface.

import android.app.Dialog
import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.viewpager2.widget.ViewPager2
import com.laoji.nativeplatform.media.MinutesPlaybackState
import com.laoji.nativeplatform.media.MinutesPlayerView

internal interface MinutesDetailPlayerOwner {
  val view: View
  fun setSource(source: MinutesPlayerSource?)
  fun seekTo(positionMs: Long)
}

private class ProductionMinutesDetailPlayerOwner(
  context: Context,
  onPlaybackState: (MinutesPlaybackState) -> Unit,
) : MinutesDetailPlayerOwner {
  private val player = MinutesPlayerView(context, onPlaybackState)
  override val view: View = player
  override fun setSource(source: MinutesPlayerSource?) = player.setSource(source)
  override fun seekTo(positionMs: Long) = player.seekTo(positionMs)
}

internal class MinutesDetailSurface(
  context: Context,
  private val onAction: (Map<String, Any?>) -> Unit,
  onPlaybackState: (MinutesPlaybackState) -> Unit,
  playerOwnerFactory: (Context, (MinutesPlaybackState) -> Unit) -> MinutesDetailPlayerOwner =
    ::ProductionMinutesDetailPlayerOwner,
) : LinearLayout(context) {
  internal val titleBar = MinutesTitleBar(context)
  internal val audioHeader = LinearLayout(context)
  internal val stickyLayout = MinutesDetailStickyLayout(context)
  internal val detailPager = ViewPager2(context)
  private val playerOwner = playerOwnerFactory(context, onPlaybackState)
  internal val player: View = playerOwner.view
  internal val audioNotice: TextView = context.textView(textSizeSp = 13, color = MinutesPalette.secondary)

  private val title = context.textView(textSizeSp = 24, weight = Typeface.BOLD)
  private val dateTime = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val pagerAdapter = MinutesDetailPagerAdapter(context, ::handleContentAction)
  private val tabBar = MinutesDetailTabBar(context, ::requestUserTab)
  private val viewStateStore = MinutesDetailViewStateStore(context)
  private var renderedState = MinutesDetailState()
  private var pendingTabCommand: TabCommand? = null
  private var localTabGeneration = 0
  private var renderedMeetingId = ""
  private var titleDialog: Dialog? = null
  private var titleDialogSaveAction: View? = null
  private var consumedTitleEditRequestId = 0
  private val persistRunnable = Runnable { persistViewState(synchronous = false) }

  internal val titleEditorShowing: Boolean
    get() = titleDialog?.isShowing == true

  internal val activeTitleDialogSaveAction: View?
    get() = titleDialogSaveAction

  private data class TabCommand(
    val generation: Int,
    val target: MinutesDetailTab,
    val emit: Boolean,
  )

  init {
    orientation = VERTICAL
    setBackgroundColor(MinutesPalette.surface)
    addView(
      titleBar,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(MinutesDetailLayoutContract.TITLE_BAR_HEIGHT_DP)),
    )

    audioHeader.orientation = VERTICAL
    audioHeader.setPadding(
      context.dp(MinutesDetailLayoutContract.HEADER_HORIZONTAL_PADDING_DP),
      context.dp(MinutesDetailLayoutContract.HEADER_TOP_PADDING_DP),
      context.dp(MinutesDetailLayoutContract.HEADER_HORIZONTAL_PADDING_DP),
      context.dp(MinutesDetailLayoutContract.HEADER_BOTTOM_PADDING_DP),
    )
    title.maxLines = 2
    title.isClickable = true
    title.isFocusable = true
    title.contentDescription = "编辑会议标题"
    title.setOnClickListener { showTitleEditor() }
    audioHeader.addView(title, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    audioHeader.addView(
      dateTime,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = context.dp(MinutesDetailLayoutContract.SUBTITLE_TOP_MARGIN_DP)
      },
    )

    detailPager.adapter = pagerAdapter
    detailPager.retainAllMinutesDetailPages()
    detailPager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
      override fun onPageScrollStateChanged(state: Int) {
        if (state == ViewPager2.SCROLL_STATE_DRAGGING) pendingTabCommand = null
        if (state == ViewPager2.SCROLL_STATE_IDLE) pendingTabCommand?.let(::finishTabCommandWhenSettled)
      }

      override fun onPageSelected(position: Int) {
        val tab = MinutesDetailLayoutContract.tabAt(position)
        val command = pendingTabCommand
        if (command != null) {
          if (command.target != tab || detailPager.currentItem != MinutesDetailLayoutContract.tabIndex(command.target)) return
          commitTabSelection(tab, command.generation, emit = false)
          finishTabCommandWhenSettled(command)
          return
        }
        if (tab != renderedState.activeTab) {
          commitTabSelection(tab, nextTabGeneration(), emit = true)
        }
      }
    })
    stickyLayout.setOwners(audioHeader, tabBar, detailPager)
    stickyLayout.setListener(object : MinutesDetailStickyListener {
      override fun onCollapseOffsetChanged(offsetPx: Int) = schedulePersistViewState()
    })
    pagerAdapter.setScrollStateListener(::schedulePersistViewState)
    addView(stickyLayout, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

    audioNotice.gravity = Gravity.CENTER
    audioNotice.setPadding(context.dp(16), context.dp(8), context.dp(16), context.dp(8))
    audioNotice.visibility = View.GONE
    addView(audioNotice, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

    // Feishu owns the audio toolbar outside the sticky container. WRAP_CONTENT lets the player
    // measure its real controls and system inset instead of imposing the old 100dp surface slot.
    addView(player, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    tabBar.select(MinutesDetailTab.TRANSCRIPT)
  }

  fun render(state: MinutesDetailState) {
    val meetingChanged = renderedMeetingId != state.meetingId
    if (meetingChanged) {
      persistViewState(synchronous = true)
      renderedMeetingId = state.meetingId
      pendingTabCommand = null
      consumedTitleEditRequestId = 0
    }
    val persisted = if (meetingChanged) viewStateStore.read(state.meetingId) else null
    val restoredTab = persisted?.activeTab?.takeUnless { state.activeTabIsExplicit }
    val incomingTabFresh = meetingChanged ||
      state.tabGeneration > renderedState.tabGeneration ||
      (state.tabGeneration == renderedState.tabGeneration && state.activeTab == renderedState.activeTab)
    val acceptedTab = when {
      restoredTab != null -> restoredTab
      incomingTabFresh -> state.activeTab
      else -> renderedState.activeTab
    }
    val acceptedGeneration = when {
      restoredTab != null && restoredTab != state.activeTab -> nextGenerationAfter(state.tabGeneration, persisted.tabGeneration)
      restoredTab != null -> maxOf(state.tabGeneration, persisted.tabGeneration)
      incomingTabFresh -> state.tabGeneration
      else -> renderedState.tabGeneration
    }
    localTabGeneration = maxOf(localTabGeneration, acceptedGeneration)
    renderedState = state.selectTab(acceptedTab, acceptedGeneration)
    if (titleDialog?.isShowing == true && (!state.available || meetingChanged)) titleDialog?.dismiss()
    titleBar.configure(
      title = "",
      showBack = true,
      showShare = renderedState.available && renderedState.canShare,
      showMore = renderedState.available,
      shareEnabled = renderedState.available && renderedState.canShare,
      onAction = { onAction(mapOf("type" to it, "meetingId" to renderedState.meetingId)) },
    )
    title.text = renderedState.title
    title.isClickable = renderedState.available
    title.isFocusable = renderedState.available
    title.contentDescription = if (renderedState.available) "编辑会议标题" else null
    dateTime.text = renderedState.dateTimeLabel
    dateTime.visibility = if (renderedState.dateTimeLabel.isBlank()) View.GONE else View.VISIBLE
    renderAudioState(renderedState)
    pagerAdapter.render(renderedState)
    issueTabCommand(
      tab = acceptedTab,
      generation = acceptedGeneration,
      smoothScroll = false,
      emit = restoredTab != null && restoredTab != state.activeTab,
    )
    if (persisted != null) {
      post {
        stickyLayout.restoreHeaderCollapseOffset(persisted.headerCollapseOffsetPx)
        pagerAdapter.restoreScrollPositions(persisted)
      }
    }
    if (renderedState.available && renderedState.titleEditRequestId > consumedTitleEditRequestId) {
      consumedTitleEditRequestId = renderedState.titleEditRequestId
      post { showTitleEditor() }
    }
  }

  internal fun pageFor(tab: MinutesDetailTab): MinutesDetailPage = pagerAdapter.pageFor(tab)

  private fun requestUserTab(tab: MinutesDetailTab) {
    if (tab == renderedState.activeTab && detailPager.currentItem == MinutesDetailLayoutContract.tabIndex(tab)) return
    issueTabCommand(tab, nextTabGeneration(), smoothScroll = true, emit = true)
  }

  private fun issueTabCommand(
    tab: MinutesDetailTab,
    generation: Int,
    smoothScroll: Boolean,
    emit: Boolean,
  ) {
    if (generation < renderedState.tabGeneration) return
    tabBar.select(tab)
    val target = MinutesDetailLayoutContract.tabIndex(tab)
    if (detailPager.currentItem == target) {
      pendingTabCommand = null
      commitTabSelection(tab, generation, emit)
      return
    }
    pendingTabCommand = TabCommand(generation, tab, emit)
    detailPager.setCurrentItem(target, smoothScroll)
  }

  private fun commitTabSelection(tab: MinutesDetailTab, generation: Int, emit: Boolean) {
    if (generation < renderedState.tabGeneration) return
    renderedState = renderedState.selectTab(tab, generation)
    localTabGeneration = maxOf(localTabGeneration, generation)
    tabBar.select(tab)
    schedulePersistViewState()
    if (emit) emitTabSelection(tab, generation)
  }

  private fun finishTabCommandWhenSettled(command: TabCommand) {
    post {
      if (pendingTabCommand != command) return@post
      if (detailPager.scrollState != ViewPager2.SCROLL_STATE_IDLE) return@post
      if (detailPager.currentItem != MinutesDetailLayoutContract.tabIndex(command.target)) return@post
      pendingTabCommand = null
      commitTabSelection(command.target, command.generation, command.emit)
    }
  }

  private fun nextTabGeneration(): Int {
    localTabGeneration = maxOf(localTabGeneration, renderedState.tabGeneration)
    localTabGeneration = if (localTabGeneration == Int.MAX_VALUE) Int.MAX_VALUE else localTabGeneration + 1
    return localTabGeneration
  }

  private fun nextGenerationAfter(first: Int, second: Int): Int {
    val value = maxOf(first, second).coerceAtLeast(0)
    return if (value == Int.MAX_VALUE) Int.MAX_VALUE else value + 1
  }

  private fun emitTabSelection(tab: MinutesDetailTab, generation: Int) {
    onAction(
      mapOf(
        "type" to "selectDetailTab",
        "meetingId" to renderedState.meetingId,
        "tab" to tab.wireName,
        "selectionGeneration" to generation,
      ),
    )
  }

  private fun renderAudioState(state: MinutesDetailState) {
    playerOwner.setSource(state.playerSource)
    val message = state.audioErrorMessage.ifBlank { state.audioStatusMessage }
    audioNotice.text = message
    audioNotice.setTextColor(if (state.audioErrorMessage.isNotBlank()) MinutesPalette.danger else MinutesPalette.secondary)
    audioNotice.backgroundShape(
      if (state.audioErrorMessage.isNotBlank()) MinutesPalette.dangerSoft else MinutesPalette.page,
    )
    audioNotice.contentDescription = message.takeIf { it.isNotBlank() }
    audioNotice.visibility = if (message.isBlank()) View.GONE else View.VISIBLE
  }

  private fun schedulePersistViewState() {
    removeCallbacks(persistRunnable)
    postDelayed(persistRunnable, VIEW_STATE_WRITE_DELAY_MS)
  }

  internal fun persistViewStateNow() {
    persistViewState(synchronous = true)
  }

  private fun persistViewState(synchronous: Boolean) {
    removeCallbacks(persistRunnable)
    val meetingId = renderedState.meetingId
    if (meetingId.isBlank()) return
    val scroll = pagerAdapter.captureScrollPositions()
    viewStateStore.write(
      meetingId,
      MinutesDetailPersistedViewState(
        activeTab = renderedState.activeTab,
        tabGeneration = renderedState.tabGeneration,
        headerCollapseOffsetPx = stickyLayout.headerCollapseOffsetPx,
        transcript = requireNotNull(scroll[MinutesDetailTab.TRANSCRIPT]),
        summary = requireNotNull(scroll[MinutesDetailTab.SUMMARY]),
        speakers = requireNotNull(scroll[MinutesDetailTab.SPEAKERS]),
      ),
      synchronous = synchronous,
    )
  }

  private fun handleContentAction(action: Map<String, Any?>) {
    if (action["type"] == "seekTranscript") {
      (action["positionMs"] as? Number)?.toLong()?.let(playerOwner::seekTo)
    }
    onAction(action + mapOf("meetingId" to renderedState.meetingId))
  }

  private fun showTitleEditor() {
    if (!renderedState.available || !isAttachedToWindow || renderedState.meetingId.isBlank() || titleDialog?.isShowing == true) return
    val dialog = Dialog(context)
    val dialogMeetingId = renderedState.meetingId
    val panel = LinearLayout(context).apply {
      orientation = VERTICAL
      setPadding(context.dp(20), context.dp(18), context.dp(20), context.dp(12))
      backgroundShape(MinutesPalette.surface, radiusDp = 6)
    }
    panel.addView(
      context.textView("修改标题", 17, MinutesPalette.text, Typeface.BOLD).apply { gravity = Gravity.CENTER },
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(28)),
    )
    val input = EditText(context).apply {
      setText(renderedState.title)
      setSelection(text.length)
      setTextSize(16f)
      setTextColor(MinutesPalette.text)
      setHintTextColor(MinutesPalette.faint)
      hint = "输入会议标题"
      maxLines = 2
      backgroundShape(MinutesPalette.page, radiusDp = 6)
      setPadding(context.dp(12), context.dp(8), context.dp(12), context.dp(8))
    }
    panel.addView(input, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(52)).apply { topMargin = context.dp(14) })
    val error = context.textView(textSizeSp = 12, color = MinutesPalette.danger).apply {
      gravity = Gravity.CENTER_VERTICAL
      visibility = View.INVISIBLE
    }
    panel.addView(error, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(28)))
    val actions = LinearLayout(context).apply { orientation = HORIZONTAL }
    val cancel = context.textView("取消", 16, MinutesPalette.text).apply {
      gravity = Gravity.CENTER
      isClickable = true
      isFocusable = true
      setOnClickListener { dialog.dismiss() }
    }
    val save = context.textView("保存", 16, MinutesPalette.primary, Typeface.BOLD).apply {
      gravity = Gravity.CENTER
      isClickable = true
      isFocusable = true
      setOnClickListener {
        if (!renderedState.available || renderedState.meetingId != dialogMeetingId) {
          dialog.dismiss()
          return@setOnClickListener
        }
        val value = input.text.toString().trim()
        if (value.isBlank()) {
          error.text = "标题不能为空"
          error.visibility = View.VISIBLE
          return@setOnClickListener
        }
        onAction(mapOf("type" to "saveTitle", "meetingId" to renderedState.meetingId, "title" to value))
        dialog.dismiss()
      }
    }
    titleDialogSaveAction = save
    actions.addView(cancel, LayoutParams(0, context.dp(48), 1f))
    actions.addView(save, LayoutParams(0, context.dp(48), 1f))
    panel.addView(actions, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(48)))

    dialog.setContentView(panel)
    dialog.setCanceledOnTouchOutside(true)
    dialog.setOnDismissListener {
      titleDialog = null
      titleDialogSaveAction = null
    }
    dialog.window?.apply {
      setBackgroundDrawable(ColorDrawable(android.graphics.Color.TRANSPARENT))
      addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      attributes = attributes.apply { dimAmount = 0.42f }
      setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    }
    titleDialog = dialog
    dialog.show()
    val width = (context.resources.displayMetrics.widthPixels - context.dp(56)).coerceAtMost(context.dp(360))
    dialog.window?.setLayout(width, ViewGroup.LayoutParams.WRAP_CONTENT)
    input.post {
      input.requestFocus()
      (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
        ?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
    }
  }

  override fun onDetachedFromWindow() {
    persistViewState(synchronous = true)
    titleDialog?.dismiss()
    titleDialog = null
    titleDialogSaveAction = null
    super.onDetachedFromWindow()
  }

  private companion object {
    const val VIEW_STATE_WRITE_DELAY_MS = 120L
  }
}
