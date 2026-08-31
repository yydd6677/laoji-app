package com.laoji.nativeplatform.calendar

// CAL-ROOT-001: Calendar chrome uses native semantic colors and fixed Android dimensions.

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import com.laoji.nativeplatform.NativeThemePreference
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
    val isDark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
      Configuration.UI_MODE_NIGHT_YES || NativeThemePreference.isMidnight(context)
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

  fun dp(context: Context, value: Float): Float = value * context.resources.displayMetrics.density

  fun sp(context: Context, value: Float): Float = TypedValue.applyDimension(
    TypedValue.COMPLEX_UNIT_SP,
    value,
    context.resources.displayMetrics
  )

  fun palette(context: Context): CalendarPalette {
    val isDark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
      Configuration.UI_MODE_NIGHT_YES
    val theme = NativeThemePreference.read(context)
    if (theme == "paper") {
      return CalendarPalette(
        background = Color.rgb(243, 240, 231),
        surface = Color.rgb(252, 251, 246),
        surfaceMuted = Color.rgb(239, 238, 230),
        fillPressed = Color.argb(23, 37, 38, 33),
        textPrimary = Color.rgb(37, 38, 33),
        textSecondary = Color.rgb(98, 99, 93),
        textDisabled = Color.rgb(180, 181, 173),
        textPlaceholder = Color.rgb(133, 134, 126),
        divider = Color.argb(33, 37, 38, 33),
        monthGridDivider = Color.argb(43, 37, 38, 33),
        accent = Color.rgb(99, 120, 36),
        accentSoft = Color.rgb(233, 237, 217),
        selectionMarker = Color.rgb(216, 215, 205),
        accentText = Color.WHITE,
        eventBorder = Color.rgb(62, 113, 143),
        eventFill = Color.rgb(229, 237, 239),
        eventText = Color.rgb(47, 87, 108),
        eventPressedOverlay = Color.rgb(133, 134, 126),
        destructive = Color.rgb(201, 80, 69)
      )
    }
    if (theme == "midnight") {
      return CalendarPalette(
        background = Color.rgb(16, 20, 27),
        surface = Color.rgb(21, 26, 34),
        surfaceMuted = Color.rgb(32, 40, 52),
        fillPressed = Color.argb(26, 238, 243, 250),
        textPrimary = Color.rgb(238, 243, 250),
        textSecondary = Color.rgb(176, 186, 200),
        textDisabled = Color.rgb(86, 97, 112),
        textPlaceholder = Color.rgb(127, 138, 154),
        divider = Color.argb(36, 222, 231, 242),
        monthGridDivider = Color.argb(46, 222, 231, 242),
        accent = Color.rgb(116, 167, 255),
        accentSoft = Color.rgb(30, 50, 80),
        selectionMarker = Color.rgb(44, 55, 69),
        accentText = Color.rgb(16, 20, 27),
        eventBorder = Color.rgb(117, 169, 255),
        eventFill = Color.rgb(27, 49, 78),
        eventText = Color.rgb(164, 197, 255),
        eventPressedOverlay = Color.rgb(127, 138, 154),
        destructive = Color.rgb(255, 119, 112)
      )
    }
    if (theme == "vivid" && !isDark) {
      return CalendarPalette(
        background = Color.rgb(248, 246, 252),
        surface = Color.WHITE,
        surfaceMuted = Color.rgb(242, 238, 252),
        fillPressed = Color.argb(28, 114, 85, 201),
        textPrimary = Color.rgb(33, 29, 45),
        textSecondary = Color.rgb(110, 104, 123),
        textDisabled = Color.rgb(201, 196, 209),
        textPlaceholder = Color.rgb(153, 146, 167),
        divider = Color.argb(33, 71, 55, 92),
        monthGridDivider = Color.argb(43, 71, 55, 92),
        accent = Color.rgb(114, 85, 201),
        accentSoft = Color.rgb(238, 233, 252),
        selectionMarker = Color.rgb(234, 219, 230),
        accentText = Color.WHITE,
        eventBorder = Color.rgb(130, 101, 212),
        eventFill = Color.rgb(241, 236, 252),
        eventText = Color.rgb(79, 54, 157),
        eventPressedOverlay = Color.rgb(153, 146, 167),
        destructive = Color.rgb(255, 77, 79)
      )
    }
    return if (isDark) {
      CalendarPalette(
        background = Color.rgb(16, 20, 27),
        surface = Color.rgb(21, 26, 34),
        surfaceMuted = Color.rgb(32, 40, 52),
        fillPressed = Color.argb(26, 238, 243, 250),
        textPrimary = Color.rgb(238, 243, 250),
        textSecondary = Color.rgb(176, 186, 200),
        textDisabled = Color.rgb(86, 97, 112),
        textPlaceholder = Color.rgb(127, 138, 154),
        divider = Color.argb(36, 222, 231, 242),
        monthGridDivider = Color.argb(46, 222, 231, 242),
        accent = Color.rgb(116, 167, 255),
        accentSoft = Color.rgb(30, 50, 80),
        selectionMarker = Color.rgb(44, 55, 69),
        accentText = Color.WHITE,
        // [PRODUCT] The bounded LaoJi event entry uses a quieter B400 blue;
        // weekend dates continue to use the normal Calendar accent.
        eventBorder = Color.rgb(117, 169, 255),
        // Calendar event fill and text use the shared semantic blue pair.
        eventFill = Color.rgb(27, 49, 78),
        eventText = Color.rgb(164, 197, 255),
        eventPressedOverlay = Color.rgb(127, 138, 154),
        destructive = Color.rgb(255, 119, 112)
      )
    } else {
      CalendarPalette(
        background = Color.rgb(243, 246, 250),
        surface = Color.WHITE,
        surfaceMuted = Color.rgb(238, 243, 250),
        fillPressed = Color.argb(26, 23, 32, 51),
        textPrimary = Color.rgb(23, 32, 51),
        textSecondary = Color.rgb(91, 101, 119),
        textDisabled = Color.rgb(180, 188, 200),
        textPlaceholder = Color.rgb(135, 146, 165),
        divider = Color.argb(33, 23, 32, 51),
        monthGridDivider = Color.argb(43, 23, 32, 51),
        accent = Color.rgb(39, 104, 232),
        accentSoft = Color.rgb(234, 241, 255),
        selectionMarker = Color.rgb(220, 227, 236),
        accentText = Color.WHITE,
        // [PRODUCT] One step lighter than primary B600, while retaining enough
        // contrast against the pale event fill and neutral list surface.
        eventBorder = Color.rgb(60, 120, 238),
        eventFill = Color.rgb(226, 235, 252),
        eventText = Color.rgb(27, 85, 200),
        eventPressedOverlay = Color.rgb(135, 146, 165),
        destructive = Color.rgb(226, 46, 40)
      )
    }
  }

  fun textPaint(context: Context, color: Int, sizeSp: Float, bold: Boolean = false): Paint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      this.color = color
      textSize = sp(context, sizeSp)
      typeface = LaojiThemeTypography.typeface(
        context,
        if (bold) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL,
      )
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
