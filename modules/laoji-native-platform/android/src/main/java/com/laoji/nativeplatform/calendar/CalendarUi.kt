package com.laoji.nativeplatform.calendar

// CAL-ROOT-001: Calendar chrome uses native semantic colors and fixed Android dimensions.

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import com.laoji.nativeplatform.NativeThemePreference
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
  // [PRODUCT] Month-grid hairlines are slightly more visible than the shared
  // divider token so the seven-column calendar remains scannable on-device.
  val monthGridDivider: Int,
  val accent: Int,
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

// [PRODUCT] Intentional LaoJi calendar overrides. Feishu remains the geometry
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
    val isDark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
      Configuration.UI_MODE_NIGHT_YES
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
    sourceRadiusDp + if (NativeThemePreference.isVivid(context)) 2f else 0f

  fun eventBorderRadiusDp(context: Context): Float =
    if (NativeThemePreference.isVivid(context)) 7f else CalendarProductVisualContract.EVENT_BORDER_RADIUS_DP

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
    val isVivid = NativeThemePreference.isVivid(context)
    if (isVivid && !isDark) {
      return CalendarPalette(
        background = Color.rgb(255, 240, 246),
        surface = Color.rgb(253, 234, 245),
        surfaceMuted = Color.rgb(240, 232, 255),
        fillPressed = Color.argb(31, 123, 92, 184),
        textPrimary = Color.rgb(28, 27, 51),
        textSecondary = Color.rgb(148, 144, 181),
        textDisabled = Color.rgb(210, 206, 227),
        textPlaceholder = Color.rgb(184, 180, 212),
        divider = Color.argb(46, 150, 100, 200),
        monthGridDivider = Color.argb(61, 150, 100, 200),
        accent = Color.rgb(123, 92, 184),
        accentSoft = Color.rgb(237, 232, 255),
        selectionMarker = Color.rgb(255, 181, 204),
        accentText = Color.WHITE,
        eventBorder = Color.rgb(146, 104, 224),
        eventFill = Color.rgb(240, 236, 255),
        eventText = Color.rgb(46, 24, 128),
        eventPressedOverlay = Color.rgb(184, 180, 212),
        destructive = Color.rgb(255, 77, 79)
      )
    }
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
        monthGridDivider = Color.rgb(72, 72, 72),
        accent = Color.rgb(117, 164, 255),
        accentSoft = Color.rgb(21, 35, 64),
        selectionMarker = Color.rgb(67, 67, 67),
        accentText = Color.WHITE,
        // [PRODUCT] The bounded LaoJi event entry uses a quieter B400 blue;
        // weekend dates continue to use the normal Calendar accent.
        eventBorder = Color.rgb(76, 136, 255),
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
        monthGridDivider = Color.argb(46, 31, 35, 41),
        accent = Color.rgb(20, 86, 240),
        accentSoft = Color.rgb(240, 244, 255),
        selectionMarker = Color.rgb(222, 224, 227),
        accentText = Color.WHITE,
        // [PRODUCT] One step lighter than primary B600, while retaining enough
        // contrast against the pale event fill and neutral list surface.
        eventBorder = Color.rgb(51, 112, 255),
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
