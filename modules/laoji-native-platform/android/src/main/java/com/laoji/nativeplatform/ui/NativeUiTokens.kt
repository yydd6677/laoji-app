package com.laoji.nativeplatform.ui

// UI-TOKENS-001: Keep the Android presentation layer on Feishu's semantic UD colors.

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
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
    val isVivid = NativeThemePreference.isVivid(context)
    if (isVivid && !isDark) {
      return NativeUiPalette(
        body = Color.rgb(255, 240, 246),
        surface = Color.rgb(253, 234, 245),
        surfaceOverlay = Color.rgb(240, 232, 255),
        textPrimary = Color.rgb(28, 27, 51),
        textSecondary = Color.rgb(148, 144, 181),
        textTertiary = Color.rgb(184, 180, 212),
        textDisabled = Color.rgb(210, 206, 227),
        divider = Color.argb(46, 150, 100, 200),
        primary = Color.rgb(123, 92, 184),
        primaryPressed = Color.rgb(46, 24, 128),
        primarySoft = Color.rgb(237, 232, 255),
        danger = Color.rgb(255, 77, 79),
        mask = Color.argb(87, 46, 24, 128),
        backgroundTips = Color.rgb(46, 24, 128),
        onTips = Color.WHITE,
      )
    }
    if (isVivid && isDark) {
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
        body = Color.rgb(16, 16, 16),
        surface = Color.rgb(31, 31, 31),
        surfaceOverlay = Color.rgb(55, 55, 55),
        textPrimary = Color.rgb(240, 240, 240),
        textSecondary = Color.rgb(193, 193, 193),
        textTertiary = Color.rgb(143, 149, 158),
        textDisabled = Color.rgb(95, 95, 95),
        divider = Color.argb(38, 240, 240, 240),
        // Feishu night resources: primary_fill_default -> B400,
        // primary_fill_pressed -> B500, and B50 for a quiet selected fill.
        primary = Color.rgb(51, 112, 235),
        primaryPressed = Color.rgb(76, 136, 255),
        primarySoft = Color.rgb(21, 35, 64),
        danger = Color.rgb(240, 91, 86),
        mask = Color.argb(150, 0, 0, 0),
        backgroundTips = Color.rgb(80, 80, 80),
        onTips = Color.WHITE,
      )
    } else {
      NativeUiPalette(
        body = Color.rgb(248, 249, 250),
        surface = Color.WHITE,
        surfaceOverlay = Color.rgb(242, 243, 245),
        textPrimary = Color.rgb(31, 35, 41),
        textSecondary = Color.rgb(100, 106, 115),
        textTertiary = Color.rgb(143, 149, 158),
        textDisabled = Color.rgb(187, 191, 196),
        divider = Color.argb(38, 31, 35, 41),
        // Feishu light resources: primary_fill_default -> B600 and
        // primary_fill_pressed -> B700. B500 is the hover token, not default.
        primary = Color.rgb(20, 86, 240),
        primaryPressed = Color.rgb(4, 66, 210),
        primarySoft = Color.rgb(240, 244, 255),
        danger = Color.rgb(226, 46, 40),
        mask = Color.argb(128, 0, 0, 0),
        backgroundTips = Color.rgb(31, 35, 41),
        onTips = Color.WHITE,
      )
    }
  }

  fun textPaint(context: Context, color: Int, sizeSp: Float, bold: Boolean = false): Paint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      this.color = color
      textSize = sp(context, sizeSp)
      typeface = if (bold) Typeface.create(Typeface.DEFAULT, Typeface.BOLD) else Typeface.DEFAULT
    }

  fun roundedBackground(context: Context, color: Int, radiusDp: Float, stroke: Int? = null): GradientDrawable =
    GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      setColor(color)
      cornerRadius = dp(context, radiusDp)
      stroke?.let { setStroke(dp(context, DIVIDER_DP).toInt().coerceAtLeast(1), it) }
    }
}
