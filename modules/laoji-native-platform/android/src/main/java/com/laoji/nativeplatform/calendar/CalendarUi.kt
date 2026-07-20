package com.laoji.nativeplatform.calendar

// CAL-ROOT-001: Calendar chrome uses native semantic colors and fixed Android dimensions.

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import java.util.Locale

data class CalendarPalette(
  val background: Int,
  val surface: Int,
  val surfaceMuted: Int,
  val fillPressed: Int,
  val textPrimary: Int,
  val textSecondary: Int,
  // Feishu UD_N400: adjacent-month dates use the disabled/muted semantic token,
  // not the readable secondary-text token.
  val textDisabled: Int,
  val textPlaceholder: Int,
  val divider: Int,
  val accent: Int,
  val accentSoft: Int,
  val selectionMarker: Int,
  val accentText: Int,
  val eventFill: Int,
  val eventText: Int,
  // CAL-DAY-COMPOSE-001: event fill/text/pressed tokens are kept together so the
  // Canvas event layer cannot silently fall back to a different palette family.
  val eventPressedOverlay: Int,
  val destructive: Int
)

object CalendarUi {
  // Feishu keeps an empty summary in storage and supplies copy only at render
  // time. List/chip surfaces use the parenthesized variant; detail uses its own
  // non-parenthesized title in the page snapshot builder.
  fun listEventTitle(title: String): String = title.ifBlank { "(无主题)" }

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
        background = Color.rgb(26, 26, 26),
        surface = Color.rgb(10, 10, 10),
        surfaceMuted = Color.rgb(41, 41, 41),
        fillPressed = Color.argb(31, 235, 235, 235),
        textPrimary = Color.rgb(235, 235, 235),
        textSecondary = Color.rgb(166, 166, 166),
        textDisabled = Color.rgb(95, 95, 95),
        textPlaceholder = DayRulerContract.TEXT_COLOR_DARK,
        divider = Color.rgb(65, 65, 65),
        accent = Color.rgb(117, 164, 255),
        accentSoft = Color.rgb(21, 35, 64),
        selectionMarker = Color.rgb(67, 67, 67),
        accentText = Color.WHITE,
        // Feishu calendar light/dark event tokens: bg_blue and text_blue.
        eventFill = Color.rgb(23, 49, 102),
        eventText = Color.rgb(143, 180, 255),
        eventPressedOverlay = Color.rgb(117, 117, 117),
        destructive = Color.rgb(240, 91, 86)
      )
    } else {
      CalendarPalette(
        background = Color.rgb(245, 246, 247),
        surface = Color.WHITE,
        surfaceMuted = Color.rgb(242, 243, 245),
        fillPressed = Color.argb(31, 31, 35, 41),
        textPrimary = Color.rgb(31, 35, 41),
        textSecondary = Color.rgb(100, 106, 115),
        textDisabled = Color.rgb(187, 191, 196),
        textPlaceholder = DayRulerContract.TEXT_COLOR_LIGHT,
        divider = Color.argb(38, 31, 35, 41),
        accent = Color.rgb(20, 86, 240),
        accentSoft = Color.rgb(240, 244, 255),
        selectionMarker = Color.rgb(222, 224, 227),
        accentText = Color.WHITE,
        eventFill = Color.rgb(224, 233, 255),
        eventText = Color.rgb(4, 66, 210),
        eventPressedOverlay = Color.rgb(143, 149, 158),
        destructive = Color.rgb(226, 46, 40)
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
    // The app language is Chinese even when the emulator/device system locale is
    // English. Feishu's retained calendar surface also uses the fixed, compact
    // Sunday-first labels instead of inheriting DateFormatSymbols from Android.
    return listOf("日", "一", "二", "三", "四", "五", "六")
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
