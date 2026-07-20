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

internal class MinutesListSurface(
  context: Context,
  private val onAction: (Map<String, Any?>) -> Unit,
) : LinearLayout(context) {
  private val titleBar = MinutesMainTitleBar(context)
  private val searchBar = LinearLayout(context)
  private val searchBack = context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back, "退出搜索")
  private val searchInput = EditText(context)
  private val searchClear = context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_close, "清除搜索")
  private val content = FrameLayout(context)
  private val list = RecyclerView(context)
  private val itemContextMenu = MinutesItemContextMenu(context, onAction)
  private val adapter = MinutesMeetingAdapter(onAction, itemContextMenu::show)
  private val stateOverlay = LinearLayout(context)
  private val progress = ProgressBar(context)
  private val emptyImage = ImageView(context)
  private val stateMessage = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val retryButton = context.textView("重试", 16, MinutesPalette.primary, Typeface.BOLD)
  private val cachedError = LinearLayout(context)
  private val cachedMessage = context.textView(textSizeSp = 14, color = MinutesPalette.danger)
  private val cachedRetry = context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_refresh, "重新同步会议记录")
  // The retained LaoJi recording action uses Feishu's bottom operation-panel geometry.
  private val recordButton = LinearLayout(context)
  private val recordIcon = ImageView(context)
  private val recordLabel = context.textView("录音", 16, MinutesPalette.surface)
  private var renderingSearch = false
  private var wasSearching = false
  private var renderedTitle = "会议记录"
  // Feishu's home V2 opens in the two-column cover grid; the list is an
  // explicit secondary mode exposed by the trailing switch icon.
  private var viewMode = MinutesHomeViewMode.GRID

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
    list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_DRAGGING) {
          MinutesSwipeMenuLayout.closeOpenMenu()
          itemContextMenu.dismiss()
        }
      }
    })
    list.clipToPadding = false
    list.setPadding(0, 0, 0, context.dp(84))
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

    recordButton.orientation = HORIZONTAL
    recordButton.gravity = Gravity.CENTER
    recordButton.minimumWidth = context.dp(88)
    recordButton.setPadding(context.dp(12), 0, context.dp(12), 0)
    recordButton.backgroundHorizontalGradient(
      startColor = android.graphics.Color.rgb(85, 95, 242),
      endColor = android.graphics.Color.rgb(139, 118, 245),
      radiusDp = 24,
    )
    // Feishu UDShadow.S.Down is a 6dp blur with a 2dp downward offset and an
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
    content.addView(
      recordButton,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44), Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM).apply {
        bottomMargin = context.dp(16)
      },
    )
  }

  fun render(state: MinutesListState) {
    renderedTitle = state.title
    titleBar.configure(state.title, viewMode) { action ->
      if (action == "toggleViewMode") toggleViewMode()
      else onAction(mapOf("type" to action))
    }
    titleBar.visibility = if (state.searching) View.GONE else View.VISIBLE
    searchBar.visibility = if (state.searching) View.VISIBLE else View.GONE
    renderingSearch = true
    if (searchInput.text.toString() != state.query) {
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
      it.title.contains(normalizedQuery, ignoreCase = true)
        || it.dateTimeLabel.contains(normalizedQuery, ignoreCase = true)
        || it.statusLabel.contains(normalizedQuery, ignoreCase = true)
    }
    adapter.submitList(visibleMeetings)

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
        else -> "暂无会议记录"
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
    list.setPadding(
      0,
      if (cachedError.visibility == View.VISIBLE) context.dp(56) else context.dp(12),
      0,
      context.dp(84),
    )
    recordButton.visibility = if (state.searching) View.GONE else View.VISIBLE
  }

  private fun toggleViewMode() {
    itemContextMenu.dismiss()
    val firstVisible = when (val layoutManager = list.layoutManager) {
      is StaggeredGridLayoutManager -> layoutManager.findFirstVisibleItemPositions(null).minOrNull() ?: 0
      is LinearLayoutManager -> layoutManager.findFirstVisibleItemPosition()
      else -> 0
    }
    viewMode = if (viewMode == MinutesHomeViewMode.LIST) MinutesHomeViewMode.GRID else MinutesHomeViewMode.LIST
    adapter.setViewMode(viewMode)
    list.layoutManager = if (viewMode == MinutesHomeViewMode.GRID) {
      createGridLayoutManager()
    } else {
      LinearLayoutManager(context)
    }
    titleBar.configure(renderedTitle, viewMode) { action ->
      if (action == "toggleViewMode") toggleViewMode()
      else onAction(mapOf("type" to action))
    }
    list.scrollToPosition(firstVisible.coerceAtLeast(0))
  }

  private fun createGridLayoutManager(): StaggeredGridLayoutManager =
    StaggeredGridLayoutManager(2, RecyclerView.VERTICAL).apply {
      // [SOURCE] MmHomeListBaseFragment uses a two-column
      // MmStaggeredGridLayoutManager for the cover mode.
      gapStrategy = StaggeredGridLayoutManager.GAP_HANDLING_MOVE_ITEMS_BETWEEN_SPANS
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
    searchClear.setOnClickListener { onAction(mapOf("type" to "updateSearchQuery", "query" to "")) }
    searchBar.addView(searchClear, LayoutParams(context.dp(44), context.dp(44)))
  }

  override fun onDetachedFromWindow() {
    itemContextMenu.dismiss()
    super.onDetachedFromWindow()
  }
}
