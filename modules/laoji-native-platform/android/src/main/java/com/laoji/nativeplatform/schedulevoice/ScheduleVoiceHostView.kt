package com.laoji.nativeplatform.schedulevoice

// UI-OVERLAY-001 / MIN-AUDIO-001: fixed-slot native schedule voice sheet and gestures.

import android.animation.Animator
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
import android.view.animation.OvershootInterpolator
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
import com.laoji.nativeplatform.NativeThemePreference
import com.laoji.nativeplatform.ui.LaojiThemeTypography
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

  // Keep the enlarged microphone and its feedback rings as integral dp values.
  // The visible button grows from 48dp to 58dp; the ring envelope and canvas
  // grow together so the 72dp outer wave is never clipped.
  const val MIC_CIRCLE_RADIUS_DP = 29f
  const val MIC_DOCK_SIZE_DP = 152f
  const val PULSE_RING_COUNT = 3
  const val PULSE_START_RADIUS_DP = 52f
  const val PULSE_TRAVEL_RADIUS_DP = 20f
  const val CONTENT_INSET_DP = 20f
  const val STAGE_HEIGHT_DP = 384f
}

private enum class VoiceThemeExpression { DIRECT, SOFT, EDITORIAL, LAYERED }
private enum class VoiceMicShape { CIRCLE, SQUIRCLE, TEXT_ACTION, PORTHOLE }

private data class VoiceThemeProfile(
  val expression: VoiceThemeExpression,
  val micShape: VoiceMicShape,
  val sheetRadiusDp: Float,
  val inputRadiusDp: Float,
  val buttonRadiusDp: Float,
  val panelOffsetDp: Float,
  val entranceDurationMs: Long,
  val panelDurationMs: Long,
)

private fun voiceThemeProfile(context: Context): VoiceThemeProfile = when (NativeThemePreference.read(context)) {
  "vivid" -> VoiceThemeProfile(
    expression = VoiceThemeExpression.SOFT,
    micShape = VoiceMicShape.SQUIRCLE,
    sheetRadiusDp = 24f,
    inputRadiusDp = 22f,
    buttonRadiusDp = 18f,
    panelOffsetDp = 10f,
    entranceDurationMs = 300L,
    panelDurationMs = 260L,
  )
  "paper" -> VoiceThemeProfile(
    expression = VoiceThemeExpression.EDITORIAL,
    micShape = VoiceMicShape.TEXT_ACTION,
    sheetRadiusDp = 6f,
    inputRadiusDp = 2f,
    buttonRadiusDp = 6f,
    panelOffsetDp = 8f,
    entranceDurationMs = 280L,
    panelDurationMs = 260L,
  )
  "midnight" -> VoiceThemeProfile(
    expression = VoiceThemeExpression.LAYERED,
    micShape = VoiceMicShape.PORTHOLE,
    sheetRadiusDp = 18f,
    inputRadiusDp = 16f,
    buttonRadiusDp = 12f,
    panelOffsetDp = 4f,
    entranceDurationMs = 170L,
    panelDurationMs = 150L,
  )
  else -> VoiceThemeProfile(
    expression = VoiceThemeExpression.DIRECT,
    micShape = VoiceMicShape.CIRCLE,
    sheetRadiusDp = 12f,
    inputRadiusDp = 12f,
    buttonRadiusDp = 10f,
    panelOffsetDp = 6f,
    entranceDurationMs = 220L,
    panelDurationMs = 200L,
  )
}

private enum class VoiceButtonStyle { PRIMARY, SECONDARY, TEXT }

private class VoiceButton(context: Context) : TextView(context) {
  override fun getAccessibilityClassName(): CharSequence = "android.widget.Button"
}

