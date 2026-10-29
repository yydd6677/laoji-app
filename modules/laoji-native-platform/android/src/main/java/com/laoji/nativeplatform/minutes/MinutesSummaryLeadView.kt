package com.laoji.nativeplatform.minutes

import android.content.Context
import android.graphics.Rect
import android.text.StaticLayout
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/** One editorial lead. Disclosure is measured before drawing, never posted in
 * response to a server/status refresh. Expanding is an explicit reading action. */
internal class MinutesSummaryLeadView(
  context: Context,
  text: String,
  initiallyExpanded: Boolean = false,
  private val onExpansionChanged: (Boolean) -> Unit = {},
) : LinearLayout(context) {
  internal val body: TextView = context.textView(text, 18, { MinutesPalette.text }).apply {
    setLineSpacing(0f, 1.32f)
    setTextIsSelectable(true)
    maxLines = 4
    ellipsize = TextUtils.TruncateAt.END
  }
  internal val disclosure = context.textView("展开概述", 14, { MinutesPalette.primary }).apply {
    gravity = Gravity.CENTER_VERTICAL
    visibility = View.GONE
    isClickable = true
    isFocusable = true
    minimumHeight = context.dp(44)
    minutesBackground { context.roundedStateBackground(defaultColor = android.graphics.Color.TRANSPARENT,
      pressedColor = MinutesPalette.primarySoft, disabledColor = android.graphics.Color.TRANSPARENT, radiusDp = 6) }
  }
  internal var expanded = initiallyExpanded
    private set
  private var measuredTextWidth = -1
  private var measuredTypeface: android.graphics.Typeface? = null
  private var hasOverflow = false

  init {
    orientation = VERTICAL
    body.maxLines = if (expanded) Int.MAX_VALUE else 4
    body.ellipsize = if (expanded) null else TextUtils.TruncateAt.END
    disclosure.text = if (expanded) "收起概述" else "展开概述"
    addView(body, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(disclosure, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    disclosure.setOnClickListener {
      expanded = !expanded
      onExpansionChanged(expanded)
      body.maxLines = if (expanded) Int.MAX_VALUE else 4
      body.ellipsize = if (expanded) null else TextUtils.TruncateAt.END
      disclosure.text = if (expanded) "收起概述" else "展开概述"
      if (!expanded) post { body.requestRectangleOnScreen(Rect(0, 0, body.width, body.height), false) }
      requestLayout()
    }
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    val width = (body.measuredWidth - body.compoundPaddingLeft - body.compoundPaddingRight).coerceAtLeast(1)
    if (width != measuredTextWidth || measuredTypeface !== body.typeface) {
      measuredTextWidth = width
      measuredTypeface = body.typeface
      // TextView.layout may still be null in its first onMeasure. Measure the
      // same text/paint here so disclosure belongs to the first drawn frame.
      hasOverflow = StaticLayout.Builder.obtain(body.text, 0, body.text.length, body.paint, width)
        .setIncludePad(body.includeFontPadding)
        .setLineSpacing(body.lineSpacingExtra, body.lineSpacingMultiplier)
        .setBreakStrategy(body.breakStrategy)
        .setHyphenationFrequency(body.hyphenationFrequency)
        .setMaxLines(5)
        .build().lineCount > 4
    }
    val visibility = if (hasOverflow) View.VISIBLE else View.GONE
    if (disclosure.visibility != visibility) {
      disclosure.visibility = visibility
      super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
  }
}
