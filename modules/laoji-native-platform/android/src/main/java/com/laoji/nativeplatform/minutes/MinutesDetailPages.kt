package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001: each detail tab keeps an independent native owner.

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.util.TypedValue
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Spannable
import android.text.SpannableString
import android.text.TextWatcher
import android.text.style.BackgroundColorSpan
import android.view.ActionMode
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.widget.NestedScrollView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.laoji.nativeplatform.media.MinutesPlaybackState
import kotlin.math.roundToInt

internal class MinutesNotesPage(
  context: Context,
  onAction: (Map<String, Any?>) -> Unit,
) : MinutesDetailPage(context, MinutesDetailTab.NOTES, onAction) {
  private val root = LinearLayout(context)
  private val status = context.textView(textSizeSp = 13, color = MinutesPalette.secondary)
  private val scroll = NestedScrollView(context)
  private val editor = EditText(context)
  private var applyingSnapshot = false
  private var manualNoteConflict = false

  override val scrollingChild: View
    get() = scroll

  init {
    root.orientation = LinearLayout.VERTICAL
    status.gravity = Gravity.CENTER_VERTICAL
    status.setPadding(context.dp(20), 0, context.dp(20), 0)
    status.visibility = View.INVISIBLE
    status.isClickable = true
    status.isFocusable = true
    status.setOnClickListener {
      if (status.isEnabled) {
        onAction(mapOf("type" to if (manualNoteConflict) "openManualNoteConflict" else "retryManualNote"))
      }
    }
    root.addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(32)))
    editor.apply {
      setTextSize(16f)
      setTextColor(MinutesPalette.text)
      setHintTextColor(MinutesPalette.faint)
      hint = "记录想法"
      gravity = Gravity.TOP or Gravity.START
      background = null
      setPadding(context.dp(20), context.dp(12), context.dp(20), context.dp(40))
      inputType = InputType.TYPE_CLASS_TEXT or
        InputType.TYPE_TEXT_FLAG_MULTI_LINE or
        InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      filters = arrayOf(InputFilter.LengthFilter(200_000))
      setLineSpacing(0f, 1.25f)
      overScrollMode = View.OVER_SCROLL_NEVER
      contentDescription = "我的笔记"
      addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = Unit
        override fun afterTextChanged(value: Editable?) {
          if (!applyingSnapshot) {
            onAction(mapOf("type" to "updateManualNote", "content" to value.toString()))
          }
        }
      })
    }
    scroll.isFillViewport = true
    scroll.overScrollMode = View.OVER_SCROLL_NEVER
    scroll.addView(
      editor,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    installContent(root)
  }

  override fun captureScrollPosition(): MinutesDetailPageScrollPosition =
    MinutesDetailPageScrollPosition(offsetPx = scroll.scrollY)

  override fun restoreScrollPosition(position: MinutesDetailPageScrollPosition) {
    scroll.post { scroll.scrollTo(0, position.offsetPx.coerceAtLeast(0)) }
  }

  override fun setScrollStateListener(listener: () -> Unit) {
    scroll.setOnScrollChangeListener { _, _, _, _, _ -> listener() }
  }

  fun render(state: MinutesDetailState) {
    manualNoteConflict = state.manualNoteConflict
    if (editor.text.toString() != state.manualNote) {
      val selection = editor.selectionStart.coerceAtLeast(0)
      applyingSnapshot = true
      editor.setText(state.manualNote)
      editor.setSelection(selection.coerceAtMost(editor.text.length))
      applyingSnapshot = false
    }
    val enabled = state.available && state.manualNoteEnabled && !state.manualNoteLoading
    editor.isEnabled = enabled
    editor.isFocusableInTouchMode = enabled
    editor.alpha = if (enabled) 1f else 0.72f
    val statusText = when {
      state.manualNoteConflict -> "笔记同步冲突，点击处理"
      state.manualNoteError.isNotBlank() -> state.manualNoteError +
        if (state.manualNoteRetryable) " 点击重试" else ""
      state.manualNoteLoading -> "正在读取我的笔记"
      state.manualNoteSaving -> "正在保存"
      else -> ""
    }
    status.text = statusText
    status.visibility = if (statusText.isBlank()) View.INVISIBLE else View.VISIBLE
    status.isEnabled = state.manualNoteConflict ||
      (state.manualNoteError.isNotBlank() && state.manualNoteRetryable)
    status.setTextColor(
      if (state.manualNoteConflict || state.manualNoteError.isNotBlank()) MinutesPalette.danger
      else MinutesPalette.secondary,
    )
    status.contentDescription = statusText.takeIf(String::isNotBlank)
    renderPageChrome(
      pageState = MinutesDetailPageState(
        phase = MinutesContentPhase.READY,
        generation = state.pageState(tab).generation,
        cached = true,
      ),
      hasContent = true,
      emptyMessage = "",
    )
  }
}

