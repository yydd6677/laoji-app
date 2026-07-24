package com.laoji.nativeplatform.minutes

// MIN-HOME-LIST-001: Feishu list/grid item hierarchy from MmHomeVHFactory and the
// mm_item_list_home_* layouts, with LaoJi meeting data bound into that structure.

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView

internal enum class MinutesHomeViewMode {
  LIST,
  GRID,
}

internal class MinutesMeetingAdapter(
  private val onAction: (Map<String, Any?>) -> Unit,
  private val onLongPress: (View, MinutesMeeting) -> Unit,
) : ListAdapter<MinutesMeeting, MinutesMeetingAdapter.Holder>(DIFF) {
  private var viewMode = MinutesHomeViewMode.LIST

  init {
    setHasStableIds(true)
  }

  fun setViewMode(value: MinutesHomeViewMode) {
    if (value == viewMode) return
    viewMode = value
    notifyItemRangeChanged(0, itemCount)
  }

  override fun getItemId(position: Int): Long = getItem(position).id.hashCode().toLong()

  override fun getItemViewType(position: Int): Int = viewMode.ordinal

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(
    parent,
    MinutesHomeViewMode.entries.getOrElse(viewType) { MinutesHomeViewMode.LIST },
  )

  override fun onBindViewHolder(holder: Holder, position: Int) {
    holder.bind(getItem(position), onAction, onLongPress)
  }

  override fun onViewRecycled(holder: Holder) {
    holder.recycle()
    super.onViewRecycled(holder)
  }

  class Holder(
    parent: ViewGroup,
    private val mode: MinutesHomeViewMode,
  ) : RecyclerView.ViewHolder(FrameLayout(parent.context)) {
    private val host = itemView as FrameLayout
    private val root = LinearLayout(parent.context)
    private val cover = FrameLayout(parent.context)
    private val coverIcon = ImageView(parent.context)
    private val coverContent = LinearLayout(parent.context)
    private val coverHeader = LinearLayout(parent.context)
    private val coverHeaderIcon = ImageView(parent.context)
    private val coverTitle = parent.context.textView(textSizeSp = 12, color = MinutesPalette.secondary)
    private val coverText = parent.context.textView(textSizeSp = 14)
    private val coverQuote = ImageView(parent.context)
    private val textColumn = LinearLayout(parent.context)
    private val title = parent.context.textView()
    private val metaRow = LinearLayout(parent.context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    private val typeIcon = ImageView(parent.context)
    private val meta = parent.context.textView(color = MinutesPalette.faint)
    private val divider = View(parent.context)
    private val status = parent.context.textView(color = MinutesPalette.faint)

    init {
      host.clipChildren = false
      host.clipToPadding = false
      host.addView(root)

      root.gravity = Gravity.CENTER_VERTICAL
      root.isClickable = true
      root.isFocusable = true
      root.backgroundShape(MinutesPalette.surface, radiusDp = 12)
      root.clipToOutline = true

      cover.backgroundShape(MinutesPalette.coverDefault)
      coverIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_microphone_ai_filled)
      coverIcon.imageTintList = ColorStateList.valueOf(Color.WHITE)
      coverIcon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      cover.addView(
        coverIcon,
        FrameLayout.LayoutParams(parent.context.dp(36), parent.context.dp(36), Gravity.CENTER),
      )
      coverContent.orientation = LinearLayout.VERTICAL
      coverContent.gravity = Gravity.CENTER_VERTICAL
      coverHeader.orientation = LinearLayout.HORIZONTAL
      coverHeader.gravity = Gravity.CENTER_VERTICAL
      coverHeaderIcon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      coverHeader.addView(
        coverHeaderIcon,
        LinearLayout.LayoutParams(parent.context.dp(13), parent.context.dp(13)),
      )
      coverTitle.maxLines = 1
      coverTitle.ellipsize = TextUtils.TruncateAt.END
      coverHeader.addView(
        coverTitle,
        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
          leftMargin = parent.context.dp(3)
        },
      )
      coverText.maxLines = 5
      coverText.ellipsize = TextUtils.TruncateAt.END
      coverText.setLineSpacing(parent.context.dp(4).toFloat(), 1f)
      coverContent.addView(
        coverHeader,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
      coverContent.addView(
        coverText,
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
          topMargin = parent.context.dp(6)
        },
      )
      coverQuote.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_quote_filled)
      coverQuote.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      coverContent.addView(
        coverQuote,
        LinearLayout.LayoutParams(parent.context.dp(20), parent.context.dp(20)).apply {
          gravity = Gravity.END
          topMargin = parent.context.dp(8)
        },
      )
      cover.addView(
        coverContent,
        FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
      )
      root.addView(cover)

      textColumn.orientation = LinearLayout.VERTICAL
      textColumn.gravity = Gravity.CENTER_VERTICAL
      title.maxLines = 2
      title.ellipsize = TextUtils.TruncateAt.END
      textColumn.addView(title)

      typeIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_microphone_ai_filled)
      typeIcon.imageTintList = ColorStateList.valueOf(MinutesPalette.faint)
      typeIcon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      metaRow.addView(typeIcon)
      meta.maxLines = 1
      meta.ellipsize = TextUtils.TruncateAt.END
      metaRow.addView(meta)
      divider.setBackgroundColor(MinutesPalette.divider)
      metaRow.addView(divider)
      status.maxLines = 1
      status.ellipsize = TextUtils.TruncateAt.END
      metaRow.addView(status)
      textColumn.addView(metaRow)
      root.addView(textColumn)

      applyModeGeometry()
    }

    private fun applyModeGeometry() {
      val context = itemView.context
      if (mode == MinutesHomeViewMode.LIST) {
        host.setPadding(context.dp(12), context.dp(4), context.dp(12), context.dp(4))
        root.orientation = LinearLayout.HORIZONTAL
        root.minimumHeight = context.dp(72)
        root.setPadding(context.dp(16), context.dp(13), context.dp(16), context.dp(13))
        host.layoutParams = RecyclerView.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        root.layoutParams = FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        cover.visibility = View.GONE
        cover.layoutParams = LinearLayout.LayoutParams(0, 0)
        textColumn.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        title.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 16f)
        title.typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
        metaRow.layoutParams = LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          context.dp(22),
        ).apply { topMargin = context.dp(2) }
        typeIcon.layoutParams = LinearLayout.LayoutParams(context.dp(14), context.dp(14))
        meta.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
        meta.layoutParams = LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.WRAP_CONTENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { leftMargin = context.dp(4) }
        divider.layoutParams = LinearLayout.LayoutParams(context.dp(1), context.dp(10)).apply {
          leftMargin = context.dp(6)
          rightMargin = context.dp(6)
        }
        status.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
        status.layoutParams = LinearLayout.LayoutParams(
          0,
          ViewGroup.LayoutParams.WRAP_CONTENT,
          1f,
        )
      } else {
        host.setPadding(context.dp(3), context.dp(3), context.dp(3), context.dp(3))
        root.orientation = LinearLayout.VERTICAL
        root.gravity = Gravity.START
        root.minimumHeight = 0
        root.setPadding(0, 0, 0, context.dp(12))
        host.layoutParams = RecyclerView.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        root.layoutParams = FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        cover.visibility = View.VISIBLE
        cover.layoutParams = LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          context.dp(108),
        )
        textColumn.layoutParams = LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
          leftMargin = context.dp(12)
          rightMargin = context.dp(12)
          topMargin = context.dp(10)
        }
        title.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
        title.typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
        metaRow.layoutParams = LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          context.dp(20),
        ).apply { topMargin = context.dp(6) }
        typeIcon.layoutParams = LinearLayout.LayoutParams(context.dp(12), context.dp(12))
        meta.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12f)
        meta.layoutParams = LinearLayout.LayoutParams(
          0,
          ViewGroup.LayoutParams.WRAP_CONTENT,
          1f,
        ).apply { leftMargin = context.dp(4) }
        divider.layoutParams = LinearLayout.LayoutParams(0, 0)
        status.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12f)
        status.layoutParams = LinearLayout.LayoutParams(
          ViewGroup.LayoutParams.WRAP_CONTENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { leftMargin = context.dp(4) }
      }
    }

    fun bind(
      meeting: MinutesMeeting,
      onAction: (Map<String, Any?>) -> Unit,
      onLongPress: (View, MinutesMeeting) -> Unit,
    ) {
      title.text = meeting.title
      bindCover(meeting)
      meta.text = if (mode == MinutesHomeViewMode.GRID) {
        // Feishu's cover card keeps one compact itemTime lane beside itemStatus.
        // Duration remains available in list/detail where the lane is wide enough.
        meeting.dateTimeLabel
      } else {
        listOf(meeting.dateTimeLabel, meeting.durationLabel)
          .filter { it.isNotBlank() }
          .joinToString(" · ")
      }
      // The source SUCCESS branch hides itemStatus. Keep app-specific active,
      // processing, failure, and sync states, but do not add a success badge.
      val visibleStatus = meeting.statusLabel.takeUnless { it == "已完成" }.orEmpty()
      val hasStatus = visibleStatus.isNotBlank()
      divider.visibility = if (hasStatus && mode == MinutesHomeViewMode.LIST) View.VISIBLE else View.GONE
      status.visibility = if (hasStatus) View.VISIBLE else View.GONE
      status.text = visibleStatus
      status.setTextColor(statusToneColor(meeting.statusTone))
      root.contentDescription = listOf(
        meeting.title,
        meeting.coverTitle,
        meeting.coverText,
        meta.text,
        visibleStatus,
      )
        .filter { it.isNotBlank() }
        .joinToString("，")
      root.setOnClickListener {
        onAction(
          mapOf(
            "type" to if (meeting.canResume) "openRecording" else "openMeeting",
            "meetingId" to meeting.id,
          ),
        )
      }
      root.setOnLongClickListener {
        onLongPress(root, meeting)
        true
      }
    }

    private fun bindCover(meeting: MinutesMeeting) {
      if (mode != MinutesHomeViewMode.GRID) return
      val usableText = meeting.coverText.trim()
      val effectiveType = meeting.coverType.takeIf { usableText.isNotEmpty() }
        ?: MinutesListCoverType.DEFAULT
      when (effectiveType) {
        MinutesListCoverType.DEFAULT -> {
          applyDefaultCoverGeometry()
          cover.backgroundShape(MinutesPalette.coverDefault)
          coverIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_microphone_ai_filled)
          coverIcon.imageTintList = ColorStateList.valueOf(Color.WHITE)
          coverIcon.visibility = View.VISIBLE
          coverContent.visibility = View.GONE
        }
        MinutesListCoverType.SUMMARY -> {
          applyDynamicCoverGeometry(topPaddingDp = 24, bottomPaddingDp = 28)
          cover.backgroundShape(MinutesPalette.coverSummary)
          coverIcon.visibility = View.GONE
          coverContent.visibility = View.VISIBLE
          coverHeaderIcon.setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_summary_book)
          coverHeaderIcon.background = null
          coverTitle.text = meeting.coverTitle.ifBlank { "整理结果" }
          coverTitle.setTextColor(MinutesPalette.secondary)
          coverText.maxLines = 5
          coverText.text = usableText
          coverText.setTextColor(MinutesPalette.text)
          coverQuote.visibility = View.GONE
        }
        MinutesListCoverType.SPEAKER_SUMMARY -> {
          // LaoJi infers a representative transcript line locally. Its nearest
          // source surface is mm_item_list_cover_content, not the separate
          // blue-gray server-selected speaker-summary cover.
          applyDynamicCoverGeometry(topPaddingDp = 26, bottomPaddingDp = 20)
          cover.backgroundShape(MinutesPalette.coverContent)
          coverIcon.visibility = View.GONE
          coverContent.visibility = View.VISIBLE
          coverHeaderIcon.setImageDrawable(null)
          coverHeaderIcon.background = speakerAvatarBackground(meeting.coverTitle)
          coverTitle.text = meeting.coverTitle.ifBlank { "讲话人" }
          coverTitle.setTextColor(MinutesPalette.secondary)
          coverText.maxLines = 4
          coverText.text = usableText
          coverText.setTextColor(MinutesPalette.text)
          coverQuote.visibility = View.VISIBLE
        }
      }
    }

    private fun applyDefaultCoverGeometry() {
      val context = itemView.context
      cover.minimumHeight = 0
      cover.layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        context.dp(108),
      )
    }

    private fun applyDynamicCoverGeometry(topPaddingDp: Int, bottomPaddingDp: Int) {
      val context = itemView.context
      // [SOURCE] Dynamic cover layouts use wrap_content, 24dp horizontal
      // padding, and a 6dp title-to-content gap.
      cover.minimumHeight = 0
      cover.layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
      )
      coverContent.gravity = Gravity.TOP
      coverContent.setPadding(
        context.dp(24),
        context.dp(topPaddingDp),
        context.dp(24),
        context.dp(bottomPaddingDp),
      )
      coverContent.layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
      )
    }

    private fun speakerAvatarBackground(seed: String): GradientDrawable {
      val colors = if ((seed.hashCode() and 1) == 0) {
        intArrayOf(Color.rgb(193, 188, 255), Color.rgb(226, 224, 255))
      } else {
        intArrayOf(Color.rgb(167, 232, 224), Color.rgb(210, 247, 241))
      }
      return GradientDrawable(GradientDrawable.Orientation.TL_BR, colors).apply {
        shape = GradientDrawable.OVAL
      }
    }

    fun recycle() {
      root.setOnClickListener(null)
      root.setOnLongClickListener(null)
    }
  }

  companion object {
    private val DIFF = object : DiffUtil.ItemCallback<MinutesMeeting>() {
      override fun areItemsTheSame(oldItem: MinutesMeeting, newItem: MinutesMeeting): Boolean =
        oldItem.id == newItem.id

      override fun areContentsTheSame(oldItem: MinutesMeeting, newItem: MinutesMeeting): Boolean =
        oldItem == newItem
    }
  }
}
