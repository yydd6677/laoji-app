package com.laoji.nativeplatform.calendar

// CAL-ROOT-001: Calendar chrome uses native semantic colors and fixed Android dimensions.

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import java.text.DateFormatSymbols
import java.util.Locale

data class CalendarPalette(
  val background: Int,
  val surface: Int,
  val surfaceMuted: Int,
  val textPrimary: Int,
  val textSecondary: Int,
  val divider: Int,
  val accent: Int,
  val accentSoft: Int,
  val accentText: Int,
  val eventFill: Int,
  val eventText: Int,
  val destructive: Int
)

object CalendarUi {
  fun dp(context: Context, value: Float): Float = value * context.resources.displayMetrics.density

  fun sp(context: Context, value: Float): Float = TypedValue.applyDimension(
    TypedValue.COMPLEX_UNIT_SP,
    value,
    context.resources.displayMetrics
  )

  fun palette(context: Context): CalendarPalette {
    val isDark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
      Configuration.UI_MODE_NIGHT_YES
    return if (isDark) {
      CalendarPalette(
        background = Color.rgb(24, 26, 30),
        surface = Color.rgb(34, 37, 42),
        surfaceMuted = Color.rgb(45, 49, 55),
        textPrimary = Color.rgb(241, 243, 245),
        textSecondary = Color.rgb(166, 172, 181),
        divider = Color.rgb(64, 69, 77),
        accent = Color.rgb(64, 124, 255),
        accentSoft = Color.rgb(42, 68, 111),
        accentText = Color.WHITE,
        eventFill = Color.rgb(56, 104, 202),
        eventText = Color.WHITE,
        destructive = Color.rgb(255, 109, 118)
      )
    } else {
      CalendarPalette(
        background = Color.rgb(250, 251, 252),
        surface = Color.WHITE,
        surfaceMuted = Color.rgb(244, 246, 248),
        textPrimary = Color.rgb(31, 35, 41),
        textSecondary = Color.rgb(100, 106, 115),
        divider = Color.rgb(222, 226, 230),
        accent = Color.rgb(51, 112, 255),
        accentSoft = Color.rgb(232, 239, 255),
        accentText = Color.WHITE,
        eventFill = Color.rgb(62, 117, 235),
        eventText = Color.WHITE,
        destructive = Color.rgb(216, 60, 68)
      )
    }
  }

  fun textPaint(context: Context, color: Int, sizeSp: Float, bold: Boolean = false): Paint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      this.color = color
      textSize = sp(context, sizeSp)
      typeface = if (bold) Typeface.create(Typeface.DEFAULT, Typeface.BOLD) else Typeface.DEFAULT
    }

  fun background(color: Int, radiusDp: Float, context: Context, strokeColor: Int? = null): GradientDrawable =
    GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      setColor(color)
      cornerRadius = dp(context, radiusDp)
      if (strokeColor != null) setStroke(dp(context, 0.5f).toInt().coerceAtLeast(1), strokeColor)
    }

  fun monthTitle(epochDay: Int): String {
    val date = CalendarDateMath.fromEpochDay(epochDay)
    return String.format(Locale.getDefault(), "%d年%d月", date.year, date.month)
  }

  fun weekdayLabels(): List<String> {
    val weekdays = DateFormatSymbols.getInstance(Locale.getDefault()).shortWeekdays
    return (1..7).map { weekdays[it].ifBlank { it.toString() } }
  }

  fun ellipsize(text: String, paint: Paint, maxWidth: Float): String {
    if (paint.measureText(text) <= maxWidth) return text
    val suffix = "..."
    val suffixWidth = paint.measureText(suffix)
    if (suffixWidth >= maxWidth) return suffix
    var end = text.length
    while (end > 0 && paint.measureText(text, 0, end) + suffixWidth > maxWidth) end -= 1
    return text.substring(0, end) + suffix
  }
}
