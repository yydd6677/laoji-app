package com.laoji.nativeplatform.speaker

// MIN-SPEAKER-001 / UI-FORM-001: native speaker surfaces use the same semantic
// palette and fixed hit targets as the source-mapped Minutes surfaces.

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import com.laoji.nativeplatform.NativeThemePreference

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
    val dark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
      Configuration.UI_MODE_NIGHT_YES
    val vivid = NativeThemePreference.isVivid(context)
    when {
      vivid && !dark -> {
        page = Color.rgb(255, 240, 246)
        surface = Color.rgb(253, 234, 245)
        surfaceOverlay = Color.rgb(240, 232, 255)
        text = Color.rgb(28, 27, 51)
        secondary = Color.rgb(148, 144, 181)
        tertiary = Color.rgb(184, 180, 212)
        disabled = Color.rgb(210, 206, 227)
        divider = Color.rgb(229, 207, 232)
        primary = Color.rgb(123, 92, 184)
        primaryPressed = Color.rgb(46, 24, 128)
        primarySoft = Color.rgb(237, 232, 255)
        danger = Color.rgb(255, 77, 79)
        dangerSoft = Color.rgb(255, 240, 248)
        mask = Color.argb(87, 46, 24, 128)
      }
      vivid -> {
        page = Color.rgb(23, 19, 30)
        surface = Color.rgb(33, 28, 43)
        surfaceOverlay = Color.rgb(68, 55, 90)
        text = Color.rgb(247, 241, 255)
        secondary = Color.rgb(197, 183, 216)
        tertiary = Color.rgb(152, 137, 174)
        disabled = Color.rgb(102, 89, 117)
        divider = Color.rgb(92, 76, 112)
        primary = Color.rgb(169, 130, 232)
        primaryPressed = Color.rgb(216, 196, 255)
        primarySoft = Color.rgb(59, 44, 85)
        danger = Color.rgb(255, 123, 123)
        dangerSoft = Color.rgb(91, 48, 65)
        mask = Color.argb(153, 0, 0, 0)
      }
      dark -> {
        page = Color.rgb(26, 26, 26)
        surface = Color.rgb(10, 10, 10)
        surfaceOverlay = Color.rgb(41, 41, 41)
        text = Color.rgb(235, 235, 235)
        secondary = Color.rgb(166, 166, 166)
        tertiary = Color.rgb(117, 117, 117)
        disabled = Color.rgb(95, 95, 95)
        divider = Color.rgb(65, 65, 65)
        primary = Color.rgb(117, 164, 255)
        primaryPressed = Color.rgb(76, 136, 255)
        primarySoft = Color.rgb(21, 35, 64)
        danger = Color.rgb(240, 91, 86)
        dangerSoft = Color.rgb(74, 35, 35)
        mask = Color.argb(153, 0, 0, 0)
      }
      else -> {
        page = Color.rgb(248, 249, 250)
        surface = Color.WHITE
        surfaceOverlay = Color.rgb(242, 243, 245)
        text = Color.rgb(31, 35, 41)
        secondary = Color.rgb(100, 106, 115)
        tertiary = Color.rgb(143, 149, 158)
        disabled = Color.rgb(187, 191, 196)
        divider = Color.rgb(222, 224, 227)
        primary = Color.rgb(20, 86, 240)
        primaryPressed = Color.rgb(4, 66, 210)
        primarySoft = Color.rgb(240, 244, 255)
        danger = Color.rgb(226, 46, 40)
        dangerSoft = Color.rgb(255, 243, 243)
        mask = Color.argb(140, 0, 0, 0)
      }
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
  typeface = Typeface.create(Typeface.DEFAULT, weight)
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
