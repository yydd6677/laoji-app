package com.laoji.nativeplatform.minutes

// MIN-REC-LAYOUT-001 / MIN-REC-STATE-001: source-mapped Record V3 presentation.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.constraintlayout.widget.ConstraintLayout
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.laoji.nativeplatform.audio.RecorderLevelFrame
import com.laoji.nativeplatform.audio.RecorderLevelHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

internal class MinutesRecordingSurface(
  context: Context,
  private val onAction: (Map<String, Any?>) -> Unit,
) : ConstraintLayout(context) {
  private val topBar = FrameLayout(context)
  private val backButton = context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back, "返回")
  private val titleSection = ConstraintLayout(context)
  private val title = context.textView(textSizeSp = 24, weight = Typeface.BOLD)
  private val timeIcon = ImageView(context).apply { id = View.generateViewId() }
  private val startedAt = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val tabBar = FrameLayout(context)
  private val transcriptTab = context.textView("文字记录", textSizeSp = 14, weight = Typeface.BOLD)
  private val tabIndicator = View(context)
  private val divider = View(context)
  private val content = FrameLayout(context)
  private val transcript = RecyclerView(context)
  private val transcriptAdapter = MinutesRecordingTranscriptAdapter()
  private val errorBanner = LinearLayout(context)
  private val errorText = context.textView(textSizeSp = 13, color = MinutesPalette.danger)
  private val retryText = context.textView("重试", textSizeSp = 14, color = MinutesPalette.danger, weight = Typeface.BOLD)
  private val latestButton = context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_down_bottom, "回到最新转写")
  private val bottomPanel = ConstraintLayout(context).apply { id = View.generateViewId() }
  private val timer = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val waveContainer = FrameLayout(context)
  private val waveform = MinutesRecordingWaveformView(context)
  private val actionRow = LinearLayout(context)
  private val statusPill = LinearLayout(context)
  private val statusDot = View(context)
  private val statusText = context.textView(textSizeSp = 16, color = MinutesPalette.secondary)
  private val pauseButton = ImageButton(context)
  private val stopButton = ImageButton(context)
  private val layoutManager = LinearLayoutManager(context)
  private var renderedState = MinutesRecordingState()
  private var followingLatest = true
  private var lastTranscriptSize = 0
  private var levelCollectionJob: Job? = null
  private var collectingSessionId: String? = null
  private var surfaceVisible = false
  private var nativeElapsedMs = 0L

  init {
    setBackgroundColor(MinutesPalette.surface)
    clipChildren = false
    buildTopBar()
    buildTitleSection()
    buildTranscriptArea()
    buildBottomPanel()
    bindActions()
  }

  private fun buildTopBar() {
    topBar.id = View.generateViewId()
    topBar.setBackgroundColor(MinutesPalette.surface)
    backButton.setPadding(context.dp(10), context.dp(10), context.dp(10), context.dp(10))
    addView(
      topBar,
      LayoutParams(0, context.dp(MinutesRecordingV3Contract.TOP_BAR_HEIGHT_DP)).apply {
        topToTop = LayoutParams.PARENT_ID
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
      },
    )
    topBar.addView(
      backButton,
      FrameLayout.LayoutParams(context.dp(44), context.dp(44), Gravity.START).apply {
        leftMargin = context.dp(6)
      },
    )
  }

  private fun buildTitleSection() {
    titleSection.id = View.generateViewId()
    titleSection.minimumHeight = context.dp(MinutesRecordingV3Contract.TITLE_MIN_HEIGHT_DP)
    addView(
      titleSection,
      LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topToBottom = topBar.id
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
      },
    )

    title.id = View.generateViewId()
    title.minimumHeight = context.dp(36)
    title.maxLines = 2
    title.ellipsize = TextUtils.TruncateAt.END
    title.gravity = Gravity.CENTER_VERTICAL
    titleSection.addView(
      title,
      LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topToTop = LayoutParams.PARENT_ID
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
        topMargin = context.dp(20)
        marginStart = context.dp(20)
        marginEnd = context.dp(10)
      },
    )

    startedAt.id = View.generateViewId()
    startedAt.gravity = Gravity.CENTER_VERTICAL
    titleSection.addView(
      startedAt,
      LayoutParams(0, context.dp(22)).apply {
        topToBottom = title.id
        startToEnd = timeIcon.id
        endToEnd = LayoutParams.PARENT_ID
        bottomToBottom = LayoutParams.PARENT_ID
        topMargin = context.dp(6)
        bottomMargin = context.dp(16)
        marginStart = context.dp(4)
        marginEnd = context.dp(20)
      },
    )

    timeIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_time_outline)
    timeIcon.imageTintList = ColorStateList.valueOf(MinutesPalette.secondary)
    timeIcon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    titleSection.addView(
      timeIcon,
      LayoutParams(context.dp(12), context.dp(12)).apply {
        startToStart = LayoutParams.PARENT_ID
        topToTop = startedAt.id
        bottomToBottom = startedAt.id
        marginStart = context.dp(20)
      },
    )

    tabBar.id = View.generateViewId()
    addView(
      tabBar,
      LayoutParams(0, context.dp(MinutesRecordingV3Contract.TAB_HEIGHT_DP)).apply {
        topToBottom = titleSection.id
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
        marginStart = context.dp(10)
        marginEnd = context.dp(20)
      },
    )
    transcriptTab.gravity = Gravity.CENTER
    transcriptTab.setTextColor(MinutesPalette.text)
    tabBar.addView(
      transcriptTab,
      FrameLayout.LayoutParams(context.dp(72), context.dp(40), Gravity.START),
    )
    tabIndicator.backgroundShape(MinutesPalette.primary, radiusDp = 1)
    tabBar.addView(
      tabIndicator,
      FrameLayout.LayoutParams(context.dp(45), context.dp(2), Gravity.START or Gravity.BOTTOM).apply {
        leftMargin = context.dp(6)
      },
    )

    divider.id = View.generateViewId()
    divider.setBackgroundColor(MinutesPalette.divider)
    addView(
      divider,
      LayoutParams(0, 1).apply {
        topToBottom = tabBar.id
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
        marginStart = context.dp(20)
        marginEnd = context.dp(20)
      },
    )
  }

  private fun buildTranscriptArea() {
    content.id = View.generateViewId()
    addView(
      content,
      LayoutParams(0, 0).apply {
        topToBottom = divider.id
        bottomToTop = bottomPanel.id
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
      },
    )

    transcript.layoutManager = layoutManager
    transcript.adapter = transcriptAdapter
    transcript.clipChildren = false
    transcript.clipToPadding = false
    transcript.setPadding(context.dp(20), 0, context.dp(20), 0)
    transcript.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (newState != RecyclerView.SCROLL_STATE_DRAGGING || transcriptAdapter.itemCount == 0) return
        val atEnd = layoutManager.findLastVisibleItemPosition() >= transcriptAdapter.itemCount - 2
        setFollowingLatest(atEnd, emit = true)
      }
    })
    content.addView(
      transcript,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )

    errorBanner.orientation = LinearLayout.HORIZONTAL
    errorBanner.gravity = Gravity.CENTER_VERTICAL
    errorBanner.setPadding(context.dp(12), 0, context.dp(8), 0)
    errorBanner.backgroundShape(MinutesPalette.dangerSoft, radiusDp = 6)
    errorBanner.addView(errorText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    retryText.gravity = Gravity.CENTER
    errorBanner.addView(retryText, LinearLayout.LayoutParams(context.dp(52), context.dp(44)))
    errorBanner.visibility = View.GONE
    content.addView(
      errorBanner,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(44), Gravity.TOP).apply {
        leftMargin = context.dp(20)
        rightMargin = context.dp(20)
        topMargin = context.dp(8)
      },
    )

    latestButton.imageTintList = ColorStateList.valueOf(MinutesPalette.secondary)
    latestButton.backgroundShape(MinutesPalette.surface, radiusDp = 22)
    latestButton.elevation = context.dp(4).toFloat()
    latestButton.visibility = View.GONE
    content.addView(
      latestButton,
      FrameLayout.LayoutParams(context.dp(44), context.dp(44), Gravity.END or Gravity.BOTTOM).apply {
        rightMargin = context.dp(16)
        bottomMargin = context.dp(16)
      },
    )
  }

  private fun buildBottomPanel() {
    bottomPanel.setBackgroundColor(MinutesPalette.surface)
    addView(
      bottomPanel,
      LayoutParams(0, context.dp(MinutesRecordingV3Contract.BOTTOM_PANEL_HEIGHT_DP)).apply {
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
        bottomToBottom = LayoutParams.PARENT_ID
      },
    )

    timer.id = View.generateViewId()
    timer.gravity = Gravity.CENTER
    bottomPanel.addView(
      timer,
      LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(MinutesRecordingV3Contract.DURATION_HEIGHT_DP)).apply {
        topToTop = LayoutParams.PARENT_ID
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
        topMargin = context.dp(10)
      },
    )

    waveContainer.id = View.generateViewId()
    waveContainer.setPadding(context.dp(16), 0, context.dp(16), 0)
    bottomPanel.addView(
      waveContainer,
      LayoutParams(0, context.dp(MinutesRecordingV3Contract.WAVE_CONTAINER_HEIGHT_DP)).apply {
        topToBottom = timer.id
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
        topMargin = context.dp(4)
      },
    )
    waveContainer.addView(
      waveform,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(MinutesRecordingV3Contract.WAVE_HEIGHT_DP), Gravity.CENTER_VERTICAL),
    )

    actionRow.id = View.generateViewId()
    actionRow.orientation = LinearLayout.HORIZONTAL
    actionRow.gravity = Gravity.CENTER_VERTICAL
    actionRow.setPadding(
      context.dp(MinutesRecordingV3Contract.ACTION_HORIZONTAL_PADDING_DP),
      context.dp(10),
      context.dp(MinutesRecordingV3Contract.ACTION_HORIZONTAL_PADDING_DP),
      context.dp(10),
    )
    bottomPanel.addView(
      actionRow,
      LayoutParams(0, context.dp(MinutesRecordingV3Contract.ACTION_ROW_HEIGHT_DP)).apply {
        topToBottom = waveContainer.id
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
      },
    )

    statusPill.orientation = LinearLayout.HORIZONTAL
    statusPill.gravity = Gravity.CENTER_VERTICAL
    statusPill.setPadding(context.dp(20), 0, context.dp(12), 0)
    statusPill.backgroundShape(MinutesPalette.page, radiusDp = 100)
    statusPill.isClickable = false
    statusDot.backgroundShape(MinutesPalette.primary, radiusDp = 4)
    statusPill.addView(statusDot, LinearLayout.LayoutParams(context.dp(8), context.dp(8)))
    statusText.maxLines = 1
    statusText.ellipsize = TextUtils.TruncateAt.END
    statusPill.addView(
      statusText,
      LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
        leftMargin = context.dp(8)
      },
    )
    actionRow.addView(
      statusPill,
      LinearLayout.LayoutParams(0, context.dp(MinutesRecordingV3Contract.ACTION_HEIGHT_DP), 1f),
    )

    configureActionButton(pauseButton)
    actionRow.addView(
      pauseButton,
      LinearLayout.LayoutParams(context.dp(78), context.dp(MinutesRecordingV3Contract.ACTION_HEIGHT_DP)).apply {
        leftMargin = context.dp(MinutesRecordingV3Contract.ACTION_GAP_DP)
      },
    )
    configureActionButton(stopButton)
    actionRow.addView(
      stopButton,
      LinearLayout.LayoutParams(context.dp(78), context.dp(MinutesRecordingV3Contract.ACTION_HEIGHT_DP)).apply {
        leftMargin = context.dp(MinutesRecordingV3Contract.ACTION_GAP_DP)
      },
    )
  }

  private fun configureActionButton(button: ImageButton) {
    button.scaleType = ImageView.ScaleType.CENTER
    button.setPadding(context.dp(13), context.dp(13), context.dp(13), context.dp(13))
    button.isFocusable = true
  }

  private fun bindActions() {
    backButton.setOnClickListener {
      onAction(mapOf("type" to "back", "meetingId" to renderedState.meetingId))
    }
    pauseButton.setOnClickListener {
      onAction(
        mapOf(
          "type" to "toggleRecordingPause",
          "meetingId" to renderedState.meetingId,
          "resume" to (renderedState.phase == MinutesRecordingPhase.PAUSED),
        ),
      )
    }
    stopButton.setOnClickListener { emitStopOrStart() }
    retryText.setOnClickListener {
      onAction(mapOf("type" to "retryRecording", "meetingId" to renderedState.meetingId))
    }
    latestButton.setOnClickListener {
      setFollowingLatest(true, emit = true)
      scrollToLatest()
    }
  }

  fun render(state: MinutesRecordingState) {
    val sessionChanged = renderedState.meetingId != state.meetingId
    if (sessionChanged) {
      nativeElapsedMs = state.elapsedMs.coerceAtLeast(0L)
    } else {
      nativeElapsedMs = maxOf(nativeElapsedMs, state.elapsedMs.coerceAtLeast(0L))
    }
    renderedState = state
    title.text = state.title.ifBlank { "会议记录" }
    startedAt.text = state.startedAtLabel
    val showTime = state.startedAtLabel.isNotBlank()
    startedAt.visibility = if (showTime) View.VISIBLE else View.INVISIBLE
    timeIcon.visibility = if (showTime) View.VISIBLE else View.INVISIBLE

    renderTimer()

    transcriptAdapter.submitList(state.transcript) {
      if (followingLatest && state.transcript.size >= lastTranscriptSize) scrollToLatest()
      lastTranscriptSize = state.transcript.size
    }
    setFollowingLatest(state.followLatest, emit = false)

    errorText.text = state.errorMessage
    errorBanner.visibility = if (state.errorMessage.isBlank()) View.GONE else View.VISIBLE
    transcript.setPadding(
      context.dp(20),
      if (state.errorMessage.isBlank()) 0 else context.dp(52),
      context.dp(20),
      0,
    )

    renderStatus(state)
    renderPauseButton(state)
    renderStopButton(state)
    applyResponsiveActionWidths(width)
    updateLevelCollection()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    surfaceVisible = isShown && windowVisibility == View.VISIBLE
    updateLevelCollection()
  }

  override fun onDetachedFromWindow() {
    stopLevelCollection(clearWaveform = true)
    surfaceVisible = false
    super.onDetachedFromWindow()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    surfaceVisible = isVisible && windowVisibility == View.VISIBLE
    updateLevelCollection()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    surfaceVisible = visibility == View.VISIBLE && isShown
    updateLevelCollection()
  }

  private fun updateLevelCollection() {
    val sessionId = renderedState.meetingId
    val shouldCollect = isAttachedToWindow &&
      surfaceVisible &&
      sessionId.isNotBlank() &&
      renderedState.phase == MinutesRecordingPhase.RECORDING

    if (!shouldCollect) {
      stopLevelCollection(clearWaveform = true)
      return
    }

    if (collectingSessionId == sessionId && levelCollectionJob?.isActive == true) {
      waveform.setActive(true)
      return
    }
    val sessionChanged = collectingSessionId != null && collectingSessionId != sessionId
    stopLevelCollection(clearWaveform = sessionChanged)
    waveform.setActive(true)
    collectingSessionId = sessionId
    levelCollectionJob = CoroutineScope(Dispatchers.Main.immediate).launch {
      RecorderLevelHub.observe(sessionId)
        .filterNotNull()
        .collect(::renderRecorderLevel)
    }
  }

  private fun stopLevelCollection(clearWaveform: Boolean) {
    levelCollectionJob?.cancel()
    levelCollectionJob = null
    collectingSessionId = null
    waveform.setActive(false, clear = clearWaveform)
  }

  private fun renderRecorderLevel(frame: RecorderLevelFrame) {
    if (
      frame.sessionId != renderedState.meetingId ||
      renderedState.phase != MinutesRecordingPhase.RECORDING
    ) return
    nativeElapsedMs = maxOf(nativeElapsedMs, frame.durationMs)
    renderTimer()
    waveform.offerLevel(frame.normalized)
  }

  private fun renderTimer() {
    val clock = formatClock(nativeElapsedMs)
    timer.text = clock
    timer.contentDescription = "${renderedState.statusLabel}，已录制 $clock"
  }

  private fun renderStatus(state: MinutesRecordingState) {
    statusText.text = state.statusLabel.ifBlank {
      when (state.phase) {
        MinutesRecordingPhase.PREPARING -> "正在连接"
        MinutesRecordingPhase.RECORDING -> "实时转写中"
        MinutesRecordingPhase.PAUSED -> "录音已暂停"
        MinutesRecordingPhase.STOPPING -> "正在停止"
        MinutesRecordingPhase.SAVING -> "正在保存"
        MinutesRecordingPhase.FAILED -> "录音失败"
        else -> "准备录音"
      }
    }
    val tone = when (state.phase) {
      MinutesRecordingPhase.RECORDING -> MinutesPalette.primary
      MinutesRecordingPhase.PAUSED -> MinutesPalette.warning
      MinutesRecordingPhase.FAILED -> MinutesPalette.danger
      else -> MinutesPalette.faint
    }
    statusDot.backgroundShape(tone, radiusDp = 4)
    statusText.setTextColor(if (state.phase == MinutesRecordingPhase.FAILED) MinutesPalette.danger else MinutesPalette.secondary)
    statusPill.contentDescription = statusText.text
  }

  private fun renderPauseButton(state: MinutesRecordingState) {
    val enabled = state.canPause
    pauseButton.isEnabled = enabled
    pauseButton.alpha = if (enabled) 1f else 0.45f
    pauseButton.backgroundShape(if (enabled) MinutesPalette.primarySoft else MinutesPalette.page, radiusDp = 100)
    pauseButton.imageTintList = ColorStateList.valueOf(if (enabled) MinutesPalette.primary else MinutesPalette.disabled)
    pauseButton.setImageResource(
      if (state.phase == MinutesRecordingPhase.PAUSED) com.laoji.nativeplatform.R.drawable.laoji_ic_play_filled
      else com.laoji.nativeplatform.R.drawable.laoji_ic_pause_filled,
    )
    pauseButton.contentDescription = if (state.phase == MinutesRecordingPhase.PAUSED) "继续录音" else "暂停录音"
  }

  private fun renderStopButton(state: MinutesRecordingState) {
    val enabled = state.canStop || state.canStart
    stopButton.isEnabled = enabled
    stopButton.alpha = if (enabled) 1f else 0.45f
    stopButton.backgroundShape(MinutesPalette.page, radiusDp = 100)
    stopButton.imageTintList = ColorStateList.valueOf(if (enabled) MinutesPalette.text else MinutesPalette.disabled)
    when {
      state.canStop -> stopButton.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_stop_filled)
      state.phase == MinutesRecordingPhase.FAILED -> stopButton.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_refresh)
      else -> stopButton.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_microphone_filled)
    }
    stopButton.contentDescription = when {
      state.canStop -> "结束并保存会议录音"
      state.phase == MinutesRecordingPhase.FAILED -> "重试开始会议录音"
      else -> "开始会议录音"
    }
  }

  private fun emitStopOrStart() {
    val type = if (renderedState.canStop) "stopRecording" else "startRecording"
    onAction(mapOf("type" to type, "meetingId" to renderedState.meetingId))
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    applyResponsiveActionWidths(w)
  }

  private fun applyResponsiveActionWidths(widthPx: Int) {
    if (widthPx <= 0) return
    val widthDp = (widthPx / resources.displayMetrics.density).toInt()
    val widths = MinutesRecordingV3Contract.actionWidths(widthDp)
    statusPill.layoutParams = (statusPill.layoutParams as LinearLayout.LayoutParams).apply {
      width = widths.statusWidthDp?.let(context::dp) ?: 0
      weight = if (widths.statusWidthDp == null) 1f else 0f
    }
    for (button in listOf(pauseButton, stopButton)) {
      button.layoutParams = (button.layoutParams as LinearLayout.LayoutParams).apply {
        width = context.dp(widths.actionWidthDp)
        weight = 0f
      }
    }
  }

  private fun scrollToLatest() {
    val last = transcriptAdapter.itemCount - 1
    if (last >= 0) transcript.scrollToPosition(last)
  }

  private fun setFollowingLatest(value: Boolean, emit: Boolean) {
    if (followingLatest == value) return
    followingLatest = value
    latestButton.visibility = if (!value && transcriptAdapter.itemCount > 0) View.VISIBLE else View.GONE
    if (emit) {
      onAction(
        mapOf(
          "type" to "setFollowLatest",
          "meetingId" to renderedState.meetingId,
          "followLatest" to value,
        ),
      )
    }
  }
}
