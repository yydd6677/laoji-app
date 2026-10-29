package com.laoji.nativeplatform.schedulevoice

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import com.laoji.nativeplatform.ui.LaojiThemeTypography
import com.laoji.nativeplatform.ui.NativeUiTokens

/** Read-only confirmation fields: state/level updates do not recreate text. */
internal class ScheduleVoiceFields(context: Context) : LinearLayout(context) {
  private var rendered: List<ScheduleVoiceField>? = null

  init { orientation = VERTICAL }

  fun render(next: List<ScheduleVoiceField>) {
    if (rendered == next) return
    rendered = next.toList()
    fun dp(value: Float) = (NativeUiTokens.dp(context, value) + 0.5f).toInt()
    removeAllViews()
    next.forEachIndexed { index, field ->
      val row = LinearLayout(context).apply {
        orientation = HORIZONTAL
        gravity = Gravity.TOP
        isBaselineAligned = true
        minimumHeight = dp(48f)
        setPadding(0, dp(10f), 0, dp(10f))
      }
      fun text(value: String, size: Float, secondary: Boolean) = TextView(context).apply {
        text = value; textSize = size
        gravity = Gravity.START or Gravity.TOP
        includeFontPadding = false
        NativeUiTokens.bindTheme(this) { palette ->
          setTextColor(if (secondary) palette.textSecondary else palette.textPrimary)
          typeface = LaojiThemeTypography.typeface(context)
        }
      }
      row.addView(text(field.label, 14f, true).apply { maxLines = 2 },
        LayoutParams(dp((78f * resources.configuration.fontScale).coerceAtMost(112f)), LayoutParams.WRAP_CONTENT))
      row.addView(text(field.value, 16f, false).apply { setLineSpacing(0f, 1.2f) },
        LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
      addView(row, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
      if (index < next.lastIndex) addView(View(context).apply {
        NativeUiTokens.bindTheme(this) { setBackgroundColor(it.divider) }
      },
        LayoutParams(LayoutParams.MATCH_PARENT, dp(1f)))
    }
  }
}
