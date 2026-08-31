package com.laoji.nativeplatform.speaker

// MIN-SPEAKER-001 / UI-FORM-001: native speaker surfaces use the same semantic
// palette and fixed hit targets as the source-mapped Minutes surfaces.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import com.laoji.nativeplatform.NativeThemePreference
import com.laoji.nativeplatform.ui.NativeUiTokens
import com.laoji.nativeplatform.ui.LaojiThemeTypography

internal object SpeakerPalette {
  var page = Color.rgb(248, 249, 250)
  var surface = Color.WHITE
  var surfaceOverlay = Color.rgb(242, 243, 245)
  var text = Color.rgb(31, 35, 41)
  var secondary = Color.rgb(100, 106, 115)
  var tertiary = Color.rgb(143, 149, 158)
  var disabled = Color.rgb(187, 191, 196)
  var divider = Color.rgb(222, 224, 227)
  var primary = Color.rgb(20, 86, 240)
  var primaryPressed = Color.rgb(4, 66, 210)
  var primarySoft = Color.rgb(240, 244, 255)
  var danger = Color.rgb(226, 46, 40)
  var dangerSoft = Color.rgb(255, 243, 243)
  var mask = Color.argb(140, 0, 0, 0)

  fun configure(context: Context) {
    val palette = NativeUiTokens.palette(context)
    page = palette.body
    surface = palette.surface
    surfaceOverlay = palette.surfaceOverlay
    text = palette.textPrimary
    secondary = palette.textSecondary
    tertiary = palette.textTertiary
    disabled = palette.textDisabled
    divider = palette.divider
    primary = palette.primary
    primaryPressed = palette.primaryPressed
    primarySoft = palette.primarySoft
    danger = palette.danger
    mask = palette.mask
    dangerSoft = when (NativeThemePreference.read(context)) {
      "vivid" -> Color.rgb(255, 240, 248)
      "paper" -> Color.rgb(249, 232, 228)
      "midnight" -> Color.rgb(74, 41, 43)
      else -> Color.rgb(255, 243, 243)
    }
  }
}

internal fun Context.speakerDp(value: Int): Int =
  TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

internal fun Context.speakerSp(value: Int): Float =
  TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), resources.displayMetrics)

internal fun View.speakerBackground(
  color: Int,
  radiusDp: Int = 0,
  strokeColor: Int? = null,
  strokeWidthDp: Int = 0,
) {
  background = GradientDrawable().apply {
    setColor(color)
    cornerRadius = context.speakerDp(radiusDp).toFloat()
    if (strokeColor != null && strokeWidthDp > 0) {
      setStroke(context.speakerDp(strokeWidthDp), strokeColor)
    }
  }
}

internal fun Context.speakerText(
  text: CharSequence = "",
  sizeSp: Int = 14,
  color: Int = SpeakerPalette.text,
  weight: Int = Typeface.NORMAL,
): TextView = TextView(this).apply {
  this.text = text
  setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp.toFloat())
  setTextColor(color)
  typeface = LaojiThemeTypography.typeface(this@speakerText, weight)
  includeFontPadding = false
}

internal fun Context.speakerIconButton(
  drawableRes: Int,
  description: String,
  tint: Int = SpeakerPalette.text,
): ImageButton = ImageButton(this).apply {
  setImageResource(drawableRes)
  imageTintList = ColorStateList.valueOf(tint)
  background = null
  contentDescription = description
  minimumWidth = speakerDp(44)
  minimumHeight = speakerDp(44)
  setPadding(speakerDp(10), speakerDp(10), speakerDp(10), speakerDp(10))
  isFocusable = true
  isClickable = true
}
