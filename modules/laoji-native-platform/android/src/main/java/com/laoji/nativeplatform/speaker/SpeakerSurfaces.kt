package com.laoji.nativeplatform.speaker

// MIN-SPEAKER-001 / UI-FORM-001: native manager and enrollment pages own pixels and hit areas.

import android.content.Context
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
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.laoji.nativeplatform.ui.installImeOverlapBottomPadding

internal class SpeakerManagerSurface(
  context: Context,
  private val onAction: (Map<String, Any?>) -> Unit,
) : LinearLayout(context) {
  private val paletteReady = SpeakerPalette.configure(context)
  private val titleBar = speakerTitleBar(context, "讲话人管理", onAction)
  private val list = RecyclerView(context)
  private val adapter = SpeakerProfileAdapter(onAction)
  private val state = LinearLayout(context)
  private val progress = ProgressBar(context)
  private val message = context.speakerText(sizeSp = 14, color = SpeakerPalette.secondary)
  private val stateAction = context.speakerText("重试", 14, SpeakerPalette.primary, Typeface.BOLD)
  private val createRow = context.speakerText("＋  新建讲话人", 16, SpeakerPalette.primary).apply {
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.speakerDp(20), 0, context.speakerDp(20), 0)
    speakerBackground(SpeakerPalette.surface)
    minHeight = context.speakerDp(64)
    isClickable = true
    isFocusable = true
    contentDescription = "新建讲话人"
    setOnClickListener { onAction(mapOf("type" to "create")) }
  }
  private var rendered = SpeakerManagerState(false, "loading", "", emptyList())

  init {
    orientation = VERTICAL
    setBackgroundColor(SpeakerPalette.page)
    addView(titleBar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(44)))

    addView(createRow, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(64)))
    addView(View(context).apply { setBackgroundColor(SpeakerPalette.page) }, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(8)))

    list.layoutManager = LinearLayoutManager(context)
    list.adapter = adapter
    list.setBackgroundColor(SpeakerPalette.surface)
    addView(list, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

    state.orientation = VERTICAL
    state.gravity = Gravity.CENTER
    state.setPadding(context.speakerDp(28), context.speakerDp(28), context.speakerDp(28), context.speakerDp(72))
    message.gravity = Gravity.CENTER
    message.setLineSpacing(0f, 1.25f)
    state.addView(progress, LayoutParams(context.speakerDp(24), context.speakerDp(24)))
    state.addView(message, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      topMargin = context.speakerDp(14)
    })
    stateAction.gravity = Gravity.CENTER
    stateAction.minWidth = context.speakerDp(76)
    stateAction.minHeight = context.speakerDp(36)
    stateAction.isClickable = true
    stateAction.isFocusable = true
    stateAction.setOnClickListener {
      onAction(mapOf("type" to if (rendered.guest) "login" else "retry"))
    }
    state.addView(stateAction, LayoutParams(context.speakerDp(100), context.speakerDp(40)).apply {
      topMargin = context.speakerDp(18)
    })
    addView(state, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
  }

  fun render(value: SpeakerManagerState) {
    rendered = value
    createRow.visibility = if (value.guest) View.GONE else View.VISIBLE
    adapter.submitList(value.speakers)
    val showState = value.guest || value.phase != "ready" || value.speakers.isEmpty()
    list.visibility = if (showState) View.GONE else View.VISIBLE
    state.visibility = if (showState) View.VISIBLE else View.GONE
    progress.visibility = if (!value.guest && value.phase == "loading") View.VISIBLE else View.GONE
    message.text = when {
      value.guest -> "讲话人暂时无法加载"
      value.message.isNotBlank() -> value.message
      value.phase == "loading" -> "正在加载讲话人"
      value.phase == "error" -> "讲话人暂时无法加载"
      else -> "暂无讲话人"
    }
    stateAction.visibility = if (value.guest || value.phase == "error") View.VISIBLE else View.GONE
    stateAction.text = "重试"
  }
}

