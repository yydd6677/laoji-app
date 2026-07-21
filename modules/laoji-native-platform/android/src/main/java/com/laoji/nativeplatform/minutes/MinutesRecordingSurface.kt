package com.laoji.nativeplatform.minutes

// MIN-REC-LAYOUT-001 / MIN-REC-STATE-001: source-mapped Record V3 presentation.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.text.InputFilter
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
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
  private val titleContainer = FrameLayout(context).apply { id = View.generateViewId() }
  private val title = context.textView(textSizeSp = 24, weight = Typeface.BOLD)
  private val titleEditor = EditText(context)
  private val timeIcon = ImageView(context).apply { id = View.generateViewId() }
  private val startedAt = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val locationRow = LinearLayout(context).apply { id = View.generateViewId() }
  private val locationIcon = ImageView(context)
  private val locationText = context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
  private val tabBar = FrameLayout(context)
  private val transcriptTab = context.textView("文字记录", textSizeSp = 16, weight = Typeface.BOLD)
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
  private val actionRow = ConstraintLayout(context)
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
  private var editingTitle = false

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

    title.minimumHeight = context.dp(36)
    title.maxLines = 2
    title.ellipsize = TextUtils.TruncateAt.END
    title.gravity = Gravity.CENTER_VERTICAL
    title.contentDescription = "编辑会议标题"
    title.isClickable = true
    title.isFocusable = true
    titleSection.addView(
      titleContainer,
      LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topToTop = LayoutParams.PARENT_ID
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
        topMargin = context.dp(20)
        marginStart = context.dp(20)
        marginEnd = context.dp(10)
      },
    )
    titleContainer.addView(
      title,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    titleEditor.apply {
      setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 24f)
      setTextColor(MinutesPalette.text)
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      includeFontPadding = false
      background = null
      gravity = Gravity.CENTER_VERTICAL
      maxLines = 2
      minHeight = context.dp(36)
      setPadding(0, 0, 0, 0)
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      imeOptions = EditorInfo.IME_ACTION_DONE
      filters = arrayOf(InputFilter.LengthFilter(200))
      visibility = View.GONE
      contentDescription = "会议标题"
    }
    titleContainer.addView(
      titleEditor,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )

    startedAt.id = View.generateViewId()
    startedAt.gravity = Gravity.CENTER_VERTICAL
    titleSection.addView(
      startedAt,
      LayoutParams(0, context.dp(22)).apply {
        topToBottom = titleContainer.id
        startToEnd = timeIcon.id
        endToEnd = LayoutParams.PARENT_ID
        topMargin = context.dp(6)
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

    locationRow.orientation = LinearLayout.HORIZONTAL
    locationRow.gravity = Gravity.CENTER_VERTICAL
    locationRow.minimumHeight = context.dp(36)
    locationRow.setPadding(0, 0, 0, 0)
    locationIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_location_outline)
    locationIcon.imageTintList = ColorStateList.valueOf(MinutesPalette.secondary)
    locationIcon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    locationRow.addView(
      locationIcon,
      LinearLayout.LayoutParams(context.dp(14), context.dp(14)),
    )
    locationRow.addView(
      locationText,
      LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
        marginStart = context.dp(4)
      },
    )
    titleSection.addView(
      locationRow,
      LayoutParams(0, context.dp(36)).apply {
        topToBottom = startedAt.id
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
        bottomToBottom = LayoutParams.PARENT_ID
        marginStart = context.dp(20)
        marginEnd = context.dp(20)
        bottomMargin = context.dp(10)
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
    tabBar.addView(transcriptTab, FrameLayout.LayoutParams(context.dp(82), context.dp(44), Gravity.START))
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
    // Final transcript reconciliation can replace provisional rows immediately
    // before this recording surface is replaced by the detail surface. The
    // default item-removal animator may then finish after detach and ask
    // RecyclerView to recycle a still-attached row, crashing the main thread.
    // Live transcript updates prioritize continuity over decorative row motion.
    transcript.itemAnimator = null
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

    latestButton.minimumWidth = 0
    latestButton.minimumHeight = 0
    latestButton.setPadding(context.dp(10), context.dp(10), context.dp(10), context.dp(10))
    latestButton.imageTintList = ColorStateList.valueOf(MinutesPalette.secondary)
    latestButton.backgroundShape(MinutesPalette.surface, radiusDp = 22)
    latestButton.elevation = context.dp(4).toFloat()
    latestButton.visibility = View.GONE
    content.addView(
      latestButton,
      FrameLayout.LayoutParams(context.dp(38), context.dp(38), Gravity.END or Gravity.BOTTOM).apply {
        rightMargin = context.dp(16)
        bottomMargin = context.dp(12)
      },
    )
  }

  private fun buildBottomPanel() {
    pauseButton.id = View.generateViewId()
    stopButton.id = View.generateViewId()
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
    timer.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 16f)
    timer.setTextColor(MinutesPalette.secondary)
    timer.typeface = Typeface.MONOSPACE
    bottomPanel.addView(
      timer,
      LayoutParams(0, context.dp(MinutesRecordingV3Contract.DURATION_HEIGHT_DP)).apply {
        topToTop = LayoutParams.PARENT_ID
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
      },
    )

    waveContainer.id = View.generateViewId()
    waveContainer.setPadding(context.dp(4), context.dp(6), context.dp(4), 0)
    bottomPanel.addView(
      waveContainer,
      LayoutParams(0, context.dp(MinutesRecordingV3Contract.WAVE_CONTAINER_HEIGHT_DP)).apply {
        topToBottom = timer.id
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
      },
    )
    waveContainer.addView(
      waveform,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        context.dp(MinutesRecordingV3Contract.WAVE_HEIGHT_DP),
        Gravity.TOP,
      ),
    )

    actionRow.id = View.generateViewId()
    bottomPanel.addView(
      actionRow,
      LayoutParams(0, context.dp(MinutesRecordingV3Contract.ACTION_ROW_HEIGHT_DP)).apply {
        topToBottom = waveContainer.id
        bottomToBottom = LayoutParams.PARENT_ID
        startToStart = LayoutParams.PARENT_ID
        endToEnd = LayoutParams.PARENT_ID
      },
    )

    configureActionButton(pauseButton)
    actionRow.addView(
      pauseButton,
      LayoutParams(
        context.dp(MinutesRecordingV3Contract.PAUSE_WIDTH_DP),
        context.dp(MinutesRecordingV3Contract.PAUSE_HEIGHT_DP),
      ).apply {
        startToStart = LayoutParams.PARENT_ID
        endToStart = stopButton.id
        topToTop = LayoutParams.PARENT_ID
        bottomToBottom = LayoutParams.PARENT_ID
        marginEnd = context.dp(MinutesRecordingV3Contract.ACTION_GAP_DP / 2)
        horizontalChainStyle = LayoutParams.CHAIN_PACKED
      },
    )
    configureActionButton(stopButton)
    actionRow.addView(
      stopButton,
      LayoutParams(
        context.dp(MinutesRecordingV3Contract.STOP_WIDTH_DP),
        context.dp(MinutesRecordingV3Contract.STOP_HEIGHT_DP),
      ).apply {
        startToEnd = pauseButton.id
        endToEnd = LayoutParams.PARENT_ID
        topToTop = LayoutParams.PARENT_ID
        bottomToBottom = LayoutParams.PARENT_ID
        marginStart = context.dp(MinutesRecordingV3Contract.ACTION_GAP_DP / 2)
      },
    )
  }

  private fun configureActionButton(button: ImageButton) {
    button.scaleType = ImageView.ScaleType.CENTER
    button.background = null
    button.isFocusable = true
  }

  private fun bindActions() {
    backButton.setOnClickListener {
      if (editingTitle) {
        commitTitleEdit()
        return@setOnClickListener
      }
      onAction(mapOf("type" to "back", "meetingId" to renderedState.meetingId))
    }
    title.setOnClickListener { beginTitleEdit() }
    titleEditor.setOnEditorActionListener { _, actionId, _ ->
      if (actionId != EditorInfo.IME_ACTION_DONE) return@setOnEditorActionListener false
      commitTitleEdit()
      true
    }
    titleEditor.onFocusChangeListener = View.OnFocusChangeListener { _, hasFocus ->
      if (!hasFocus && editingTitle) commitTitleEdit()
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
    locationRow.setOnClickListener {
      if (!renderedState.canEditLocation || renderedState.locationLoading) return@setOnClickListener
      onAction(
        mapOf(
          "type" to "requestMeetingLocation",
          "meetingId" to renderedState.meetingId,
        ),
      )
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
    if (!editingTitle) title.text = state.title.ifBlank { "新录音" }
    startedAt.text = state.startedAtLabel
    val showTime = state.startedAtLabel.isNotBlank()
    startedAt.visibility = if (showTime) View.VISIBLE else View.INVISIBLE
    timeIcon.visibility = if (showTime) View.VISIBLE else View.INVISIBLE
    val locationLabel = when {
      state.locationLoading -> "正在定位"
      state.location.isNotBlank() -> state.location
      else -> "添加地点"
    }
    locationText.text = locationLabel
    locationText.setTextColor(if (state.location.isBlank()) MinutesPalette.faint else MinutesPalette.secondary)
    locationRow.isEnabled = state.canEditLocation && !state.locationLoading
    locationRow.isClickable = locationRow.isEnabled
    locationRow.isFocusable = locationRow.isEnabled
    locationRow.alpha = if (state.locationLoading) 0.72f else 1f
    locationRow.contentDescription = if (state.locationLoading) "正在获取当前位置" else locationLabel

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

    renderPauseButton(state)
    renderStopButton(state)
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

  private fun renderPauseButton(state: MinutesRecordingState) {
    val enabled = state.canPause
    pauseButton.isEnabled = enabled
    pauseButton.alpha = if (enabled) 1f else 0.5f
    pauseButton.backgroundShape(if (enabled) MinutesPalette.primarySoft else MinutesPalette.page, radiusDp = 100)
    pauseButton.setPadding(context.dp(27), context.dp(16), context.dp(27), context.dp(16))
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
    stopButton.alpha = if (enabled) 1f else 0.5f
    stopButton.backgroundShape(
      when {
        state.canStop -> MinutesPalette.page
        enabled -> MinutesPalette.primarySoft
        else -> MinutesPalette.page
      },
      radiusDp = 100,
    )
    stopButton.setPadding(context.dp(27), context.dp(16), context.dp(27), context.dp(16))
    stopButton.imageTintList = ColorStateList.valueOf(
      when {
        !enabled -> MinutesPalette.disabled
        state.canStop -> MinutesPalette.text
        else -> MinutesPalette.primary
      },
    )
    when {
      state.canStop -> stopButton.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_stop_filled)
      state.phase == MinutesRecordingPhase.FAILED -> stopButton.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_refresh)
      else -> stopButton.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_microphone_filled)
    }
    stopButton.contentDescription = when {
      state.canStop -> "结束并保存会议录音"
      state.phase == MinutesRecordingPhase.FAILED -> "重新开始会议录音"
      else -> "开始会议录音"
    }
  }

  private fun emitStopOrStart() {
    val type = if (renderedState.canStop) "stopRecording" else "startRecording"
    onAction(mapOf("type" to type, "meetingId" to renderedState.meetingId))
  }

  private fun beginTitleEdit() {
    if (editingTitle) return
    editingTitle = true
    titleEditor.setText(title.text)
    titleEditor.setSelection(titleEditor.text.length)
    title.visibility = View.INVISIBLE
    titleEditor.visibility = View.VISIBLE
    titleEditor.requestFocus()
    titleEditor.post {
      context.getSystemService(InputMethodManager::class.java)
        ?.showSoftInput(titleEditor, InputMethodManager.SHOW_IMPLICIT)
    }
  }

  private fun commitTitleEdit() {
    if (!editingTitle) return
    val previous = renderedState.title.ifBlank { "新录音" }
    val next = titleEditor.text.toString().trim().ifBlank { previous }
    editingTitle = false
    titleEditor.clearFocus()
    context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(titleEditor.windowToken, 0)
    titleEditor.visibility = View.GONE
    title.visibility = View.VISIBLE
    title.text = next
    if (next != previous) {
      onAction(
        mapOf(
          "type" to "saveTitle",
          "meetingId" to renderedState.meetingId,
          "title" to next,
        ),
      )
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
