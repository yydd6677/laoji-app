package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001: all supported detail pages remain mounted behind one native pager.

import android.content.Context
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2

internal class MinutesDetailPagerAdapter(
  context: Context,
  onAction: (Map<String, Any?>) -> Unit,
) : RecyclerView.Adapter<MinutesDetailPagerAdapter.Holder>() {
  private val pages: Map<MinutesDetailTab, MinutesDetailPage> = linkedMapOf(
    MinutesDetailTab.TRANSCRIPT to MinutesTranscriptPage(context, onAction),
    MinutesDetailTab.SUMMARY to MinutesSummaryPage(context, onAction),
    MinutesDetailTab.SPEAKERS to MinutesSpeakersPage(context, onAction),
    MinutesDetailTab.INFO to MinutesInfoPage(context, onAction),
  )

  init {
    setHasStableIds(true)
  }

  override fun getItemCount(): Int = MinutesDetailLayoutContract.PAGE_COUNT
  override fun getItemId(position: Int): Long = MinutesDetailLayoutContract.tabAt(position).ordinal.toLong()
  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(parent)

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val page = pageFor(MinutesDetailLayoutContract.tabAt(position))
    (page.parent as? ViewGroup)?.removeView(page)
    holder.root.removeAllViews()
    holder.root.addView(page, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  fun render(state: MinutesDetailState) {
    (pageFor(MinutesDetailTab.TRANSCRIPT) as MinutesTranscriptPage).render(state)
    (pageFor(MinutesDetailTab.SUMMARY) as MinutesSummaryPage).render(state)
    (pageFor(MinutesDetailTab.SPEAKERS) as MinutesSpeakersPage).render(state)
    (pageFor(MinutesDetailTab.INFO) as MinutesInfoPage).render(state)
  }

  fun pageFor(tab: MinutesDetailTab): MinutesDetailPage = requireNotNull(pages[tab])

  fun setScrollStateListener(listener: () -> Unit) {
    pages.values.forEach { it.setScrollStateListener(listener) }
  }

  fun captureScrollPositions(): Map<MinutesDetailTab, MinutesDetailPageScrollPosition> =
    pages.mapValues { (_, page) -> page.captureScrollPosition() }

  fun restoreScrollPositions(state: MinutesDetailPersistedViewState) {
    pageFor(MinutesDetailTab.TRANSCRIPT).restoreScrollPosition(state.transcript)
    pageFor(MinutesDetailTab.SUMMARY).restoreScrollPosition(state.summary)
    pageFor(MinutesDetailTab.SPEAKERS).restoreScrollPosition(state.speakers)
    pageFor(MinutesDetailTab.INFO).restoreScrollPosition(state.info)
  }

  internal class Holder(parent: ViewGroup) : RecyclerView.ViewHolder(FrameLayout(parent.context)) {
    val root: FrameLayout = itemView as FrameLayout

    init {
      root.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }
  }
}

internal class MinutesDetailTabBar(
  context: Context,
  onTabSelected: (MinutesDetailTab) -> Unit,
) : FrameLayout(context) {
  private val tabViews = linkedMapOf<MinutesDetailTab, TabView>()
  private val tabs = LinearLayout(context)
  private val divider = View(context)

  init {
    setBackgroundColor(MinutesPalette.surface)
    tabs.orientation = LinearLayout.HORIZONTAL
    tabs.gravity = Gravity.START or Gravity.CENTER_VERTICAL
    addView(
      tabs,
      LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
        leftMargin = context.dp(10)
      },
    )
    MinutesDetailTab.entries.forEach { tab ->
      val view = TabView(context, tab.label).apply {
        setOnClickListener { onTabSelected(tab) }
      }
      tabViews[tab] = view
      tabs.addView(view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }
    divider.setBackgroundColor(MinutesPalette.divider)
    addView(
      divider,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1, Gravity.BOTTOM).apply {
        leftMargin = context.dp(MinutesDetailLayoutContract.TAB_DIVIDER_LEFT_MARGIN_DP)
        rightMargin = context.dp(MinutesDetailLayoutContract.TAB_DIVIDER_RIGHT_MARGIN_DP)
      },
    )
  }

  fun render(state: MinutesDetailState) {
    tabViews[MinutesDetailTab.SPEAKERS]?.setLabel(
      if (state.speakers.isEmpty()) MinutesDetailTab.SPEAKERS.label
      else "${MinutesDetailTab.SPEAKERS.label}(${state.speakers.size})",
    )
  }

  fun select(tab: MinutesDetailTab) {
    tabViews.forEach { (candidate, view) -> view.setSelectedState(candidate == tab) }
  }

  private class TabView(context: Context, label: String) : FrameLayout(context) {
    private val text = context.textView(label, 14, MinutesPalette.secondary).apply {
      gravity = Gravity.CENTER
      typeface = Typeface.create("sans-serif", Typeface.NORMAL)
      // [DEVICE] Matches Feishu's theme-resolved glyph advance on the same 420 dpi device.
      textScaleX = 1.025f
    }
    // [SOURCE] ud_tab_item_layout.xml keeps an INVISIBLE bold copy so selection never changes tab width.
    private val boldMeasureText = context.textView(label, 14, MinutesPalette.secondary, Typeface.BOLD).apply {
      gravity = Gravity.CENTER
      typeface = Typeface.create("sans-serif", Typeface.BOLD)
      textScaleX = 1.025f
      visibility = View.INVISIBLE
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val indicator = View(context).apply { backgroundShape(MinutesPalette.primary, radiusDp = 1) }

    init {
      isClickable = true
      isFocusable = true
      contentDescription = label
      minimumWidth = context.dpRounded(MinutesDetailLayoutContract.TAB_MIN_WIDTH_DP)
      setPadding(
        context.dp(MinutesDetailLayoutContract.TAB_HORIZONTAL_PADDING_DP),
        0,
        context.dp(MinutesDetailLayoutContract.TAB_HORIZONTAL_PADDING_DP),
        0,
      )
      addView(
        boldMeasureText,
        LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER),
      )
      addView(
        text,
        LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER),
      )
      addView(
        indicator,
        LayoutParams(0, context.dp(MinutesDetailLayoutContract.TAB_INDICATOR_HEIGHT_DP), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL),
      )
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      super.onMeasure(widthMeasureSpec, heightMeasureSpec)
      val contentWidth = maxOf(text.measuredWidth, boldMeasureText.measuredWidth)
      if (indicator.layoutParams.width != contentWidth) {
        indicator.layoutParams = indicator.layoutParams.apply { width = contentWidth }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
      }
    }

    fun setLabel(label: String) {
      if (text.text.toString() == label) return
      text.text = label
      boldMeasureText.text = label
      contentDescription = label
    }

    fun setSelectedState(selected: Boolean) {
      isSelected = selected
      text.isSelected = selected
      text.setTextColor(if (selected) MinutesPalette.primary else MinutesPalette.secondary)
      text.typeface = Typeface.create("sans-serif", if (selected) Typeface.BOLD else Typeface.NORMAL)
      indicator.visibility = if (selected) View.VISIBLE else View.INVISIBLE
    }
  }
}

internal fun ViewPager2.retainAllMinutesDetailPages() {
  offscreenPageLimit = MinutesDetailLayoutContract.PAGE_COUNT
}
