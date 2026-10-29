package com.laoji.nativeplatform.calendar

// CAL-ROOT-001: Calendar chrome uses native semantic colors and fixed Android dimensions.

import android.content.Context
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import com.laoji.nativeplatform.NativeThemePreference
import com.laoji.nativeplatform.ui.GeneratedUiTokens
import com.laoji.nativeplatform.ui.LaojiThemeTypography
import java.util.Locale

data class CalendarPalette(
  val background: Int,
  val surface: Int,
  val surfaceMuted: Int,
  val fillPressed: Int,
  val textPrimary: Int,
  val textSecondary: Int,
  // Adjacent-month dates use the disabled/muted semantic token,
  // not the readable secondary-text token.
  val textDisabled: Int,
  val textPlaceholder: Int,
  val divider: Int,
  // [PRODUCT] Month-grid hairlines are slightly more visible than the shared
  // divider token so the seven-column calendar remains scannable on-device.
  val monthGridDivider: Int,
  val accent: Int,
  val weekendDate: Int,
  val accentSoft: Int,
  val selectionMarker: Int,
  val accentText: Int,
  val eventBorder: Int,
  val eventFill: Int,
  val eventText: Int,
  // CAL-DAY-COMPOSE-001: event fill/text/pressed tokens are kept together so the
  // Canvas event layer cannot silently fall back to a different palette family.
  val eventPressedOverlay: Int,
  val destructive: Int
)

data class CalendarEventVisual(
  val border: Int,
  val fill: Int,
  val text: Int,
  val pressedOverlay: Int,
)

// [PRODUCT] LaoJi owns the calendar geometry
// baseline, while date emphasis and bounded event entries follow the user's
// explicit personalization contract.
internal object CalendarProductVisualContract {
  const val DATE_NUMBER_SCALE = 1.2f
  const val EVENT_BORDER_WIDTH_DP = 2f
  const val EVENT_BORDER_RADIUS_DP = 4f

  fun dateNumberSizeSp(sourceSizeSp: Float): Float = sourceSizeSp * DATE_NUMBER_SCALE

  fun isWeekendColumn(sundayFirstColumn: Int): Boolean =
    sundayFirstColumn == 0 || sundayFirstColumn == 6
}

object CalendarUi {
  private val eventCategories = setOf("工作", "学习", "健康", "生活", "社交", "出行", "财务", "重要", "其他")

  // [PRODUCT] Fixed hues copied from LaoJi's original event-bucket design.
  // They are deliberately independent from the standard/vivid page palette.
  private val eventCategoryColors = mapOf(
    "工作" to Color.rgb(91, 140, 255),
    "学习" to Color.rgb(82, 196, 26),
    "健康" to Color.rgb(38, 198, 218),
    "生活" to Color.rgb(123, 92, 184),
    "社交" to Color.rgb(255, 143, 171),
    "出行" to Color.rgb(255, 149, 0),
    "财务" to Color.rgb(155, 89, 182),
    "重要" to Color.rgb(255, 77, 79),
    "其他" to Color.rgb(184, 180, 212),
  )

  private val eventCategoryTextColors = mapOf(
    "工作" to Color.rgb(49, 93, 184),
    "学习" to Color.rgb(39, 117, 31),
    "健康" to Color.rgb(20, 125, 137),
    "生活" to Color.rgb(87, 58, 135),
    "社交" to Color.rgb(180, 71, 112),
    "出行" to Color.rgb(166, 93, 0),
    "财务" to Color.rgb(113, 59, 135),
    "重要" to Color.rgb(184, 39, 45),
    "其他" to Color.rgb(119, 114, 138),
  )

  fun normalizeEventCategory(category: String?): String {
    val clean = category?.trim().orEmpty()
    return if (clean in eventCategories) clean else "其他"
  }

  fun eventVisual(context: Context, category: String?): CalendarEventVisual {
    val key = normalizeEventCategory(category)
    val border = eventCategoryColors[key] ?: eventCategoryColors.getValue("其他")
    val isDark = NativeThemePreference.isMidnight(context)
    val fillAlpha = if (isDark) 58 else 30
    val text = if (isDark) border else eventCategoryTextColors[key] ?: eventCategoryTextColors.getValue("其他")
    return CalendarEventVisual(
      border = border,
      fill = Color.argb(fillAlpha, Color.red(border), Color.green(border), Color.blue(border)),
      text = text,
      pressedOverlay = Color.argb(38, Color.red(border), Color.green(border), Color.blue(border)),
    )
  }

