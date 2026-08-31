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
}

private enum class VoiceThemeExpression { DIRECT, SOFT, EDITORIAL, LAYERED }
private enum class VoiceMicShape { CIRCLE, SQUIRCLE, TEXT_ACTION, PORTHOLE }

private data class VoiceThemeProfile(
  val expression: VoiceThemeExpression,
  val micShape: VoiceMicShape,
  val sheetRadiusDp: Float,
  val sheetInsetDp: Float,
  val contentInsetDp: Float,
  val inputRadiusDp: Float,
  val buttonRadiusDp: Float,
  val stageHeightDp: Float,
  val panelOffsetDp: Float,
  val entranceDurationMs: Long,
  val panelDurationMs: Long,
)

private fun voiceThemeProfile(context: Context): VoiceThemeProfile = when (NativeThemePreference.read(context)) {
  "vivid" -> VoiceThemeProfile(
    expression = VoiceThemeExpression.SOFT,
    micShape = VoiceMicShape.SQUIRCLE,
    sheetRadiusDp = 24f,
    sheetInsetDp = 12f,
    contentInsetDp = 20f,
    inputRadiusDp = 22f,
    buttonRadiusDp = 18f,
    stageHeightDp = 404f,
    panelOffsetDp = 10f,
    entranceDurationMs = 300L,
    panelDurationMs = 260L,
  )
  "paper" -> VoiceThemeProfile(
    expression = VoiceThemeExpression.EDITORIAL,
    micShape = VoiceMicShape.TEXT_ACTION,
    sheetRadiusDp = 6f,
    sheetInsetDp = 8f,
    contentInsetDp = 24f,
    inputRadiusDp = 2f,
    buttonRadiusDp = 6f,
    stageHeightDp = 376f,
    panelOffsetDp = 8f,
    entranceDurationMs = 280L,
    panelDurationMs = 260L,
  )
  "midnight" -> VoiceThemeProfile(
    expression = VoiceThemeExpression.LAYERED,
    micShape = VoiceMicShape.PORTHOLE,
    sheetRadiusDp = 18f,
    sheetInsetDp = 12f,
    contentInsetDp = 20f,
    inputRadiusDp = 16f,
    buttonRadiusDp = 12f,
    stageHeightDp = 392f,
    panelOffsetDp = 4f,
    entranceDurationMs = 170L,
    panelDurationMs = 150L,
  )
  else -> VoiceThemeProfile(
    expression = VoiceThemeExpression.DIRECT,
    micShape = VoiceMicShape.CIRCLE,
    sheetRadiusDp = 12f,
    sheetInsetDp = 0f,
    contentInsetDp = 20f,
    inputRadiusDp = 12f,
    buttonRadiusDp = 10f,
    stageHeightDp = 384f,
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
  private val profile: VoiceThemeProfile,
  private val kind: String,
) : View(context) {
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

private class VoiceMicView(context: Context, private val profile: VoiceThemeProfile) : View(context) {
  private val palette = NativeUiTokens.palette(context)
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
        val halfWidth = VoiceUi.dp(context, 78f).toFloat()
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

  private val profile = voiceThemeProfile(context)
  private val palette = NativeUiTokens.palette(context)
  private val overlayRoot = FrameLayout(context)
  private val backdrop = View(context).apply { setBackgroundColor(palette.mask) }
  private val sheet = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    background = GradientDrawable().apply {
      setColor(palette.surface)
      val radius = VoiceUi.dp(context, profile.sheetRadiusDp).toFloat()
      cornerRadii = if (profile.sheetInsetDp > 0f) {
        floatArrayOf(radius, radius, radius, radius, radius, radius, radius, radius)
      } else {
        floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f)
      }
      if (profile.expression == VoiceThemeExpression.LAYERED) {
        setStroke(VoiceUi.dp(context, 1f).coerceAtLeast(1), palette.divider)
      }
    }
    elevation = if (profile.expression == VoiceThemeExpression.SOFT) VoiceUi.dp(context, 8f).toFloat() else 0f
    isClickable = true
  }
  private val stageHost = FrameLayout(context)
  private val title = TextView(context)
  private val close = VoiceIconView(context, profile, "close")
  private val parseAction = VoiceButton(context)
  private val inputPanel = LinearLayout(context)
  private val inputPrompt = TextView(context)
  private val input = EditText(context)
  private val feedback = TextView(context)
  private val micDock = FrameLayout(context)
  private val mic = VoiceMicView(context, profile)
  private val parsingIndicator = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal)
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
      FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
        val inset = VoiceUi.dp(context, profile.sheetInsetDp)
        leftMargin = inset
        rightMargin = inset
        bottomMargin = inset
      },
    )
    buildHeader()
    sheet.addView(
      stageHost,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, profile.stageHeightDp)),
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
    val row = FrameLayout(context).apply {
      if (profile.expression in setOf(VoiceThemeExpression.SOFT, VoiceThemeExpression.LAYERED)) {
        background = NativeUiTokens.roundedBackground(
          context,
          palette.surfaceOverlay,
          if (profile.expression == VoiceThemeExpression.SOFT) 22f else 16f,
          palette.divider,
        )
      }
    }
    title.text = when (profile.expression) {
      VoiceThemeExpression.SOFT -> "说出安排"
      VoiceThemeExpression.EDITORIAL -> "记下一段安排"
      else -> "语音新建"
    }
    title.textSize = if (profile.expression == VoiceThemeExpression.EDITORIAL) 20f else 17f
    title.setTextColor(palette.textPrimary)
    title.gravity = if (profile.expression == VoiceThemeExpression.DIRECT) {
      Gravity.CENTER
    } else {
      Gravity.START or Gravity.CENTER_VERTICAL
    }
    title.setPadding(
      VoiceUi.dp(context, if (profile.expression == VoiceThemeExpression.DIRECT) 0f else 54f),
      0,
      VoiceUi.dp(context, 64f),
      0,
    )
    title.typeface = LaojiThemeTypography.typeface(context, android.graphics.Typeface.NORMAL)
    row.addView(title, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    close.contentDescription = "关闭新建日程"
    row.addView(
      close,
      FrameLayout.LayoutParams(VoiceUi.dp(context, 48f), VoiceUi.dp(context, 48f), Gravity.START or Gravity.CENTER_VERTICAL),
    )
    parseAction.text = "解析"
    parseAction.contentDescription = "解析日程"
    parseAction.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.TEXT)
    parseAction.setOnClickListener { emit("parse") }
    row.addView(
      parseAction,
      FrameLayout.LayoutParams(VoiceUi.dp(context, 68f), VoiceUi.dp(context, 48f), Gravity.END or Gravity.CENTER_VERTICAL),
    )
    sheet.addView(
      row,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 64f)).apply {
        if (profile.expression in setOf(VoiceThemeExpression.SOFT, VoiceThemeExpression.LAYERED)) {
          val inset = VoiceUi.dp(context, 12f)
          leftMargin = inset
          rightMargin = inset
          topMargin = inset
        }
      },
    )
  }

  private fun buildInputPanel() {
    inputPanel.orientation = LinearLayout.VERTICAL
    val contentInset = VoiceUi.dp(context, profile.contentInsetDp)
    inputPanel.setPadding(contentInset, VoiceUi.dp(context, 8f), contentInset, VoiceUi.dp(context, 14f))
    inputPrompt.text = "说出你要安排的事"
    inputPrompt.textSize = if (profile.expression == VoiceThemeExpression.EDITORIAL) 19f else 17f
    inputPrompt.setTextColor(palette.textPrimary)
    inputPrompt.typeface = LaojiThemeTypography.typeface(context, android.graphics.Typeface.NORMAL)
    inputPrompt.includeFontPadding = false
    inputPrompt.gravity = if (profile.expression == VoiceThemeExpression.DIRECT) Gravity.CENTER else Gravity.START or Gravity.CENTER_VERTICAL
    inputPrompt.visibility = if (profile.expression == VoiceThemeExpression.LAYERED) View.GONE else View.VISIBLE
    inputPanel.addView(
      inputPrompt,
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, if (inputPrompt.visibility == View.VISIBLE) VoiceUi.dp(context, 48f) else 0),
    )

    input.hint = null
    input.textSize = if (profile.expression == VoiceThemeExpression.EDITORIAL) 18f else 17f
    input.setTextColor(palette.textPrimary)
    input.setHintTextColor(palette.textTertiary)
    input.gravity = Gravity.TOP or Gravity.START
    input.includeFontPadding = false
    input.setPadding(VoiceUi.dp(context, 16f), VoiceUi.dp(context, 14f), VoiceUi.dp(context, 16f), VoiceUi.dp(context, 12f))
    input.background = GradientDrawable().apply {
      setColor(if (profile.expression == VoiceThemeExpression.LAYERED) palette.surfaceOverlay else palette.surface)
      cornerRadius = VoiceUi.dp(context, profile.inputRadiusDp).toFloat()
      if (profile.expression != VoiceThemeExpression.SOFT) {
        setStroke(VoiceUi.dp(context, 1f).coerceAtLeast(1), palette.divider)
      }
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
    inputPanel.addView(input, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 116f)))

    feedback.textSize = 13f
    feedback.setTextColor(palette.textSecondary)
    feedback.gravity = if (profile.expression == VoiceThemeExpression.EDITORIAL) Gravity.START or Gravity.CENTER_VERTICAL else Gravity.CENTER
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
    parsingIndicator.progressTintList = ColorStateList.valueOf(palette.primary)
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
    val contentInset = VoiceUi.dp(context, profile.contentInsetDp)
    confirmPanel.setPadding(contentInset, VoiceUi.dp(context, 8f), contentInset, VoiceUi.dp(context, 14f))
    confirmTitle.textSize = if (profile.expression == VoiceThemeExpression.EDITORIAL) 21f else 19f
    confirmTitle.setTextColor(palette.textPrimary)
    confirmTitle.typeface = LaojiThemeTypography.typeface(context, android.graphics.Typeface.NORMAL)
    confirmTitle.gravity = Gravity.CENTER_VERTICAL
    confirmTitle.includeFontPadding = false
    confirmPanel.addView(confirmTitle, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)))

    fields.orientation = LinearLayout.VERTICAL
    if (profile.expression in setOf(VoiceThemeExpression.SOFT, VoiceThemeExpression.LAYERED)) {
      fields.background = NativeUiTokens.roundedBackground(
        context,
        if (profile.expression == VoiceThemeExpression.LAYERED) palette.surfaceOverlay else palette.surface,
        profile.inputRadiusDp,
        palette.divider,
      )
    }
    val scroll = ScrollView(context).apply {
      // Reserve the scrollbar lane instead of drawing it over long field values.
      scrollBarStyle = View.SCROLLBARS_INSIDE_INSET
      isVerticalScrollBarEnabled = true
      addView(fields)
    }
    fields.setPadding(
      if (profile.expression in setOf(VoiceThemeExpression.SOFT, VoiceThemeExpression.LAYERED)) VoiceUi.dp(context, 12f) else 0,
      0,
      VoiceUi.dp(context, 12f),
      0,
    )
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
      setColor(if (profile.expression == VoiceThemeExpression.LAYERED) palette.surfaceOverlay else palette.surface)
      cornerRadius = VoiceUi.dp(context, profile.inputRadiusDp).toFloat()
      setStroke(VoiceUi.dp(context, 1f).coerceAtLeast(1), palette.primary)
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
    clarifyButton.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.SECONDARY)
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
    retryButton.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.TEXT)
    detailButton.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.TEXT)
    saveButton.applyVoiceButtonStyle(palette, profile, VoiceButtonStyle.PRIMARY)
    secondaryActions.addView(retryButton, LinearLayout.LayoutParams(0, VoiceUi.dp(context, 40f), 1f))
    secondaryActions.addView(detailButton, LinearLayout.LayoutParams(0, VoiceUi.dp(context, 40f), 1f))
    actions.addView(secondaryActions, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 40f)))
    actions.addView(saveButton, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)).apply {
      topMargin = VoiceUi.dp(context, 6f)
    })
    confirmPanel.addView(actions, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    stageHost.addView(confirmPanel, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
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
    feedback.setTextColor(
      when {
        readableError.isNotBlank() -> palette.danger
        value.phase in setOf(ScheduleVoicePhase.PREPARING, ScheduleVoicePhase.RECORDING, ScheduleVoicePhase.PARSING) -> palette.primary
        else -> palette.textSecondary
      },
    )
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
    } else {
      when (profile.expression) {
        VoiceThemeExpression.SOFT -> "说出安排"
        VoiceThemeExpression.EDITORIAL -> "记下一段安排"
        else -> "语音新建"
      }
    }
    confirmTitle.text = value.title.ifBlank { "无主题" }
    fields.removeAllViews()
    value.fields.forEachIndexed { index, field ->
      val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        isBaselineAligned = true
        setPadding(
          if (profile.expression in setOf(VoiceThemeExpression.SOFT, VoiceThemeExpression.LAYERED)) VoiceUi.dp(context, 12f) else 0,
          0,
          if (profile.expression in setOf(VoiceThemeExpression.SOFT, VoiceThemeExpression.LAYERED)) VoiceUi.dp(context, 12f) else 0,
          0,
        )
      }
      val label = TextView(context).apply {
        text = field.label
        textSize = 14f
        setTextColor(palette.textSecondary)
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        includeFontPadding = false
        maxLines = 1
        typeface = LaojiThemeTypography.typeface(context, android.graphics.Typeface.NORMAL)
      }
      val content = TextView(context).apply {
        text = field.value
        textSize = 15f
        setTextColor(palette.textPrimary)
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        includeFontPadding = false
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        typeface = LaojiThemeTypography.typeface(context, android.graphics.Typeface.NORMAL)
      }
      row.addView(label, LinearLayout.LayoutParams(VoiceUi.dp(context, 78f), LayoutParams.WRAP_CONTENT))
      row.addView(content, LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
      fields.addView(row, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 48f)))
      if (index < value.fields.lastIndex) {
        fields.addView(
          View(context).apply { setBackgroundColor(palette.divider) },
          LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, VoiceUi.dp(context, 1f)),
        )
      }
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
    saveButton.text = if (value.phase == ScheduleVoicePhase.SAVING) "保存中" else "保存日程"
    saveButton.isEnabled = value.canSave && !value.needsClarification && value.phase != ScheduleVoicePhase.SAVING
    detailButton.isEnabled = value.canEditDetails
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
