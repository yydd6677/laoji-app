package com.laoji.nativeplatform.calendarpages

// UI-TITLE-COMMON-001 / UI-TOKENS-001 / UI-FORM-001: the old fixed-margin
// title bar is deleted; this file retains shared palette, search helpers and state UI only.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.view.ViewCompat
import com.laoji.nativeplatform.ui.NativeUiTokens
import com.laoji.nativeplatform.ui.LaojiThemeTypography

internal object CalendarPagePalette {
  var body = Color.WHITE
  var float = Color.WHITE
  var neutralBackground = Color.rgb(245, 246, 247)
  var text = Color.rgb(31, 35, 41)
  var secondary = Color.rgb(100, 106, 115)
  var placeholder = Color.rgb(143, 149, 158)
  var disabled = Color.rgb(187, 191, 196)
  var divider = Color.rgb(222, 224, 227)
  var primary = Color.rgb(20, 86, 240)
  var primaryPressed = Color.rgb(4, 66, 210)
  var primaryHeader = Color.rgb(4, 66, 210)
  var primarySoft = Color.rgb(240, 244, 255)
  var danger = Color.rgb(226, 46, 40)
  var scrim = Color.argb(112, 255, 255, 255)

  fun configure(context: Context) {
    val palette = NativeUiTokens.palette(context)
    body = palette.surface
    float = palette.surface
    neutralBackground = palette.body
    text = palette.textPrimary
    secondary = palette.textSecondary
    placeholder = palette.textTertiary
    disabled = palette.textDisabled
    divider = palette.divider
    primary = palette.primary
    primaryPressed = palette.primaryPressed
    primaryHeader = palette.primaryPressed
    primarySoft = palette.primarySoft
    danger = palette.danger
    scrim = palette.mask
  }
}

internal fun Context.pageDp(value: Float): Int =
  CalendarCommonTitleBarContract.dpToPx(value, resources.displayMetrics.density)

internal fun Context.pageDp(value: Int): Int = pageDp(value.toFloat())

internal fun Context.pageText(
  value: CharSequence = "",
  sizeSp: Float = 14f,
  color: Int = CalendarPagePalette.text,
  weight: Int = Typeface.NORMAL,
): TextView = TextView(this).apply {
  text = value
  setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
  setTextColor(color)
  typeface = LaojiThemeTypography.typeface(this@pageText, weight)
  includeFontPadding = false
}

internal fun View.pageShape(
  color: Int,
  radiusDp: Float = 0f,
  strokeColor: Int? = null,
  strokeWidthDp: Float = 0f,
) {
  background = GradientDrawable().apply {
    setColor(color)
    cornerRadius = context.pageDp(radiusDp).toFloat()
    if (strokeColor != null && strokeWidthDp > 0f) {
      setStroke(context.pageDp(strokeWidthDp).coerceAtLeast(1), strokeColor)
    }
  }
}

internal fun Context.pageDivider(startInsetDp: Int = 16): View = View(this).apply {
  setBackgroundColor(CalendarPagePalette.divider)
  minimumHeight = pageDp(0.5f).coerceAtLeast(1)
  layoutParams = LinearLayout.LayoutParams(
    LinearLayout.LayoutParams.MATCH_PARENT,
    pageDp(0.5f).coerceAtLeast(1),
  ).apply { marginStart = pageDp(startInsetDp) }
}

internal fun Context.pageIconButton(
  drawableRes: Int,
  description: String,
  tint: Int = CalendarPagePalette.text,
): ImageButton = ImageButton(this).apply {
  setImageResource(drawableRes)
  imageTintList = ColorStateList.valueOf(tint)
  background = null
  contentDescription = description
  minimumWidth = pageDp(44)
  minimumHeight = pageDp(44)
  setPadding(pageDp(11), pageDp(11), pageDp(11), pageDp(11))
  isClickable = true
  isFocusable = true
}

internal class CalendarPageEmptyArt(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = context.pageDp(3).toFloat()
    color = CalendarPagePalette.disabled
    strokeCap = Paint.Cap.ROUND
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val inset = context.pageDp(22).toFloat()
    val lens = RectF(inset, inset, width - inset * 1.35f, height - inset * 1.35f)
    canvas.drawOval(lens, paint)
    canvas.drawLine(width * 0.66f, height * 0.66f, width * 0.83f, height * 0.83f, paint)
  }
}

internal class CalendarPageStateView(
  context: Context,
  private val onRetry: (() -> Unit)? = null,
) : LinearLayout(context) {
  private val progress = ProgressBar(context).apply {
    indeterminateTintList = ColorStateList.valueOf(CalendarPagePalette.primary)
  }
  private val art = CalendarPageEmptyArt(context)
  private val message = context.pageText(sizeSp = 14f, color = CalendarPagePalette.secondary).apply {
    gravity = Gravity.CENTER
  }
  private val retry = context.pageText("重试", 14f, CalendarPagePalette.primary, Typeface.BOLD).apply {
    gravity = Gravity.CENTER
    pageShape(CalendarPagePalette.float, 4f, CalendarPagePalette.divider, 1f)
    setOnClickListener { onRetry?.invoke() }
    isClickable = true
    isFocusable = true
  }

  init {
    orientation = VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    setPadding(0, context.pageDp(80), 0, 0)
    addView(progress, LayoutParams(context.pageDp(40), context.pageDp(40)))
    addView(art, LayoutParams(context.pageDp(100), context.pageDp(100)))
    addView(message, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = context.pageDp(12)
    })
    addView(retry, LayoutParams(context.pageDp(76), context.pageDp(36)).apply {
      topMargin = context.pageDp(16)
    })
    ViewCompat.setImportantForAccessibility(this, ViewCompat.IMPORTANT_FOR_ACCESSIBILITY_YES)
  }

  fun render(state: CalendarPageLoadState, text: String?) {
    visibility = if (state == CalendarPageLoadState.READY) GONE else VISIBLE
    progress.visibility = if (state == CalendarPageLoadState.LOADING) VISIBLE else GONE
    art.visibility = if (state == CalendarPageLoadState.EMPTY || state == CalendarPageLoadState.ERROR) VISIBLE else GONE
    message.visibility = if (state == CalendarPageLoadState.LOADING) GONE else VISIBLE
    retry.visibility = if (state == CalendarPageLoadState.ERROR && onRetry != null) VISIBLE else GONE
    message.text = text ?: when (state) {
      CalendarPageLoadState.EMPTY -> "没有找到日程"
      CalendarPageLoadState.ERROR -> "暂时无法显示"
      else -> ""
    }
    contentDescription = message.text
  }
}