private fun voiceButtonBackground(
  context: Context,
  palette: NativeUiPalette,
  profile: VoiceThemeProfile,
  style: VoiceButtonStyle,
): StateListDrawable {
  fun shape(color: Int, stroke: Int? = null) = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    setColor(color)
    cornerRadius = NativeUiTokens.dp(context, profile.buttonRadiusDp)
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

private fun VoiceButton.applyVoiceButtonStyle(
  palette: NativeUiPalette,
  profile: VoiceThemeProfile,
  style: VoiceButtonStyle,
) {
  gravity = Gravity.CENTER
  includeFontPadding = false
  isClickable = true
  isFocusable = true
  setTextSize(TypedValue.COMPLEX_UNIT_SP, if (style == VoiceButtonStyle.TEXT) 16f else 17f)
  typeface = LaojiThemeTypography.typeface(context, android.graphics.Typeface.NORMAL)
  val horizontalPadding = VoiceUi.dp(context, if (style == VoiceButtonStyle.TEXT) 16f else 28f)
  setPadding(horizontalPadding, 0, horizontalPadding, 0)
  background = voiceButtonBackground(context, palette, profile, style)
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

private class VoiceIconView(
  context: Context,
  private val kind: String,
) : View(context) {
  private var profile = voiceThemeProfile(context)
  private var palette = NativeUiTokens.palette(context)
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
    NativeUiTokens.bindTheme(this) {
      palette = it
      profile = voiceThemeProfile(context)
      invalidate()
    }
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
      VoiceUi.dp(context, if (profile.expression == VoiceThemeExpression.SOFT) 18f else 6f).toFloat(),
      VoiceUi.dp(context, if (profile.expression == VoiceThemeExpression.SOFT) 18f else 6f).toFloat(),
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
  private var profile = voiceThemeProfile(context)
  private var palette = NativeUiTokens.palette(context)
  private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = VoiceUi.dp(context, 1.5f).toFloat()
  }
  private var pulseProgress = 0f
  private var pulseAnimator: ValueAnimator? = null
  private val micGlyph = requireNotNull(
    context.getDrawable(com.laoji.nativeplatform.R.drawable.laoji_ic_microphone_ai_filled),
  ).mutate()
  var recording: Boolean = false
    set(value) {
      if (field == value) return
      field = value
      contentDescription = if (value) "停止语音输入" else "开始语音输入"
      if (value) startPulse() else stopPulse()
      invalidate()
    }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textAlign = Paint.Align.LEFT
    textSize = NativeUiTokens.sp(context, 16f)
    typeface = LaojiThemeTypography.typeface(context, android.graphics.Typeface.NORMAL)
  }

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "开始语音输入"
    NativeUiTokens.bindTheme(this) {
      palette = it
      profile = voiceThemeProfile(context)
      labelPaint.typeface = LaojiThemeTypography.typeface(context, android.graphics.Typeface.NORMAL)
      invalidate()
    }
  }

  override fun onDraw(canvas: Canvas) {
    val cx = width / 2f
    val cy = height / 2f
    val pulseRingCount = when (profile.expression) {
      VoiceThemeExpression.SOFT -> VoiceUi.PULSE_RING_COUNT
      VoiceThemeExpression.DIRECT -> 2
      VoiceThemeExpression.LAYERED -> 1
      VoiceThemeExpression.EDITORIAL -> 0
    }
    if (recording && pulseRingCount > 0) {
      repeat(pulseRingCount) { index ->
        drawPulseRing(
          canvas,
          cx,
          cy,
          (pulseProgress + index.toFloat() / pulseRingCount) % 1f,
        )
      }
    }
    fill.color = when {
      !isEnabled -> palette.surfaceOverlay
      recording -> palette.danger
      isPressed -> palette.primary
      else -> palette.primarySoft
    }
    val iconColor = when {
      !isEnabled -> palette.textDisabled
      recording || isPressed -> Color.WHITE
      else -> palette.primary
    }
    val glyphSize: Int
    val left: Int
    val top: Int
    when (profile.micShape) {
      VoiceMicShape.CIRCLE -> {
        canvas.drawCircle(cx, cy, VoiceUi.dp(context, VoiceUi.MIC_CIRCLE_RADIUS_DP).toFloat(), fill)
        glyphSize = VoiceUi.dp(context, 30f)
        left = (cx - glyphSize / 2f).toInt()
        top = (cy - glyphSize / 2f).toInt()
      }
      VoiceMicShape.SQUIRCLE -> {
        val half = VoiceUi.dp(context, 40f).toFloat()
        canvas.drawRoundRect(
          RectF(cx - half, cy - half, cx + half, cy + half),
          VoiceUi.dp(context, 26f).toFloat(),
          VoiceUi.dp(context, 26f).toFloat(),
          fill,
        )
        glyphSize = VoiceUi.dp(context, 32f)
        left = (cx - glyphSize / 2f).toInt()
        top = (cy - glyphSize / 2f).toInt()
      }
      VoiceMicShape.TEXT_ACTION -> {
        val halfWidth = VoiceUi.dp(context, VoiceUi.MIC_DOCK_SIZE_DP / 2f - 2f).toFloat()
        val halfHeight = VoiceUi.dp(context, 27f).toFloat()
        val actionRect = RectF(cx - halfWidth, cy - halfHeight, cx + halfWidth, cy + halfHeight)
        fill.color = when {
          !isEnabled -> palette.surfaceOverlay
          recording -> palette.danger
          isPressed -> palette.primarySoft
          else -> palette.surface
        }
        canvas.drawRoundRect(actionRect, VoiceUi.dp(context, 6f).toFloat(), VoiceUi.dp(context, 6f).toFloat(), fill)
        ring.color = when {
          !isEnabled -> palette.textDisabled
          recording -> palette.danger
          else -> palette.primary
        }
        ring.alpha = 255
        canvas.drawRoundRect(actionRect, VoiceUi.dp(context, 6f).toFloat(), VoiceUi.dp(context, 6f).toFloat(), ring)
        glyphSize = VoiceUi.dp(context, 22f)
        left = (cx - VoiceUi.dp(context, 60f)).toInt()
        top = (cy - glyphSize / 2f).toInt()
        labelPaint.color = when {
          !isEnabled -> palette.textDisabled
          recording -> Color.WHITE
          else -> palette.primary
        }
        val label = if (recording) "完成这段记录" else "开始说话"
        val baseline = cy - (labelPaint.ascent() + labelPaint.descent()) / 2f
        canvas.drawText(label, cx - VoiceUi.dp(context, 28f), baseline, labelPaint)
      }
      VoiceMicShape.PORTHOLE -> {
        ring.color = if (recording) palette.danger else palette.primary
        ring.alpha = 255
        canvas.drawCircle(cx, cy, VoiceUi.dp(context, 47f).toFloat(), ring)
        canvas.drawCircle(cx, cy, VoiceUi.dp(context, 31f).toFloat(), fill)
        glyphSize = VoiceUi.dp(context, 28f)
        left = (cx - glyphSize / 2f).toInt()
        top = (cy - glyphSize / 2f).toInt()
      }
    }
    micGlyph.setTint(iconColor)
    micGlyph.setBounds(left, top, left + glyphSize, top + glyphSize)
    micGlyph.draw(canvas)
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
      duration = when (profile.expression) {
        VoiceThemeExpression.SOFT -> 1040L
        VoiceThemeExpression.EDITORIAL -> 1200L
        VoiceThemeExpression.LAYERED -> 760L
        VoiceThemeExpression.DIRECT -> 920L
      }
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

  private var profile = voiceThemeProfile(context)
  private var palette = NativeUiTokens.palette(context)
  private val overlayRoot = FrameLayout(context)
  private val backdrop = View(context).apply { setBackgroundColor(palette.mask) }
  private val sheet = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    isClickable = true
  }
  private val header = FrameLayout(context)
  private val stageHost = FrameLayout(context)
  private val title = TextView(context)
  private val close = VoiceIconView(context, "close")
  private val parseAction = VoiceButton(context)
  private val inputPanel = LinearLayout(context)
  private val input = EditText(context)
  private val feedback = TextView(context)
  private val micDock = FrameLayout(context)
  private val mic = VoiceMicView(context)
  private val parsingIndicator = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal)
  private val confirmPanel = LinearLayout(context)
  private val confirmTitle = TextView(context)
  private val fields = ScheduleVoiceFields(context)
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
  private var activeStage: View? = null
  private var stageGeneration = 0

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
    sheet.addView(
      stageHost,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, VoiceUi.STAGE_HEIGHT_DP)),
    )
    buildInputPanel()
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
    NativeUiTokens.bindTheme(this) { nextPalette ->
      palette = nextPalette
      profile = voiceThemeProfile(context)
      applyAppearance()
    }
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
    backdrop.animate().alpha(0f).setDuration(profile.panelDurationMs).start()
    sheet.animate()
      .alpha(0f)
      .translationY(restingSheetTranslationY() + VoiceUi.dp(context, profile.panelOffsetDp * 2f))
      .setDuration(profile.panelDurationMs)
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
    title.text = "语音新建"
    title.textSize = 17f
    title.gravity = Gravity.CENTER
    title.setPadding(VoiceUi.dp(context, 54f), 0, VoiceUi.dp(context, 68f), 0)
    header.addView(title, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    close.contentDescription = "关闭新建日程"
    header.addView(
      close,
      FrameLayout.LayoutParams(VoiceUi.dp(context, 48f), VoiceUi.dp(context, 48f), Gravity.START or Gravity.CENTER_VERTICAL),
    )
    parseAction.text = "解析"
    parseAction.contentDescription = "解析日程"
    parseAction.setOnClickListener { emit("parse") }
    header.addView(
      parseAction,
      FrameLayout.LayoutParams(VoiceUi.dp(context, 68f), VoiceUi.dp(context, 48f), Gravity.END or Gravity.CENTER_VERTICAL),
    )
    sheet.addView(
      header,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 64f)),
    )
  }

  private fun buildInputPanel() {
    inputPanel.orientation = LinearLayout.VERTICAL
    val contentInset = VoiceUi.dp(context, VoiceUi.CONTENT_INSET_DP)
    inputPanel.setPadding(contentInset, VoiceUi.dp(context, 8f), contentInset, VoiceUi.dp(context, 14f))
    input.hint = null
    input.contentDescription = "日程内容"
    input.textSize = 17f
    input.gravity = Gravity.TOP or Gravity.START
    input.includeFontPadding = false
    input.setPadding(VoiceUi.dp(context, 16f), VoiceUi.dp(context, 14f), VoiceUi.dp(context, 16f), VoiceUi.dp(context, 12f))
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
    inputPanel.addView(input, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 116f)))

    feedback.textSize = 13f
    feedback.gravity = Gravity.CENTER
    feedback.includeFontPadding = false
    feedback.maxLines = 1
    feedback.ellipsize = TextUtils.TruncateAt.END
    inputPanel.addView(feedback, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 32f)))

    micDock.addView(
      mic,
      FrameLayout.LayoutParams(
        VoiceUi.dp(context, VoiceUi.MIC_DOCK_SIZE_DP),
        VoiceUi.dp(context, VoiceUi.MIC_DOCK_SIZE_DP),
        Gravity.CENTER,
      ),
    )
    parsingIndicator.isIndeterminate = true
    parsingIndicator.visibility = View.INVISIBLE
    micDock.addView(
      parsingIndicator,
      FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 3f), Gravity.TOP).apply {
        leftMargin = VoiceUi.dp(context, 24f)
        rightMargin = VoiceUi.dp(context, 24f)
        topMargin = VoiceUi.dp(context, 62f)
      },
    )
    inputPanel.addView(
      micDock,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, VoiceUi.MIC_DOCK_SIZE_DP)),
    )
    mic.setOnTouchListener { _, event -> handleMicTouch(event) }
    stageHost.addView(inputPanel, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  private fun buildConfirmPanel() {
    confirmPanel.orientation = LinearLayout.VERTICAL
    val contentInset = VoiceUi.dp(context, VoiceUi.CONTENT_INSET_DP)
    confirmPanel.setPadding(contentInset, VoiceUi.dp(context, 8f), contentInset, VoiceUi.dp(context, 14f))
    confirmTitle.textSize = 19f
    confirmTitle.gravity = Gravity.CENTER_VERTICAL
    confirmTitle.includeFontPadding = false
    confirmTitle.setPadding(0, VoiceUi.dp(context, 8f), 0, VoiceUi.dp(context, 12f))
    confirmPanel.addView(confirmTitle, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

    fields.orientation = LinearLayout.VERTICAL
    val scroll = ScrollView(context).apply {
      // Reserve the scrollbar lane instead of drawing it over long field values.
      scrollBarStyle = View.SCROLLBARS_INSIDE_INSET
      isVerticalScrollBarEnabled = true
      addView(fields)
    }
    fields.setPadding(
      VoiceUi.dp(context, 12f),
      0,
      VoiceUi.dp(context, 12f),
      0,
    )
    clarificationPanel.orientation = LinearLayout.VERTICAL
    clarificationPanel.setPadding(0, VoiceUi.dp(context, 8f), 0, 0)
    clarificationQuestion.textSize = 14f
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
    clarificationAnswer.hint = "补充信息"
    clarificationAnswer.contentDescription = "补充信息"
    clarificationAnswer.setSingleLine(true)
    clarificationAnswer.imeOptions = EditorInfo.IME_ACTION_DONE
    clarificationAnswer.setOnEditorActionListener { _, actionId, _ ->
      actionId == EditorInfo.IME_ACTION_DONE && hideImeIfVisible()
    }
    clarificationAnswer.includeFontPadding = false
    clarificationAnswer.setPadding(VoiceUi.dp(context, 12f), 0, VoiceUi.dp(context, 12f), 0)
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
    confirmFeedback.gravity = Gravity.CENTER_VERTICAL
    confirmFeedback.includeFontPadding = false
    confirmFeedback.maxLines = 1
    confirmFeedback.ellipsize = TextUtils.TruncateAt.END
    confirmPanel.addView(confirmFeedback, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 28f)))

    val actions = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    val secondaryActions = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    retryButton.text = "重新输入"
    detailButton.text = "详细编辑"
    saveButton.text = "保存"
    retryButton.setOnClickListener { emit("retry-input") }
    detailButton.setOnClickListener { emit("edit-details") }
    saveButton.setOnClickListener { emit("save") }
    clarifyButton.setOnClickListener { emit("clarify") }
    secondaryActions.addView(retryButton, LinearLayout.LayoutParams(0, VoiceUi.dp(context, 40f), 1f))
    secondaryActions.addView(detailButton, LinearLayout.LayoutParams(0, VoiceUi.dp(context, 40f), 1f))
    actions.addView(secondaryActions, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 40f)))
    actions.addView(saveButton, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)).apply {
      topMargin = VoiceUi.dp(context, 6f)
    })
    confirmPanel.addView(actions, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    stageHost.addView(confirmPanel, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  /** Appearance only: never replays stage transitions, input text or capture. */
  private fun applyAppearance() {
    backdrop.setBackgroundColor(palette.mask)
    sheet.background = GradientDrawable().apply {
      setColor(palette.surface)
      val radius = VoiceUi.dp(context, profile.sheetRadiusDp).toFloat()
      cornerRadii = floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f)
      if (profile.expression == VoiceThemeExpression.LAYERED) {
        setStroke(VoiceUi.dp(context, 1f).coerceAtLeast(1), palette.divider)
      }
    }
    sheet.elevation = if (profile.expression == VoiceThemeExpression.SOFT) VoiceUi.dp(context, 8f).toFloat() else 0f
    val enclosed = profile.expression in setOf(VoiceThemeExpression.SOFT, VoiceThemeExpression.LAYERED)
    header.background = if (enclosed) NativeUiTokens.roundedBackground(
      context, palette.surfaceOverlay, profile.inputRadiusDp, palette.divider,
    ) else null
    fields.background = if (enclosed) NativeUiTokens.roundedBackground(
      context, palette.surfaceOverlay, profile.inputRadiusDp, palette.divider,
    ) else null
    fun inputBackground(border: Int?) = GradientDrawable().apply {
      setColor(if (profile.expression == VoiceThemeExpression.LAYERED) palette.surfaceOverlay else palette.surface)
      cornerRadius = VoiceUi.dp(context, profile.inputRadiusDp).toFloat()
      border?.let { setStroke(VoiceUi.dp(context, 1f).coerceAtLeast(1), it) }
    }
    input.background = inputBackground(if (profile.expression == VoiceThemeExpression.SOFT) null else palette.divider)
    clarificationAnswer.background = inputBackground(palette.primary)
    listOf(title, confirmTitle, input, clarificationAnswer).forEach { it.setTextColor(palette.textPrimary) }
    listOf(input, clarificationAnswer).forEach { it.setHintTextColor(palette.textTertiary) }
    clarificationQuestion.setTextColor(palette.textSecondary)
    listOf(title, confirmTitle, input, feedback, clarificationQuestion, clarificationAnswer, confirmFeedback).forEach {
      it.typeface = LaojiThemeTypography.typeface(context, android.graphics.Typeface.NORMAL)
    }
    parseAction.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.TEXT)
    retryButton.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.TEXT)
    detailButton.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.TEXT)
    saveButton.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.PRIMARY)
    clarifyButton.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.SECONDARY)
    clarifyButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    clarifyButton.setPadding(VoiceUi.dp(context, 16f), 0, VoiceUi.dp(context, 16f), 0)
    parsingIndicator.indeterminateTintList = ColorStateList.valueOf(palette.primary)
    applyFeedbackAppearance(snapshot)
  }

  private fun applyFeedbackAppearance(value: ScheduleVoiceSnapshot) {
    val error = value.errorMessage.isNotBlank()
    feedback.setTextColor(when {
      error -> palette.danger
      value.phase in setOf(ScheduleVoicePhase.PREPARING, ScheduleVoicePhase.RECORDING, ScheduleVoicePhase.PARSING) -> palette.primary
      else -> palette.textSecondary
    })
    confirmFeedback.setTextColor(if (error) palette.danger else palette.textSecondary)
  }

  private fun render(value: ScheduleVoiceSnapshot) {
    rendering = true
    val inputPhase = value.phase in setOf(
      ScheduleVoicePhase.INPUT,
      ScheduleVoicePhase.PREPARING,
      ScheduleVoicePhase.RECORDING,
      ScheduleVoicePhase.PARSING,
    )
    renderStage(if (inputPhase) inputPanel else confirmPanel)
    if (input.text.toString() != value.text) input.setText(value.text)
    input.isEnabled = value.phase == ScheduleVoicePhase.INPUT
    val readableError = value.errorMessage.takeIf { it.isNotBlank() }?.let {
      NativeUserMessages.readable(it, "日程解析失败，请检查输入后重试。")
    }.orEmpty()
    val readableStatus = value.statusLabel.takeIf {
      it.isNotBlank()
        && !it.contains("正在连接")
        && !it.contains("语音服务")
    }?.let {
      NativeUserMessages.readable(it, "")
    }.orEmpty()
    val phaseStatus = when (value.phase) {
      ScheduleVoicePhase.PREPARING, ScheduleVoicePhase.RECORDING -> "正在听"
      ScheduleVoicePhase.PARSING -> "正在理解"
      else -> readableStatus
    }
    feedback.text = readableError.ifBlank { phaseStatus }
    mic.recording = value.phase in setOf(ScheduleVoicePhase.PREPARING, ScheduleVoicePhase.RECORDING)
    // Keep ownership of ACTION_UP while native capture is starting. Otherwise
    // a fast hold-and-release can strand a recording without emitting stop.
    mic.isEnabled = value.phase in setOf(ScheduleVoicePhase.INPUT, ScheduleVoicePhase.PREPARING, ScheduleVoicePhase.RECORDING)
    mic.visibility = if (value.phase == ScheduleVoicePhase.PARSING) View.INVISIBLE else View.VISIBLE
    parsingIndicator.visibility = if (value.phase == ScheduleVoicePhase.PARSING) View.VISIBLE else View.INVISIBLE
    parseAction.isEnabled = value.canParse && value.phase == ScheduleVoicePhase.INPUT
    parseAction.visibility = if (value.phase == ScheduleVoicePhase.INPUT) View.VISIBLE else View.INVISIBLE
    title.text = if (value.phase in setOf(ScheduleVoicePhase.CONFIRM, ScheduleVoicePhase.SAVING)) {
      "确认日程"
    } else "语音新建"
    val nextTitle = value.title.ifBlank { "无主题" }
    if (confirmTitle.text.toString() != nextTitle) confirmTitle.text = nextTitle
    fields.render(value.fields)
    clarificationPanel.visibility = if (value.needsClarification) View.VISIBLE else View.GONE
    clarificationQuestion.text = value.clarificationQuestion
    if (clarificationAnswer.text.toString() != value.clarificationAnswer) {
      clarificationAnswer.setText(value.clarificationAnswer)
      clarificationAnswer.setSelection(clarificationAnswer.text.length)
    }
    clarificationAnswer.isEnabled = value.needsClarification
    clarifyButton.isEnabled = value.canClarify && value.needsClarification
    confirmFeedback.text = readableError
    applyFeedbackAppearance(value)
    saveButton.isEnabled = value.canSave && !value.needsClarification && value.phase == ScheduleVoicePhase.CONFIRM
    detailButton.isEnabled = value.canEditDetails && value.phase == ScheduleVoicePhase.CONFIRM
    retryButton.isEnabled = value.phase == ScheduleVoicePhase.CONFIRM
    rendering = false
  }

  private fun renderStage(target: View) {
    if (activeStage === target) return
    val previous = activeStage
    activeStage = target
    val generation = ++stageGeneration
    inputPanel.animate().cancel()
    confirmPanel.animate().cancel()
    if (previous == null || !ValueAnimator.areAnimatorsEnabled()) {
      listOf(inputPanel, confirmPanel).filter { it !== target }.forEach { it.visibility = View.GONE }
      target.visibility = View.VISIBLE
      target.alpha = 1f
      target.translationY = 0f
      return
    }
    target.visibility = View.VISIBLE
    target.alpha = 0f
    target.translationY = VoiceUi.dp(context, profile.panelOffsetDp).toFloat()
    previous.animate()
      .alpha(0f)
      .translationY(-VoiceUi.dp(context, profile.panelOffsetDp / 2f).toFloat())
      .setDuration((profile.panelDurationMs / 2).coerceAtLeast(1L))
      .setInterpolator(DecelerateInterpolator())
      .withEndAction {
        if (generation == stageGeneration && activeStage !== previous) {
          previous.visibility = View.GONE
          previous.alpha = 1f
          previous.translationY = 0f
        }
      }
      .start()
    target.animate()
      .alpha(1f)
      .translationY(0f)
      .setDuration(profile.panelDurationMs)
      .setInterpolator(
        if (profile.expression == VoiceThemeExpression.SOFT) OvershootInterpolator(0.55f)
        else DecelerateInterpolator(),
      )
      .start()
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
      val startOffset = when (profile.expression) {
        VoiceThemeExpression.SOFT -> 36f
        VoiceThemeExpression.EDITORIAL -> 8f
        VoiceThemeExpression.LAYERED -> 12f
        VoiceThemeExpression.DIRECT -> 24f
      }
      sheet.translationY = restingSheetTranslationY() + VoiceUi.dp(context, startOffset)
      sheet.alpha = if (profile.expression == VoiceThemeExpression.DIRECT) 0.82f else 0f
      if (profile.expression == VoiceThemeExpression.SOFT) {
        sheet.scaleX = 0.98f
        sheet.scaleY = 0.98f
      }
      val animators = mutableListOf<Animator>(
        ObjectAnimator.ofFloat(backdrop, View.ALPHA, 0f, 1f),
        ObjectAnimator.ofFloat(sheet, View.ALPHA, sheet.alpha, 1f),
        ObjectAnimator.ofFloat(sheet, View.TRANSLATION_Y, sheet.translationY, restingSheetTranslationY()),
      )
      if (profile.expression == VoiceThemeExpression.SOFT) {
        animators += ObjectAnimator.ofFloat(sheet, View.SCALE_X, 0.98f, 1f)
        animators += ObjectAnimator.ofFloat(sheet, View.SCALE_Y, 0.98f, 1f)
      }
      AnimatorSet().apply {
        playTogether(animators)
        duration = profile.entranceDurationMs
        interpolator = if (profile.expression == VoiceThemeExpression.SOFT) {
          OvershootInterpolator(0.52f)
        } else {
          DecelerateInterpolator()
        }
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