internal abstract class MinutesDetailPage(
  context: Context,
  val tab: MinutesDetailTab,
  private val onAction: (Map<String, Any?>) -> Unit,
) : FrameLayout(context) {
  private val body = LinearLayout(context)
  private val contentHost = FrameLayout(context)
  private val stateOverlay = LinearLayout(context)
  private val emptyImage = ImageView(context)
  private val progress = ProgressBar(context)
  private val stateMessage = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val retry = context.textView("重试", 16, MinutesPalette.primary, Typeface.BOLD)
  private val summaryAction = context.textView("生成整理结果", 16, MinutesPalette.primary, Typeface.BOLD)
  private lateinit var content: View

  internal var renderedPageState: MinutesDetailPageState = MinutesDetailPageState()
    private set

  internal val renderedGeneration: Int
    get() = renderedPageState.generation

  internal val contentContainer: View
    get() = contentHost

  internal abstract val scrollingChild: View
  internal abstract fun captureScrollPosition(): MinutesDetailPageScrollPosition
  internal abstract fun restoreScrollPosition(position: MinutesDetailPageScrollPosition)
  internal abstract fun setScrollStateListener(listener: () -> Unit)

  init {
    setBackgroundColor(MinutesPalette.surface)
    stateOverlay.orientation = LinearLayout.VERTICAL
    stateOverlay.gravity = Gravity.CENTER
    stateOverlay.setPadding(context.dp(24), context.dp(24), context.dp(24), context.dp(24))
    stateOverlay.setBackgroundColor(MinutesPalette.surface)
    emptyImage.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_minutes_empty)
    emptyImage.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    stateOverlay.addView(emptyImage, LinearLayout.LayoutParams(context.dp(100), context.dp(100)))
    stateMessage.gravity = Gravity.CENTER
    stateMessage.setLineSpacing(0f, 1.25f)
    stateOverlay.addView(progress, LinearLayout.LayoutParams(context.dp(24), context.dp(24)))
    stateOverlay.addView(
      stateMessage,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = context.dp(16)
      },
    )
    retry.gravity = Gravity.CENTER
    retry.isClickable = true
    retry.isFocusable = true
    retry.contentDescription = "重试加载${tab.label}"
    retry.setOnClickListener {
      onAction(mapOf("type" to "retryDetailContent", "tab" to tab.wireName))
    }
    stateOverlay.addView(
      retry,
      LinearLayout.LayoutParams(context.dp(76), context.dp(36)).apply { topMargin = context.dp(18) },
    )
    summaryAction.gravity = Gravity.CENTER
    summaryAction.isClickable = true
    summaryAction.isFocusable = true
    summaryAction.contentDescription = "生成会议整理结果"
    summaryAction.setOnClickListener { onAction(mapOf("type" to "generateSummary")) }
    stateOverlay.addView(
      summaryAction,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44)).apply {
        topMargin = context.dp(12)
      },
    )

    body.orientation = LinearLayout.VERTICAL
    addView(body, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  protected fun installContent(view: View) {
    check(!::content.isInitialized) { "Detail page content can only be installed once" }
    content = view
    body.addView(contentHost, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    contentHost.addView(view, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    contentHost.addView(
      stateOverlay,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
        // Summary owns a fixed 44dp operation row even before content exists.
        // Keep the empty/loading surface below that row so its action remains
        // discoverable and the page does not reflow when generation starts.
        if (tab == MinutesDetailTab.SUMMARY) topMargin = context.dp(44)
      },
    )
  }

  protected fun renderPageChrome(
    pageState: MinutesDetailPageState,
    hasContent: Boolean,
    emptyMessage: String,
    canGenerateSummary: Boolean = false,
    summaryGenerating: Boolean = false,
    summaryActionLabel: String = "生成整理结果",
  ) {
    renderedPageState = pageState.normalized()
    val phase = renderedPageState.phase
    val showBlockingState = !hasContent
    stateOverlay.visibility = if (showBlockingState) View.VISIBLE else View.GONE
    content.visibility = if (
      !hasContent && showBlockingState && tab != MinutesDetailTab.SUMMARY
    ) View.INVISIBLE else View.VISIBLE
    progress.visibility = if (phase == MinutesContentPhase.LOADING) View.VISIBLE else View.GONE
    emptyImage.visibility = if (
      phase == MinutesContentPhase.READY || phase == MinutesContentPhase.EMPTY
    ) View.VISIBLE else View.GONE
    retry.visibility = if (phase == MinutesContentPhase.ERROR) View.VISIBLE else View.GONE
    // SummaryPage owns one fixed action slot; do not alternate with a
    // centered overlay button as content changes phase.
    val showSummaryAction = tab != MinutesDetailTab.SUMMARY
      && canGenerateSummary
      && !summaryGenerating
      && phase != MinutesContentPhase.LOADING
    summaryAction.visibility = if (showSummaryAction) View.VISIBLE else View.GONE
    summaryAction.isEnabled = !summaryGenerating
    summaryAction.alpha = if (summaryGenerating) 0.45f else 1f
    summaryAction.text = summaryActionLabel.ifBlank { "生成整理结果" }
    stateMessage.text = renderedPageState.message.ifBlank {
      when (phase) {
        MinutesContentPhase.LOADING -> "正在同步${tab.label}"
        MinutesContentPhase.ERROR -> "${tab.label}暂时不可用"
        else -> emptyMessage
      }
    }
  }
}

internal class MinutesTranscriptPage(
  context: Context,
  private val emitAction: (Map<String, Any?>) -> Unit,
) : MinutesDetailPage(context, MinutesDetailTab.TRANSCRIPT, emitAction) {
  private val root = LinearLayout(context)
  private val searchBar = LinearLayout(context)
  private val searchField = LinearLayout(context)
  private val searchIcon = ImageView(context)
  private val searchInput = EditText(context)
  private val matchCount = context.textView(textSizeSp = 14, color = MinutesPalette.faint)
  private val clearSearch = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_close,
    "清空文字搜索",
  )
  private val previousMatch = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_up_outline,
    "上一处匹配",
  )
  private val nextMatch = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_down_outline,
    "下一处匹配",
  )
  private val markerStrip = HorizontalScrollView(context)
  private val markerItems = LinearLayout(context)
  internal val list = RecyclerView(context)
  private val rows = MinutesTranscriptPageAdapter(emitAction)
  private val searchController = MinutesTranscriptSearchController()

  override val scrollingChild: View
    get() = list

  private var scrollStateListener: () -> Unit = {}
  private var renderedMeetingId = ""
  private var renderedLines: List<MinutesTranscriptLine> = emptyList()
  private var renderedMarkers: List<MinutesMarker> = emptyList()
  private var expectedPlaybackSourceId: String? = null
  private var playbackSourceId: String? = null
  private var playbackPositionMs = 0L
  private var applyingQuery = false
  private val defaultListBottomPadding = context.dp(32)

  init {
    root.orientation = LinearLayout.VERTICAL
    root.setBackgroundColor(MinutesPalette.surface)

    // [SOURCE] mm_layout_detail_search.xml uses a 48dp host, 36dp filler input,
    // 16sp query, and 6dp radius. [INFERENCE] navigation remains in the same
    // fixed row because LaoJi performs local, looping search without a dialog.
    searchBar.orientation = LinearLayout.HORIZONTAL
    searchBar.gravity = Gravity.CENTER_VERTICAL
    searchBar.setPadding(context.dp(20), context.dp(6), context.dp(8), context.dp(6))
    searchBar.setBackgroundColor(MinutesPalette.surface)

    searchField.orientation = LinearLayout.HORIZONTAL
    searchField.gravity = Gravity.CENTER_VERTICAL
    searchField.backgroundShape(MinutesPalette.filler, radiusDp = 6)
    searchIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_search_outline)
    searchIcon.imageTintList = android.content.res.ColorStateList.valueOf(MinutesPalette.secondary)
    searchIcon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    searchField.addView(
      searchIcon,
      LinearLayout.LayoutParams(context.dp(18), context.dp(18)).apply { leftMargin = context.dp(12) },
    )
    searchInput.apply {
      setTextSize(16f)
      setTextColor(MinutesPalette.text)
      setHintTextColor(MinutesPalette.faint)
      hint = "搜索文字记录"
      background = null
      setPadding(context.dp(8), 0, context.dp(4), 0)
      maxLines = 1
      isSingleLine = true
      inputType = InputType.TYPE_CLASS_TEXT
      imeOptions = EditorInfo.IME_ACTION_SEARCH
      filters = arrayOf(InputFilter.LengthFilter(200))
      contentDescription = "搜索文字记录"
      addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = Unit
        override fun afterTextChanged(value: Editable?) {
          if (applyingQuery) return
          searchController.updateQuery(value?.toString().orEmpty())
          renderSearch(scrollToSelected = true)
        }
      })
    }
    searchField.addView(searchInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
    matchCount.gravity = Gravity.CENTER_VERTICAL
    matchCount.visibility = View.INVISIBLE
    searchField.addView(
      matchCount,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
        rightMargin = context.dp(4)
      },
    )
    clearSearch.setPadding(context.dp(10), context.dp(10), context.dp(10), context.dp(10))
    clearSearch.visibility = View.GONE
    clearSearch.setOnClickListener {
      searchInput.setText("")
      searchInput.requestFocus()
    }
    searchField.addView(clearSearch, LinearLayout.LayoutParams(context.dp(36), context.dp(36)))
    searchBar.addView(searchField, LinearLayout.LayoutParams(0, context.dp(36), 1f))

    previousMatch.setOnClickListener {
      searchController.previous()
      renderSearch(scrollToSelected = true)
    }
    nextMatch.setOnClickListener {
      searchController.next()
      renderSearch(scrollToSelected = true)
    }
    searchBar.addView(previousMatch, LinearLayout.LayoutParams(context.dp(44), context.dp(44)))
    searchBar.addView(nextMatch, LinearLayout.LayoutParams(context.dp(44), context.dp(44)))
    root.addView(searchBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(48)))

    markerStrip.isHorizontalScrollBarEnabled = false
    markerStrip.overScrollMode = View.OVER_SCROLL_NEVER
    markerStrip.setPadding(context.dp(20), context.dp(4), context.dp(12), context.dp(4))
    markerItems.orientation = LinearLayout.HORIZONTAL
    markerItems.gravity = Gravity.CENTER_VERTICAL
    markerStrip.addView(
      markerItems,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
    markerStrip.visibility = View.GONE
    root.addView(markerStrip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(52)))

    list.layoutManager = LinearLayoutManager(context)
    list.adapter = rows
    // [INFERENCE] The transcript page remains mounted while meeting deletion
    // clears its rows and navigates back to the list. A delayed default removal
    // animation can outlive that surface hand-off and recycle an attached row.
    // Keep transcript replacement immediate; seeking and scrolling behavior is
    // unchanged.
    list.itemAnimator = null
    list.clipToPadding = false
    list.setPadding(0, context.dp(12), 0, defaultListBottomPadding)
    list.overScrollMode = View.OVER_SCROLL_NEVER
    list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_IDLE) scrollStateListener()
      }
    })
    root.addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    installContent(root)
  }

  override fun captureScrollPosition(): MinutesDetailPageScrollPosition {
    val manager = list.layoutManager as LinearLayoutManager
    val index = manager.findFirstVisibleItemPosition().coerceAtLeast(0)
    val offset = manager.findViewByPosition(index)?.top ?: 0
    return MinutesDetailPageScrollPosition(index, offset)
  }

  override fun restoreScrollPosition(position: MinutesDetailPageScrollPosition) {
    list.post {
      (list.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(position.anchorIndex, position.offsetPx)
    }
  }

  override fun setScrollStateListener(listener: () -> Unit) {
    scrollStateListener = listener
  }

  fun render(state: MinutesDetailState) {
    if (renderedMeetingId.isNotBlank() && renderedMeetingId != state.meetingId) {
      clearQuery()
      resetRevealTailSpace()
    }
    renderedMeetingId = state.meetingId
    renderedLines = state.transcript
    renderMarkers(state.markers)
    expectedPlaybackSourceId = state.playerSource
      ?.takeIf { it.sourceId.isNotBlank() && it.uri.isNotBlank() }
      ?.sourceId
    searchController.updateLines(renderedLines)
    rows.setCanSeek(expectedPlaybackSourceId != null)
    rows.setCanCreateClip(state.canCreateClip)
    renderSearch(scrollToSelected = false)
    renderPageChrome(
      pageState = state.pageState(tab),
      hasContent = state.transcript.isNotEmpty() || state.markers.isNotEmpty(),
      emptyMessage = "暂无文字记录",
    )
  }

  fun onPlaybackState(state: MinutesPlaybackState) {
    playbackSourceId = state.sourceId
    playbackPositionMs = state.positionMs.coerceAtLeast(0L)
    updateActiveLine()
  }

  fun revealSegment(segmentId: String): Boolean {
    val index = renderedLines.indexOfFirst { it.id == segmentId }
    if (index < 0) return false
    revealLineAtTop(index)
    return true
  }

  fun revealMarker(segmentId: String?, positionMs: Long): Boolean {
    val segmentIndex = segmentId
      ?.takeIf { it.isNotBlank() }
      ?.let { id -> renderedLines.indexOfFirst { it.id == id } }
      ?.takeIf { it >= 0 }
    val target = segmentIndex ?: renderedLines.indices.minByOrNull { index ->
      val line = renderedLines[index]
      when {
        positionMs < line.startMs -> line.startMs - positionMs
        positionMs > line.endMs -> positionMs - line.endMs
        else -> 0L
      }
    }
    if (target == null) return false
    revealLineAtTop(target)
    return true
  }

  private fun revealLineAtTop(index: Int) {
    list.post {
      val topOffset = -list.paddingTop
      // [SOURCE] Feishu keeps 32dp trailing space and uses an offset scroll for transcript jumps.
      // [INFERENCE] Cross-meeting citation jumps need temporary tail room so a final segment can
      // still align near the top instead of being clamped to the bottom of the list.
      val revealBottomPadding = (list.height - topOffset).coerceAtLeast(defaultListBottomPadding)
      if (list.paddingBottom != revealBottomPadding) {
        list.setPadding(list.paddingLeft, list.paddingTop, list.paddingRight, revealBottomPadding)
      }
      (list.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(index, topOffset)
    }
  }

  private fun resetRevealTailSpace() {
    if (list.paddingBottom == defaultListBottomPadding) return
    list.setPadding(list.paddingLeft, list.paddingTop, list.paddingRight, defaultListBottomPadding)
  }

  private fun renderMarkers(markers: List<MinutesMarker>) {
    if (renderedMarkers == markers) return
    renderedMarkers = markers
    markerItems.removeAllViews()
    markers.forEach { marker ->
      val item = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        isEnabled = !marker.deleting
        isClickable = isEnabled
        isFocusable = isEnabled
        alpha = if (isEnabled) 1f else 0.45f
        background = context.roundedStateBackground(
          defaultColor = MinutesPalette.primarySoft,
          pressedColor = MinutesPalette.primaryTransparent,
          disabledColor = MinutesPalette.page,
          radiusDp = 6,
        )
        contentDescription = if (marker.deleting) {
          "正在删除标记 ${marker.timestampLabel}"
        } else {
          "跳到标记 ${marker.timestampLabel}"
        }
        setOnClickListener {
          emitAction(
            mapOf(
              "type" to "openMarker",
              "markerId" to marker.id,
              "segmentId" to marker.segmentId,
              "positionMs" to marker.positionMs,
            ),
          )
        }
      }
      val icon = ImageView(context).apply {
        setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ud_icon_flag_outlined)
        imageTintList = android.content.res.ColorStateList.valueOf(MinutesPalette.primary)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      }
      item.addView(
        icon,
        LinearLayout.LayoutParams(context.dp(16), context.dp(16)).apply { leftMargin = context.dp(12) },
      )
      val timestamp = context.textView(marker.timestampLabel, textSizeSp = 14, color = MinutesPalette.text).apply {
        gravity = Gravity.CENTER_VERTICAL
        maxLines = 1
      }
      item.addView(
        timestamp,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
          marginStart = context.dp(6)
        },
      )
      val more = context.iconButton(
        com.laoji.nativeplatform.R.drawable.laoji_ic_more_outline,
        "更多标记操作 ${marker.timestampLabel}",
      ).apply {
        isEnabled = !marker.deleting
        imageTintList = statefulIconTint(
          defaultColor = MinutesPalette.secondary,
          pressedColor = MinutesPalette.text,
          disabledColor = MinutesPalette.disabled,
        )
        setPadding(context.dp(14), context.dp(14), context.dp(14), context.dp(14))
        setOnClickListener {
          emitAction(mapOf("type" to "openMarkerActions", "markerId" to marker.id))
        }
      }
      item.addView(more, LinearLayout.LayoutParams(context.dp(44), context.dp(44)))
      val delete = context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_close, "删除标记 ${marker.timestampLabel}").apply {
        isEnabled = !marker.deleting
        imageTintList = statefulIconTint(
          defaultColor = MinutesPalette.secondary,
          pressedColor = MinutesPalette.text,
          disabledColor = MinutesPalette.disabled,
        )
        setPadding(context.dp(14), context.dp(14), context.dp(14), context.dp(14))
        setOnClickListener {
          emitAction(mapOf("type" to "deleteMarker", "markerId" to marker.id))
        }
      }
      item.addView(delete, LinearLayout.LayoutParams(context.dp(44), context.dp(44)))
      markerItems.addView(
        item,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44)).apply {
          rightMargin = context.dp(8)
        },
      )
    }
    markerStrip.visibility = if (markers.isEmpty()) View.GONE else View.VISIBLE
  }

  private fun clearQuery() {
    applyingQuery = true
    searchInput.setText("")
    applyingQuery = false
    searchController.updateQuery("")
  }

  private fun renderSearch(scrollToSelected: Boolean) {
    val searchState = searchController.state
    val hasQuery = searchController.hasEffectiveQuery()
    matchCount.visibility = if (hasQuery) View.VISIBLE else View.INVISIBLE
    matchCount.text = if (hasQuery) searchState.countLabel else ""
    clearSearch.visibility = if (searchInput.text.isNullOrEmpty()) View.GONE else View.VISIBLE
    val navigationEnabled = searchState.matches.isNotEmpty()
    setNavigationEnabled(previousMatch, navigationEnabled)
    setNavigationEnabled(nextMatch, navigationEnabled)

    val controllerRanges = searchController.rangesByLineIndex()
    val selected = searchState.selectedMatch
    val nextRows = renderedLines.mapIndexed { index, line ->
      val ranges = if (hasQuery) controllerRanges[index].orEmpty() else line.searchRanges
      val selectedRange = if (hasQuery) {
        selected?.takeIf { it.lineIndex == index }?.range
      } else {
        line.searchRanges.firstOrNull().takeIf { line.selectedSearchMatch }
      }
      MinutesTranscriptRenderRow(line, ranges, selectedRange)
    }
    rows.submitRows(nextRows) {
      updateActiveLine()
      if (scrollToSelected) selected?.let(::scrollToMatch)
    }
  }

  private fun updateActiveLine() {
    val playbackMatchesMeeting = expectedPlaybackSourceId != null &&
      playbackSourceId == expectedPlaybackSourceId
    val active = if (playbackMatchesMeeting) {
      searchController.activeLineIndex(playbackPositionMs)
    } else {
      renderedLines.indexOfFirst { it.active }.takeIf { it >= 0 }
    }
    rows.setActiveLineIndex(active)
  }

  private fun scrollToMatch(match: MinutesTranscriptMatch) {
    list.post {
      if (match.lineIndex !in 0 until rows.itemCount) return@post
      (list.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(
        match.lineIndex,
        context.dp(12),
      )
    }
  }

  private fun setNavigationEnabled(button: ImageButton, enabled: Boolean) {
    button.isEnabled = enabled
    button.alpha = if (enabled) 1f else 0.35f
  }
}