  fun eventRadiusDp(context: Context, sourceRadiusDp: Float): Float =
    sourceRadiusDp + when {
      NativeThemePreference.isVivid(context) -> 2f
      NativeThemePreference.isMidnight(context) -> 1f
      else -> 0f
    }

  fun eventBorderRadiusDp(context: Context): Float =
    when {
      NativeThemePreference.isVivid(context) -> 7f
      NativeThemePreference.isMidnight(context) -> 6f
      NativeThemePreference.isPaper(context) -> 5f
      else -> CalendarProductVisualContract.EVENT_BORDER_RADIUS_DP
    }

  // Keep an empty summary in storage and supply copy only at render
  // time. List/chip surfaces use the parenthesized variant; detail uses its own
  // non-parenthesized title in the page snapshot builder.
  fun listEventTitle(title: String): String = title.ifBlank { "(无主题)" }

  fun eventDisplayTitle(event: CalendarEvent): String =
    (if (event.completed) "✓ " else "") + listEventTitle(event.title)

  fun eventChipTitle(event: CalendarEvent): String =
    listOfNotNull(event.timePeriodLabel?.takeIf(String::isNotBlank), eventDisplayTitle(event)).joinToString(" ")

  fun dp(context: Context, value: Float): Float = value * context.resources.displayMetrics.density

  fun sp(context: Context, value: Float): Float = TypedValue.applyDimension(
    TypedValue.COMPLEX_UNIT_SP,
    value,
    context.resources.displayMetrics
  )

  fun palette(context: Context): CalendarPalette {
    val theme = NativeThemePreference.read(context)
    val colors = GeneratedUiTokens.palette(theme)
    // These are legacy quiet event fallbacks, not event-category assignments.
    val event = when (theme) {
      "paper" -> Triple(Color.rgb(62, 113, 143), Color.rgb(229, 237, 239), Color.rgb(47, 87, 108))
      "midnight" -> Triple(Color.rgb(117, 169, 255), Color.rgb(27, 49, 78), Color.rgb(164, 197, 255))
      "vivid" -> Triple(Color.rgb(130, 101, 212), Color.rgb(241, 236, 252), Color.rgb(79, 54, 157))
      else -> Triple(Color.rgb(60, 120, 238), Color.rgb(226, 235, 252), colors.primaryPressed)
    }
    return CalendarPalette(
      background = colors.appBg,
      surface = if (theme == "neutral" || theme == "vivid") colors.card else colors.body,
      surfaceMuted = colors.inputBg,
      fillPressed = colors.pressed,
      textPrimary = colors.text,
      textSecondary = colors.sub,
      textDisabled = colors.disabled,
      textPlaceholder = colors.faint,
      divider = colors.divider,
      monthGridDivider = colors.calendarGridDivider,
      accent = colors.primary,
      weekendDate = colors.blue,
      accentSoft = colors.primaryLight,
      selectionMarker = if (theme == "vivid") Color.rgb(234, 219, 230) else colors.border,
      accentText = if (theme == "midnight") colors.appBg else Color.WHITE,
      eventBorder = event.first,
      eventFill = event.second,
      eventText = event.third,
      eventPressedOverlay = colors.faint,
      destructive = colors.red,
    )
  }

  fun textPaint(context: Context, color: Int, sizeSp: Float, bold: Boolean = false): Paint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = sp(context, sizeSp)
      restyleTextPaint(context, this, color, bold)
    }

  fun restyleTextPaint(context: Context, paint: Paint, color: Int, bold: Boolean = false) {
    paint.color = color
    paint.typeface = LaojiThemeTypography.typeface(context,
      if (bold) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
  }

  fun background(
    color: Int,
    radiusDp: Float,
    context: Context,
    strokeColor: Int? = null,
    strokeWidthDp: Float = 0.5f,
  ): GradientDrawable =
    GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      setColor(color)
      cornerRadius = dp(context, radiusDp)
      if (strokeColor != null) {
        setStroke(dp(context, strokeWidthDp).toInt().coerceAtLeast(1), strokeColor)
      }
    }

  fun monthTitle(epochDay: Int): String {
    val date = CalendarDateMath.fromEpochDay(epochDay)
    return String.format(Locale.getDefault(), "%d年%d月", date.year, date.month)
  }

  fun weekdayLabels(): List<String> {
    // The app language is Chinese even when the emulator/device system locale is
    // English. The calendar surface uses the fixed, compact
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
