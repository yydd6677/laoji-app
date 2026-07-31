package com.laoji.nativeplatform.schedulevoice

// UI-OVERLAY-001 / MIN-AUDIO-001: fixed-slot native schedule voice sheet and gestures.

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.SystemClock
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.laoji.nativeplatform.ui.NativeUiPalette
import com.laoji.nativeplatform.ui.NativeUiTokens
import com.laoji.nativeplatform.ui.NativeUserMessages
import com.laoji.nativeplatform.ui.currentNavigationBarInsetBottom
import com.laoji.nativeplatform.ui.requestInsetsWhenAttached
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

private object VoiceUi {
  fun dp(context: Context, value: Float): Int = (NativeUiTokens.dp(context, value) + 0.5f).toInt()

  // [PRODUCT] The recording feedback radius is 1.4x the original treatment.
  // Keep both geometry and density integral: 2 rings * 1.4 rounds to 3 rings,
  // while 43dp + 17dp preserves the requested 60dp outer radius.
  const val PULSE_RING_COUNT = 3
  const val PULSE_START_RADIUS_DP = 43f
  const val PULSE_TRAVEL_RADIUS_DP = 17f
}

private enum class VoiceButtonStyle { PRIMARY, SECONDARY, TEXT }

private class VoiceButton(context: Context) : TextView(context) {
  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
}

private fun voiceButtonBackground(
  context: Context,
  palette: NativeUiPalette,
  style: VoiceButtonStyle,
): StateListDrawable {
  fun shape(color: Int, stroke: Int? = null) = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    setColor(color)
    cornerRadius = NativeUiTokens.dp(context, 6f)
    stroke?.let { setStroke(VoiceUi.dp(context, 1f).coerceAtLeast(1), it) }
  }
  return StateListDrawable().apply {
    when (style) {
      VoiceButtonStyle.PRIMARY -> {
        addState(intArrayOf(-android.R.attr.state_enabled), shape(palette.textDisabled))
        addState(intArrayOf(android.R.attr.state_pressed), shape(palette.primaryPressed))
        addState(intArrayOf(), shape(palette.primary))
      }
      VoiceButtonStyle.SECONDARY -> {
        addState(intArrayOf(-android.R.attr.state_enabled), shape(palette.surface, palette.divider))
        addState(intArrayOf(android.R.attr.state_pressed), shape(palette.surfaceOverlay, palette.divider))
        addState(intArrayOf(), shape(palette.surface, palette.divider))
      }
      VoiceButtonStyle.TEXT -> {
        addState(intArrayOf(-android.R.attr.state_enabled), shape(Color.TRANSPARENT))
        addState(intArrayOf(android.R.attr.state_pressed), shape(palette.primarySoft))
        addState(intArrayOf(), shape(Color.TRANSPARENT))
      }
    }
  }
}

private fun VoiceButton.applyFeishuStyle(palette: NativeUiPalette, style: VoiceButtonStyle) {
  gravity = Gravity.CENTER
  includeFontPadding = false
  isClickable = true
  isFocusable = true
  setTextSize(TypedValue.COMPLEX_UNIT_SP, if (style == VoiceButtonStyle.TEXT) 16f else 17f)
  typeface = android.graphics.Typeface.DEFAULT
  val horizontalPadding = VoiceUi.dp(context, if (style == VoiceButtonStyle.TEXT) 16f else 28f)
  setPadding(horizontalPadding, 0, horizontalPadding, 0)
  background = voiceButtonBackground(context, palette, style)
  setTextColor(
    when (style) {
      VoiceButtonStyle.PRIMARY -> ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
        intArrayOf(palette.surface, palette.surface),
      )
      VoiceButtonStyle.SECONDARY -> ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
        intArrayOf(palette.textDisabled, palette.textPrimary),
      )
      VoiceButtonStyle.TEXT -> ColorStateList(
        arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
        intArrayOf(palette.textDisabled, palette.primary),
      )
    },
  )
}

