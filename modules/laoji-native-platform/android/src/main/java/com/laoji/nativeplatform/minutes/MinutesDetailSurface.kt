package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001: source-mapped native detail surface.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ImageView
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

  private val titleContainer = FrameLayout(context)
  private val title = context.textView(textSizeSp = 24, weight = Typeface.BOLD)
  private val titleEditor = EditText(context)
  private val subtitleRow = LinearLayout(context)
  private val dateTimeIcon = ImageView(context)
  private val dateTime = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val pagerAdapter = MinutesDetailPagerAdapter(context, ::handleContentAction)
  private val tabBar = MinutesDetailTabBar(context, ::requestUserTab)
  private val viewStateStore = MinutesDetailViewStateStore(context)
  private var renderedState = MinutesDetailState()
  private var pendingTabCommand: TabCommand? = null
  private var localTabGeneration = 0
  private var renderedMeetingId = ""
  private var editingTitle = false
  private var consumedTitleEditRequestId = 0
  private val persistRunnable = Runnable { persistViewState(synchronous = false) }

  internal val titleEditorShowing: Boolean
    get() = editingTitle

  internal val activeTitleDialogSaveAction: View?
    get() = titleBar.activeDoneAction

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
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dpRounded(MinutesDetailLayoutContract.TITLE_BAR_HEIGHT_DP)),
    )

    audioHeader.orientation = VERTICAL
    audioHeader.setPadding(
      context.dpRounded(MinutesDetailLayoutContract.HEADER_HORIZONTAL_PADDING_DP),
      context.dpRounded(MinutesDetailLayoutContract.HEADER_TOP_PADDING_DP),
      context.dpRounded(MinutesDetailLayoutContract.HEADER_HORIZONTAL_PADDING_DP),
      context.dpRounded(MinutesDetailLayoutContract.HEADER_BOTTOM_PADDING_DP),
    )
    title.maxLines = 2
    title.isClickable = true
    title.isFocusable = true
    title.contentDescription = "编辑会议标题"
    title.setOnClickListener { beginTitleEdit() }
    titleContainer.addView(
      title,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    titleEditor.apply {
      setTextSize(24f)
      setTextColor(MinutesPalette.text)
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      background = null
      setPadding(0, 0, 0, 0)
      maxLines = 2
      imeOptions = EditorInfo.IME_ACTION_SEND
      visibility = View.GONE
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == EditorInfo.IME_ACTION_SEND || actionId == EditorInfo.IME_ACTION_DONE) {
          finishTitleEdit(save = true)
          true
        } else {
          false
        }
      }
      addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = Unit
        override fun afterTextChanged(value: Editable?) {
          if (editingTitle) {
            titleBar.setEditDirty(value.toString().trim() != renderedState.title)
          }
        }
      })
    }
    titleContainer.addView(
      titleEditor,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    audioHeader.addView(titleContainer, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    subtitleRow.orientation = HORIZONTAL
    subtitleRow.gravity = Gravity.CENTER_VERTICAL
    dateTimeIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_time_outline)
    dateTimeIcon.imageTintList = ColorStateList.valueOf(MinutesPalette.secondary)
    dateTimeIcon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    subtitleRow.addView(dateTimeIcon, LayoutParams(context.dpRounded(12), context.dpRounded(12)))
    subtitleRow.addView(
      dateTime,
      LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dpRounded(22)).apply {
        leftMargin = context.dpRounded(4)
      },
    )
    audioHeader.addView(
      subtitleRow,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dpRounded(22)).apply {
        topMargin = context.dpRounded(MinutesDetailLayoutContract.SUBTITLE_TOP_MARGIN_DP)
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
    if (editingTitle && (!state.available || meetingChanged)) finishTitleEdit(save = false)
    configureTitleBar()
    if (!editingTitle) title.text = renderedState.title.ifBlank { "未命名会议" }
    title.isClickable = renderedState.available
    title.isFocusable = renderedState.available
    title.contentDescription = if (renderedState.available) "编辑会议标题" else null
    dateTime.text = renderedState.dateTimeLabel
    subtitleRow.visibility = if (renderedState.dateTimeLabel.isBlank()) View.GONE else View.VISIBLE
    renderAudioState(renderedState)
    pagerAdapter.render(renderedState)
    tabBar.render(renderedState)
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
      post { beginTitleEdit() }
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
        info = requireNotNull(scroll[MinutesDetailTab.INFO]),
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

  private fun configureTitleBar() {
    titleBar.configure(
      title = if (editingTitle) renderedState.title else "",
      showBack = !editingTitle,
      showShare = !editingTitle && renderedState.available && renderedState.canShare,
      showMore = !editingTitle && renderedState.available,
      shareEnabled = renderedState.available && renderedState.canShare,
      showDone = editingTitle,
      onAction = { action ->
        if (action == "done") finishTitleEdit(save = true)
        else onAction(mapOf("type" to action, "meetingId" to renderedState.meetingId))
      },
    )
  }

  private fun beginTitleEdit() {
    if (!renderedState.available || !isAttachedToWindow || renderedState.meetingId.isBlank() || editingTitle) return
    editingTitle = true
    titleEditor.setText(renderedState.title)
    titleEditor.setSelection(titleEditor.text.length)
    title.visibility = View.INVISIBLE
    titleEditor.visibility = View.VISIBLE
    configureTitleBar()
    titleBar.setEditDirty(false)
    titleEditor.post {
      titleEditor.requestFocus()
      (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
        ?.showSoftInput(titleEditor, InputMethodManager.SHOW_IMPLICIT)
    }
  }

  private fun finishTitleEdit(save: Boolean) {
    if (!editingTitle) return
    val value = titleEditor.text.toString().trim()
    val shouldSave = save && value != renderedState.title && isAttachedToWindow
    if (shouldSave) {
      title.text = value.ifBlank { "未命名会议" }
      onAction(mapOf("type" to "saveTitle", "meetingId" to renderedState.meetingId, "title" to value))
    } else {
      title.text = renderedState.title.ifBlank { "未命名会议" }
    }
    editingTitle = false
    titleEditor.clearFocus()
    titleEditor.visibility = View.GONE
    title.visibility = View.VISIBLE
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
      ?.hideSoftInputFromWindow(windowToken, 0)
    configureTitleBar()
  }

  override fun onDetachedFromWindow() {
    persistViewState(synchronous = true)
    finishTitleEdit(save = false)
    super.onDetachedFromWindow()
  }

  private companion object {
    const val VIEW_STATE_WRITE_DELAY_MS = 120L
  }
}
