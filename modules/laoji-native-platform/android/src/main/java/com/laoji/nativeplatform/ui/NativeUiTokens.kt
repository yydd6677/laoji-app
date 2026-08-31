package com.laoji.nativeplatform.ui

// UI-TOKENS-001: Android surfaces consume LaoJi semantic theme roles. Stable
// hit targets and layout dimensions stay independent from skin expression.

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import com.laoji.nativeplatform.NativeThemePreference

data class NativeUiPalette(
  val body: Int,
  val surface: Int,
  val surfaceOverlay: Int,
  val textPrimary: Int,
  val textSecondary: Int,
  val textTertiary: Int,
  val textDisabled: Int,
  val divider: Int,
  val primary: Int,
  val primaryPressed: Int,
  val primarySoft: Int,
  val danger: Int,
  val mask: Int,
  val backgroundTips: Int,
  val onTips: Int,
)

object NativeUiTokens {
  const val ICON_HIT_SIZE_DP = 48f
  const val PROFILE_ENTRY_HIT_SIZE_DP = 44f
  const val PROFILE_ENTRY_AVATAR_SIZE_DP = 36f
  const val DIALOG_MAX_WIDTH_DP = 296f
  const val DIALOG_CONTENT_WIDTH_DP = 260f
  const val DIALOG_ACTION_HEIGHT_DP = 50f
  const val SHEET_EDGE_MARGIN_DP = 12f
  const val SHEET_ITEM_HEIGHT_DP = 52f
  const val SHEET_CANCEL_HEIGHT_DP = 48f
  const val SHEET_CANCEL_GAP_DP = 12f
  const val TOAST_MAX_WIDTH_DP = 295f
  const val TOAST_MIN_HEIGHT_DP = 40f
  const val DIVIDER_DP = 0.5f
  const val OVERLAY_DURATION_MS = 170L
  const val SHEET_DURATION_MS = 300L
  const val TOAST_DURATION_MS = 200L

  fun dp(context: Context, value: Float): Float = value * context.resources.displayMetrics.density

  fun sp(context: Context, value: Float): Float = TypedValue.applyDimension(
    TypedValue.COMPLEX_UNIT_SP,
    value,
    context.resources.displayMetrics,
  )

