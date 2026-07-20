package com.laoji.nativeplatform.media

// MIN-PLAYER-001: source-shaped half-float speed picker, reconstructed from
// mm_dialog_speed.xml, mm_view_speed_picker.xml and SpeedItem.java.

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.laoji.nativeplatform.minutes.MinutesPalette
import com.laoji.nativeplatform.minutes.backgroundShape
import com.laoji.nativeplatform.minutes.dp
import com.laoji.nativeplatform.minutes.textView

internal class MinutesPlaybackSpeedSheet(private val sourceContext: Context) {
  private var dialog: Dialog? = null

  fun dismiss() {
    dialog?.dismiss()
    dialog = null
  }

  fun show(selectedRate: Float, onSelect: (Float) -> Unit) {
    val activity = sourceContext.findActivity() ?: return
    dismiss()

    val panel = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      // Dialog content already stops above the navigation bar. Adding its inset
      // again creates a second, empty navigation slot at the bottom of the sheet.
      setPadding(0, activity.dp(32), 0, activity.dp(24))
      backgroundShape(MinutesPalette.surface, radiusDp = 12)
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
      contentDescription = "播放速度"
    }
    val speedRow = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    panel.addView(
      speedRow,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, activity.dp(61)),
    )

    val items = MINUTES_PLAYBACK_RATES.mapIndexed { index, rate ->
      MinutesPlaybackSpeedItem(
        context = activity,
        rate = rate,
        barHeightDp = when (index) {
          0 -> 20
          2, 5, 6 -> 28
          else -> 12
        },
        alwaysShowLabel = index == 0 || index == 2 || index == 5 || index == 6,
      )
    }
    fun select(rate: Float, emit: Boolean) {
      items.forEach { it.setRateSelected(it.rate == rate) }
      if (emit) onSelect(rate)
    }
    items.forEach { item ->
      speedRow.addView(
        item,
        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f),
      )
      item.setOnClickListener {
        it.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        select(item.rate, emit = true)
      }
    }
    select(MINUTES_PLAYBACK_RATES.minByOrNull { kotlin.math.abs(it - selectedRate) } ?: 1f, emit = false)

    val nextDialog = Dialog(activity).apply {
      requestWindowFeature(Window.FEATURE_NO_TITLE)
      setContentView(panel)
      setCanceledOnTouchOutside(true)
      setOnDismissListener { if (dialog === this) dialog = null }
    }
    nextDialog.window?.apply {
      setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
      setGravity(Gravity.BOTTOM)
      addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      attributes = attributes.apply {
        dimAmount = 0.60f
        windowAnimations = com.laoji.nativeplatform.R.style.LaojiMinutesSheetAnimation
      }
    }
    dialog = nextDialog
    nextDialog.show()
    nextDialog.window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
  }
}

private class MinutesPlaybackSpeedItem(
  context: Context,
  val rate: Float,
  barHeightDp: Int,
  private val alwaysShowLabel: Boolean,
) : FrameLayout(context) {
  private val bar = View(context)
  private val label: TextView = context.textView(
    text = "${rateLabel(rate)}x",
    textSizeSp = 15,
    color = MinutesPalette.text,
    weight = Typeface.BOLD,
  )

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "${rateLabel(rate)} 倍速"
    bar.backgroundShape(MinutesPalette.disabled, radiusDp = 2)
    addView(
      bar,
      LayoutParams(context.dp(3), context.dp(barHeightDp), Gravity.TOP or Gravity.CENTER_HORIZONTAL),
    )
    label.gravity = Gravity.CENTER
    addView(
      label,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(20), Gravity.BOTTOM),
    )
  }

  fun setRateSelected(selected: Boolean) {
    isSelected = selected
    bar.backgroundShape(if (selected) MinutesPalette.primary else MinutesPalette.disabled, radiusDp = 2)
    label.setTextColor(if (selected) MinutesPalette.primary else MinutesPalette.text)
    label.text = "${rateLabel(rate)}${if (selected) "X" else "x"}"
    label.visibility = if (selected || alwaysShowLabel) View.VISIBLE else View.INVISIBLE
  }
}

private fun Context.findActivity(): Activity? {
  var current: Context? = this
  while (current is ContextWrapper) {
    if (current is Activity) return current
    current = current.baseContext
  }
  return current as? Activity
}

private fun rateLabel(rate: Float): String =
  if (rate % 1f == 0f) rate.toInt().toString() else rate.toString()
