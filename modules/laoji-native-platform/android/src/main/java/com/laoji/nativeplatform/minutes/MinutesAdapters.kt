package com.laoji.nativeplatform.minutes

// MIN-SEARCH-001: stable native list rows render real service data.

import android.graphics.Typeface
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView

internal class MinutesMeetingAdapter(
  private val onAction: (Map<String, Any?>) -> Unit,
) : ListAdapter<MinutesMeeting, MinutesMeetingAdapter.Holder>(DIFF) {
  init {
    setHasStableIds(true)
  }

  override fun getItemId(position: Int): Long = getItem(position).id.hashCode().toLong()

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(parent)

  override fun onBindViewHolder(holder: Holder, position: Int) {
    holder.bind(getItem(position), onAction)
  }

  class Holder(parent: ViewGroup) : RecyclerView.ViewHolder(LinearLayout(parent.context)) {
    private val root = itemView as LinearLayout
    private val title = parent.context.textView(textSizeSp = 16, weight = Typeface.BOLD)
    private val metaRow = LinearLayout(parent.context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    private val statusDot = View(parent.context)
    private val meta = parent.context.textView(textSizeSp = 14, color = MinutesPalette.faint)

    init {
      root.orientation = LinearLayout.VERTICAL
      root.gravity = Gravity.CENTER_VERTICAL
      root.minimumHeight = parent.context.dp(72)
      root.setPadding(parent.context.dp(16), parent.context.dp(13), parent.context.dp(16), parent.context.dp(13))
      root.isClickable = true
      root.isFocusable = true
      title.maxLines = 2
      title.ellipsize = TextUtils.TruncateAt.END
      root.addView(title, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      statusDot.backgroundShape(MinutesPalette.faint, radiusDp = 4)
      metaRow.addView(statusDot, LinearLayout.LayoutParams(parent.context.dp(8), parent.context.dp(8)))
      metaRow.addView(
        meta,
        LinearLayout.LayoutParams(0, parent.context.dp(22), 1f).apply { leftMargin = parent.context.dp(6) },
      )
      root.addView(
        metaRow,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, parent.context.dp(22)).apply {
          topMargin = parent.context.dp(2)
        },
      )
    }

    fun bind(meeting: MinutesMeeting, onAction: (Map<String, Any?>) -> Unit) {
      title.text = meeting.title
      val statusColor = statusToneColor(meeting.statusTone)
      statusDot.backgroundShape(statusColor, radiusDp = 4)
      meta.setTextColor(statusColor)
      meta.text = listOf(meeting.statusLabel.ifBlank { meeting.dateTimeLabel }, meeting.durationLabel)
        .filter { it.isNotBlank() }
        .joinToString(" · ")
      root.contentDescription = listOf(meeting.title, meta.text).filter { it.isNotBlank() }.joinToString("，")
      root.setOnClickListener {
        onAction(mapOf(
          "type" to if (meeting.canResume) "openRecording" else "openMeeting",
          "meetingId" to meeting.id,
        ))
      }
      root.setOnLongClickListener {
        onAction(
          mapOf(
            "type" to "openMeetingMenu",
            "meetingId" to meeting.id,
            "canResume" to meeting.canResume,
          ),
        )
        true
      }
    }
  }

  companion object {
    private val DIFF = object : DiffUtil.ItemCallback<MinutesMeeting>() {
      override fun areItemsTheSame(oldItem: MinutesMeeting, newItem: MinutesMeeting): Boolean = oldItem.id == newItem.id
      override fun areContentsTheSame(oldItem: MinutesMeeting, newItem: MinutesMeeting): Boolean = oldItem == newItem
    }
  }
}
