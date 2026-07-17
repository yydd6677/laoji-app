package com.laoji.nativeplatform.schedulevoice

// UI-OVERLAY-001 / MIN-AUDIO-001: fixed-slot native schedule voice sheet and gestures.

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.laoji.nativeplatform.ui.requestInsetsWhenAttached
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

private object VoiceUi {
  const val ACCENT = 0xff1456f0.toInt()
  const val TEXT = 0xff1f2329.toInt()
  const val SECONDARY = 0xff646a73.toInt()
  const val BORDER = 0xffdee0e3.toInt()
  const val MUTED = 0xfff5f6f7.toInt()
  const val ERROR = 0xfff54a45.toInt()
  fun dp(context: Context, value: Float): Int = (value * context.resources.displayMetrics.density + 0.5f).toInt()
}

private class VoiceIconView(context: Context, private val kind: String) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = VoiceUi.TEXT
    style = Paint.Style.STROKE
    strokeWidth = VoiceUi.dp(context, 2f).toFloat()
    strokeCap = Paint.Cap.ROUND
  }

  init {
    isClickable = true
    isFocusable = true
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f
    val cy = height / 2f
    if (kind == "close") {
      val inset = VoiceUi.dp(context, 7f).toFloat()
      canvas.drawLine(cx - inset, cy - inset, cx + inset, cy + inset, paint)
      canvas.drawLine(cx + inset, cy - inset, cx - inset, cy + inset, paint)
    }
  }
}

private class VoiceMicView(context: Context) : View(context) {
  var recording: Boolean = false
    set(value) {
      field = value
      contentDescription = if (value) "停止语音输入" else "开始语音输入"
      invalidate()
    }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val icon = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    style = Paint.Style.STROKE
    strokeWidth = VoiceUi.dp(context, 2.2f).toFloat()
    strokeCap = Paint.Cap.ROUND
  }

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "开始语音输入"
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f
    val cy = height / 2f
    fill.color = if (recording) VoiceUi.ERROR else VoiceUi.ACCENT
    canvas.drawCircle(cx, cy, VoiceUi.dp(context, 32f).toFloat(), fill)
    val mic = RectF(
      cx - VoiceUi.dp(context, 6f),
      cy - VoiceUi.dp(context, 13f),
      cx + VoiceUi.dp(context, 6f),
      cy + VoiceUi.dp(context, 6f),
    )
    canvas.drawRoundRect(mic, VoiceUi.dp(context, 6f).toFloat(), VoiceUi.dp(context, 6f).toFloat(), icon)
    canvas.drawArc(
      RectF(cx - VoiceUi.dp(context, 11f), cy - VoiceUi.dp(context, 4f), cx + VoiceUi.dp(context, 11f), cy + VoiceUi.dp(context, 13f)),
      0f,
      180f,
      false,
      icon,
    )
    canvas.drawLine(cx, cy + VoiceUi.dp(context, 13f), cx, cy + VoiceUi.dp(context, 19f), icon)
    canvas.drawLine(cx - VoiceUi.dp(context, 7f), cy + VoiceUi.dp(context, 19f), cx + VoiceUi.dp(context, 7f), cy + VoiceUi.dp(context, 19f), icon)
  }
}

