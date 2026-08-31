package com.laoji.nativeplatform.ui

import android.app.Activity
import android.content.Context
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat
import com.laoji.nativeplatform.NativeThemePreference
import java.util.concurrent.ConcurrentHashMap

/** Keeps React Native, classic Android views, and Canvas text on one theme font. */
object LaojiThemeTypography {
  private val typefaces = ConcurrentHashMap<String, Typeface>()

  private fun normalizedTheme(context: Context): String = when (NativeThemePreference.read(context)) {
    "vivid" -> "vivid"
    "paper" -> "paper"
    "midnight" -> "midnight"
    else -> "neutral"
  }

  private fun resourceName(themeId: String): String = "xml_laoji_theme_$themeId"

  fun typeface(context: Context, style: Int = Typeface.NORMAL): Typeface {
    val themeId = normalizedTheme(context)
    val base = typefaces.getOrPut(themeId) {
      val resourceId = context.resources.getIdentifier(
        resourceName(themeId),
        "font",
        context.packageName,
      )
      if (resourceId == 0) {
        Typeface.DEFAULT
      } else {
        ResourcesCompat.getFont(context, resourceId) ?: Typeface.DEFAULT
      }
    }
    return Typeface.create(base, style)
  }

  /** Must run before Activity.onCreate so every Android TextView inherits the selected family. */
  fun applyActivityTheme(activity: Activity) {
    val styleName = when (normalizedTheme(activity)) {
      "vivid" -> "LaojiThemeVivid"
      "paper" -> "LaojiThemePaper"
      "midnight" -> "LaojiThemeMidnight"
      else -> "LaojiThemeNeutral"
    }
    val styleId = activity.resources.getIdentifier(styleName, "style", activity.packageName)
    if (styleId != 0) activity.setTheme(styleId)
  }
}