internal class MinutesSummaryPage(
  context: Context,
  private val emitAction: (Map<String, Any?>) -> Unit,
) : MinutesDetailPage(context, MinutesDetailTab.SUMMARY, emitAction) {
  private val root = LinearLayout(context)
  private val summaryActionBar = LinearLayout(context)
  private val regenerateAction = context.textView("重新生成", 16, MinutesPalette.primary)
  internal val scroll = NestedScrollView(context)
  private val rows = LinearLayout(context)
  private var renderedSections: List<MinutesSummarySection> = emptyList()
  private var renderedActions: List<MinutesActionItem> = emptyList()
  private var renderedCanGenerateSummary = false
  private var renderedSummaryGenerating = false
  private var renderedSummaryActionLabel = ""
  private val actionRows = mutableMapOf<String, View>()
  private var lastActionFocusKey = ""

  override val scrollingChild: View
    get() = scroll

  private var scrollStateListener: () -> Unit = {}

  init {
    root.orientation = LinearLayout.VERTICAL
    summaryActionBar.orientation = LinearLayout.HORIZONTAL
    summaryActionBar.gravity = Gravity.CENTER_VERTICAL or Gravity.END
    summaryActionBar.setPadding(context.dp(12), 0, context.dp(8), 0)
    regenerateAction.apply {
      gravity = Gravity.CENTER
      isClickable = true
      isFocusable = true
      contentDescription = "重新生成整理结果"
      setTextColor(
        statefulIconTint(
          MinutesPalette.primary,
          MinutesPalette.primary,
          MinutesPalette.disabled,
        ),
      )
      background = context.roundedStateBackground(
        defaultColor = MinutesPalette.surface,
        pressedColor = MinutesPalette.primarySoft,
        disabledColor = MinutesPalette.surface,
        radiusDp = 6,
      )
      setOnClickListener { emitAction(mapOf("type" to "generateSummary")) }
    }
    summaryActionBar.addView(
      regenerateAction,
      LinearLayout.LayoutParams(context.dp(104), context.dp(44)),
    )
    root.addView(
      summaryActionBar,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(44)),
    )
    scroll.isFillViewport = true
    scroll.overScrollMode = View.OVER_SCROLL_NEVER
    scroll.setOnScrollChangeListener { _, _, _, _, _ -> scrollStateListener() }
    rows.orientation = LinearLayout.VERTICAL
    rows.setPadding(context.dp(20), context.dp(10), context.dp(20), context.dp(48))
    scroll.addView(rows, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    root.addView(
      scroll,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
    )
    installContent(root)
  }

  override fun captureScrollPosition(): MinutesDetailPageScrollPosition =
    MinutesDetailPageScrollPosition(offsetPx = scroll.scrollY)

  override fun restoreScrollPosition(position: MinutesDetailPageScrollPosition) {
    scroll.post { scroll.scrollTo(0, position.offsetPx.coerceAtLeast(0)) }
  }

  override fun setScrollStateListener(listener: () -> Unit) {
    scrollStateListener = listener
  }

  fun render(state: MinutesDetailState) {
    // Reserve the same slot before and after generation. Only the label and
    // enabled state change, so the body does not jump when content arrives.
    // Keep the operation row mounted. The text action itself becomes
    // INVISIBLE when there is no transcript, preserving the measured height
    // while cached/remote page snapshots settle.
    summaryActionBar.visibility = View.VISIBLE
    regenerateAction.visibility = if (state.canGenerateSummary) View.VISIBLE else View.INVISIBLE
    regenerateAction.isEnabled = !state.summaryGenerating
    val idleActionLabel = state.summaryActionLabel.ifBlank { "重新生成" }
    regenerateAction.text = if (state.summaryGenerating) {
      "正在生成"
    } else {
      idleActionLabel
    }
    regenerateAction.contentDescription = if (state.summaryGenerating) {
      "正在生成整理结果"
    } else if (idleActionLabel.startsWith("重新")) {
      "重新生成整理结果"
    } else {
      "生成整理结果"
    }
    replaceContent(
      state.summary,
      state.actions,
      state.canGenerateSummary,
      state.summaryGenerating,
      state.summaryActionLabel,
    )
    focusAction(state.focusActionId, state.focusActionRequestId)
    renderPageChrome(
      pageState = state.pageState(tab),
      hasContent = state.summary.isNotEmpty() || state.actions.isNotEmpty(),
      emptyMessage = "该会议暂未生成整理结果",
      canGenerateSummary = state.canGenerateSummary,
      summaryGenerating = state.summaryGenerating,
      summaryActionLabel = state.summaryActionLabel,
    )
  }

  private fun replaceContent(
    sections: List<MinutesSummarySection>,
    actions: List<MinutesActionItem>,
    canGenerateSummary: Boolean,
    summaryGenerating: Boolean,
    summaryActionLabel: String,
  ) {
    if (
      renderedSections == sections
      && renderedActions == actions
      && renderedCanGenerateSummary == canGenerateSummary
      && renderedSummaryGenerating == summaryGenerating
      && renderedSummaryActionLabel == summaryActionLabel
    ) return
    val retainedScrollY = scroll.scrollY
    renderedSections = sections.toList()
    renderedActions = actions.toList()
    renderedCanGenerateSummary = canGenerateSummary
    renderedSummaryGenerating = summaryGenerating
    renderedSummaryActionLabel = summaryActionLabel
    actionRows.clear()
    rows.removeAllViews()
    sections.forEach { section ->
      rows.addView(
        summarySection(section),
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
    }
    if (actions.isNotEmpty()) {
      rows.addView(
        actionSection(actions),
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
    }
    scroll.post { scroll.scrollTo(0, retainedScrollY.coerceAtMost(rows.height)) }
  }

  private fun actionSection(actions: List<MinutesActionItem>): View = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(0, context.dp(12), 0, context.dp(8))
    val header = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    header.addView(
      context.textView("待办事项", 17, MinutesPalette.text, Typeface.BOLD).apply {
        setLineSpacing(0f, 1.2f)
      },
      LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
    )
    addView(
      header,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(44)).apply {
        bottomMargin = context.dp(2)
      },
    )
    actions.forEachIndexed { index, action ->
      val renderedRow = actionRow(action)
      actionRows[action.id] = renderedRow
      addView(
        renderedRow,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
      if (index < actions.lastIndex) {
        addView(
          View(context).apply { setBackgroundColor(MinutesPalette.divider) },
          LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply {
            leftMargin = context.dp(44)
          },
        )
      }
    }
  }

  internal fun focusAction(actionId: String, requestId: Long, force: Boolean = false) {
    if (actionId.isBlank() || requestId <= 0L) return
    val key = "$actionId:$requestId"
    if (!force && key == lastActionFocusKey) return
    val target = actionRows[actionId] ?: return
    lastActionFocusKey = key
    scroll.post {
      if (!target.isAttachedToWindow) return@post
      val bounds = Rect()
      target.getDrawingRect(bounds)
      rows.offsetDescendantRectToMyCoords(target, bounds)
      scroll.smoothScrollTo(0, (bounds.top - context.dp(12)).coerceAtLeast(0))
    }
  }

  private fun actionRow(action: MinutesActionItem): View {
    val completed = action.status == "completed"
    val dismissed = action.status == "dismissed"
    val syncConflict = action.syncConflict
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.TOP
      minimumHeight = context.dp(64)
      setPadding(0, context.dp(6), 0, context.dp(6))
    }
    val toggleHost = FrameLayout(context).apply {
      isEnabled = !action.updating && !dismissed && !syncConflict
      isClickable = !action.updating && !dismissed && !syncConflict
      isFocusable = !action.updating && !dismissed && !syncConflict
      contentDescription = when {
        action.updating -> "正在更新待办事项"
        syncConflict -> "待办事项存在同步冲突"
        dismissed -> "已忽略待办事项：${action.content}"
        completed -> "恢复待办事项：${action.content}"
        else -> "完成待办事项：${action.content}"
      }
      setOnClickListener {
        emitAction(
          mapOf(
            "type" to "toggleAction",
            "actionId" to action.id,
            "completed" to !completed,
          ),
        )
      }
    }
    if (action.updating) {
      toggleHost.addView(
        ProgressBar(context).apply { isIndeterminate = true },
        FrameLayout.LayoutParams(context.dp(22), context.dp(22), Gravity.CENTER),
      )
    } else {
      toggleHost.addView(
        context.textView(
          when {
            completed -> "✓"
            dismissed -> "−"
            else -> ""
          },
          15,
          when {
            completed -> Color.WHITE
            dismissed -> MinutesPalette.faint
            else -> MinutesPalette.text
          },
        ).apply {
          gravity = Gravity.CENTER
          backgroundShape(
            color = if (completed) MinutesPalette.primary else MinutesPalette.surface,
            radiusDp = 11,
            strokeColor = when {
              completed -> MinutesPalette.primary
              dismissed -> MinutesPalette.faint
              else -> MinutesPalette.disabled
            },
            strokeWidthDp = 1,
          )
        },
        FrameLayout.LayoutParams(context.dp(22), context.dp(22), Gravity.CENTER),
      )
    }
    row.addView(toggleHost, LinearLayout.LayoutParams(context.dp(44), context.dp(44)))

    val body = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      isClickable = !action.updating
      isFocusable = !action.updating
      contentDescription = if (syncConflict) {
        "处理待办事项同步冲突：${action.content}"
      } else {
        "编辑待办事项：${action.content}"
      }
      setPadding(0, context.dp(3), context.dp(4), context.dp(3))
      setOnClickListener {
        emitAction(
          mapOf(
            "type" to "editAction",
            "actionId" to action.id,
          ),
        )
      }
    }
    body.addView(
      context.textView(
        action.content,
        16,
        if (dismissed) MinutesPalette.faint else MinutesPalette.text,
      ).apply {
        setLineSpacing(0f, 1.2f)
        if (completed) paintFlags = paintFlags or android.graphics.Paint.STRIKE_THRU_TEXT_FLAG
      },
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    val metadata = buildList {
      if (action.assigneeLabel.isNotBlank()) add("负责人：${action.assigneeLabel}")
      if (action.dueLabel.isNotBlank()) add("截止：${action.dueLabel}")
      if (action.reminderLabel.isNotBlank()) {
        add(if (action.reminderLabel == "已提醒") "已提醒" else "提醒：${action.reminderLabel}")
      }
      if (dismissed) add("已忽略")
      if (syncConflict) add("同步冲突")
    }.joinToString("  ·  ")
    if (metadata.isNotBlank()) {
      body.addView(
        context.textView(
          metadata,
          13,
          if (syncConflict) MinutesPalette.warning else MinutesPalette.secondary,
        ).apply {
          setPadding(0, context.dp(4), 0, 0)
        },
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
    }
    if (action.hasSource) {
      val sourceTarget = FrameLayout(context).apply {
        isClickable = !action.updating
        isFocusable = !action.updating
        contentDescription = "打开待办来源 ${formatClock(action.sourceStartMs)}"
        setOnClickListener {
          emitAction(
            mapOf(
              "type" to "openActionSource",
              "actionId" to action.id,
              "segmentId" to action.sourceSegmentId,
              "positionMs" to action.sourceStartMs,
            ),
          )
        }
      }
      sourceTarget.addView(
        context.textView("来源 ${formatClock(action.sourceStartMs)}", 13, MinutesPalette.primary).apply {
          gravity = Gravity.CENTER
          setPadding(context.dp(10), 0, context.dp(10), 0)
          backgroundShape(MinutesPalette.primarySoft, radiusDp = 6)
        },
        FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(32), Gravity.CENTER_VERTICAL),
      )
      body.addView(sourceTarget, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44)))
    }
    val followupLabel = if (action.followupEventSourceId.isBlank()) "创建后续日程" else "查看后续日程"
    val followupTarget = FrameLayout(context).apply {
      isClickable = !action.updating && !dismissed && !syncConflict
      isFocusable = !action.updating && !dismissed && !syncConflict
      isEnabled = !action.updating && !dismissed && !syncConflict
      contentDescription = followupLabel
      setOnClickListener {
        emitAction(
          mapOf(
            "type" to "actionToEvent",
            "actionId" to action.id,
          ),
        )
      }
    }
    val followupContent = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      setPadding(context.dp(12), 0, context.dp(12), 0)
      backgroundShape(MinutesPalette.primarySoft, radiusDp = 6)
    }
    followupContent.addView(
      ImageView(context).apply {
        setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_calendar_outline)
        imageTintList = android.content.res.ColorStateList.valueOf(
          if (dismissed || syncConflict) MinutesPalette.faint else MinutesPalette.primary,
        )
        contentDescription = null
      },
      LinearLayout.LayoutParams(context.dp(16), context.dp(16)),
    )
    followupContent.addView(
      context.textView(
        followupLabel,
        14,
        if (dismissed || syncConflict) MinutesPalette.faint else MinutesPalette.primary,
      ).apply {
        gravity = Gravity.CENTER_VERTICAL
      },
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
        marginStart = context.dp(6)
      },
    )
    followupTarget.addView(
      followupContent,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(36), Gravity.CENTER_VERTICAL),
    )
    body.addView(
      followupTarget,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44)),
    )
    row.addView(body, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    if (action.canShare) {
      row.addView(
        context.iconButton(
          com.laoji.nativeplatform.R.drawable.laoji_ic_share_outline,
          "共享待办事项",
        ).apply {
          isEnabled = !action.updating
          imageTintList = android.content.res.ColorStateList.valueOf(MinutesPalette.secondary)
          setOnClickListener {
            emitAction(
              mapOf(
                "type" to "shareAction",
                "actionId" to action.id,
              ),
            )
          }
        },
        LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
      )
    }
    row.addView(
      context.iconButton(
        com.laoji.nativeplatform.R.drawable.laoji_ic_edit_outline,
        if (syncConflict) "处理待办事项同步冲突" else "编辑待办事项",
      ).apply {
        isEnabled = !action.updating
        imageTintList = android.content.res.ColorStateList.valueOf(MinutesPalette.secondary)
        setOnClickListener {
          emitAction(
            mapOf(
              "type" to "editAction",
              "actionId" to action.id,
            ),
          )
        }
      },
      LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
    )
    return row
  }

  private fun summarySection(section: MinutesSummarySection): View {
    val container = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(0, context.dp(10), 0, context.dp(10))
    }
    val heading = section.title.ifBlank {
      section.text.takeIf { section.kind == "heading" }.orEmpty()
    }
    if (heading.isNotBlank() || section.editable) {
      val headingRow = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = context.dp(44)
      }
      if (heading.isNotBlank()) {
        headingRow.addView(
          context.textView(heading, 17, MinutesPalette.text, Typeface.BOLD).apply {
            setLineSpacing(0f, 1.2f)
            setTextIsSelectable(true)
          },
          LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
      } else {
        headingRow.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
      }
      if (section.editable) {
        headingRow.addView(
          context.iconButton(
            com.laoji.nativeplatform.R.drawable.laoji_ic_edit_outline,
            if (section.userEdited) "编辑整理内容，当前含人工修改" else "编辑整理内容",
          ).apply {
            imageTintList = android.content.res.ColorStateList.valueOf(MinutesPalette.secondary)
            setOnClickListener {
              emitAction(
                mapOf(
                  "type" to "editSummarySection",
                  "sectionId" to section.id,
                ),
              )
            }
          },
          LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
        )
      }
      container.addView(
        headingRow,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
          bottomMargin = if (section.text.isBlank() || section.kind == "heading") 0 else context.dp(2)
        },
      )
    }
    if (section.text.isNotBlank() && section.kind != "heading") {
      val listKind = section.kind in setOf(
        "bullets", "bullet", "numbered", "ordered", "decisions", "topics", "risks", "action_items",
      )
      if (listKind) {
        section.text.split(Regex("\\r?\\n")).map(String::trim).filter(String::isNotBlank).forEachIndexed { index, line ->
          val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
            setPadding(0, context.dp(3), 0, context.dp(3))
          }
          row.addView(
            context.textView(
              if (section.kind == "numbered" || section.kind == "ordered") "${index + 1}." else "•",
              15,
              MinutesPalette.text,
            ),
            LinearLayout.LayoutParams(context.dp(26), ViewGroup.LayoutParams.WRAP_CONTENT),
          )
          row.addView(
            context.textView(line, 16, MinutesPalette.text).apply {
              setLineSpacing(0f, 1.25f)
              setTextIsSelectable(true)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
          )
          container.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
      } else {
        container.addView(
          context.textView(section.text, 16, MinutesPalette.text).apply {
            setLineSpacing(0f, 1.25f)
            setTextIsSelectable(true)
          },
          LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
        )
      }
    }
    if (section.citations.isNotEmpty()) {
      val citationRow = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, context.dp(4), 0, 0)
      }
      section.citations.forEach { citation ->
        val target = FrameLayout(context).apply {
          isClickable = true
          isFocusable = true
          contentDescription = "跳转到文字记录 ${citation.label.ifBlank { formatClock(citation.startMs) }}"
          setOnClickListener {
            emitAction(
              mapOf(
                "type" to "seekSummaryCitation",
                "segmentId" to citation.segmentId,
                "positionMs" to citation.startMs,
              ),
            )
          }
        }
        target.addView(
          context.textView(
            citation.label.ifBlank { formatClock(citation.startMs) },
            14,
            MinutesPalette.primary,
          ).apply {
            gravity = Gravity.CENTER
            setPadding(context.dp(10), 0, context.dp(10), 0)
            backgroundShape(MinutesPalette.primarySoft, radiusDp = 6)
          },
          FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(32), Gravity.CENTER),
        )
        citationRow.addView(
          target,
          LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44)).apply {
            rightMargin = context.dp(4)
          },
        )
      }
      val scroller = HorizontalScrollView(context).apply {
        isHorizontalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        addView(citationRow, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      }
      container.addView(scroller, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(48)))
    }
    return container
  }
}

