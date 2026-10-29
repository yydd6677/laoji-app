package com.laoji.nativeplatform.ui

// UI-TOKENS-001: Android surfaces consume LaoJi semantic theme roles. Stable
// hit targets and layout dimensions stay independent from skin expression.

import android.content.Context
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.View
import com.laoji.nativeplatform.NativeThemePreference
import java.util.Collections
import java.util.WeakHashMap

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
  private class ThemeBinding(val apply: (NativeUiPalette) -> Unit)
  // Callbacks are owned by each View, never by this weak index. A callback may
  // capture its owner without making a detached Activity live forever.
  private val themedViews = Collections.newSetFromMap(WeakHashMap<View, Boolean>())
  private val themeHandler by lazy { Handler(Looper.getMainLooper()) }

  fun bindTheme(view: View, apply: (NativeUiPalette) -> Unit) {
    check(Looper.myLooper() == Looper.getMainLooper())
    check(view.getTag(com.laoji.nativeplatform.R.id.laoji_theme_bindings) == null) { "theme owner already bound" }
    view.setTag(com.laoji.nativeplatform.R.id.laoji_theme_bindings, ThemeBinding(apply))
    themedViews.add(view)
    apply(palette(view.context))
  }

  internal fun onThemePreferenceChanged() {
    val refresh = Runnable {
      for (view in themedViews.toList()) {
        val binding = view.getTag(com.laoji.nativeplatform.R.id.laoji_theme_bindings) as? ThemeBinding ?: continue
        binding.apply(palette(view.context))
        view.invalidate()
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) refresh.run() else themeHandler.post(refresh)
  }

  const val ICON_HIT_SIZE_DP = GeneratedUiTokens.dimension_iconTarget
  const val PROFILE_ENTRY_HIT_SIZE_DP = GeneratedUiTokens.dimension_profileEntryHitSize
  const val PROFILE_ENTRY_AVATAR_SIZE_DP = GeneratedUiTokens.dimension_profileEntryAvatarSize
  const val DIALOG_MAX_WIDTH_DP = GeneratedUiTokens.dimension_dialogMaxWidth
  const val DIALOG_CONTENT_WIDTH_DP = GeneratedUiTokens.dimension_dialogContentWidth
  const val DIALOG_ACTION_HEIGHT_DP = GeneratedUiTokens.dimension_dialogActionHeight
  const val SHEET_EDGE_MARGIN_DP = GeneratedUiTokens.dimension_sheetEdgeMargin
  const val SHEET_ITEM_HEIGHT_DP = GeneratedUiTokens.dimension_sheetItemHeight
  const val SHEET_CANCEL_HEIGHT_DP = GeneratedUiTokens.dimension_sheetCancelHeight
  const val SHEET_CANCEL_GAP_DP = GeneratedUiTokens.dimension_sheetCancelGap
  const val TOAST_MAX_WIDTH_DP = GeneratedUiTokens.dimension_toastMaxWidth
  const val TOAST_MIN_HEIGHT_DP = GeneratedUiTokens.dimension_toastMinHeight
  const val DIVIDER_DP = GeneratedUiTokens.dimension_divider
  const val OVERLAY_DURATION_MS = GeneratedUiTokens.motion_overlayDuration
  const val SHEET_DURATION_MS = GeneratedUiTokens.motion_sheetDuration
  const val TOAST_DURATION_MS = GeneratedUiTokens.motion_toastDuration

  fun dp(context: Context, value: Float): Float = value * context.resources.displayMetrics.density

  fun sp(context: Context, value: Float): Float = TypedValue.applyDimension(
    TypedValue.COMPLEX_UNIT_SP,
    value,
    context.resources.displayMetrics,
  )

  fun palette(context: Context): NativeUiPalette {
    val theme = NativeThemePreference.read(context)
    val colors = GeneratedUiTokens.palette(theme)
    // A selected skin is authoritative; OS night mode must not recolor only
    // the native half of a page while RN still renders the selected skin.
    return NativeUiPalette(
      body = colors.appBg,
      surface = if (theme == "paper") colors.body else colors.card,
      surfaceOverlay = colors.inputBg,
      textPrimary = colors.text,
      textSecondary = colors.sub,
      textTertiary = colors.faint,
      textDisabled = colors.disabled,
      divider = colors.divider,
      primary = colors.primary,
      primaryPressed = colors.primaryPressed,
      primarySoft = colors.primaryLight,
      danger = colors.red,
      mask = colors.overlay,
      backgroundTips = colors.text,
      onTips = colors.appBg,
    )
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
