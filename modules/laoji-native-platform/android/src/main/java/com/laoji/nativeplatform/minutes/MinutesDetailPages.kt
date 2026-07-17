package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001: transcript, summary and speaker pages keep independent native owners.

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.widget.NestedScrollView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

internal abstract class MinutesDetailPage(
  context: Context,
  val tab: MinutesDetailTab,
  private val onAction: (Map<String, Any?>) -> Unit,
) : FrameLayout(context) {
  private val body = LinearLayout(context)
  private val contentHost = FrameLayout(context)
  private val stateOverlay = LinearLayout(context)
  private val progress = ProgressBar(context)
  private val stateMessage = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val retry = context.textView("重试", 16, MinutesPalette.primary, Typeface.BOLD)
  private val summaryAction = context.textView("生成总结", 16, MinutesPalette.primary, Typeface.BOLD)
  private val warning = LinearLayout(context)
  private val warningText = context.textView(textSizeSp = 13, color = MinutesPalette.danger)
  private val warningRetry = context.iconButton(android.R.drawable.ic_popup_sync, "重试加载当前内容")
  private lateinit var content: View

  internal var renderedPageState: MinutesDetailPageState = MinutesDetailPageState()
    private set

  internal val renderedGeneration: Int
    get() = renderedPageState.generation

  internal val warningBanner: View
    get() = warning

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
    summaryAction.contentDescription = "生成会议总结"
    summaryAction.setOnClickListener { onAction(mapOf("type" to "generateSummary")) }
    stateOverlay.addView(
      summaryAction,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44)).apply {
        topMargin = context.dp(12)
      },
    )

    warning.orientation = LinearLayout.HORIZONTAL
    warning.gravity = Gravity.CENTER_VERTICAL
    warning.setPadding(context.dp(16), 0, context.dp(4), 0)
    warning.backgroundShape(MinutesPalette.dangerSoft)
    warning.visibility = View.GONE
    warning.addView(warningText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    warningRetry.setOnClickListener { retry.performClick() }
    warning.addView(warningRetry, LinearLayout.LayoutParams(context.dp(44), context.dp(44)))
    body.orientation = LinearLayout.VERTICAL
    addView(body, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  protected fun installContent(view: View) {
    check(!::content.isInitialized) { "Detail page content can only be installed once" }
    content = view
    body.addView(warning, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(44)))
    body.addView(contentHost, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    contentHost.addView(view, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    contentHost.addView(stateOverlay, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  protected fun renderPageChrome(
    pageState: MinutesDetailPageState,
    hasContent: Boolean,
    emptyMessage: String,
    canGenerateSummary: Boolean = false,
    summaryGenerating: Boolean = false,
    summaryActionLabel: String = "生成总结",
  ) {
    renderedPageState = pageState.normalized()
    val phase = renderedPageState.phase
    val showBlockingState = !hasContent
    stateOverlay.visibility = if (showBlockingState) View.VISIBLE else View.GONE
    content.visibility = if (!hasContent && showBlockingState) View.INVISIBLE else View.VISIBLE
    progress.visibility = if (phase == MinutesContentPhase.LOADING) View.VISIBLE else View.GONE
    retry.visibility = if (phase == MinutesContentPhase.ERROR) View.VISIBLE else View.GONE
    val showSummaryAction = tab == MinutesDetailTab.SUMMARY && canGenerateSummary && phase != MinutesContentPhase.LOADING
    summaryAction.visibility = if (showSummaryAction) View.VISIBLE else View.GONE
    summaryAction.isEnabled = !summaryGenerating
    summaryAction.alpha = if (summaryGenerating) 0.45f else 1f
    summaryAction.text = summaryActionLabel.ifBlank { "生成总结" }
    stateMessage.text = renderedPageState.message.ifBlank {
      when (phase) {
        MinutesContentPhase.LOADING -> "正在同步${tab.label}"
        MinutesContentPhase.ERROR -> "${tab.label}暂时不可用"
        else -> emptyMessage
      }
    }
    val showWarning = hasContent && (phase == MinutesContentPhase.ERROR || (phase == MinutesContentPhase.LOADING && renderedPageState.cached))
    warning.visibility = if (showWarning) View.VISIBLE else View.GONE
    warning.backgroundShape(if (phase == MinutesContentPhase.ERROR) MinutesPalette.dangerSoft else MinutesPalette.primarySoft)
    warningText.setTextColor(if (phase == MinutesContentPhase.ERROR) MinutesPalette.danger else MinutesPalette.secondary)
    warningText.text = renderedPageState.message.ifBlank {
      if (phase == MinutesContentPhase.LOADING) "正在同步，当前显示本机缓存" else "同步失败，正在显示本机缓存"
    }
  }
}

internal class MinutesTranscriptPage(
  context: Context,
  onAction: (Map<String, Any?>) -> Unit,
) : MinutesDetailPage(context, MinutesDetailTab.TRANSCRIPT, onAction) {
  internal val list = RecyclerView(context)
  private val rows = MinutesTranscriptPageAdapter(onAction)

  override val scrollingChild: View
    get() = list

  private var scrollStateListener: () -> Unit = {}

  init {
    list.layoutManager = LinearLayoutManager(context)
    list.adapter = rows
    list.clipToPadding = false
    list.setPadding(0, 0, 0, context.dp(32))
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
    rows.replace(state.transcript, state.canManageSpeakers)
    renderPageChrome(
      pageState = state.pageState(tab),
      hasContent = state.transcript.isNotEmpty(),
      emptyMessage = "暂无文字记录",
    )
  }
}

internal class MinutesSummaryPage(
  context: Context,
  onAction: (Map<String, Any?>) -> Unit,
) : MinutesDetailPage(context, MinutesDetailTab.SUMMARY, onAction) {
  internal val scroll = NestedScrollView(context)
  private val rows = LinearLayout(context)
  private var renderedBlocks: List<MinutesSummaryBlock> = emptyList()

  override val scrollingChild: View
    get() = scroll

  private var scrollStateListener: () -> Unit = {}

  init {
    scroll.isFillViewport = true
    scroll.overScrollMode = View.OVER_SCROLL_NEVER
    scroll.setOnScrollChangeListener { _, _, _, _, _ -> scrollStateListener() }
    rows.orientation = LinearLayout.VERTICAL
    rows.setPadding(context.dp(20), context.dp(10), context.dp(20), context.dp(48))
    scroll.addView(rows, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    installContent(scroll)
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
    replaceBlocks(state.summary)
    renderPageChrome(
      pageState = state.pageState(tab),
      hasContent = state.summary.isNotEmpty(),
      emptyMessage = "该会议暂未生成纪要",
      canGenerateSummary = state.canGenerateSummary,
      summaryGenerating = state.summaryGenerating,
      summaryActionLabel = state.summaryActionLabel,
    )
  }

  private fun replaceBlocks(blocks: List<MinutesSummaryBlock>) {
    if (renderedBlocks == blocks) return
    val retainedScrollY = scroll.scrollY
    renderedBlocks = blocks.toList()
    rows.removeAllViews()
    blocks.forEachIndexed { index, block ->
      rows.addView(
        summaryRow(block, index),
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
    }
    scroll.post { scroll.scrollTo(0, retainedScrollY.coerceAtMost(rows.height)) }
  }

  private fun summaryRow(block: MinutesSummaryBlock, index: Int): View {
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.TOP
      setPadding(0, context.dp(8), 0, context.dp(8))
      contentDescription = block.text
    }
    val marker = context.textView(textSizeSp = 15, color = MinutesPalette.text).apply {
      text = when (block.kind) {
        "bullet" -> "•"
        "ordered" -> "${index + 1}."
        "task" -> if (block.checked) "✓" else "□"
        "quote" -> "│"
        else -> ""
      }
    }
    val body = context.textView(textSizeSp = if (block.kind == "heading") 17 else 16).apply {
      text = block.text
      typeface = Typeface.create(Typeface.DEFAULT, if (block.kind == "heading") Typeface.BOLD else Typeface.NORMAL)
      setLineSpacing(0f, 1.25f)
      setTextIsSelectable(true)
    }
    row.addView(marker, LinearLayout.LayoutParams(context.dp(26), ViewGroup.LayoutParams.WRAP_CONTENT))
    row.addView(body, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    return row
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
    rows.replace(state.speakers)
    renderPageChrome(
      pageState = state.pageState(tab),
      hasContent = state.speakers.isNotEmpty(),
      emptyMessage = "暂无发言人信息",
    )
  }
}

private class MinutesTranscriptPageAdapter(
  private val onAction: (Map<String, Any?>) -> Unit,
) : RecyclerView.Adapter<MinutesTranscriptPageAdapter.Holder>() {
  private var rows: List<MinutesTranscriptLine> = emptyList()
  private var canManageSpeakers = false

  init {
    setHasStableIds(true)
  }

  fun replace(next: List<MinutesTranscriptLine>, canManage: Boolean) {
    if (rows == next && canManageSpeakers == canManage) return
    rows = next.toList()
    canManageSpeakers = canManage
    notifyDataSetChanged()
  }

  override fun getItemCount(): Int = rows.size
  override fun getItemId(position: Int): Long = rows[position].id.hashCode().toLong()
  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(parent)
  override fun onBindViewHolder(holder: Holder, position: Int) = holder.bind(rows[position], canManageSpeakers, onAction)

  internal class Holder(parent: ViewGroup) : RecyclerView.ViewHolder(LinearLayout(parent.context)) {
    private val root = itemView as LinearLayout
    private val metaRow = LinearLayout(parent.context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    private val avatar = TextView(parent.context).apply {
      gravity = Gravity.CENTER
      text = "人"
      setTextSize(10f)
      typeface = Typeface.DEFAULT_BOLD
    }
    private val speaker = parent.context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
    private val time = parent.context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
    private val body = parent.context.textView(textSizeSp = 16)

    init {
      root.orientation = LinearLayout.VERTICAL
      root.setPadding(parent.context.dp(20), parent.context.dp(18), parent.context.dp(20), parent.context.dp(12))
      metaRow.addView(avatar, LinearLayout.LayoutParams(parent.context.dp(18), parent.context.dp(18)))
      metaRow.addView(speaker, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
        leftMargin = parent.context.dp(8)
      })
      metaRow.addView(time, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      root.addView(metaRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, parent.context.dp(22)))
      body.setLineSpacing(0f, 1.35f)
      body.setTextIsSelectable(true)
      root.addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = parent.context.dp(8)
      })
    }

    fun bind(line: MinutesTranscriptLine, canManage: Boolean, onAction: (Map<String, Any?>) -> Unit) {
      val tone = minutesSpeakerTone(line.speakerId.ifBlank { line.speakerLabel })
      avatar.backgroundShape(tone.first, radiusDp = 9)
      avatar.setTextColor(tone.second)
      speaker.text = line.speakerLabel
      time.text = line.timestampLabel
      body.text = line.text
      body.alpha = if (line.isFinal) 1f else 0.72f
      root.contentDescription = "${line.speakerLabel}，${line.timestampLabel}，${line.text}"
      root.setOnClickListener {
        onAction(mapOf("type" to "seekTranscript", "lineId" to line.id, "positionMs" to line.startMs))
      }
      root.setOnLongClickListener(if (canManage) {
        View.OnLongClickListener {
          onAction(mapOf("type" to "requestSpeakerAction", "lineId" to line.id, "speakerId" to line.speakerId))
          true
        }
      } else null)
    }
  }
}

private class MinutesSpeakersPageAdapter(
  private val onAction: (Map<String, Any?>) -> Unit,
) : RecyclerView.Adapter<MinutesSpeakersPageAdapter.Holder>() {
  private var rows: List<MinutesSpeaker> = emptyList()

  init {
    setHasStableIds(true)
  }

  fun replace(next: List<MinutesSpeaker>) {
    if (rows == next) return
    rows = next.toList()
    notifyDataSetChanged()
  }

  override fun getItemCount(): Int = rows.size
  override fun getItemId(position: Int): Long = rows[position].id.hashCode().toLong()
  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(parent)
  override fun onBindViewHolder(holder: Holder, position: Int) = holder.bind(rows[position], onAction)

  internal class Holder(parent: ViewGroup) : RecyclerView.ViewHolder(FrameLayout(parent.context)) {
    private val root = itemView as FrameLayout
    private val avatar = TextView(parent.context).apply {
      gravity = Gravity.CENTER
      text = "人"
      setTextSize(14f)
      typeface = Typeface.DEFAULT_BOLD
    }
    private val labels = LinearLayout(parent.context).apply { orientation = LinearLayout.VERTICAL }
    private val name = parent.context.textView(textSizeSp = 16, weight = Typeface.BOLD)
    private val meta = parent.context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
    private val chevron = parent.context.textView("›", 24, MinutesPalette.faint).apply { gravity = Gravity.CENTER }

    init {
      root.minimumHeight = parent.context.dp(68)
      root.setPadding(parent.context.dp(20), parent.context.dp(8), parent.context.dp(16), parent.context.dp(8))
      root.addView(avatar, FrameLayout.LayoutParams(parent.context.dp(44), parent.context.dp(44), Gravity.CENTER_VERTICAL))
      labels.addView(name)
      labels.addView(meta, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = parent.context.dp(4)
      })
      root.addView(labels, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL).apply {
        leftMargin = parent.context.dp(58)
        rightMargin = parent.context.dp(36)
      })
      root.addView(chevron, FrameLayout.LayoutParams(parent.context.dp(32), parent.context.dp(44), Gravity.END or Gravity.CENTER_VERTICAL))
    }

    fun bind(speaker: MinutesSpeaker, onAction: (Map<String, Any?>) -> Unit) {
      val tone = minutesSpeakerTone(speaker.id)
      avatar.backgroundShape(tone.first, radiusDp = 22)
      avatar.setTextColor(tone.second)
      name.text = speaker.label
      meta.text = listOf("${speaker.segmentCount} 段", speaker.durationLabel).filter { it.isNotBlank() }.joinToString(" · ")
      chevron.visibility = if (speaker.canManage) View.VISIBLE else View.INVISIBLE
      root.isClickable = speaker.canManage
      root.isFocusable = speaker.canManage
      root.setOnClickListener(if (speaker.canManage) {
        View.OnClickListener { onAction(mapOf("type" to "manageSpeaker", "speakerId" to speaker.id)) }
      } else null)
    }
  }
}

private val minutesSpeakerTones = listOf(
  Color.rgb(232, 243, 255) to Color.rgb(51, 112, 255),
  Color.rgb(228, 247, 237) to Color.rgb(32, 161, 98),
  Color.rgb(240, 235, 255) to Color.rgb(127, 90, 240),
  Color.rgb(255, 240, 226) to Color.rgb(240, 124, 43),
  Color.rgb(225, 246, 245) to Color.rgb(22, 156, 150),
  Color.rgb(253, 234, 242) to Color.rgb(214, 79, 130),
)

private fun minutesSpeakerTone(key: String): Pair<Int, Int> =
  minutesSpeakerTones[(key.hashCode() and Int.MAX_VALUE) % minutesSpeakerTones.size]