internal class MinutesSpeakersPage(
  context: Context,
  onAction: (Map<String, Any?>) -> Unit,
) : MinutesDetailPage(context, MinutesDetailTab.SPEAKERS, onAction) {
  internal val list = RecyclerView(context)
  private val rows = MinutesSpeakersPageAdapter(onAction)

  override val scrollingChild: View
    get() = list

  private var scrollStateListener: () -> Unit = {}

  init {
    list.layoutManager = LinearLayoutManager(context)
    list.adapter = rows
    // [INFERENCE] Every detail tab stays mounted in the pager. Deleting the
    // meeting clears the speaker rows while the detail surface is navigating
    // away; RecyclerView's default change animator can then finish after the
    // hand-off and recycle a holder that is still attached. Speaker row motion
    // is not a product interaction, so keep this state replacement immediate.
    list.itemAnimator = null
    list.clipToPadding = false
    list.setPadding(0, context.dp(16), 0, context.dp(16))
    list.overScrollMode = View.OVER_SCROLL_NEVER
    list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_IDLE) scrollStateListener()
      }
    })
    installContent(list)
  }

  override fun captureScrollPosition(): MinutesDetailPageScrollPosition {
    val manager = list.layoutManager as LinearLayoutManager
    val index = manager.findFirstVisibleItemPosition().coerceAtLeast(0)
    val offset = manager.findViewByPosition(index)?.top ?: 0
    return MinutesDetailPageScrollPosition(index, offset)
  }

  override fun restoreScrollPosition(position: MinutesDetailPageScrollPosition) {
    list.post {
      (list.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(position.anchorIndex, position.offsetPx)
    }
  }

  override fun setScrollStateListener(listener: () -> Unit) {
    scrollStateListener = listener
  }

  fun render(state: MinutesDetailState) {
    val mediaDurationMs = maxOf(
      state.playerSource?.durationMsHint ?: 0L,
      state.transcript.maxOfOrNull { maxOf(it.startMs, it.endMs) } ?: 0L,
    )
    rows.replace(
      state.speakers.mapIndexed { index, speaker ->
        MinutesSpeakerTimelineRow(
          speaker = speaker,
          segments = state.transcript.filter { line ->
            line.speakerId == speaker.id ||
              (line.speakerId == "unknown" && line.speakerLabel == speaker.label)
          },
          mediaDurationMs = mediaDurationMs,
          colorIndex = index,
        )
      },
    )
    renderPageChrome(
      pageState = state.pageState(tab),
      hasContent = state.speakers.isNotEmpty(),
      emptyMessage = "暂无讲话人信息",
    )
  }
}

