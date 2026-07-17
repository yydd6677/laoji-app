package com.laoji.nativeplatform.minutes

// UI-TOKENS-001 / MIN-ROOT-001: shared native Minutes tokens and controls.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView

internal object MinutesPalette {
  val page = Color.rgb(248, 249, 250)
  val surface = Color.WHITE
  val text = Color.rgb(31, 35, 41)
  val secondary = Color.rgb(100, 106, 115)
  val faint = Color.rgb(143, 149, 158)
  val disabled = Color.rgb(187, 191, 196)
  val divider = Color.rgb(222, 224, 227)
  val primary = Color.rgb(20, 86, 240)
  val primarySoft = Color.rgb(240, 244, 255)
  val danger = Color.rgb(226, 46, 40)
  val dangerSoft = Color.rgb(255, 243, 243)
  val warning = Color.rgb(194, 87, 5)
  val success = Color.rgb(37, 136, 50)
}

internal fun Context.dp(value: Int): Int =
  TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

internal fun Context.sp(value: Int): Float =
  TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), resources.displayMetrics)

internal fun View.backgroundShape(
  color: Int,
  radiusDp: Int = 0,
  strokeColor: Int? = null,
  strokeWidthDp: Int = 0,
) {
  background = GradientDrawable().apply {
    setColor(color)
    cornerRadius = context.dp(radiusDp).toFloat()
    if (strokeColor != null && strokeWidthDp > 0) {
      setStroke(context.dp(strokeWidthDp), strokeColor)
    }
  }
}

internal fun Context.textView(
  text: CharSequence = "",
  textSizeSp: Int = 14,
  color: Int = MinutesPalette.text,
  weight: Int = Typeface.NORMAL,
): TextView = TextView(this).apply {
  this.text = text
  setTextSize(TypedValue.COMPLEX_UNIT_SP, textSizeSp.toFloat())
  setTextColor(color)
  typeface = Typeface.create(Typeface.DEFAULT, weight)
  includeFontPadding = false
}

internal fun Context.iconButton(
  drawableRes: Int,
  description: String,
): ImageButton = ImageButton(this).apply {
  setImageResource(drawableRes)
  imageTintList = ColorStateList.valueOf(MinutesPalette.text)
  background = null
  contentDescription = description
  isFocusable = true
  isClickable = true
  minimumWidth = dp(44)
  minimumHeight = dp(44)
  setPadding(dp(11), dp(11), dp(11), dp(11))
}

internal class MinutesTitleBar(context: Context) : FrameLayout(context) {
  private val titleView = context.textView(textSizeSp = 20, weight = Typeface.BOLD).apply {
    gravity = Gravity.CENTER
    maxLines = 1
  }
  private val leftActions = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private val rightActions = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private var actionConfiguration = ""
  private var actionHandler: ((String) -> Unit)? = null

  init {
    setBackgroundColor(MinutesPalette.surface)
    minimumHeight = context.dp(44)
    addView(
      titleView,
      LayoutParams(LayoutParams.MATCH_PARENT, context.dp(44)).apply {
        leftMargin = context.dp(98)
        rightMargin = context.dp(98)
        gravity = Gravity.CENTER
      },
    )
    addView(
      leftActions,
      LayoutParams(LayoutParams.WRAP_CONTENT, context.dp(44)).apply { gravity = Gravity.START },
    )
    addView(
      rightActions,
      LayoutParams(LayoutParams.WRAP_CONTENT, context.dp(44)).apply { gravity = Gravity.END },
    )
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  fun configure(
    title: String,
    showBack: Boolean,
    showSearch: Boolean = false,
    showShare: Boolean = false,
    showMore: Boolean = false,
    shareEnabled: Boolean = true,
    onAction: (String) -> Unit,
  ) {
    if (titleView.text.toString() != title) titleView.text = title
    actionHandler = onAction
    val nextConfiguration = listOf(showBack, showSearch, showShare, showMore, shareEnabled).joinToString("|")
    if (nextConfiguration == actionConfiguration) return
    actionConfiguration = nextConfiguration
    leftActions.removeAllViews()
    rightActions.removeAllViews()
    if (showBack) {
      leftActions.addView(
        context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back, "返回").apply {
          setOnClickListener { actionHandler?.invoke("back") }
        },
        LinearLayout.LayoutParams(context.dp(44), context.dp(44)).apply { leftMargin = context.dp(6) },
      )
    }
    if (showSearch) {
      addRightAction(android.R.drawable.ic_menu_search, "搜索会议记录", action = "search")
    }
    if (showShare) {
      addRightAction(android.R.drawable.ic_menu_share, "分享会议资料", shareEnabled, "share")
    }
    if (showMore) {
      addRightAction(android.R.drawable.ic_menu_more, "更多会议操作", action = "more")
    }
  }

  private fun addRightAction(
    drawableRes: Int,
    description: String,
    enabled: Boolean = true,
    action: String,
  ) {
    rightActions.addView(
      context.iconButton(drawableRes, description).apply {
        isEnabled = enabled
        alpha = if (enabled) 1f else 0.35f
        setOnClickListener { actionHandler?.invoke(action) }
      },
      LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
    )
  }
}

internal fun statusToneColor(tone: String): Int = when (tone) {
  "danger" -> MinutesPalette.danger
  "warning" -> MinutesPalette.warning
  "success" -> MinutesPalette.success
  "primary" -> MinutesPalette.primary
  else -> MinutesPalette.faint
}

internal fun formatClock(durationMs: Long): String {
  val totalSeconds = (durationMs.coerceAtLeast(0L) / 1_000L).toInt()
  val hours = totalSeconds / 3_600
  val minutes = (totalSeconds % 3_600) / 60
  val seconds = totalSeconds % 60
  return if (hours > 0) {
    "%02d:%02d:%02d".format(hours, minutes, seconds)
  } else {
    "%02d:%02d".format(minutes, seconds)
  }
}