private class VoiceIconView(context: Context, private val kind: String) : View(context) {
  private val palette = NativeUiTokens.palette(context)
  private val background = Paint(Paint.ANTI_ALIAS_FLAG)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.textPrimary
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
    background.color = when {
      !isEnabled -> palette.surfaceOverlay
      isPressed -> palette.primarySoft
      else -> Color.TRANSPARENT
    }
    canvas.drawRoundRect(
      RectF(
        cx - VoiceUi.dp(context, 18f),
        cy - VoiceUi.dp(context, 18f),
        cx + VoiceUi.dp(context, 18f),
        cy + VoiceUi.dp(context, 18f),
      ),
      VoiceUi.dp(context, 6f).toFloat(),
      VoiceUi.dp(context, 6f).toFloat(),
      background,
    )
    paint.color = if (isEnabled) palette.textPrimary else palette.textDisabled
    if (kind == "close") {
      val inset = VoiceUi.dp(context, 7f).toFloat()
      canvas.drawLine(cx - inset, cy - inset, cx + inset, cy + inset, paint)
      canvas.drawLine(cx + inset, cy - inset, cx - inset, cy + inset, paint)
    }
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }
}

private class VoiceMicView(context: Context) : View(context) {
  private val palette = NativeUiTokens.palette(context)
  private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = VoiceUi.dp(context, 1.5f).toFloat()
  }
  private var pulseProgress = 0f
  private var pulseAnimator: ValueAnimator? = null
  var recording: Boolean = false
    set(value) {
      if (field == value) return
      field = value
      contentDescription = if (value) "停止语音输入" else "开始语音输入"
      if (value) startPulse() else stopPulse()
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
    if (recording) {
      repeat(VoiceUi.PULSE_RING_COUNT) { index ->
        drawPulseRing(
          canvas,
          cx,
          cy,
          (pulseProgress + index.toFloat() / VoiceUi.PULSE_RING_COUNT) % 1f,
        )
      }
    }
    fill.color = when {
      !isEnabled -> palette.surfaceOverlay
      recording -> palette.danger
      isPressed -> palette.primary
      else -> palette.primarySoft
    }
    canvas.drawCircle(cx, cy, VoiceUi.dp(context, 24f).toFloat(), fill)
    icon.color = when {
      !isEnabled -> palette.textDisabled
      recording || isPressed -> Color.WHITE
      else -> palette.primary
    }
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

  private fun drawPulseRing(canvas: Canvas, cx: Float, cy: Float, progress: Float) {
    ring.color = palette.danger
    ring.alpha = ((1f - progress) * 170f).toInt().coerceIn(0, 170)
    canvas.drawCircle(
      cx,
      cy,
      VoiceUi.dp(
        context,
        VoiceUi.PULSE_START_RADIUS_DP + (VoiceUi.PULSE_TRAVEL_RADIUS_DP * progress),
      ).toFloat(),
      ring,
    )
  }

  private fun startPulse() {
    pulseAnimator?.cancel()
    pulseAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 960L
      repeatCount = ValueAnimator.INFINITE
      interpolator = LinearInterpolator()
      addUpdateListener {
        pulseProgress = it.animatedValue as Float
        invalidate()
      }
      start()
    }
  }

  private fun stopPulse() {
    pulseAnimator?.cancel()
    pulseAnimator = null
    pulseProgress = 0f
  }

  override fun onDetachedFromWindow() {
    stopPulse()
    super.onDetachedFromWindow()
  }
}