/**
 * [SOURCE] Feishu's information tab presents user-semantic creation metadata,
 * not local-file, sync, or transcript implementation state. LaoJi currently
 * Missing capabilities are not represented by invented placeholders.
 */
private data class MinutesInfoRow(
  val label: String,
  val value: String,
  val action: String? = null,
  val accent: Boolean = false,
)

internal class MinutesInfoPage(
  context: Context,
  private val onInfoAction: (Map<String, Any?>) -> Unit,
) : MinutesDetailPage(context, MinutesDetailTab.INFO, onInfoAction) {
  private val scroll = NestedScrollView(context)
  private val rows = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(0, context.dp(14), 0, context.dp(40))
  }
  private var renderedKey = ""

  override val scrollingChild: View
    get() = scroll

  init {
    scroll.isFillViewport = true
    scroll.overScrollMode = View.OVER_SCROLL_NEVER
    scroll.addView(rows, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    installContent(scroll)
  }

  override fun captureScrollPosition(): MinutesDetailPageScrollPosition =
    MinutesDetailPageScrollPosition(offsetPx = scroll.scrollY)

  override fun restoreScrollPosition(position: MinutesDetailPageScrollPosition) {
    scroll.post { scroll.scrollTo(0, position.offsetPx.coerceAtLeast(0)) }
  }

  override fun setScrollStateListener(listener: () -> Unit) {
    scroll.setOnScrollChangeListener { _, _, _, _, _ -> listener() }
  }

  fun render(state: MinutesDetailState) {
    val values = buildList {
      state.dateTimeLabel.takeIf { it.isNotBlank() }?.let { add(MinutesInfoRow("创建时间", it)) }
      add(MinutesInfoRow(
        label = "地址",
        value = when {
          state.locationLoading -> "正在定位"
          state.location.isNotBlank() -> state.location
          else -> "添加地点"
        },
        action = "requestMeetingLocation".takeIf { state.canEditLocation && !state.locationLoading },
        accent = state.location.isBlank(),
      ))
    }
    val key = values.joinToString("|") { "${it.label}=${it.value}:${it.action}:${it.accent}" }
    if (key != renderedKey) {
      renderedKey = key
      val retainedScroll = scroll.scrollY
      rows.removeAllViews()
      values.forEachIndexed { index, item ->
        val row = LinearLayout(context).apply {
          orientation = LinearLayout.VERTICAL
          setPadding(context.dp(16), 0, context.dp(16), 0)
          minimumHeight = context.dp(66)
          if (item.action != null) {
            val selectable = TypedValue()
            if (context.theme.resolveAttribute(android.R.attr.selectableItemBackground, selectable, true)) {
              setBackgroundResource(selectable.resourceId)
            }
            isClickable = true
            isFocusable = true
            contentDescription = item.value
            setOnClickListener { onInfoAction(mapOf("type" to item.action)) }
          }
        }
        row.addView(context.textView(item.label, 14, MinutesPalette.secondary))
        row.addView(context.textView(
          item.value,
          16,
          if (item.accent) MinutesPalette.primary else MinutesPalette.text,
        ).apply {
          setLineSpacing(0f, 1.2f)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
          topMargin = context.dp(8)
        })
        rows.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
          topMargin = if (index == 0) 0 else context.dp(14)
        })
      }
      scroll.post { scroll.scrollTo(0, retainedScroll.coerceAtMost(rows.height)) }
    }
    renderPageChrome(
      pageState = state.pageState(tab),
      hasContent = values.isNotEmpty(),
      emptyMessage = "暂无录音信息",
    )
  }
}

