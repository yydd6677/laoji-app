package com.laoji.nativeplatform.minutes

import android.content.Context
import android.graphics.Typeface
import android.content.res.ColorStateList
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.ImageView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.StaggeredGridLayoutManager
import android.text.Editable
import android.text.TextWatcher
import expo.modules.kotlin.AppContext

internal class MinutesListSurface(
  context: Context,
  appContext: AppContext,
  private val onAction: (Map<String, Any?>) -> Unit,
) : LinearLayout(context) {
  private val titleBar = MinutesMainTitleBar(context, appContext)
  private val searchBar = LinearLayout(context)
  private val searchBack = context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back, "退出搜索")
  private val searchInput = EditText(context)
  private val searchClear = context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_close, "清除搜索")
  private val content = FrameLayout(context)
  private val list = RecyclerView(context)
  private val itemContextMenu = MinutesItemContextMenu(context, onAction)
  private val mainMenu = MinutesMainMenu(context, onAction)
  private var viewMode = MinutesHomeViewMode.GRID
  private val adapter = MinutesMeetingAdapter(onAction, itemContextMenu::show)
  private val reorderController = MinutesMeetingReorderController(
    list = list,
    adapter = adapter,
    viewMode = { viewMode },
    showContextMenu = itemContextMenu::show,
    dismissContextMenu = itemContextMenu::dismiss,
    onOrderChanged = { meetingIds ->
      onAction(mapOf("type" to "reorderMeetings", "meetingIds" to meetingIds))
    },
  )
  private val stateOverlay = LinearLayout(context)
  private val progress = ProgressBar(context)
  private val emptyImage = ImageView(context)
  private val stateMessage = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val retryButton = context.textView("重试", 16, MinutesPalette.primary, Typeface.BOLD)
  private val cachedError = LinearLayout(context)
  private val cachedMessage = context.textView(textSizeSp = 14, color = MinutesPalette.danger)
  private val cachedRetry = context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_refresh, "重新同步会议记录")
  // [SOURCE] Feishu Minutes uses upload + record in one 64dp bottom operation host.
  private val operationHost = LinearLayout(context)
  private val uploadButton = LinearLayout(context)
  private val uploadIcon = ImageView(context)
  private val uploadProgress = ProgressBar(context, null, android.R.attr.progressBarStyleSmall)
  private val uploadLabel = context.textView("上传", 16, MinutesPalette.text)
  private val recordButton = LinearLayout(context)
  private val recordIcon = ImageView(context)
  private val recordLabel = context.textView("录音", 16, MinutesPalette.surface)
  private var renderingSearch = false
  private var wasSearching = false
  private var renderedTitle = "会议记录"
  // Meeting home opens in the two-column cover grid; the list is an
  // explicit secondary mode exposed by the trailing switch icon.
  private var recycleBin = false
  private var canOpenRecycleBin = false
  private var mainListFirstVisible = 0
  private var pendingMainListScrollRestore: Int? = null

  fun setProfileEntrySnapshot(snapshot: Map<String, Any?>) {
    titleBar.setProfileEntrySnapshot(snapshot)
  }

  init {
    orientation = VERTICAL
    setBackgroundColor(MinutesPalette.page)
    addView(titleBar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(44)))
    configureSearchBar()
    addView(searchBar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(44)))
    addView(content, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

    adapter.setViewMode(viewMode)
    list.layoutManager = createGridLayoutManager()
    list.adapter = adapter
    // List refreshes and recording completion can add/move a cover in the same
    // frame that the surface is being replaced. The product does not rely on
    // RecyclerView's default change animation, and disabling it avoids delayed
    // recycling of an attached cover during that hand-off.
    list.itemAnimator = null
    list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING) {
          MinutesSwipeMenuLayout.closeOpenMenu()
          itemContextMenu.dismiss()
          mainMenu.dismiss()
        }
      }
    })
    list.clipToPadding = false
    applyListPadding()
    list.setBackgroundColor(MinutesPalette.page)
    list.overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    content.addView(list, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    stateOverlay.orientation = VERTICAL
    stateOverlay.gravity = Gravity.CENTER
    stateOverlay.setPadding(context.dp(24), context.dp(24), context.dp(24), context.dp(24))
    emptyImage.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_minutes_empty)
    emptyImage.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    stateOverlay.addView(emptyImage, LayoutParams(context.dp(100), context.dp(100)))
    stateMessage.gravity = Gravity.CENTER
    stateMessage.setLineSpacing(0f, 1.25f)
    stateOverlay.addView(progress, LayoutParams(context.dp(24), context.dp(24)))
    stateOverlay.addView(
      stateMessage,
      LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = context.dp(16)
      },
    )
    retryButton.gravity = Gravity.CENTER
    retryButton.isClickable = true
    retryButton.isFocusable = true
    retryButton.contentDescription = "重试加载会议记录"
    retryButton.setOnClickListener { onAction(mapOf("type" to "refreshMeetings")) }
    stateOverlay.addView(
      retryButton,
      LayoutParams(context.dp(76), context.dp(36)).apply { topMargin = context.dp(18) },
    )
    content.addView(
      stateOverlay,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )

    cachedError.orientation = HORIZONTAL
    cachedError.gravity = Gravity.CENTER_VERTICAL
    cachedError.setPadding(context.dp(12), 0, context.dp(4), 0)
    cachedError.backgroundShape(MinutesPalette.dangerSoft)
    cachedError.addView(cachedMessage, LayoutParams(0, context.dp(44), 1f).apply {
      gravity = Gravity.CENTER_VERTICAL
    })
    cachedRetry.setOnClickListener { onAction(mapOf("type" to "refreshMeetings")) }
    cachedError.addView(cachedRetry, LayoutParams(context.dp(44), context.dp(44)))
    content.addView(
      cachedError,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(44), Gravity.TOP).apply {
        topMargin = context.dp(12)
        leftMargin = context.dp(12)
        rightMargin = context.dp(12)
      },
    )
    operationHost.orientation = HORIZONTAL
    operationHost.gravity = Gravity.CENTER
    operationHost.setPadding(context.dp(10), 0, context.dp(10), 0)

    uploadButton.orientation = HORIZONTAL
    uploadButton.gravity = Gravity.CENTER
    uploadButton.minimumWidth = context.dp(88)
    uploadButton.setPadding(context.dp(10), 0, context.dp(10), 0)
    uploadButton.background = context.roundedStateBackground(
      defaultColor = MinutesPalette.surface,
      pressedColor = MinutesPalette.filler,
      disabledColor = MinutesPalette.surface,
      radiusDp = 24,
    )
    uploadButton.elevation = context.dp(2).toFloat()
    uploadButton.isClickable = true
    uploadButton.isFocusable = true
    uploadButton.contentDescription = "导入会议录音"
    uploadButton.setOnClickListener { onAction(mapOf("type" to "importMedia")) }
    uploadIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_share_outline)
    uploadIcon.imageTintList = statefulIconTint(
      MinutesPalette.text,
      MinutesPalette.text,
      MinutesPalette.disabled,
    )
    uploadIcon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    uploadProgress.indeterminateTintList = ColorStateList.valueOf(MinutesPalette.secondary)
    uploadProgress.visibility = View.GONE
    uploadButton.addView(uploadIcon, LayoutParams(context.dp(16), context.dp(16)))
    uploadButton.addView(uploadProgress, LayoutParams(context.dp(16), context.dp(16)))
    uploadLabel.setTextColor(statefulIconTint(
      MinutesPalette.text,
      MinutesPalette.text,
      MinutesPalette.disabled,
    ))
    uploadButton.addView(uploadLabel, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(24)).apply {
      leftMargin = context.dp(4)
    })
    operationHost.addView(uploadButton, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44)))

    recordButton.orientation = HORIZONTAL
    recordButton.gravity = Gravity.CENTER
    recordButton.minimumWidth = context.dp(88)
    recordButton.setPadding(context.dp(12), 0, context.dp(12), 0)
    recordButton.backgroundHorizontalGradient(
      startColor = MinutesPalette.recordGradientStart,
      endColor = MinutesPalette.recordGradientEnd,
      radiusDp = 24,
    )
    // [SOURCE] Feishu UDShadow.S.Down is a 6dp blur with a 2dp downward offset and an
    // 8% neutral shadow. Native elevation 2 is the closest platform rendering
    // without introducing a second custom shadow owner.
    recordButton.elevation = context.dp(2).toFloat()
    recordButton.isClickable = true
    recordButton.isFocusable = true
    recordButton.contentDescription = "开始录音"
    recordButton.setOnClickListener { onAction(mapOf("type" to "startRecording")) }
    recordIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_microphone_ai_outlined)
    recordIcon.imageTintList = ColorStateList.valueOf(MinutesPalette.surface)
    recordIcon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    recordButton.addView(recordIcon, LayoutParams(context.dp(16), context.dp(16)))
    recordButton.addView(recordLabel, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(24)).apply {
      leftMargin = context.dp(4)
    })
    operationHost.addView(
      recordButton,
      LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44)).apply {
        leftMargin = context.dp(8)
      },
    )
    content.addView(
      operationHost,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(64), Gravity.BOTTOM).apply {
        bottomMargin = context.dp(16)
      },
    )
  }

  fun render(state: MinutesListState) {
    val nextRecycleBin = state.mode == MinutesListMode.RECYCLE_BIN
    canOpenRecycleBin = state.canOpenRecycleBin
    if (nextRecycleBin != recycleBin) {
      if (nextRecycleBin) mainListFirstVisible = firstVisiblePosition()
      recycleBin = nextRecycleBin
      if (recycleBin) {
        pendingMainListScrollRestore = null
        applyViewMode(MinutesHomeViewMode.LIST, 0)
      } else {
        pendingMainListScrollRestore = mainListFirstVisible
        applyViewMode(viewMode)
      }
    }
    renderedTitle = state.title
    titleBar.configure(
      state.title,
      if (recycleBin) MinutesHomeViewMode.LIST else viewMode,
      recycleBin,
      state.canEmptyRecycleBin,
      state.recycleBinEmptying,
    ) { action ->
      if (action == "toggleViewMode") toggleViewMode()
      else if (action == "more") mainMenu.show(titleBar.moreAnchor(), canOpenRecycleBin)
      else onAction(mapOf("type" to action))
    }
    titleBar.visibility = if (state.searching) View.GONE else View.VISIBLE
    if (state.searching || recycleBin) mainMenu.dismiss()
    searchBar.visibility = if (state.searching) View.VISIBLE else View.GONE
    renderingSearch = true
    // While the native EditText owns focus, React snapshots trail the latest
    // keystroke by one bridge round-trip. Reapplying that stale query here
    // drops characters during normal typing. Synchronize on entry/exit and
    // when the field is not actively owned by the user instead.
    val shouldSynchronizeQuery = !state.searching || !wasSearching || !searchInput.hasFocus()
    if (shouldSynchronizeQuery && searchInput.text.toString() != state.query) {
      searchInput.setText(state.query)
      searchInput.setSelection(searchInput.text.length)
    }
    renderingSearch = false
    if (state.searching && !wasSearching) {
      searchInput.post {
        if (!isAttachedToWindow || searchBar.visibility != View.VISIBLE) return@post
        searchInput.requestFocus()
        searchInput.setSelection(searchInput.text.length)
        context.getSystemService(InputMethodManager::class.java)
          ?.showSoftInput(searchInput, InputMethodManager.SHOW_IMPLICIT)
      }
    } else if (!state.searching && wasSearching) {
      searchInput.clearFocus()
      context.getSystemService(InputMethodManager::class.java)
        ?.hideSoftInputFromWindow(searchInput.windowToken, 0)
    }
    wasSearching = state.searching
    searchClear.visibility = if (state.query.isBlank()) View.INVISIBLE else View.VISIBLE
    val normalizedQuery = state.query.trim()
    val visibleMeetings = if (normalizedQuery.isBlank()) state.meetings else state.meetings.filter {
      it.searchSource.isNotBlank()
        || it.title.contains(normalizedQuery, ignoreCase = true)
        || it.dateTimeLabel.contains(normalizedQuery, ignoreCase = true)
        || it.statusLabel.contains(normalizedQuery, ignoreCase = true)
        || it.supportText.contains(normalizedQuery, ignoreCase = true)
    }
    reorderController.setCanReorder(
      state.canReorder && !state.searching && !recycleBin && normalizedQuery.isBlank(),
    )
    adapter.submitList(visibleMeetings) {
      pendingMainListScrollRestore?.let { position ->
        pendingMainListScrollRestore = null
        list.scrollToPosition(position.coerceAtLeast(0))
      }
    }

    val showBlockingState = state.meetings.isEmpty() && state.phase != MinutesContentPhase.READY
    val showNoSearchResults = state.searching && normalizedQuery.isNotBlank() &&
      state.meetings.isNotEmpty() && visibleMeetings.isEmpty()
    val showStateOverlay = showBlockingState || state.meetings.isEmpty() || showNoSearchResults
    list.visibility = if (showStateOverlay) View.INVISIBLE else View.VISIBLE
    stateOverlay.visibility = if (showStateOverlay) View.VISIBLE else View.GONE
    progress.visibility = if (!showNoSearchResults && state.phase == MinutesContentPhase.LOADING) View.VISIBLE else View.GONE
    emptyImage.visibility = if (
      showNoSearchResults || state.phase == MinutesContentPhase.READY || state.phase == MinutesContentPhase.EMPTY
    ) View.VISIBLE else View.GONE
    retryButton.visibility = if (!showNoSearchResults && state.phase == MinutesContentPhase.ERROR) View.VISIBLE else View.GONE
    stateMessage.text = if (showNoSearchResults) {
      "未找到相关会议记录"
    } else state.message.ifBlank {
      when (state.phase) {
        MinutesContentPhase.LOADING -> "正在加载会议记录"
        MinutesContentPhase.ERROR -> "会议记录服务暂时不可用"
        else -> if (recycleBin) "回收站为空" else "暂无会议记录"
      }
    }
    cachedError.visibility = if (
      !state.searching && state.meetings.isNotEmpty() && state.showingCachedData && state.phase == MinutesContentPhase.ERROR
    ) {
      View.VISIBLE
    } else {
      View.GONE
    }
    cachedMessage.text = state.message.ifBlank { "同步失败，正在显示本机缓存" }
    applyListPadding(
      topPadding = when {
        cachedError.visibility == View.VISIBLE -> context.dp(56)
        else -> context.dp(12)
      },
    )
    operationHost.visibility = if (state.searching || recycleBin) View.GONE else View.VISIBLE
    uploadButton.isEnabled = !state.mediaImporting
    uploadIcon.visibility = if (state.mediaImporting) View.GONE else View.VISIBLE
    uploadProgress.visibility = if (state.mediaImporting) View.VISIBLE else View.GONE
    uploadButton.contentDescription = if (state.mediaImporting) {
      state.mediaImportStatusLabel.ifBlank { "录音导入暂时繁忙" }
    } else {
      "导入会议录音"
    }
  }

  private fun toggleViewMode() {
    if (recycleBin) return
    itemContextMenu.dismiss()
    mainMenu.dismiss()
    val firstVisible = firstVisiblePosition()
    viewMode = if (viewMode == MinutesHomeViewMode.LIST) MinutesHomeViewMode.GRID else MinutesHomeViewMode.LIST
    applyViewMode(viewMode, firstVisible)
    titleBar.configure(
      renderedTitle,
      viewMode,
      recycleBin = false,
      canEmptyRecycleBin = false,
      recycleBinEmptying = false,
    ) { action ->
      if (action == "toggleViewMode") toggleViewMode()
      else if (action == "more") mainMenu.show(titleBar.moreAnchor(), canOpenRecycleBin)
      else onAction(mapOf("type" to action))
    }
  }

  private fun firstVisiblePosition(): Int = when (val layoutManager = list.layoutManager) {
    is StaggeredGridLayoutManager -> layoutManager.findFirstVisibleItemPositions(null).minOrNull() ?: 0
    is LinearLayoutManager -> layoutManager.findFirstVisibleItemPosition().coerceAtLeast(0)
    else -> 0
  }

  private fun applyViewMode(mode: MinutesHomeViewMode, firstVisible: Int? = null) {
    adapter.setViewMode(mode)
    list.layoutManager = if (mode == MinutesHomeViewMode.GRID) {
      createGridLayoutManager()
    } else {
      LinearLayoutManager(context)
    }
    applyListPadding(topPadding = list.paddingTop)
    firstVisible?.let { list.scrollToPosition(it.coerceAtLeast(0)) }
  }

  private fun createGridLayoutManager(): StaggeredGridLayoutManager =
    StaggeredGridLayoutManager(2, RecyclerView.VERTICAL).apply {
      // [SOURCE] MmHomeListBaseFragment uses a two-column
      // MmStaggeredGridLayoutManager for the cover mode.
      gapStrategy = StaggeredGridLayoutManager.GAP_HANDLING_MOVE_ITEMS_BETWEEN_SPANS
    }

  private fun applyListPadding(topPadding: Int = 0) {
    val sidePadding = if (!recycleBin && viewMode == MinutesHomeViewMode.GRID) {
      context.dp(MinutesPalette.gridSidePaddingDp)
    } else 0
    list.setPadding(sidePadding, topPadding, sidePadding, context.dp(84))
  }

  private fun configureSearchBar() {
    // MIN-SEARCH-001: search remains a native list state instead of routing to the legacy RN page.
    searchBar.orientation = HORIZONTAL
    searchBar.gravity = Gravity.CENTER_VERTICAL
    searchBar.setPadding(context.dp(4), 0, context.dp(4), 0)
    searchBar.setBackgroundColor(MinutesPalette.surface)
    searchBar.visibility = View.GONE
    searchBack.setOnClickListener { onAction(mapOf("type" to "endSearch")) }
    searchBar.addView(searchBack, LayoutParams(context.dp(44), context.dp(44)))
    searchInput.apply {
      hint = "搜索会议记录"
      textSize = 16f
      setSingleLine(true)
      setTextColor(MinutesPalette.text)
      setHintTextColor(MinutesPalette.faint)
      background = null
      contentDescription = "搜索会议记录"
      addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) {
          if (!renderingSearch) onAction(mapOf("type" to "updateSearchQuery", "query" to value.toString()))
        }
        override fun afterTextChanged(value: Editable?) = Unit
      })
    }
    searchBar.addView(searchInput, LayoutParams(0, context.dp(44), 1f))
    searchClear.setOnClickListener {
      renderingSearch = true
      searchInput.text.clear()
      renderingSearch = false
      searchClear.visibility = View.INVISIBLE
      onAction(mapOf("type" to "updateSearchQuery", "query" to ""))
    }
    searchBar.addView(searchClear, LayoutParams(context.dp(44), context.dp(44)))
  }

  override fun onDetachedFromWindow() {
    itemContextMenu.dismiss()
    mainMenu.dismiss()
    super.onDetachedFromWindow()
  }
}