private class SpeakerProfileAdapter(
  private val onAction: (Map<String, Any?>) -> Unit,
) : ListAdapter<SpeakerProfileModel, SpeakerProfileAdapter.Holder>(DIFF) {
  init { setHasStableIds(true) }
  override fun getItemId(position: Int): Long = getItem(position).id.hashCode().toLong()
  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(parent)
  override fun onBindViewHolder(holder: Holder, position: Int) = holder.bind(getItem(position), onAction)

  class Holder(parent: ViewGroup) : RecyclerView.ViewHolder(LinearLayout(parent.context)) {
    private val root = itemView as LinearLayout
    private val avatar = parent.context.speakerText("人", 14, SpeakerPalette.primary, Typeface.BOLD)
    private val labels = LinearLayout(parent.context)
    private val name = parent.context.speakerText(sizeSp = 16)
    private val meta = parent.context.speakerText(sizeSp = 12, color = SpeakerPalette.secondary)
    private val chevron = parent.context.speakerText("›", 24, SpeakerPalette.tertiary)

    init {
      root.layoutParams = RecyclerView.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
      )
      root.orientation = LinearLayout.HORIZONTAL
      root.gravity = Gravity.CENTER_VERTICAL
      root.minimumHeight = parent.context.speakerDp(66)
      root.setPadding(parent.context.speakerDp(16), 0, parent.context.speakerDp(12), 0)
      root.speakerBackground(SpeakerPalette.surface)
      root.isClickable = true
      root.isFocusable = true
      avatar.gravity = Gravity.CENTER
      avatar.speakerBackground(SpeakerPalette.primarySoft, 20)
      root.addView(avatar, LinearLayout.LayoutParams(parent.context.speakerDp(40), parent.context.speakerDp(40)))
      labels.orientation = LinearLayout.VERTICAL
      labels.addView(name)
      labels.addView(meta, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = parent.context.speakerDp(3) })
      root.addView(labels, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = parent.context.speakerDp(12) })
      chevron.gravity = Gravity.CENTER
      root.addView(chevron, LinearLayout.LayoutParams(parent.context.speakerDp(32), parent.context.speakerDp(44)))
    }

    fun bind(profile: SpeakerProfileModel, onAction: (Map<String, Any?>) -> Unit) {
      name.text = profile.name
      meta.text = when {
        profile.quality in 0f..0.3999f -> "建议补充采集"
        profile.sampleCount > 0 -> "${profile.sampleCount} 份声纹"
        else -> "声纹已建立"
      }
      meta.setTextColor(if (profile.quality in 0f..0.3999f) SpeakerPalette.danger else SpeakerPalette.secondary)
      root.contentDescription = "管理讲话人${profile.name}"
      root.setOnClickListener { onAction(mapOf("type" to "open", "speakerId" to profile.id)) }
    }
  }

  companion object {
    private val DIFF = object : DiffUtil.ItemCallback<SpeakerProfileModel>() {
      override fun areItemsTheSame(oldItem: SpeakerProfileModel, newItem: SpeakerProfileModel) = oldItem.id == newItem.id
      override fun areContentsTheSame(oldItem: SpeakerProfileModel, newItem: SpeakerProfileModel) = oldItem == newItem
    }
  }
}