private data class MinutesTranscriptRenderRow(
  val line: MinutesTranscriptLine,
  val searchRanges: List<MinutesTextRange> = emptyList(),
  val selectedRange: MinutesTextRange? = null,
)

private class MinutesTranscriptPageAdapter(
  private val onAction: (Map<String, Any?>) -> Unit,
) : ListAdapter<MinutesTranscriptRenderRow, MinutesTranscriptPageAdapter.Holder>(DIFF) {
  private var activeLineIndex: Int? = null
  private var canSeek = false
  private var canCreateClip = false

  init {
    setHasStableIds(true)
  }

  fun submitRows(next: List<MinutesTranscriptRenderRow>, committed: () -> Unit) {
    if (currentList == next) {
      committed()
      return
    }
    submitList(next.toList(), committed)
  }

  fun setActiveLineIndex(next: Int?) {
    val normalized = next?.takeIf { it in currentList.indices }
    if (activeLineIndex == normalized) return
    val previous = activeLineIndex
    activeLineIndex = normalized
    previous?.takeIf { it in currentList.indices }?.let {
      notifyItemChanged(it, PAYLOAD_ACTIVE)
    }
    normalized?.let { notifyItemChanged(it, PAYLOAD_ACTIVE) }
  }

  fun setCanSeek(next: Boolean) {
    if (canSeek == next) return
    canSeek = next
    if (itemCount > 0) notifyItemRangeChanged(0, itemCount, PAYLOAD_SEEK)
  }

  fun setCanCreateClip(next: Boolean) {
    if (canCreateClip == next) return
    canCreateClip = next
    if (itemCount > 0) notifyItemRangeChanged(0, itemCount, PAYLOAD_CLIP)
  }

  override fun getItemId(position: Int): Long = getItem(position).line.id.hashCode().toLong()
  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(parent)

  override fun onBindViewHolder(holder: Holder, position: Int) {
    holder.bind(getItem(position), position == activeLineIndex, canSeek, canCreateClip, onAction)
  }

  override fun onBindViewHolder(holder: Holder, position: Int, payloads: MutableList<Any>) {
    if (payloads.isEmpty()) {
      onBindViewHolder(holder, position)
      return
    }
    val payload = payloads.filterIsInstance<Int>().fold(0) { result, value -> result or value }
    holder.bindPayload(
      getItem(position),
      position == activeLineIndex,
      canSeek,
      canCreateClip,
      onAction,
      payload,
    )
  }

  internal class Holder(parent: ViewGroup) : RecyclerView.ViewHolder(LinearLayout(parent.context)) {
    private val root = itemView as LinearLayout
    private val metaRow = LinearLayout(parent.context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    private val speakerTarget = LinearLayout(parent.context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      isClickable = true
      isFocusable = true
    }
    private val avatar = FrameLayout(parent.context)
    private val speaker = parent.context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
    private val separator = View(parent.context)
    private val time = parent.context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
    private val body = parent.context.textView(textSizeSp = 16)
    private var boundLine: MinutesTranscriptLine? = null
    private var boundActive = false
    private var boundCanCreateClip = false
    private var boundAction: (Map<String, Any?>) -> Unit = {}

    init {
      root.layoutParams = RecyclerView.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
      )
      root.orientation = LinearLayout.VERTICAL
      // The 44dp speaker target preserves the previous visual baselines by trading
      // 10dp of top padding and the old 10dp body gap for touch-target height.
      root.setPadding(parent.context.dp(20), parent.context.dp(10), parent.context.dp(20), parent.context.dp(12))
      avatar.addView(
        ImageView(parent.context).apply {
          setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_person_filled)
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        },
        FrameLayout.LayoutParams(parent.context.dp(14), parent.context.dp(14), Gravity.CENTER),
      )
      speakerTarget.addView(avatar, LinearLayout.LayoutParams(parent.context.dp(24), parent.context.dp(24)))
      speakerTarget.addView(speaker, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        leftMargin = parent.context.dp(8)
      })
      metaRow.addView(speakerTarget, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, parent.context.dp(44)))
      separator.backgroundShape(MinutesPalette.disabled, radiusDp = 2)
      metaRow.addView(separator, LinearLayout.LayoutParams(parent.context.dp(3), parent.context.dp(3)).apply {
        leftMargin = parent.context.dp(12)
        rightMargin = parent.context.dp(12)
      })
      metaRow.addView(time, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      root.addView(metaRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, parent.context.dp(44)))
      body.setLineSpacing(0f, 1.35f)
      body.setTextIsSelectable(true)
      body.customSelectionActionModeCallback = object : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
          menu.removeItem(android.R.id.shareText)
          menu.add(Menu.NONE, MENU_SHARE_SELECTION, Menu.NONE, "分享")
            .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
          val line = boundLine
          if (
            boundCanCreateClip
            && line?.isFinal == true
            && line.revisionKind != MinutesTranscriptRevisionKind.REALTIME_DRAFT
          ) {
            menu.add(Menu.NONE, MENU_CREATE_CLIP, Menu.NONE, "生成音频片段")
              .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
          }
          return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
          return when (item.itemId) {
            MENU_SHARE_SELECTION -> {
              shareSelection(mode)
              true
            }
            MENU_CREATE_CLIP -> {
              createClipSelection(mode)
              true
            }
            else -> false
          }
        }

        override fun onDestroyActionMode(mode: ActionMode) = Unit
      }
      root.addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = 0
      })
    }

    fun bind(
      row: MinutesTranscriptRenderRow,
      active: Boolean,
      canSeek: Boolean,
      canCreateClip: Boolean,
      onAction: (Map<String, Any?>) -> Unit,
    ) {
      boundCanCreateClip = canCreateClip
      boundAction = onAction
      bindMetadata(row.line)
      bindBody(row)
      bindActive(active)
      bindSeek(row.line, canSeek, onAction)
    }

    fun bindPayload(
      row: MinutesTranscriptRenderRow,
      active: Boolean,
      canSeek: Boolean,
      canCreateClip: Boolean,
      onAction: (Map<String, Any?>) -> Unit,
      payload: Int,
    ) {
      if (payload == 0 || payload and PAYLOAD_METADATA != 0) bindMetadata(row.line)
      if (payload == 0 || payload and PAYLOAD_BODY != 0) bindBody(row)
      if (payload == 0 || payload and PAYLOAD_ACTIVE != 0) bindActive(active)
      if (payload == 0 || payload and PAYLOAD_CLIP != 0) boundCanCreateClip = canCreateClip
      boundAction = onAction
      if (
        payload == 0
        || payload and (PAYLOAD_SEEK or PAYLOAD_METADATA or PAYLOAD_BODY) != 0
      ) bindSeek(row.line, canSeek, onAction)
    }

    private fun bindMetadata(line: MinutesTranscriptLine) {
      boundLine = line
      val tone = minutesSpeakerTone(line.speakerId.ifBlank { line.speakerLabel })
      avatar.backgroundShape(tone.first, radiusDp = 12)
      (avatar.getChildAt(0) as ImageView).imageTintList = android.content.res.ColorStateList.valueOf(tone.second)
      speaker.text = line.speakerLabel
      speakerTarget.contentDescription = "修改讲话人，${line.speakerLabel}"
      time.text = line.timestampLabel
      bindAccessibility()
    }

    private fun bindBody(row: MinutesTranscriptRenderRow) {
      boundLine = row.line
      val styled = SpannableString(row.line.text)
      row.searchRanges.filter { it.validFor(row.line.text) }.forEach { range ->
        styled.setSpan(
          BackgroundColorSpan(MinutesPalette.primaryTransparent),
          range.start,
          range.end,
          Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
      }
      row.selectedRange?.takeIf { it.validFor(row.line.text) }?.let { range ->
        styled.setSpan(
          BackgroundColorSpan(MinutesPalette.primaryTransparentStrong),
          range.start,
          range.end,
          Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
      }
      body.text = styled
      body.alpha = if (
        row.line.revisionKind == MinutesTranscriptRevisionKind.REALTIME_DRAFT || !row.line.isFinal
      ) 0.72f else 1f
      bindAccessibility()
    }

    private fun bindActive(active: Boolean) {
      boundActive = active
      root.backgroundShape(if (active) MinutesPalette.primarySoft else MinutesPalette.surface)
      bindAccessibility()
    }

    private fun bindAccessibility() {
      val line = boundLine ?: return
      root.contentDescription = listOfNotNull(
        "当前播放".takeIf { boundActive },
        line.speakerLabel,
        line.timestampLabel,
        line.text,
      ).joinToString("，")
    }

    private fun bindSeek(
      line: MinutesTranscriptLine,
      canSeek: Boolean,
      onAction: (Map<String, Any?>) -> Unit,
    ) {
      val listener = if (canSeek) View.OnClickListener {
        onAction(
          mapOf(
            "type" to "seekTranscript",
            "lineId" to line.id,
            "positionMs" to line.startMs,
            "playerSourceId" to line.playerSourceId,
          ),
        )
      } else null
      root.setOnClickListener(listener)
      metaRow.setOnClickListener(listener)
      body.setOnClickListener(listener)
      speakerTarget.setOnClickListener {
        onAction(
          mapOf(
            "type" to "editTranscriptSpeaker",
            "lineId" to line.id,
            "speakerId" to line.speakerId,
            "speakerClusterId" to line.speakerClusterId,
            "speakerLabel" to line.speakerLabel,
            "positionMs" to line.startMs,
            "revisionKind" to line.revisionKind.wireName,
          ),
        )
      }
      root.setOnLongClickListener(null)
      root.isLongClickable = false
    }

    private fun shareSelection(mode: ActionMode) {
      val line = boundLine ?: return
      val start = minOf(body.selectionStart, body.selectionEnd).coerceAtLeast(0)
      val end = maxOf(body.selectionStart, body.selectionEnd).coerceAtMost(body.text.length)
      if (end <= start) return
      val selected = body.text.subSequence(start, end).toString()
      val prefix = listOf(line.speakerLabel, line.timestampLabel)
        .filter { it.isNotBlank() }
        .joinToString(" ")
      val shareText = listOf(prefix, selected).filter { it.isNotBlank() }.joinToString("\n")
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, shareText)
      }
      val chooser = Intent.createChooser(send, "分享选中文字")
      if (body.context !is Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        body.context.startActivity(chooser)
        mode.finish()
      } catch (_: Exception) {
        Toast.makeText(body.context, "暂时无法分享，请稍后重试。", Toast.LENGTH_SHORT).show()
      }
    }

    private fun createClipSelection(mode: ActionMode) {
      val line = boundLine ?: return
      val start = minOf(body.selectionStart, body.selectionEnd).coerceAtLeast(0)
      val end = maxOf(body.selectionStart, body.selectionEnd).coerceAtMost(body.text.length)
      if (end <= start) return
      val selected = body.text.subSequence(start, end).toString().trim()
      if (selected.isBlank()) return
      boundAction(
        mapOf(
          "type" to "createClipFromTranscript",
          "lineId" to line.id,
          "positionMs" to line.startMs,
          "endMs" to line.endMs,
          "selectedText" to selected,
        ),
      )
      mode.finish()
    }
  }

  companion object {
    private const val PAYLOAD_METADATA = 1
    private const val PAYLOAD_BODY = 1 shl 1
    private const val PAYLOAD_ACTIVE = 1 shl 2
    private const val PAYLOAD_SEEK = 1 shl 3
    private const val PAYLOAD_CLIP = 1 shl 4
    private const val MENU_SHARE_SELECTION = 0x4C4A5301
    private const val MENU_CREATE_CLIP = 0x4C4A5302

    private val DIFF = object : DiffUtil.ItemCallback<MinutesTranscriptRenderRow>() {
      override fun areItemsTheSame(
        oldItem: MinutesTranscriptRenderRow,
        newItem: MinutesTranscriptRenderRow,
      ): Boolean = oldItem.line.id == newItem.line.id

      override fun areContentsTheSame(
        oldItem: MinutesTranscriptRenderRow,
        newItem: MinutesTranscriptRenderRow,
      ): Boolean = oldItem == newItem

      override fun getChangePayload(
        oldItem: MinutesTranscriptRenderRow,
        newItem: MinutesTranscriptRenderRow,
      ): Any {
        var payload = 0
        if (
          oldItem.line.speakerId != newItem.line.speakerId ||
          oldItem.line.speakerClusterId != newItem.line.speakerClusterId ||
          oldItem.line.speakerLabel != newItem.line.speakerLabel ||
          oldItem.line.playerSourceId != newItem.line.playerSourceId ||
          oldItem.line.timestampLabel != newItem.line.timestampLabel
        ) payload = payload or PAYLOAD_METADATA
        if (
          oldItem.line.text != newItem.line.text ||
          oldItem.line.isFinal != newItem.line.isFinal ||
          oldItem.line.revisionKind != newItem.line.revisionKind ||
          oldItem.searchRanges != newItem.searchRanges ||
          oldItem.selectedRange != newItem.selectedRange
        ) payload = payload or PAYLOAD_BODY
        if (
          oldItem.line.startMs != newItem.line.startMs ||
          oldItem.line.endMs != newItem.line.endMs
        ) payload = payload or PAYLOAD_SEEK
        return payload
      }
    }
  }
}

