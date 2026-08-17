package com.laoji.nativeplatform.minutes

import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.widget.TextViewCompat

/**
 * Foreground operation feedback is intentionally separate from issue banners.
 * A running operation gets a progress cue and a quiet semantic surface; an
 * error/warning is rendered without a fake spinner and may expose a retry
 * action. Keeping this owner shared prevents upload, transcript, and summary
 * pages from inventing competing status rows.
 */
internal class MinutesOperationStatusView(context: android.content.Context) : LinearLayout(context) {
  internal val progress = ProgressBar(context, null, android.R.attr.progressBarStyleSmall)
  internal val message = context.textView(textSizeSp = 13, color = MinutesPalette.secondary)
  internal val detail = context.textView(textSizeSp = 12, color = MinutesPalette.faint)
  internal val actionHost = FrameLayout(context)
  private val textColumn = LinearLayout(context)
  private var compactHeaderMode = false
  private var actionSlotWidthDp = 76
  private var actionSlotHeightDp = 44

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.dp(16), 0, context.dp(4), 0)
    visibility = View.GONE
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    progress.isIndeterminate = true
    progress.visibility = View.GONE
    addView(progress, LinearLayout.LayoutParams(context.dp(20), context.dp(20)).apply { rightMargin = context.dp(10) })
    textColumn.orientation = VERTICAL
    textColumn.gravity = Gravity.CENTER_VERTICAL
    message.maxLines = 1
    message.ellipsize = android.text.TextUtils.TruncateAt.END
    detail.maxLines = 1
    detail.ellipsize = android.text.TextUtils.TruncateAt.END
    textColumn.addView(message, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    textColumn.addView(detail, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      topMargin = context.dp(2)
    })
    addView(textColumn, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    addView(actionHost, LinearLayout.LayoutParams(context.dp(76), context.dp(44)))
  }

  internal fun attachAction(view: View) {
    actionHost.layoutParams = actionHost.layoutParams.apply {
      width = context.dp(actionSlotWidthDp)
      height = context.dp(actionSlotHeightDp)
    }
    actionHost.removeAllViews()
    actionHost.addView(
      view,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(actionSlotHeightDp)),
    )
  }

  internal fun removeActionSlot() {
    actionHost.removeAllViews()
    actionHost.layoutParams = actionHost.layoutParams.apply { width = 0 }
    actionHost.visibility = View.GONE
  }

  /**
   * The meeting detail header already owns one metadata row. Reuse that row
   * for per-meeting processing state instead of inserting another vertical
   * slot between tabs and content.
   */
  internal fun useCompactHeaderMode() {
    compactHeaderMode = true
    actionSlotWidthDp = 48
    actionSlotHeightDp = 28
    setPadding(context.dp(8), 0, context.dp(2), 0)
    message.setTextSize(12f)
    // The metadata row already gives this view the space remaining to the
    // right of the meeting date. A fixed 132dp ceiling truncated valid status
    // labels on narrow displays and with a larger system font. Consume the
    // whole slot and reduce the compact label slightly only when necessary;
    // never replace operation state with an ellipsis.
    message.maxWidth = Int.MAX_VALUE
    message.ellipsize = null
    TextViewCompat.setAutoSizeTextTypeUniformWithConfiguration(
      message,
      10,
      12,
      1,
      android.util.TypedValue.COMPLEX_UNIT_SP,
    )
    detail.visibility = View.GONE
    textColumn.layoutParams = LinearLayout.LayoutParams(
      0,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      1f,
    )
    progress.layoutParams = (progress.layoutParams as LinearLayout.LayoutParams).apply {
      width = context.dp(16)
      height = context.dp(16)
      rightMargin = context.dp(6)
    }
    actionHost.layoutParams = (actionHost.layoutParams as LinearLayout.LayoutParams).apply {
      width = context.dp(actionSlotWidthDp)
      height = context.dp(actionSlotHeightDp)
    }
  }

  internal fun render(label: String, detailText: String, tone: String, showAction: Boolean) {
    val cleanLabel = label.trim()
    if (cleanLabel.isBlank()) {
      message.text = ""
      detail.text = ""
      detail.visibility = View.GONE
      progress.visibility = View.GONE
      actionHost.visibility = View.GONE
      background = null
      visibility = View.GONE
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      return
    }
    val issue = tone == "danger" || tone == "warning"
    visibility = View.VISIBLE
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    message.text = cleanLabel
    message.setTextColor(statusToneColor(tone))
    detail.text = detailText.trim()
    detail.visibility = if (compactHeaderMode || detailText.isBlank()) View.GONE else View.VISIBLE
    val running = cleanLabel.contains("正在")
      || cleanLabel.contains("等待")
      || cleanLabel.contains("补全")
      || cleanLabel.contains("准备")
      || cleanLabel.contains("生成")
      || cleanLabel.contains("保存")
    progress.visibility = if (!issue && running) View.VISIBLE else View.GONE
    progress.indeterminateTintList = android.content.res.ColorStateList.valueOf(statusToneColor(tone))
    actionHost.visibility = if (showAction) View.VISIBLE else if (compactHeaderMode) View.GONE else View.INVISIBLE
    backgroundShape(
      when (tone) {
        "danger" -> MinutesPalette.dangerSoft
        "warning" -> withAlpha(MinutesPalette.warning, 24)
        else -> MinutesPalette.primarySoft
      },
      radiusDp = if (compactHeaderMode) 14 else 6,
    )
    contentDescription = listOf(cleanLabel, detailText.trim())
      .filter { it.isNotBlank() }
      .joinToString("，")
  }
}
