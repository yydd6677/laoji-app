package com.laoji.nativeplatform.minutes

// MIN-REC-TRANSCRIPT-001: dedicated Record V3 transcript rows; detail rows are not reused.

import android.graphics.Typeface
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView

internal class MinutesRecordingTranscriptAdapter :
  ListAdapter<MinutesTranscriptLine, MinutesRecordingTranscriptAdapter.Holder>(DIFF) {
  init {
    setHasStableIds(true)
  }

  override fun getItemId(position: Int): Long = getItem(position).id.hashCode().toLong()

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(parent)

  override fun onBindViewHolder(holder: Holder, position: Int) = holder.bind(getItem(position))

  internal class Holder(parent: ViewGroup) : RecyclerView.ViewHolder(LinearLayout(parent.context)) {
    private val root = itemView as LinearLayout
    private val metaRow = LinearLayout(parent.context)
    private val avatar = FrameLayout(parent.context)
    private val speaker = parent.context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
    private val separator = View(parent.context)
    private val timestamp = parent.context.textView(textSizeSp = 14, color = MinutesPalette.secondary)
    private val body = parent.context.textView(textSizeSp = 16)

    init {
      root.orientation = LinearLayout.VERTICAL
      root.setPadding(0, parent.context.dp(32), 0, 0)

      metaRow.orientation = LinearLayout.HORIZONTAL
      metaRow.gravity = Gravity.CENTER_VERTICAL
      metaRow.minimumHeight = parent.context.dp(20)

      avatar.backgroundShape(MinutesPalette.page, radiusDp = 10)
      avatar.addView(
        ImageView(parent.context).apply {
          setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_person_filled)
          imageTintList = android.content.res.ColorStateList.valueOf(MinutesPalette.faint)
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        },
        FrameLayout.LayoutParams(parent.context.dp(12), parent.context.dp(12), Gravity.CENTER),
      )
      metaRow.addView(avatar, LinearLayout.LayoutParams(parent.context.dp(20), parent.context.dp(20)))

      speaker.maxLines = 1
      speaker.ellipsize = TextUtils.TruncateAt.END
      speaker.typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
      metaRow.addView(
        speaker,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, parent.context.dp(20)).apply {
          leftMargin = parent.context.dp(6)
        },
      )

      separator.backgroundShape(MinutesPalette.disabled, radiusDp = 2)
      metaRow.addView(
        separator,
        LinearLayout.LayoutParams(parent.context.dp(3), parent.context.dp(3)).apply {
          leftMargin = parent.context.dp(12)
          rightMargin = parent.context.dp(12)
        },
      )
      metaRow.addView(
        timestamp,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, parent.context.dp(20)),
      )
      root.addView(metaRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

      body.setLineSpacing(parent.context.dp(8).toFloat(), 1f)
      body.setTextIsSelectable(true)
      root.addView(
        body,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
          topMargin = parent.context.dp(10)
        },
      )
    }

    fun bind(line: MinutesTranscriptLine) {
      speaker.text = line.speakerLabel
      timestamp.text = line.timestampLabel
      body.text = line.text
      body.alpha = if (line.isFinal) 1f else 0.72f
      root.contentDescription = "${line.speakerLabel}，${line.timestampLabel}，${line.text}"
    }
  }

  companion object {
    private val DIFF = object : DiffUtil.ItemCallback<MinutesTranscriptLine>() {
      override fun areItemsTheSame(oldItem: MinutesTranscriptLine, newItem: MinutesTranscriptLine): Boolean =
        oldItem.id == newItem.id

      override fun areContentsTheSame(oldItem: MinutesTranscriptLine, newItem: MinutesTranscriptLine): Boolean =
        oldItem == newItem
    }
  }
}