private data class MinutesSpeakerTimelineRow(
  val speaker: MinutesSpeaker,
  val segments: List<MinutesTranscriptLine>,
  val mediaDurationMs: Long,
  val colorIndex: Int,
) {
  val spokenDurationMs: Long
    get() = segments.sumOf { line -> (line.endMs - line.startMs).coerceAtLeast(0L) }

  val percent: Int
    get() = if (mediaDurationMs > 0L) {
      ((spokenDurationMs.toDouble() / mediaDurationMs.toDouble()) * 100.0).roundToInt().coerceIn(0, 100)
    } else {
      0
    }
}

private class MinutesSpeakersPageAdapter(
  private val onAction: (Map<String, Any?>) -> Unit,
) : RecyclerView.Adapter<MinutesSpeakersPageAdapter.Holder>() {
  private var rows: List<MinutesSpeakerTimelineRow> = emptyList()

  init {
    setHasStableIds(true)
  }

  fun replace(next: List<MinutesSpeakerTimelineRow>) {
    if (rows == next) return
    rows = next.toList()
    notifyDataSetChanged()
  }

  override fun getItemCount(): Int = rows.size
  override fun getItemId(position: Int): Long = rows[position].speaker.id.hashCode().toLong()
  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(parent)
  override fun onBindViewHolder(holder: Holder, position: Int) = holder.bind(rows[position], onAction)

  internal class Holder(parent: ViewGroup) : RecyclerView.ViewHolder(FrameLayout(parent.context)) {
    private val root = itemView as FrameLayout
    private val avatar = FrameLayout(parent.context)
    private val name = parent.context.textView(textSizeSp = 14)
    private val percent = parent.context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
    private val timeline = MinutesSpeakerTimelineView(parent.context)

    init {
      root.layoutParams = RecyclerView.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
      )
      avatar.addView(
        ImageView(parent.context).apply {
          setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_person_filled)
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        },
        FrameLayout.LayoutParams(parent.context.dp(14), parent.context.dp(14), Gravity.CENTER),
      )
      root.addView(avatar, FrameLayout.LayoutParams(parent.context.dp(24), parent.context.dp(24)).apply {
        leftMargin = parent.context.dp(16)
      })
      root.addView(name, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, parent.context.dp(24)).apply {
        leftMargin = parent.context.dp(48)
        rightMargin = parent.context.dp(54)
      })
      percent.gravity = Gravity.END or Gravity.CENTER_VERTICAL
      root.addView(percent, FrameLayout.LayoutParams(parent.context.dp(46), parent.context.dp(24), Gravity.END).apply {
        rightMargin = parent.context.dp(16)
      })
      root.addView(timeline, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, parent.context.dp(25)).apply {
        topMargin = parent.context.dp(24)
      })
      root.setPadding(0, 0, 0, parent.context.dp(16))
    }

    fun bind(row: MinutesSpeakerTimelineRow, onAction: (Map<String, Any?>) -> Unit) {
      val speaker = row.speaker
      val tone = minutesSpeakerTone(speaker.id)
      val timelineColor = minutesSpeakerTimelineColor(row.colorIndex)
      avatar.backgroundShape(tone.first, radiusDp = 22)
      (avatar.getChildAt(0) as ImageView).imageTintList = android.content.res.ColorStateList.valueOf(tone.second)
      name.text = speaker.label
      percent.text = "${row.percent}%"
      timeline.bind(row, timelineColor) { positionMs ->
        onAction(mapOf("type" to "seekTranscript", "positionMs" to positionMs))
      }
      root.isClickable = speaker.canManage
      root.isFocusable = speaker.canManage
      root.contentDescription = "${speaker.label}，发言时长占完整录音${row.percent}%"
      root.setOnClickListener(if (speaker.canManage) {
        View.OnClickListener { onAction(mapOf("type" to "manageSpeaker", "speakerId" to speaker.id)) }
      } else null)
    }
  }
}