  fun palette(context: Context): NativeUiPalette {
    val isDark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
      Configuration.UI_MODE_NIGHT_YES
    val theme = NativeThemePreference.read(context)
    if (theme == "paper") {
      return NativeUiPalette(
        body = Color.rgb(243, 240, 231),
        surface = Color.rgb(252, 251, 246),
        surfaceOverlay = Color.rgb(239, 238, 230),
        textPrimary = Color.rgb(37, 38, 33),
        textSecondary = Color.rgb(98, 99, 93),
        textTertiary = Color.rgb(133, 134, 126),
        textDisabled = Color.rgb(180, 181, 173),
        divider = Color.argb(33, 37, 38, 33),
        primary = Color.rgb(99, 120, 36),
        primaryPressed = Color.rgb(77, 96, 24),
        primarySoft = Color.rgb(233, 237, 217),
        danger = Color.rgb(201, 80, 69),
        mask = Color.argb(97, 34, 35, 30),
        backgroundTips = Color.rgb(37, 38, 33),
        onTips = Color.rgb(252, 251, 246),
      )
    }
    if (theme == "midnight") {
      return NativeUiPalette(
        body = Color.rgb(16, 20, 27),
        surface = Color.rgb(27, 34, 45),
        surfaceOverlay = Color.rgb(32, 40, 52),
        textPrimary = Color.rgb(238, 243, 250),
        textSecondary = Color.rgb(176, 186, 200),
        textTertiary = Color.rgb(127, 138, 154),
        textDisabled = Color.rgb(86, 97, 112),
        divider = Color.argb(36, 222, 231, 242),
        primary = Color.rgb(116, 167, 255),
        primaryPressed = Color.rgb(90, 141, 231),
        primarySoft = Color.rgb(30, 50, 80),
        danger = Color.rgb(255, 119, 112),
        mask = Color.argb(153, 0, 0, 0),
        backgroundTips = Color.rgb(238, 243, 250),
        onTips = Color.rgb(16, 20, 27),
      )
    }
    if (theme == "vivid" && !isDark) {
      return NativeUiPalette(
        body = Color.rgb(248, 246, 252),
        surface = Color.WHITE,
        surfaceOverlay = Color.rgb(242, 238, 252),
        textPrimary = Color.rgb(33, 29, 45),
        textSecondary = Color.rgb(110, 104, 123),
        textTertiary = Color.rgb(153, 146, 167),
        textDisabled = Color.rgb(201, 196, 209),
        divider = Color.argb(33, 71, 55, 92),
        primary = Color.rgb(114, 85, 201),
        primaryPressed = Color.rgb(91, 64, 174),
        primarySoft = Color.rgb(238, 233, 252),
        danger = Color.rgb(255, 77, 79),
        mask = Color.argb(92, 36, 25, 54),
        backgroundTips = Color.rgb(33, 29, 45),
        onTips = Color.WHITE,
      )
    }
    if (theme == "vivid" && isDark) {
      return NativeUiPalette(
        body = Color.rgb(23, 19, 30),
        surface = Color.rgb(33, 28, 43),
        surfaceOverlay = Color.rgb(68, 55, 90),
        textPrimary = Color.rgb(247, 241, 255),
        textSecondary = Color.rgb(197, 183, 216),
        textTertiary = Color.rgb(152, 137, 174),
        textDisabled = Color.rgb(102, 89, 117),
        divider = Color.argb(41, 235, 220, 255),
        primary = Color.rgb(169, 130, 232),
        primaryPressed = Color.rgb(216, 196, 255),
        primarySoft = Color.rgb(59, 44, 85),
        danger = Color.rgb(255, 123, 123),
        mask = Color.argb(153, 0, 0, 0),
        backgroundTips = Color.rgb(91, 67, 133),
        onTips = Color.WHITE,
      )
    }
    return if (isDark) {
      NativeUiPalette(
        body = Color.rgb(16, 20, 27),
        surface = Color.rgb(27, 34, 45),
        surfaceOverlay = Color.rgb(32, 40, 52),
        textPrimary = Color.rgb(238, 243, 250),
        textSecondary = Color.rgb(176, 186, 200),
        textTertiary = Color.rgb(127, 138, 154),
        textDisabled = Color.rgb(86, 97, 112),
        divider = Color.argb(36, 222, 231, 242),
        // [SOURCE] Feishu night resources: primary_fill_default -> B400,
        // primary_fill_pressed -> B500, and B50 for a quiet selected fill.
        primary = Color.rgb(116, 167, 255),
        primaryPressed = Color.rgb(90, 141, 231),
        primarySoft = Color.rgb(30, 50, 80),
        danger = Color.rgb(255, 119, 112),
        mask = Color.argb(150, 0, 0, 0),
        backgroundTips = Color.rgb(238, 243, 250),
        onTips = Color.rgb(16, 20, 27),
      )
    } else {
      NativeUiPalette(
        body = Color.rgb(243, 246, 250),
        surface = Color.WHITE,
        surfaceOverlay = Color.rgb(238, 243, 250),
        textPrimary = Color.rgb(23, 32, 51),
        textSecondary = Color.rgb(91, 101, 119),
        textTertiary = Color.rgb(135, 146, 165),
        textDisabled = Color.rgb(180, 188, 200),
        divider = Color.argb(33, 23, 32, 51),
        // [SOURCE] Feishu light resources: primary_fill_default -> B600 and
        // primary_fill_pressed -> B700. B500 is the hover token, not default.
        primary = Color.rgb(39, 104, 232),
        primaryPressed = Color.rgb(27, 85, 200),
        primarySoft = Color.rgb(234, 241, 255),
        danger = Color.rgb(226, 46, 40),
        mask = Color.argb(128, 0, 0, 0),
        backgroundTips = Color.rgb(23, 32, 51),
        onTips = Color.WHITE,
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

  fun roundedBackground(context: Context, color: Int, radiusDp: Float, stroke: Int? = null): GradientDrawable =
    GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      setColor(color)
      cornerRadius = dp(context, radiusDp)
      stroke?.let { setStroke(dp(context, DIVIDER_DP).toInt().coerceAtLeast(1), it) }
    }
}
