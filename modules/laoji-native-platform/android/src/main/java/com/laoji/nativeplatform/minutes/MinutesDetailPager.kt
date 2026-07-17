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
) : LinearLayout(context) {
  private val tabViews = linkedMapOf<MinutesDetailTab, TabView>()

  init {
    orientation = HORIZONTAL
    setBackgroundColor(MinutesPalette.surface)
    MinutesDetailTab.entries.forEach { tab ->
      val view = TabView(context, tab.label).apply {
        setOnClickListener { onTabSelected(tab) }
      }
      tabViews[tab] = view
      addView(view, LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
    }
  }

  fun select(tab: MinutesDetailTab) {
    tabViews.forEach { (candidate, view) -> view.setSelectedState(candidate == tab) }
  }

  private class TabView(context: Context, label: String) : FrameLayout(context) {
    private val text = context.textView(label, 14, MinutesPalette.secondary).apply { gravity = Gravity.CENTER }
    private val indicator = View(context).apply { backgroundShape(MinutesPalette.primary, radiusDp = 1) }

    init {
      isClickable = true
      isFocusable = true
      contentDescription = label
      addView(text, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      addView(indicator, LayoutParams(context.dp(28), context.dp(2), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
    }

    fun setSelectedState(selected: Boolean) {
      isSelected = selected
      text.setTextColor(if (selected) MinutesPalette.text else MinutesPalette.secondary)
      text.typeface = Typeface.create(Typeface.DEFAULT, if (selected) Typeface.BOLD else Typeface.NORMAL)
      indicator.visibility = if (selected) View.VISIBLE else View.INVISIBLE
    }
  }
}

internal fun ViewPager2.retainAllMinutesDetailPages() {
  offscreenPageLimit = MinutesDetailLayoutContract.PAGE_COUNT
}