private class MinutesSpeakerTimelineView(context: Context) : FrameLayout(context) {
  private var row: MinutesSpeakerTimelineRow? = null
  private var segmentColor: Int = MinutesPalette.primary
  private var onSeek: (Long) -> Unit = {}

  fun bind(
    row: MinutesSpeakerTimelineRow,
    segmentColor: Int,
    onSeek: (Long) -> Unit,
  ) {
    this.row = row
    this.segmentColor = segmentColor
    this.onSeek = onSeek
    rebuild()
    post { if (this.row === row) rebuild() }
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    if (width != oldWidth || height != oldHeight) rebuild()
  }

  private fun rebuild() {
    removeAllViews()
    if (width <= 0 || height <= 0) return
    val sideMargin = context.dp(16)
    val trackHeight = context.dp(5).coerceAtLeast(1)
    val trackTop = (height - trackHeight) / 2
    val trackWidth = (width - sideMargin * 2).coerceAtLeast(0)
    addView(
      View(context).apply { backgroundShape(MinutesPalette.timelineTrack, radiusDp = 3) },
      LayoutParams(trackWidth, trackHeight).apply {
        leftMargin = sideMargin
        topMargin = trackTop
      },
    )
    val current = row ?: return
    val durationMs = current.mediaDurationMs.coerceAtLeast(1L)
    current.segments.forEach { segment ->
      val startMs = segment.startMs.coerceIn(0L, durationMs)
      val endMs = maxOf(startMs + 1L, segment.endMs).coerceIn(startMs, durationMs)
      val left = sideMargin + ((startMs.toDouble() / durationMs) * trackWidth).roundToInt()
      val desiredWidth = (((endMs - startMs).toDouble() / durationMs) * trackWidth).roundToInt()
      val segmentWidth = desiredWidth.coerceAtLeast(context.dp(2)).coerceAtMost((sideMargin + trackWidth - left).coerceAtLeast(0))
      if (segmentWidth <= 0) return@forEach
      addView(
        View(context).apply {
          backgroundShape(segmentColor, radiusDp = 3)
          isClickable = true
          isFocusable = true
          contentDescription = "跳转到${segment.timestampLabel}"
          setOnClickListener { onSeek(segment.startMs) }
        },
        LayoutParams(segmentWidth, trackHeight).apply {
          leftMargin = left
          topMargin = trackTop
        },
      )
    }
  }
}

private val minutesNeutralSpeakerTones = listOf(
  Color.rgb(232, 243, 255) to Color.rgb(51, 112, 255),
  Color.rgb(228, 247, 237) to Color.rgb(32, 161, 98),
  Color.rgb(240, 235, 255) to Color.rgb(127, 90, 240),
  Color.rgb(255, 240, 226) to Color.rgb(240, 124, 43),
  Color.rgb(225, 246, 245) to Color.rgb(22, 156, 150),
  Color.rgb(253, 234, 242) to Color.rgb(214, 79, 130),
)

// [PRODUCT] The vivid skin keeps the multi-speaker distinction but removes
// the isolated source-blue swatch that otherwise survives inside an otherwise
// pink-purple surface.
private val minutesVividSpeakerTones = listOf(
  Color.rgb(252, 224, 240) to Color.rgb(214, 79, 130),
  Color.rgb(228, 247, 237) to Color.rgb(37, 136, 50),
  Color.rgb(237, 232, 255) to Color.rgb(123, 92, 184),
  Color.rgb(255, 240, 226) to Color.rgb(240, 124, 43),
  Color.rgb(225, 246, 245) to Color.rgb(22, 156, 150),
  Color.rgb(255, 240, 248) to Color.rgb(255, 77, 79),
)

// [SOURCE] MmSpeakerTimelineViewModel.COLOR_ARRAY, indexed by sorted speaker row position.
private val minutesNeutralSpeakerTimelineColors = intArrayOf(
  Color.rgb(80, 131, 251),
  Color.rgb(50, 166, 69),
  Color.rgb(117, 125, 240),
  Color.rgb(16, 168, 147),
  Color.rgb(207, 94, 207),
  Color.rgb(18, 149, 202),
  Color.rgb(159, 111, 241),
)

private val minutesVividSpeakerTimelineColors = intArrayOf(
  Color.rgb(214, 79, 130),
  Color.rgb(37, 136, 50),
  Color.rgb(123, 92, 184),
  Color.rgb(240, 124, 43),
  Color.rgb(22, 156, 150),
  Color.rgb(255, 77, 79),
  Color.rgb(146, 104, 224),
)

private fun minutesSpeakerTone(key: String): Pair<Int, Int> {
  val tones = if (MinutesPalette.vivid) minutesVividSpeakerTones else minutesNeutralSpeakerTones
  return tones[(key.hashCode() and Int.MAX_VALUE) % tones.size]
}

private fun minutesSpeakerTimelineColor(index: Int): Int {
  val colors = if (MinutesPalette.vivid) {
    minutesVividSpeakerTimelineColors
  } else {
    minutesNeutralSpeakerTimelineColors
  }
  return colors[index % colors.size]
}
