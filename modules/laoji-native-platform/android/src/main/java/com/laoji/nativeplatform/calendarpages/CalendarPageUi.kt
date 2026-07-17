package com.laoji.nativeplatform.calendarpages

// UI-SHELL-001 / UI-TOKENS-001 / UI-FORM-001: 44dp title bars, semantic colors,
// 0.5dp dividers, 100dp empty art and 76x36dp retry actions come from the source closure.

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
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.view.ViewCompat

internal object CalendarPagePalette {
  val body = Color.WHITE
  val float = Color.WHITE
  val neutralBackground = Color.rgb(245, 246, 247)
  val text = Color.rgb(31, 35, 41)
  val secondary = Color.rgb(100, 106, 115)
  val placeholder = Color.rgb(143, 149, 158)
  val disabled = Color.rgb(187, 191, 196)
  val divider = Color.rgb(222, 224, 227)
  val primary = Color.rgb(20, 86, 240)
  val primaryHeader = Color.rgb(4, 66, 210)
  val primarySoft = Color.rgb(240, 244, 255)
  val danger = Color.rgb(226, 46, 40)
  val scrim = Color.argb(112, 255, 255, 255)
}

internal fun Context.pageDp(value: Float): Int =
  TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics).toInt()

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

internal class CalendarPageTitleBar(context: Context) : FrameLayout(context) {
  private val title = context.pageText(sizeSp = 17f, weight = Typeface.BOLD).apply {
    gravity = Gravity.CENTER
    maxLines = 1
  }
  private val left = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private val right = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }

  init {
    setBackgroundColor(CalendarPagePalette.float)
    minimumHeight = context.pageDp(44)
    addView(
      title,
      LayoutParams(LayoutParams.MATCH_PARENT, context.pageDp(44)).apply {
        leftMargin = context.pageDp(96)
        rightMargin = context.pageDp(96)
        gravity = Gravity.CENTER
      },
    )
    addView(left, LayoutParams(LayoutParams.WRAP_CONTENT, context.pageDp(44)).apply {
      gravity = Gravity.START
    })
    addView(right, LayoutParams(LayoutParams.WRAP_CONTENT, context.pageDp(44)).apply {
      gravity = Gravity.END
    })
  }

  fun setTitle(value: String, color: Int = CalendarPagePalette.text, alpha: Float = 1f) {
    title.text = value
    title.setTextColor(color)
    title.alpha = alpha
  }

  fun setTitleAlpha(value: Float) {
    title.alpha = value.coerceIn(0f, 1f)
  }

  fun clearActions() {
    left.removeAllViews()
    right.removeAllViews()
  }

  fun addBack(onClick: () -> Unit) {
    left.addView(
      context.pageIconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back, "返回").apply {
        setOnClickListener { onClick() }
      },
      LinearLayout.LayoutParams(context.pageDp(44), context.pageDp(44)).apply {
        leftMargin = context.pageDp(6)
      },
    )
  }

  fun addLeftText(label: String, onClick: () -> Unit) {
    left.addView(context.pageText(label, 16f, CalendarPagePalette.text).apply {
      gravity = Gravity.CENTER
      setPadding(context.pageDp(16), 0, context.pageDp(12), 0)
      setOnClickListener { onClick() }
      isClickable = true
      isFocusable = true
      contentDescription = label
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.pageDp(44)))
  }

  fun addRightIcon(
    drawableRes: Int,
    description: String,
    tint: Int = CalendarPagePalette.text,
    enabled: Boolean = true,
    onClick: () -> Unit,
  ) {
    right.addView(
      context.pageIconButton(drawableRes, description, tint).apply {
        isEnabled = enabled
        alpha = if (enabled) 1f else 0.35f
        setOnClickListener { onClick() }
      },
      LinearLayout.LayoutParams(context.pageDp(44), context.pageDp(44)),
    )
  }

  fun addRightText(
    label: String,
    enabled: Boolean,
    busy: Boolean = false,
    onClick: () -> Unit,
  ) {
    right.addView(context.pageText(
      if (busy) "保存中" else label,
      16f,
      if (enabled) CalendarPagePalette.primary else CalendarPagePalette.disabled,
      Typeface.BOLD,
    ).apply {
      gravity = Gravity.CENTER
      setPadding(context.pageDp(12), 0, context.pageDp(16), 0)
      isEnabled = enabled
      isClickable = enabled
      isFocusable = enabled
      contentDescription = if (busy) "正在保存日程" else label
      setOnClickListener { onClick() }
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, context.pageDp(44)))
  }
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
