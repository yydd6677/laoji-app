package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001: one native pager owns stable page instances without
// constructing and laying out every inactive page on the navigation frame.

import android.content.Context
import android.graphics.Typeface
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import com.laoji.nativeplatform.media.MinutesPlaybackState
import com.laoji.nativeplatform.ui.LaojiThemeTypography

internal class MinutesDetailPagerAdapter(
  context: Context,
  onAction: (Map<String, Any?>) -> Unit,
) : RecyclerView.Adapter<MinutesDetailPagerAdapter.Holder>() {
  private val pageContext = context
  private val emitAction = onAction
  private val pages = linkedMapOf<MinutesDetailTab, MinutesDetailPage>()
  private val renderedKeys = mutableMapOf<MinutesDetailTab, List<Any?>>()
  private var latestState = MinutesDetailState()
  private var scrollStateListener: () -> Unit = {}
  private var restoredScrollPositions = emptyMap<MinutesDetailTab, MinutesDetailPageScrollPosition>()

  init {
    setHasStableIds(true)
  }

  override fun getItemCount(): Int = MinutesDetailLayoutContract.PAGE_COUNT
  override fun getItemId(position: Int): Long = MinutesDetailLayoutContract.tabAt(position).ordinal.toLong()
  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(parent)

  override fun onBindViewHolder(holder: Holder, position: Int) {
    val tab = MinutesDetailLayoutContract.tabAt(position)
    val page = pageFor(tab)
    renderIfNeeded(tab, page, latestState)
    (page.parent as? ViewGroup)?.removeView(page)
    holder.root.removeAllViews()
    holder.root.addView(page, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  fun render(state: MinutesDetailState) {
    latestState = state
    // Background transcript, status, and player updates must not traverse every
    // attached sibling while the user is reading another page. The selected
    // page is reconciled now; a sibling is reconciled immediately before it is
    // selected or rebound by ViewPager.
    val page = pageFor(state.activeTab)
    renderIfNeeded(state.activeTab, page, state)
  }

  fun onPlaybackState(state: MinutesPlaybackState) {
    (existingPageFor(MinutesDetailTab.TRANSCRIPT) as? MinutesTranscriptPage)
      ?.onPlaybackState(state)
  }

  fun pageFor(tab: MinutesDetailTab): MinutesDetailPage = pages.getOrPut(tab) {
    createPage(tab).also { page ->
      page.setScrollStateListener(scrollStateListener)
      renderIfNeeded(tab, page, latestState)
      restoredScrollPositions[tab]?.let(page::restoreScrollPosition)
    }
  }

  fun existingPageFor(tab: MinutesDetailTab): MinutesDetailPage? = pages[tab]

  fun prepareForSelection(tab: MinutesDetailTab) {
    val page = pageFor(tab)
    renderIfNeeded(tab, page, latestState)
  }

  private fun createPage(tab: MinutesDetailTab): MinutesDetailPage = when (tab) {
    MinutesDetailTab.NOTES -> MinutesNotesPage(pageContext, emitAction)
    MinutesDetailTab.TRANSCRIPT -> MinutesTranscriptPage(pageContext, emitAction)
    MinutesDetailTab.SUMMARY -> MinutesSummaryPage(pageContext, emitAction)
    MinutesDetailTab.SPEAKERS -> MinutesSpeakersPage(pageContext, emitAction)
    MinutesDetailTab.INFO -> MinutesInfoPage(pageContext, emitAction)
  }

  private fun renderPage(page: MinutesDetailPage, state: MinutesDetailState) {
    when (page) {
      is MinutesNotesPage -> page.render(state)
      is MinutesTranscriptPage -> page.render(state)
      is MinutesSummaryPage -> page.render(state)
      is MinutesSpeakersPage -> page.render(state)
      is MinutesInfoPage -> page.render(state)
    }
  }

  private fun renderIfNeeded(tab: MinutesDetailTab, page: MinutesDetailPage, state: MinutesDetailState) {
    val key = pageRenderKey(tab, state)
    if (renderedKeys[tab] == key) return
    renderPage(page, state)
    renderedKeys[tab] = key
  }

  private fun pageRenderKey(tab: MinutesDetailTab, state: MinutesDetailState): List<Any?> = when (tab) {
    MinutesDetailTab.NOTES -> listOf(
      state.meetingId,
      state.available,
      state.manualNote,
      state.manualNoteLoading,
      state.manualNoteEnabled,
      state.pageState(tab),
    )
    MinutesDetailTab.TRANSCRIPT -> listOf(
      state.meetingId,
      state.transcript,
      state.markers,
      state.playerSource?.sourceId,
      state.pageState(tab),
    )
    MinutesDetailTab.SUMMARY -> listOf(
      state.meetingId,
      state.summary,
      state.actions,
      state.canGenerateSummary,
      state.summaryGenerating,
      state.summaryActionLabel,
      state.focusActionId,
      state.focusActionRequestId,
      state.pageState(tab),
    )
    MinutesDetailTab.SPEAKERS -> listOf(
      state.meetingId,
      state.speakers,
      state.transcript,
      state.playerSource?.durationMsHint,
      state.pageState(tab),
    )
    MinutesDetailTab.INFO -> listOf(
      state.meetingId,
      state.dateTimeLabel,
      state.location,
      state.locationLoading,
      state.canEditLocation,
      state.pageState(tab),
    )
  }

  fun setScrollStateListener(listener: () -> Unit) {
    scrollStateListener = listener
    pages.values.forEach { it.setScrollStateListener(listener) }
  }

  fun captureScrollPositions(): Map<MinutesDetailTab, MinutesDetailPageScrollPosition> =
    MinutesDetailTab.entries.associateWith { tab ->
      pages[tab]?.captureScrollPosition()
        ?: restoredScrollPositions[tab]
        ?: MinutesDetailPageScrollPosition()
    }

  fun restoreScrollPositions(state: MinutesDetailPersistedViewState) {
    restoredScrollPositions = mapOf(
      MinutesDetailTab.NOTES to state.notes,
      MinutesDetailTab.TRANSCRIPT to state.transcript,
      MinutesDetailTab.SUMMARY to state.summary,
      MinutesDetailTab.SPEAKERS to state.speakers,
      MinutesDetailTab.INFO to state.info,
    )
    pages.forEach { (tab, page) ->
      restoredScrollPositions[tab]?.let(page::restoreScrollPosition)
    }
  }

  fun focusSummaryAction(state: MinutesDetailState, force: Boolean = false) {
    if (state.focusActionId.isBlank() || state.focusActionRequestId <= 0L) return
    (pageFor(MinutesDetailTab.SUMMARY) as MinutesSummaryPage).focusAction(
      state.focusActionId,
      state.focusActionRequestId,
      force,
    )
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
      typeface = LaojiThemeTypography.typeface(context, Typeface.NORMAL)
      // Speaker counts are appended asynchronously. Keep the tab single-line
      // while its normal/bold measurement is being updated to avoid a one-frame
      // wrap when the selected state changes.
      setSingleLine(true)
      ellipsize = TextUtils.TruncateAt.END
      // [DEVICE] Matches the verified theme-resolved glyph advance on the 420 dpi target.
      textScaleX = 1.025f
    }
    // [SOURCE] ud_tab_item_layout.xml keeps an INVISIBLE bold copy so selection never changes tab width.
    private val boldMeasureText = context.textView(label, 14, MinutesPalette.secondary, Typeface.BOLD).apply {
      gravity = Gravity.CENTER
      typeface = LaojiThemeTypography.typeface(context, Typeface.BOLD)
      setSingleLine(true)
      ellipsize = TextUtils.TruncateAt.END
      textScaleX = 1.025f
      visibility = View.INVISIBLE
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val indicator = View(context).apply {
      backgroundShape(MinutesPalette.primary, radiusDp = 1)
      // The first selection pass may be a no-op for unselected tabs; keep their
      // indicators hidden from the initial frame.
      visibility = View.INVISIBLE
    }

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
      // Keep the normal label at least as wide as its selected/bold variant.
      // Without this lower bound, the first selected frame can ellipsize before
      // the parent LinearLayout completes its second measurement pass.
      if (text.minWidth < contentWidth) text.minWidth = contentWidth
      if (boldMeasureText.minWidth < contentWidth) boldMeasureText.minWidth = contentWidth
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
      if (isSelected == selected) return
      isSelected = selected
      text.isSelected = selected
      text.setTextColor(if (selected) MinutesPalette.primary else MinutesPalette.secondary)
      text.typeface = LaojiThemeTypography.typeface(context, if (selected) Typeface.BOLD else Typeface.NORMAL)
      indicator.visibility = if (selected) View.VISIBLE else View.INVISIBLE
    }
  }
}

internal fun ViewPager2.retainNearbyMinutesDetailPages() {
  // Page objects themselves are stable in the adapter, so a detached sibling
  // retains its editor/list state. Keeping one neighbor attached avoids a
  // first-swipe gap without making list -> detail navigation synchronously
  // measure five full page trees.
  offscreenPageLimit = 1
}