@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class ScheduleVoiceHostView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true
  val onScheduleVoiceAction by EventDispatcher<Map<String, Any>>()
  private var bridgeEventsEnabled = true
  private var actionListener: ((Map<String, Any>) -> Unit)? = null

  private val palette = NativeUiTokens.palette(context)
  private val overlayRoot = FrameLayout(context)
  private val backdrop = View(context).apply { setBackgroundColor(palette.mask) }
  private val sheet = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    background = GradientDrawable().apply {
      setColor(palette.surface)
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
  private val parseAction = VoiceButton(context)
  private val inputPanel = LinearLayout(context)
  private val input = EditText(context)
  private val feedback = TextView(context)
  private val mic = VoiceMicView(context)
  private val busyPanel = LinearLayout(context)
  private val busyLabel = TextView(context)
  private val confirmPanel = LinearLayout(context)
  private val confirmTitle = TextView(context)
  private val fields = LinearLayout(context)
  private val clarificationPanel = LinearLayout(context)
  private val clarificationQuestion = TextView(context)
  private val clarificationAnswer = EditText(context)
  private val clarifyButton = VoiceButton(context)
  private val confirmFeedback = TextView(context)
  private val retryButton = VoiceButton(context)
  private val detailButton = VoiceButton(context)
  private val saveButton = VoiceButton(context)
  private var rendering = false
  private var snapshot = ScheduleVoiceSnapshot()
  private var touchStartedAt = 0L
  private var touchStartedFromInput = false
  private var imeInsetBottom = 0
  private var dismissing = false

  init {
    // UI-OVERLAY-001: The native sheet and backdrop must share the full host display list.
    setWillNotDraw(false)
    clipToPadding = false
    orientation = VERTICAL
    sheet.translationY = resources.displayMetrics.heightPixels.toFloat()
    sheet.setPadding(0, 0, 0, sheet.currentNavigationBarInsetBottom())
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
      val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
      val nextImeInset = if (imeVisible) {
        insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      } else {
        0
      }
      val navigationInset = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
      val sheetPaddingBottom = if (imeVisible) 0 else navigationInset
      if (sheet.paddingBottom != sheetPaddingBottom) {
        sheet.setPadding(0, 0, 0, sheetPaddingBottom)
      }
      imeInsetBottom = nextImeInset
      if (!dismissing) sheet.translationY = restingSheetTranslationY()
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
    dismissing = true
    input.clearFocus()
    clarificationAnswer.clearFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
      ?.hideSoftInputFromWindow(windowToken, 0)
    backdrop.animate().cancel()
    sheet.animate().cancel()
    backdrop.animate().alpha(0f).setDuration(NativeUiTokens.SHEET_DURATION_MS).start()
    sheet.animate()
      .translationY(sheet.height.toFloat().coerceAtLeast(1f))
      .setDuration(NativeUiTokens.SHEET_DURATION_MS)
      .setInterpolator(DecelerateInterpolator())
      .withEndAction(onClosed)
      .start()
  }

  fun hideImeIfVisible(): Boolean {
    val insets = ViewCompat.getRootWindowInsets(this) ?: return false
    if (!insets.isVisible(WindowInsetsCompat.Type.ime())) return false
    val window = (context as? Activity)?.window
    if (window != null) {
      WindowInsetsControllerCompat(window, this).hide(WindowInsetsCompat.Type.ime())
    } else {
      (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
        ?.hideSoftInputFromWindow(windowToken, 0)
    }
    return true
  }

  private fun buildHeader() {
    val row = FrameLayout(context)
    title.text = "新建日程"
    title.textSize = 17f
    title.setTextColor(palette.textPrimary)
    title.gravity = Gravity.CENTER
    title.typeface = android.graphics.Typeface.DEFAULT
    row.addView(title, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    close.contentDescription = "关闭新建日程"
    row.addView(
      close,
      FrameLayout.LayoutParams(VoiceUi.dp(context, 48f), VoiceUi.dp(context, 48f), Gravity.START or Gravity.CENTER_VERTICAL),
    )
    parseAction.text = "解析"
    parseAction.contentDescription = "解析日程"
    parseAction.applyFeishuStyle(palette, VoiceButtonStyle.TEXT)
    parseAction.setOnClickListener { emit("parse") }
    row.addView(
      parseAction,
      FrameLayout.LayoutParams(VoiceUi.dp(context, 68f), VoiceUi.dp(context, 48f), Gravity.END or Gravity.CENTER_VERTICAL),
    )
    sheet.addView(row, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 52f)))
  }

  private fun buildInputPanel() {
    inputPanel.orientation = LinearLayout.VERTICAL
    inputPanel.setPadding(VoiceUi.dp(context, 16f), VoiceUi.dp(context, 4f), VoiceUi.dp(context, 16f), VoiceUi.dp(context, 14f))
    input.hint = "日程内容"
    input.textSize = 16f
    input.setTextColor(palette.textPrimary)
    input.setHintTextColor(palette.textTertiary)
    input.gravity = Gravity.TOP or Gravity.START
    input.includeFontPadding = false
    input.setPadding(VoiceUi.dp(context, 12f), VoiceUi.dp(context, 12f), VoiceUi.dp(context, 12f), VoiceUi.dp(context, 10f))
    input.background = GradientDrawable().apply {
      setColor(palette.surfaceOverlay)
      cornerRadius = VoiceUi.dp(context, 8f).toFloat()
    }
    input.maxLines = 4
    input.imeOptions = EditorInfo.IME_ACTION_DONE
    input.setOnEditorActionListener { _, actionId, _ ->
      actionId == EditorInfo.IME_ACTION_DONE && hideImeIfVisible()
    }
    input.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
        if (!rendering) emit("text-change", mapOf("text" to (s?.toString() ?: "")))
      }
      override fun afterTextChanged(s: Editable?) = Unit
    })
    inputPanel.addView(input, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 72f)))

    feedback.textSize = 13f
    feedback.setTextColor(palette.textSecondary)
    feedback.gravity = Gravity.CENTER
    feedback.includeFontPadding = false
    feedback.maxLines = 1
    feedback.ellipsize = TextUtils.TruncateAt.END
    inputPanel.addView(feedback, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 28f)))

    val micDock = FrameLayout(context)
    micDock.addView(
      mic,
      FrameLayout.LayoutParams(VoiceUi.dp(context, 128f), VoiceUi.dp(context, 128f), Gravity.CENTER),
    )
    inputPanel.addView(micDock, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 128f)))
    mic.setOnTouchListener { _, event -> handleMicTouch(event) }
    sheet.addView(inputPanel, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
  }

  private fun buildBusyPanel() {
    busyPanel.orientation = LinearLayout.VERTICAL
    busyPanel.gravity = Gravity.CENTER
    busyPanel.setPadding(VoiceUi.dp(context, 16f), VoiceUi.dp(context, 28f), VoiceUi.dp(context, 16f), VoiceUi.dp(context, 42f))
    busyPanel.addView(ProgressBar(context), LinearLayout.LayoutParams(VoiceUi.dp(context, 36f), VoiceUi.dp(context, 36f)))
    busyLabel.textSize = 14f
    busyLabel.setTextColor(palette.textSecondary)
    busyLabel.gravity = Gravity.CENTER
    busyPanel.addView(busyLabel, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 52f)))
    sheet.addView(busyPanel, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 184f)))
  }

  private fun buildConfirmPanel() {
    confirmPanel.orientation = LinearLayout.VERTICAL
    confirmPanel.setPadding(VoiceUi.dp(context, 16f), VoiceUi.dp(context, 12f), VoiceUi.dp(context, 16f), VoiceUi.dp(context, 16f))
    confirmTitle.textSize = 17f
    confirmTitle.setTextColor(palette.textPrimary)
    confirmTitle.typeface = android.graphics.Typeface.DEFAULT
    confirmTitle.gravity = Gravity.CENTER_VERTICAL
    confirmTitle.includeFontPadding = false
    confirmPanel.addView(confirmTitle, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 36f)))

    fields.orientation = LinearLayout.VERTICAL
    val scroll = ScrollView(context).apply {
      // Reserve the scrollbar lane instead of drawing it over long field values.
      scrollBarStyle = View.SCROLLBARS_INSIDE_INSET
      isVerticalScrollBarEnabled = true
      addView(fields)
    }
    fields.setPadding(0, 0, VoiceUi.dp(context, 12f), 0)
    clarificationPanel.orientation = LinearLayout.VERTICAL
    clarificationPanel.setPadding(0, VoiceUi.dp(context, 8f), 0, 0)
    clarificationQuestion.textSize = 14f
    clarificationQuestion.setTextColor(palette.textSecondary)
    clarificationQuestion.includeFontPadding = false
    clarificationQuestion.maxLines = 3
    clarificationPanel.addView(
      clarificationQuestion,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 52f)),
    )
    val clarificationRow = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    clarificationAnswer.textSize = 16f
    clarificationAnswer.setTextColor(palette.textPrimary)
    clarificationAnswer.setHintTextColor(palette.textTertiary)
    clarificationAnswer.hint = "补充信息"
    clarificationAnswer.setSingleLine(true)
    clarificationAnswer.imeOptions = EditorInfo.IME_ACTION_DONE
    clarificationAnswer.setOnEditorActionListener { _, actionId, _ ->
      actionId == EditorInfo.IME_ACTION_DONE && hideImeIfVisible()
    }
    clarificationAnswer.includeFontPadding = false
    clarificationAnswer.setPadding(VoiceUi.dp(context, 12f), 0, VoiceUi.dp(context, 12f), 0)
    clarificationAnswer.background = GradientDrawable().apply {
      setColor(palette.surfaceOverlay)
      cornerRadius = VoiceUi.dp(context, 6f).toFloat()
    }
    clarificationAnswer.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
        if (!rendering) emit("clarification-change", mapOf("text" to (s?.toString() ?: "")))
      }
      override fun afterTextChanged(s: Editable?) = Unit
    })
    clarificationRow.addView(
      clarificationAnswer,
      LinearLayout.LayoutParams(0, VoiceUi.dp(context, 44f), 1f),
    )
    clarifyButton.text = "补充"
    clarifyButton.contentDescription = "提交补充信息"
    clarifyButton.applyFeishuStyle(palette, VoiceButtonStyle.SECONDARY)
    clarifyButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    clarifyButton.setPadding(VoiceUi.dp(context, 16f), 0, VoiceUi.dp(context, 16f), 0)
    clarificationRow.addView(
      clarifyButton,
      LinearLayout.LayoutParams(VoiceUi.dp(context, 76f), VoiceUi.dp(context, 36f)).apply {
        leftMargin = VoiceUi.dp(context, 8f)
      },
    )
    clarificationPanel.addView(
      clarificationRow,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 52f)),
    )
    clarificationPanel.visibility = View.GONE
    confirmPanel.addView(scroll, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
    confirmPanel.addView(
      clarificationPanel,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 112f)),
    )

    confirmFeedback.textSize = 13f
    confirmFeedback.setTextColor(palette.danger)
    confirmFeedback.gravity = Gravity.CENTER_VERTICAL
    confirmFeedback.includeFontPadding = false
    confirmFeedback.maxLines = 1
    confirmFeedback.ellipsize = TextUtils.TruncateAt.END
    confirmPanel.addView(confirmFeedback, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 28f)))

    val actions = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    retryButton.text = "重新输入"
    detailButton.text = "详细编辑"
    saveButton.text = "保存"
    retryButton.setOnClickListener { emit("retry-input") }
    detailButton.setOnClickListener { emit("edit-details") }
    saveButton.setOnClickListener { emit("save") }
    clarifyButton.setOnClickListener { emit("clarify") }
    retryButton.applyFeishuStyle(palette, VoiceButtonStyle.TEXT)
    detailButton.applyFeishuStyle(palette, VoiceButtonStyle.SECONDARY)
    saveButton.applyFeishuStyle(palette, VoiceButtonStyle.PRIMARY)
    actions.addView(retryButton, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 36f)))
    actions.addView(detailButton, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)).apply {
      topMargin = VoiceUi.dp(context, 4f)
    })
    actions.addView(saveButton, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)).apply {
      topMargin = VoiceUi.dp(context, 8f)
    })
    confirmPanel.addView(actions, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    sheet.addView(confirmPanel, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 430f)))
  }

  private fun render(value: ScheduleVoiceSnapshot) {
    rendering = true
    inputPanel.visibility = if (value.phase in setOf(ScheduleVoicePhase.INPUT, ScheduleVoicePhase.PREPARING, ScheduleVoicePhase.RECORDING)) View.VISIBLE else View.GONE
    busyPanel.visibility = if (value.phase in setOf(ScheduleVoicePhase.PARSING, ScheduleVoicePhase.SAVING)) View.VISIBLE else View.GONE
    confirmPanel.visibility = if (value.phase == ScheduleVoicePhase.CONFIRM) View.VISIBLE else View.GONE
    if (input.text.toString() != value.text) input.setText(value.text)
    input.isEnabled = value.phase == ScheduleVoicePhase.INPUT
    val readableError = value.errorMessage.takeIf { it.isNotBlank() }?.let {
      NativeUserMessages.readable(it, "日程解析失败，请检查输入后重试。")
    }.orEmpty()
    val readableStatus = value.statusLabel.takeIf { it.isNotBlank() }?.let {
      NativeUserMessages.readable(it, "")
    }.orEmpty()
    feedback.text = readableError.ifBlank { readableStatus }
    feedback.setTextColor(if (readableError.isNotBlank()) palette.danger else palette.textSecondary)
    mic.recording = value.phase == ScheduleVoicePhase.RECORDING
    mic.isEnabled = value.phase in setOf(ScheduleVoicePhase.INPUT, ScheduleVoicePhase.RECORDING)
    parseAction.isEnabled = value.canParse && value.phase == ScheduleVoicePhase.INPUT
    parseAction.visibility = if (value.phase in setOf(ScheduleVoicePhase.INPUT, ScheduleVoicePhase.PREPARING, ScheduleVoicePhase.RECORDING)) View.VISIBLE else View.INVISIBLE
    title.text = if (value.phase == ScheduleVoicePhase.CONFIRM) "确认日程" else "新建日程"
    busyLabel.text = NativeUserMessages.readable(
      value.statusLabel,
      if (value.phase == ScheduleVoicePhase.SAVING) "正在保存日程" else "正在解析日程",
    )
    confirmTitle.text = value.title.ifBlank { "无主题" }
    fields.removeAllViews()
    value.fields.forEach { field ->
      val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
      }
      val label = TextView(context).apply {
        text = field.label
        textSize = 14f
        setTextColor(palette.textSecondary)
      }
      val content = TextView(context).apply {
        text = field.value
        textSize = 15f
        setTextColor(palette.textPrimary)
        gravity = Gravity.END or Gravity.CENTER_VERTICAL
      }
      row.addView(label, LinearLayout.LayoutParams(VoiceUi.dp(context, 86f), LayoutParams.MATCH_PARENT))
      row.addView(content, LinearLayout.LayoutParams(0, LayoutParams.MATCH_PARENT, 1f))
      fields.addView(row, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 44f)))
    }
    clarificationPanel.visibility = if (value.needsClarification) View.VISIBLE else View.GONE
    clarificationQuestion.text = value.clarificationQuestion
    if (clarificationAnswer.text.toString() != value.clarificationAnswer) {
      clarificationAnswer.setText(value.clarificationAnswer)
      clarificationAnswer.setSelection(clarificationAnswer.text.length)
    }
    clarificationAnswer.isEnabled = value.needsClarification
    clarifyButton.isEnabled = value.canClarify && value.needsClarification
    confirmFeedback.text = readableError
    confirmFeedback.setTextColor(if (readableError.isNotBlank()) palette.danger else palette.textSecondary)
    saveButton.isEnabled = value.canSave && !value.needsClarification
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
    sheet.post {
      if (!isAttachedToWindow) return@post
      sheet.translationY = sheet.height.toFloat().coerceAtLeast(1f)
      AnimatorSet().apply {
        playTogether(
          ObjectAnimator.ofFloat(backdrop, View.ALPHA, 0f, 1f),
          ObjectAnimator.ofFloat(
            sheet,
            View.TRANSLATION_Y,
            sheet.translationY,
            restingSheetTranslationY(),
          ),
        )
        duration = NativeUiTokens.SHEET_DURATION_MS
        interpolator = DecelerateInterpolator()
        start()
      }
    }
  }

  private fun restingSheetTranslationY(): Float = -imeInsetBottom.toFloat()

  override fun onDetachedFromWindow() {
    backdrop.animate().cancel()
    sheet.animate().cancel()
    super.onDetachedFromWindow()
  }
}
