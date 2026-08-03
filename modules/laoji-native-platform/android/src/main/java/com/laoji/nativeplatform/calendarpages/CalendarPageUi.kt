package com.laoji.nativeplatform.calendarpages

// UI-TITLE-COMMON-001 / UI-TOKENS-001 / UI-FORM-001: the old fixed-margin
// title bar is deleted; this file retains shared palette, search helpers and state UI only.

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
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
import com.laoji.nativeplatform.NativeThemePreference
import com.laoji.nativeplatform.evidence.FeishuEvidence

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
    val isDark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
      Configuration.UI_MODE_NIGHT_YES
    val vivid = NativeThemePreference.isVivid(context)
    when {
      vivid && !isDark -> {
        body = Color.rgb(255, 240, 246)
        float = Color.rgb(253, 234, 245)
        neutralBackground = Color.rgb(240, 232, 255)
        text = Color.rgb(28, 27, 51)
        secondary = Color.rgb(148, 144, 181)
        placeholder = Color.rgb(184, 180, 212)
        disabled = Color.rgb(210, 206, 227)
        divider = Color.rgb(229, 207, 232)
        primary = Color.rgb(123, 92, 184)
        primaryPressed = Color.rgb(46, 24, 128)
        primaryHeader = Color.rgb(46, 24, 128)
        primarySoft = Color.rgb(237, 232, 255)
        danger = Color.rgb(255, 77, 79)
        scrim = Color.argb(112, 46, 24, 128)
      }
      vivid -> {
        body = Color.rgb(33, 28, 43)
        float = Color.rgb(48, 40, 61)
        neutralBackground = Color.rgb(68, 55, 90)
        text = Color.rgb(247, 241, 255)
        secondary = Color.rgb(197, 183, 216)
        placeholder = Color.rgb(152, 137, 174)
        disabled = Color.rgb(102, 89, 117)
        divider = Color.rgb(92, 76, 112)
        primary = Color.rgb(169, 130, 232)
        primaryPressed = Color.rgb(216, 196, 255)
        primaryHeader = Color.rgb(195, 163, 255)
        primarySoft = Color.rgb(59, 44, 85)
        danger = Color.rgb(255, 123, 123)
        scrim = Color.argb(153, 0, 0, 0)
      }
      isDark -> {
        body = Color.rgb(26, 26, 26)
        float = Color.rgb(10, 10, 10)
        neutralBackground = Color.rgb(41, 41, 41)
        text = Color.rgb(235, 235, 235)
        secondary = Color.rgb(166, 166, 166)
        placeholder = Color.rgb(117, 117, 117)
        disabled = Color.rgb(95, 95, 95)
        divider = Color.rgb(65, 65, 65)
        primary = Color.rgb(117, 164, 255)
        primaryPressed = Color.rgb(76, 136, 255)
        primaryHeader = Color.rgb(143, 180, 255)
        primarySoft = Color.rgb(21, 35, 64)
        danger = Color.rgb(240, 91, 86)
        scrim = Color.argb(153, 0, 0, 0)
      }
      else -> {
        body = Color.WHITE
        float = Color.WHITE
        neutralBackground = Color.rgb(245, 246, 247)
        text = Color.rgb(31, 35, 41)
        secondary = Color.rgb(100, 106, 115)
        placeholder = Color.rgb(143, 149, 158)
        disabled = Color.rgb(187, 191, 196)
        divider = Color.rgb(222, 224, 227)
        primary = Color.rgb(20, 86, 240)
        primaryPressed = Color.rgb(4, 66, 210)
        primaryHeader = Color.rgb(4, 66, 210)
        primarySoft = Color.rgb(240, 244, 255)
        danger = Color.rgb(226, 46, 40)
        scrim = Color.argb(112, 255, 255, 255)
      }
    }
  }
}

internal fun Context.pageDp(value: Float): Int =
  CalendarCommonTitleBarContract.dpToPx(value, resources.displayMetrics.density)

internal fun Context.pageDp(value: Int): Int = pageDp(value.toFloat())

@FeishuEvidence("UI-TOKENS-001")
internal fun Context.pageText(
  value: CharSequence = "",
  sizeSp: Float = 14f,
  color: Int = CalendarPagePalette.text,
  weight: Int = Typeface.NORMAL,
): TextView = TextView(this).apply {
  text = value
  setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
  setTextColor(color)
  typeface = Typeface.create(Typeface.DEFAULT, weight)
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

@FeishuEvidence("UI-TOKENS-001")
internal fun Context.pageDivider(startInsetDp: Int = 16): View = View(this).apply {
  setBackgroundColor(CalendarPagePalette.divider)
  minimumHeight = pageDp(0.5f).coerceAtLeast(1)
  layoutParams = LinearLayout.LayoutParams(
    LinearLayout.LayoutParams.MATCH_PARENT,
    pageDp(0.5f).coerceAtLeast(1),
  ).apply { marginStart = pageDp(startInsetDp) }
}

@FeishuEvidence("UI-ICON-PRIMITIVES-001")
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

@FeishuEvidence("UI-STATE-EMPTY-ERROR-001")
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

@FeishuEvidence("UI-STATE-EMPTY-ERROR-001")
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