@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class ScheduleVoiceHostView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true
  val onScheduleVoiceAction by EventDispatcher<Map<String, Any>>()
  private var bridgeEventsEnabled = true
  private var actionListener: ((Map<String, Any>) -> Unit)? = null

  private val overlayRoot = FrameLayout(context)
  private val backdrop = View(context).apply { setBackgroundColor(0x66000000) }
  private val sheet = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    background = GradientDrawable().apply {
      setColor(Color.WHITE)
      cornerRadii = floatArrayOf(
        VoiceUi.dp(context, 12f).toFloat(), VoiceUi.dp(context, 12f).toFloat(),
        VoiceUi.dp(context, 12f).toFloat(), VoiceUi.dp(context, 12f).toFloat(),
        0f, 0f, 0f, 0f,
      )
    }
    isClickable = true
  }
  private val title = TextView(context)
  private val close = VoiceIconView(context, "close")
  private val inputPanel = LinearLayout(context)
  private val input = EditText(context)
  private val error = TextView(context)
  private val status = TextView(context)
  private val mic = VoiceMicView(context)
  private val parseButton = Button(context)
  private val busyPanel = LinearLayout(context)
  private val busyLabel = TextView(context)
  private val confirmPanel = LinearLayout(context)
  private val confirmTitle = TextView(context)
  private val fields = LinearLayout(context)
  private val retryButton = Button(context)
  private val detailButton = Button(context)
  private val saveButton = Button(context)
  private var rendering = false
  private var snapshot = ScheduleVoiceSnapshot()
  private var touchStartedAt = 0L
  private var touchStartedFromInput = false

  init {
    // UI-OVERLAY-001: The native sheet and backdrop must share the full host display list.
    setWillNotDraw(false)
    clipToPadding = false
    orientation = VERTICAL
    addView(
      overlayRoot,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )
    overlayRoot.addView(backdrop, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    overlayRoot.addView(
      sheet,
      FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM),
    )
    buildHeader()
    buildInputPanel()
    buildBusyPanel()
    buildConfirmPanel()
    backdrop.setOnClickListener { emit("close") }
    close.setOnClickListener { emit("close") }
    ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
      val bottomInset = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
      if (sheet.paddingBottom != bottomInset) sheet.setPadding(0, 0, 0, bottomInset)
      insets
    }
    requestInsetsWhenAttached()
    animateEntrance()
    render(ScheduleVoiceSnapshot())
  }

  fun setBridgeEventsEnabled(value: Boolean) {
    bridgeEventsEnabled = value
  }

  fun setActionListener(listener: ((Map<String, Any>) -> Unit)?) {
    actionListener = listener
  }

  fun setSnapshot(value: Map<String, Any?>?) {
    val parsed = ScheduleVoiceSnapshot.parse(value) ?: return
    snapshot = parsed
    render(parsed)
  }

  fun dismiss(onClosed: () -> Unit) {
    input.clearFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
      ?.hideSoftInputFromWindow(windowToken, 0)
    backdrop.animate().cancel()
    sheet.animate().cancel()
    backdrop.animate().alpha(0f).setDuration(170L).start()
    sheet.animate()
      .translationY(VoiceUi.dp(context, 48f).toFloat())
      .setDuration(170L)
      .withEndAction(onClosed)
      .start()
  }

  private fun buildHeader() {
    val row = FrameLayout(context)
    title.text = "语音新建日程"
    title.textSize = 17f
    title.setTextColor(VoiceUi.TEXT)
    title.gravity = Gravity.CENTER
    title.typeface = android.graphics.Typeface.DEFAULT_BOLD
    row.addView(title, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    close.contentDescription = "关闭语音新建日程"
    row.addView(
      close,
      FrameLayout.LayoutParams(VoiceUi.dp(context, 48f), VoiceUi.dp(context, 48f), Gravity.END or Gravity.CENTER_VERTICAL),
    )
    sheet.addView(row, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 50f)))
  }

  private fun buildInputPanel() {
    inputPanel.orientation = LinearLayout.VERTICAL
    inputPanel.setPadding(VoiceUi.dp(context, 20f), VoiceUi.dp(context, 8f), VoiceUi.dp(context, 20f), VoiceUi.dp(context, 14f))
    input.hint = "输入或说出日程内容"
    input.textSize = 16f
    input.setTextColor(VoiceUi.TEXT)
    input.setHintTextColor(0xff8f959e.toInt())
    input.gravity = Gravity.TOP or Gravity.START
    input.setPadding(VoiceUi.dp(context, 12f), VoiceUi.dp(context, 10f), VoiceUi.dp(context, 12f), VoiceUi.dp(context, 10f))
    input.background = GradientDrawable().apply {
      setColor(VoiceUi.MUTED)
      setStroke(VoiceUi.dp(context, 1f), VoiceUi.BORDER)
      cornerRadius = VoiceUi.dp(context, 6f).toFloat()
    }
    input.maxLines = 5
    input.imeOptions = EditorInfo.IME_ACTION_DONE
    input.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
        if (!rendering) emit("text-change", mapOf("text" to (s?.toString() ?: "")))
      }
      override fun afterTextChanged(s: Editable?) = Unit
    })
    inputPanel.addView(input, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 108f)))

    error.textSize = 12f
    error.setTextColor(VoiceUi.ERROR)
    error.gravity = Gravity.CENTER_VERTICAL
    error.maxLines = 2
    inputPanel.addView(error, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 38f)))

    status.textSize = 13f
    status.setTextColor(VoiceUi.SECONDARY)
    status.gravity = Gravity.CENTER
    inputPanel.addView(status, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 24f)))

    val micDock = FrameLayout(context)
    micDock.addView(
      mic,
      FrameLayout.LayoutParams(VoiceUi.dp(context, 88f), VoiceUi.dp(context, 88f), Gravity.CENTER),
    )
    inputPanel.addView(micDock, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 94f)))
    mic.setOnTouchListener { _, event -> handleMicTouch(event) }

    parseButton.text = "解析日程"
    parseButton.textSize = 16f
    parseButton.setTextColor(Color.WHITE)
    parseButton.setBackgroundColor(VoiceUi.ACCENT)
    parseButton.setOnClickListener { emit("parse") }
    inputPanel.addView(parseButton, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)))
    sheet.addView(inputPanel, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
  }

  private fun buildBusyPanel() {
    busyPanel.orientation = LinearLayout.VERTICAL
    busyPanel.gravity = Gravity.CENTER
    busyPanel.setPadding(VoiceUi.dp(context, 20f), VoiceUi.dp(context, 28f), VoiceUi.dp(context, 20f), VoiceUi.dp(context, 42f))
    busyPanel.addView(ProgressBar(context), LinearLayout.LayoutParams(VoiceUi.dp(context, 36f), VoiceUi.dp(context, 36f)))
    busyLabel.textSize = 14f
    busyLabel.setTextColor(VoiceUi.SECONDARY)
    busyLabel.gravity = Gravity.CENTER
    busyPanel.addView(busyLabel, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 52f)))
    sheet.addView(busyPanel, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 184f)))
  }

  private fun buildConfirmPanel() {
    confirmPanel.orientation = LinearLayout.VERTICAL
    confirmPanel.setPadding(VoiceUi.dp(context, 20f), VoiceUi.dp(context, 6f), VoiceUi.dp(context, 20f), VoiceUi.dp(context, 14f))
    confirmTitle.textSize = 20f
    confirmTitle.setTextColor(VoiceUi.TEXT)
    confirmTitle.typeface = android.graphics.Typeface.DEFAULT_BOLD
    confirmTitle.gravity = Gravity.CENTER_VERTICAL
    confirmPanel.addView(confirmTitle, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)))

    fields.orientation = LinearLayout.VERTICAL
    val scroll = ScrollView(context).apply { addView(fields) }
    confirmPanel.addView(scroll, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))

    val actions = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    retryButton.text = "重新输入"
    detailButton.text = "详细编辑"
    saveButton.text = "保存"
    retryButton.setOnClickListener { emit("retry-input") }
    detailButton.setOnClickListener { emit("edit-details") }
    saveButton.setOnClickListener { emit("save") }
    for (button in listOf(retryButton, detailButton, saveButton)) {
      button.textSize = 15f
      actions.addView(button, LinearLayout.LayoutParams(0, VoiceUi.dp(context, 48f), 1f))
    }
    confirmPanel.addView(actions, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)))
    sheet.addView(confirmPanel, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 430f)))
  }

  private fun render(value: ScheduleVoiceSnapshot) {
    rendering = true
    inputPanel.visibility = if (value.phase in setOf(ScheduleVoicePhase.INPUT, ScheduleVoicePhase.PREPARING, ScheduleVoicePhase.RECORDING)) View.VISIBLE else View.GONE
    busyPanel.visibility = if (value.phase in setOf(ScheduleVoicePhase.PARSING, ScheduleVoicePhase.SAVING)) View.VISIBLE else View.GONE
    confirmPanel.visibility = if (value.phase == ScheduleVoicePhase.CONFIRM) View.VISIBLE else View.GONE
    if (input.text.toString() != value.text) input.setText(value.text)
    input.isEnabled = value.phase == ScheduleVoicePhase.INPUT
    error.text = value.errorMessage
    status.text = value.statusLabel
    mic.recording = value.phase == ScheduleVoicePhase.RECORDING
    mic.isEnabled = value.phase in setOf(ScheduleVoicePhase.INPUT, ScheduleVoicePhase.RECORDING)
    parseButton.isEnabled = value.canParse && value.phase == ScheduleVoicePhase.INPUT
    parseButton.alpha = if (parseButton.isEnabled) 1f else 0.4f
    busyLabel.text = value.statusLabel.ifBlank {
      if (value.phase == ScheduleVoicePhase.SAVING) "正在保存" else "正在解析"
    }
    confirmTitle.text = value.title.ifBlank { "未命名日程" }
    fields.removeAllViews()
    value.fields.forEach { field ->
      val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
      }
      val label = TextView(context).apply {
        text = field.label
        textSize = 14f
        setTextColor(VoiceUi.SECONDARY)
      }
      val content = TextView(context).apply {
        text = field.value
        textSize = 15f
        setTextColor(VoiceUi.TEXT)
        gravity = Gravity.END or Gravity.CENTER_VERTICAL
      }
      row.addView(label, LinearLayout.LayoutParams(VoiceUi.dp(context, 86f), LayoutParams.MATCH_PARENT))
      row.addView(content, LinearLayout.LayoutParams(0, LayoutParams.MATCH_PARENT, 1f))
      fields.addView(row, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)))
    }
    saveButton.isEnabled = value.canSave
    detailButton.isEnabled = value.canEditDetails
    rendering = false
  }

  private fun handleMicTouch(event: MotionEvent): Boolean {
    if (!mic.isEnabled) return false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        touchStartedAt = SystemClock.elapsedRealtime()
        touchStartedFromInput = snapshot.phase == ScheduleVoicePhase.INPUT
        if (touchStartedFromInput) {
          performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
          emit("record-start")
        }
        return true
      }
      MotionEvent.ACTION_UP -> {
        val heldFor = SystemClock.elapsedRealtime() - touchStartedAt
        if (ScheduleVoiceGesture.shouldStopOnRelease(touchStartedFromInput, heldFor)) {
          performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
          emit("record-stop")
        }
        touchStartedFromInput = false
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        if (touchStartedFromInput && ScheduleVoiceGesture.shouldStopOnRelease(true, SystemClock.elapsedRealtime() - touchStartedAt)) {
          emit("record-stop")
        }
        touchStartedFromInput = false
        return true
      }
    }
    return true
  }

  private fun emit(type: String, extra: Map<String, Any> = emptyMap()) {
    val payload = mapOf("type" to type) + extra
    actionListener?.invoke(payload)
    if (bridgeEventsEnabled) onScheduleVoiceAction(payload)
  }

  private fun animateEntrance() {
    backdrop.alpha = 0f
    sheet.translationY = VoiceUi.dp(context, 48f).toFloat()
    AnimatorSet().apply {
      playTogether(
        ObjectAnimator.ofFloat(backdrop, View.ALPHA, 0f, 1f),
        ObjectAnimator.ofFloat(sheet, View.TRANSLATION_Y, sheet.translationY, 0f),
      )
      duration = 170L
      start()
    }
  }

  override fun onDetachedFromWindow() {
    backdrop.animate().cancel()
    sheet.animate().cancel()
    super.onDetachedFromWindow()
  }
}