internal class SpeakerEnrollmentSurface(
  context: Context,
  private val onAction: (Map<String, Any?>) -> Unit,
) : LinearLayout(context) {
  private val paletteReady = SpeakerPalette.configure(context)
  private val titleBar = speakerTitleBar(context, "声纹采集", onAction, showDelete = true)
  private val scroll = ScrollView(context)
  private val content = LinearLayout(context)
  private val nameInput = EditText(context)
  private val saveName = context.speakerText("保存", 14, SpeakerPalette.primary, Typeface.BOLD)
  private val prompt = context.speakerText(sizeSp = 18, weight = Typeface.BOLD)
  private val progressText = context.speakerText(sizeSp = 14, color = SpeakerPalette.secondary)
  private val waveform = SpeakerWaveformView(context)
  private val error = context.speakerText(sizeSp = 13, color = SpeakerPalette.danger)
  private val consent = context.speakerText(sizeSp = 13, color = SpeakerPalette.secondary)
  private val reprocess = context.speakerText(sizeSp = 15, color = SpeakerPalette.primary)
  private val statePanel = LinearLayout(context)
  private val stateProgress = ProgressBar(context)
  private val stateMessage = context.speakerText(sizeSp = 14, color = SpeakerPalette.secondary)
  private val stateAction = context.speakerText("重试", 14, SpeakerPalette.primary, Typeface.BOLD)
  private val bottom = FrameLayout(context)
  private val singleAction = context.speakerText(sizeSp = 16, weight = Typeface.BOLD)
  private val dualActions = LinearLayout(context)
  private val secondaryAction = context.speakerText(sizeSp = 16, weight = Typeface.BOLD)
  private val primaryAction = context.speakerText(sizeSp = 16, weight = Typeface.BOLD)
  private var applying = false
  private var rendered = SpeakerEnrollmentState(
    guest = false,
    speakerId = "",
    title = "声纹采集",
    phase = "ready",
    message = "",
    name = "",
    nameEditable = true,
    nameSaveEnabled = false,
    enrollmentPhase = "idle",
    elapsedMs = 0,
    maxDurationMs = 15_000,
    level = 0f,
    errorMessage = "",
    canDelete = false,
    canRecord = true,
    canSubmit = false,
    voiceprintText = "",
  )

  init {
    orientation = VERTICAL
    setBackgroundColor(SpeakerPalette.page)
    installImeOverlapBottomPadding()
    addView(titleBar, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(44)))
    content.orientation = VERTICAL
    content.setPadding(context.speakerDp(20), context.speakerDp(16), context.speakerDp(20), context.speakerDp(24))
    scroll.addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(scroll, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    statePanel.orientation = VERTICAL
    statePanel.gravity = Gravity.CENTER
    statePanel.setPadding(context.speakerDp(28), context.speakerDp(28), context.speakerDp(28), context.speakerDp(64))
    stateMessage.gravity = Gravity.CENTER
    stateMessage.setLineSpacing(0f, 1.25f)
    statePanel.addView(stateProgress, LayoutParams(context.speakerDp(24), context.speakerDp(24)))
    statePanel.addView(stateMessage, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      topMargin = context.speakerDp(14)
    })
    stateAction.gravity = Gravity.CENTER
    stateAction.isClickable = true
    stateAction.isFocusable = true
    stateAction.setOnClickListener { onAction(mapOf("type" to "retry")) }
    statePanel.addView(stateAction, LayoutParams(context.speakerDp(100), context.speakerDp(40)).apply {
      topMargin = context.speakerDp(18)
    })
    addView(statePanel, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    addView(bottom, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(72)))
    buildContent()
    buildBottomActions()
  }

  private fun buildContent() {
    val nameRow = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    nameInput.setTextSize(16f)
    nameInput.setTextColor(SpeakerPalette.text)
    nameInput.setHintTextColor(SpeakerPalette.tertiary)
    nameInput.hint = "输入人名"
    nameInput.isSingleLine = true
    nameInput.maxLines = 1
    nameInput.imeOptions = EditorInfo.IME_ACTION_DONE
    nameInput.setOnEditorActionListener { view, actionId, _ ->
      if (actionId != EditorInfo.IME_ACTION_DONE) return@setOnEditorActionListener false
      context.getSystemService(InputMethodManager::class.java)
        ?.hideSoftInputFromWindow(view.windowToken, 0)
      view.clearFocus()
      true
    }
    nameInput.speakerBackground(SpeakerPalette.surfaceOverlay, 6)
    nameInput.setPadding(context.speakerDp(12), 0, context.speakerDp(12), 0)
    nameInput.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) {
        if (!applying) onAction(mapOf("type" to "nameChange", "name" to value.toString()))
      }
      override fun afterTextChanged(value: Editable?) = Unit
    })
    nameRow.addView(nameInput, LayoutParams(0, context.speakerDp(44), 1f))
    saveName.gravity = Gravity.CENTER
    saveName.isClickable = true
    saveName.isFocusable = true
    saveName.setOnClickListener { onAction(mapOf("type" to "saveName", "name" to nameInput.text.toString())) }
    nameRow.addView(saveName, LayoutParams(context.speakerDp(64), context.speakerDp(44)).apply { leftMargin = context.speakerDp(8) })
    content.addView(nameRow, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(44)))

    content.addView(context.speakerText("朗读以下文字", 14, SpeakerPalette.secondary), LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = context.speakerDp(28) })
    prompt.setLineSpacing(0f, 1.35f)
    prompt.setPadding(context.speakerDp(16), context.speakerDp(16), context.speakerDp(16), context.speakerDp(16))
    prompt.speakerBackground(SpeakerPalette.primarySoft, 6)
    content.addView(prompt, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = context.speakerDp(12) })
    content.addView(progressText, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(24)).apply { topMargin = context.speakerDp(28) })
    content.addView(waveform, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(58)).apply { topMargin = context.speakerDp(12) })
    error.minHeight = context.speakerDp(42)
    error.gravity = Gravity.CENTER
    content.addView(error, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(42)).apply { topMargin = context.speakerDp(12) })
    consent.gravity = Gravity.CENTER_VERTICAL
    consent.minHeight = context.speakerDp(48)
    consent.setPadding(context.speakerDp(8), 0, context.speakerDp(8), 0)
    consent.isClickable = true
    consent.isFocusable = true
    consent.setOnClickListener {
      onAction(mapOf("type" to "toggleVoiceprintConsent", "speakerId" to rendered.speakerId))
    }
    content.addView(consent, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(48)))
    reprocess.gravity = Gravity.CENTER_VERTICAL
    reprocess.minHeight = context.speakerDp(48)
    reprocess.setPadding(context.speakerDp(12), 0, context.speakerDp(12), 0)
    reprocess.speakerBackground(SpeakerPalette.surface, 6)
    reprocess.isClickable = true
    reprocess.isFocusable = true
    reprocess.setOnClickListener {
      if (rendered.canReprocess && rendered.speakerId.isNotBlank()) {
        onAction(mapOf("type" to "reprocess", "speakerId" to rendered.speakerId))
      }
    }
    content.addView(reprocess, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(48)).apply {
      topMargin = context.speakerDp(8)
    })
  }

  fun render(value: SpeakerEnrollmentState) {
    rendered = value
    titleBar.findViewWithTag<TextView>("title")?.text = value.title
    titleBar.findViewWithTag<View>("delete")?.visibility = if (value.canDelete) View.VISIBLE else View.INVISIBLE
    applying = true
    if (nameInput.text.toString() != value.name) nameInput.setText(value.name)
    applying = false
    nameInput.isEnabled = value.nameEditable && value.enrollmentPhase !in setOf("recording", "saving")
    saveName.visibility = if (value.speakerId.isNotBlank()) View.VISIBLE else View.GONE
    saveName.isEnabled = value.nameSaveEnabled
    saveName.alpha = if (value.nameSaveEnabled) 1f else 0.35f
    prompt.text = value.voiceprintText
    waveform.setLevel(value.level)
    val seconds = (value.elapsedMs / 1000).coerceAtLeast(0)
    val maximum = (value.maxDurationMs / 1000).coerceAtLeast(1)
    progressText.text = "${phaseLabel(value.enrollmentPhase)}    00:${seconds.toString().padStart(2, '0')} / 00:${maximum.toString().padStart(2, '0')}"
    error.text = value.errorMessage.ifBlank { value.message }
    consent.text = if (value.voiceprintConsentAccepted) {
      "☑ 我同意将本次录音上传，用于建立或补充讲话人声纹"
    } else {
      "☐ 我同意将本次录音上传，用于建立或补充讲话人声纹"
    }
    consent.contentDescription = if (value.voiceprintConsentAccepted) {
      "已同意上传录音用于建立或补充讲话人声纹"
    } else {
      "未同意上传录音用于建立或补充讲话人声纹"
    }
    val reprocessBusy = value.reprocessPhase == "queued" || value.reprocessPhase == "running"
    reprocess.visibility = if (value.speakerId.isNotBlank()) View.VISIBLE else View.GONE
    reprocess.text = value.reprocessMessage.ifBlank {
      when (value.reprocessPhase) {
        "queued" -> "等待重新匹配"
        "running" -> "正在重新匹配"
        "completed" -> "重新匹配旧会议"
        "failed" -> "重试旧会议匹配"
        else -> "重新匹配旧会议"
      }
    }
    reprocess.setTextColor(if (reprocessBusy) SpeakerPalette.secondary else SpeakerPalette.primary)
    reprocess.isEnabled = value.canReprocess && !reprocessBusy
    reprocess.isClickable = value.canReprocess && !reprocessBusy
    reprocess.alpha = if (value.canReprocess) 1f else 0.35f
    reprocess.contentDescription = reprocess.text
    renderActions(value)
    val ready = !value.guest && value.phase == "ready"
    scroll.visibility = if (ready) View.VISIBLE else View.GONE
    statePanel.visibility = if (ready || value.guest) View.GONE else View.VISIBLE
    stateProgress.visibility = if (value.phase == "loading") View.VISIBLE else View.GONE
    stateMessage.text = value.message.ifBlank {
      if (value.phase == "loading") "正在加载讲话人" else "讲话人暂时无法加载"
    }
    stateAction.visibility = if (value.phase == "error") View.VISIBLE else View.GONE
    bottom.visibility = if (ready || value.guest) View.VISIBLE else View.GONE
  }

  private fun renderActions(value: SpeakerEnrollmentState) {
    val showDualActions = !value.guest && value.enrollmentPhase == "ready" && value.canSubmit
    singleAction.visibility = if (showDualActions) View.GONE else View.VISIBLE
    dualActions.visibility = if (showDualActions) View.VISIBLE else View.GONE
    if (showDualActions) {
      bindBottomAction(secondaryAction, "重新录制", "retake", primary = false)
      bindBottomAction(
        primaryAction,
        "保存声纹",
        "submitRecording",
        primary = true,
        enabled = value.voiceprintConsentAccepted,
      )
      return
    }
    when {
      value.guest -> bindBottomAction(singleAction, "重新加载", "login", primary = true)
      value.enrollmentPhase == "recording" -> bindBottomAction(
        singleAction,
        "停止录制",
        "stopRecording",
        primary = false,
        danger = true,
      )
      value.enrollmentPhase == "preparing" -> bindBottomAction(
        singleAction,
        "正在准备",
        "startRecording",
        primary = true,
        enabled = false,
      )
      value.enrollmentPhase == "stopping" -> bindBottomAction(
        singleAction,
        "正在保存录音",
        "stopRecording",
        primary = true,
        enabled = false,
      )
      value.enrollmentPhase == "saving" -> bindBottomAction(
        singleAction,
        "正在保存声纹",
        "submitRecording",
        primary = true,
        enabled = false,
      )
      else -> bindBottomAction(
        singleAction,
        "开始录制",
        "startRecording",
        primary = true,
        enabled = value.canRecord,
      )
    }
  }

  private fun buildBottomActions() {
    bottom.speakerBackground(SpeakerPalette.surface)
    singleAction.gravity = Gravity.CENTER
    singleAction.setOnClickListener { emitBottomAction(singleAction) }
    bottom.addView(singleAction, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      context.speakerDp(48),
      Gravity.CENTER_VERTICAL,
    ).apply {
      leftMargin = context.speakerDp(20)
      rightMargin = context.speakerDp(20)
      topMargin = context.speakerDp(10)
      bottomMargin = context.speakerDp(14)
    })

    dualActions.orientation = HORIZONTAL
    dualActions.gravity = Gravity.CENTER
    dualActions.setPadding(context.speakerDp(20), context.speakerDp(10), context.speakerDp(20), context.speakerDp(14))
    secondaryAction.gravity = Gravity.CENTER
    secondaryAction.setOnClickListener { emitBottomAction(secondaryAction) }
    primaryAction.gravity = Gravity.CENTER
    primaryAction.setOnClickListener { emitBottomAction(primaryAction) }
    dualActions.addView(secondaryAction, LayoutParams(0, context.speakerDp(48), 1f))
    dualActions.addView(primaryAction, LayoutParams(0, context.speakerDp(48), 1.4f).apply {
      leftMargin = context.speakerDp(10)
    })
    bottom.addView(dualActions, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT,
    ))
  }

  private fun emitBottomAction(button: TextView) {
    val action = button.tag as? String ?: return
    onAction(mapOf("type" to action, "speakerId" to rendered.speakerId))
  }

  private fun bindBottomAction(
    button: TextView,
    label: String,
    action: String,
    primary: Boolean,
    danger: Boolean = false,
    enabled: Boolean = true,
  ) {
    val color = when {
      primary -> SpeakerPalette.primary
      danger -> SpeakerPalette.dangerSoft
      else -> SpeakerPalette.surfaceOverlay
    }
    val textColor = when {
      primary -> android.graphics.Color.WHITE
      danger -> SpeakerPalette.danger
      else -> SpeakerPalette.text
    }
    button.text = label
    button.tag = action
    button.setTextColor(textColor)
    button.speakerBackground(color, 6)
    button.isClickable = enabled
    button.isFocusable = enabled
    button.isEnabled = enabled
    button.alpha = if (enabled) 1f else 0.35f
    button.contentDescription = label
  }

  private fun phaseLabel(phase: String): String = when (phase) {
    "preparing" -> "正在准备麦克风"
    "recording" -> "正在采集声音"
    "stopping" -> "正在保存录音"
    "ready" -> "录音已就绪"
    "saving" -> "正在保存声纹"
    "error" -> "录音需要重试"
    else -> "尚未录制"
  }
}

private fun speakerTitleBar(
  context: Context,
  title: String,
  onAction: (Map<String, Any?>) -> Unit,
  showDelete: Boolean = false,
): FrameLayout = FrameLayout(context).apply {
  speakerBackground(SpeakerPalette.surface)
  val back = context.speakerIconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back, "返回")
  back.setOnClickListener { onAction(mapOf("type" to "back")) }
  addView(back, FrameLayout.LayoutParams(context.speakerDp(44), context.speakerDp(44), Gravity.START or Gravity.CENTER_VERTICAL))
  addView(context.speakerText(title, 17, SpeakerPalette.text, Typeface.BOLD).apply {
    tag = "title"
    gravity = Gravity.CENTER
  }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.speakerDp(44), Gravity.CENTER).apply {
    leftMargin = context.speakerDp(52)
    rightMargin = context.speakerDp(52)
  })
  if (showDelete) {
    val delete = context.speakerIconButton(android.R.drawable.ic_menu_delete, "删除讲话人", SpeakerPalette.danger).apply { tag = "delete" }
    delete.setOnClickListener { onAction(mapOf("type" to "delete")) }
    addView(delete, FrameLayout.LayoutParams(context.speakerDp(44), context.speakerDp(44), Gravity.END or Gravity.CENTER_VERTICAL))
  }
}
