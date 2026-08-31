package com.laoji.nativeplatform.calendar

// CAL-ALLDAY-EXPAND-001: all-day pages share paging progress while retaining independent vertical scroll.

import android.animation.ValueAnimator
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt
interface DayAllDaySectionListener {
  fun onAllDayEventOpened(event: CalendarEvent)
  fun onAllDayExpandedChanged(expanded: Boolean, overflow: Boolean)
}

internal data class DayAllDayCollapsedContent(
  val visibleEventCount: Int,
  val remainingCount: Int,
  val hasMoreRow: Boolean,
) {
  val totalRowCount: Int
    get() = visibleEventCount + if (hasMoreRow) 1 else 0
}

internal object DayAllDaySectionContract {
  const val ROW_HEIGHT_DP = 25f
  const val COLLAPSED_MAX_ROWS = 3
  const val EXPANDED_MAX_VISIBLE_ROWS = 7.5f
  const val INSTANCE_HORIZONTAL_SPACE_DP = 3f
  const val INSTANCE_VERTICAL_SPACE_DP = 0f
  const val EXPAND_HIT_SIZE_DP = 48f
  const val HEIGHT_ANIMATION_DURATION_MS = 100L

  fun expandedContentRows(eventCount: Int): Int = eventCount.coerceAtLeast(0)

  fun hasOverflow(eventCount: Int): Boolean = expandedContentRows(eventCount) > COLLAPSED_MAX_ROWS

  fun collapsedContent(eventCount: Int): DayAllDayCollapsedContent {
    val normalizedCount = expandedContentRows(eventCount)
    if (!hasOverflow(normalizedCount)) {
      return DayAllDayCollapsedContent(normalizedCount, 0, false)
    }
    val visibleEventCount = COLLAPSED_MAX_ROWS - 1
    return DayAllDayCollapsedContent(
      visibleEventCount = visibleEventCount,
      remainingCount = normalizedCount - visibleEventCount,
      hasMoreRow = true,
    )
  }

  fun collapsedRows(eventCount: Int): Int = collapsedContent(eventCount).totalRowCount

  fun rowHeightPx(density: Float): Int =
    (ROW_HEIGHT_DP * density.coerceAtLeast(0f)).roundToInt()

  fun horizontalSpacePx(density: Float): Int =
    (INSTANCE_HORIZONTAL_SPACE_DP * density.coerceAtLeast(0f)).roundToInt()

  fun expandedHeightCapPx(rowHeightPx: Int): Int =
    (rowHeightPx.coerceAtLeast(0) * EXPANDED_MAX_VISIBLE_ROWS).toInt()

  fun contentHeightPx(eventCount: Int, rowHeightPx: Int): Int =
    (expandedContentRows(eventCount).toLong() * rowHeightPx.coerceAtLeast(0))
      .coerceAtMost(Int.MAX_VALUE.toLong())
      .toInt()

  fun visibleHeightPx(eventCount: Int, expanded: Boolean, rowHeightPx: Int): Int {
    val safeRowHeight = rowHeightPx.coerceAtLeast(0)
    if (!expanded) return collapsedRows(eventCount) * safeRowHeight
    return min(contentHeightPx(eventCount, safeRowHeight), expandedHeightCapPx(safeRowHeight))
  }

  fun isExpandedScrollable(eventCount: Int, rowHeightPx: Int): Boolean =
    contentHeightPx(eventCount, rowHeightPx) > expandedHeightCapPx(rowHeightPx)

  fun stableEventCount(pageEventCounts: List<Int>, positionProgress: Float): Int {
    require(pageEventCounts.size == DayPagerContract.PAGE_COUNT) {
      "All-day paging requires exactly three event counts"
    }
    val absoluteProgress = DayPagerContract.CENTER_PAGE + positionProgress.coerceIn(-1f, 1f)
    val nearest = absoluteProgress.roundToInt().coerceIn(0, DayPagerContract.PAGE_COUNT - 1)
    if (abs(absoluteProgress - nearest) < 0.1f) return pageEventCounts[nearest].coerceAtLeast(0)
    val lower = absoluteProgress.toInt().coerceIn(0, DayPagerContract.PAGE_COUNT - 1)
    val upper = (lower + 1).coerceIn(0, DayPagerContract.PAGE_COUNT - 1)
    return maxOf(pageEventCounts[lower], pageEventCounts[upper]).coerceAtLeast(0)
  }

  fun orderedEvents(events: List<CalendarEvent>, epochDay: Int): List<CalendarEvent> =
    CalendarGeometry.visibleAllDayEvents(events, epochDay)
}

internal data class DayAllDaySectionState(
  val eventCount: Int = 0,
  val expanded: Boolean = false,
) {
  val overflow: Boolean
    get() = DayAllDaySectionContract.hasOverflow(eventCount)

  fun withEventCount(value: Int): DayAllDaySectionState = copy(eventCount = value.coerceAtLeast(0))

  fun withExpanded(value: Boolean): DayAllDaySectionState =
    copy(expanded = value && (expanded || overflow))
}

class DayAllDaySectionView(context: Context) : FrameLayout(context) {
  companion object {
    private const val MAX_SCROLL_OFFSET_ENTRIES = 32
  }

  private val palette = CalendarUi.palette(context)
  private val density = resources.displayMetrics.density
  private val touchRouter = AssociatedDayPagerTouchRouter(context)
  private val rowHeightPx = DayAllDaySectionContract.rowHeightPx(density)
  private val track = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
  private val trackViewport = FrameLayout(context).apply {
    clipChildren = true
    clipToPadding = true
    addView(track)
  }
  private val pages = Array(DayPagerContract.PAGE_COUNT) {
    DayAllDayPageView(context).apply {
      onEventOpened = { event -> listener?.onAllDayEventOpened(event) }
      onExpandRequested = { setExpanded(true) }
    }
  }
  private var state = DayAllDaySectionState()
  private var positionProgress = 0f
  private var pageEventCounts = List(DayPagerContract.PAGE_COUNT) { 0 }
  private val scrollOffsetsByEpochDay = LinkedHashMap<Int, Int>(MAX_SCROLL_OFFSET_ENTRIES, 0.75f, true)
  private var scrollGeneration: Int? = null
  private var listener: DayAllDaySectionListener? = null
  private var associatedPagerDispatcher: ((MotionEvent) -> Boolean)? = null
  private var hasBoundEvents = false
  private var renderedHeightPx = 0
  private var heightAnimator: ValueAnimator? = null
  private var heightAnimationTargetPx: Int? = null

  init {
    clipChildren = true
    clipToPadding = true
    setBackgroundColor(palette.surfaceMuted)
    pages.forEach(track::addView)
    addView(trackViewport, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    updatePresentation()
  }

  fun setListener(listener: DayAllDaySectionListener?) {
    this.listener = listener
    if (hasBoundEvents) listener?.onAllDayExpandedChanged(state.expanded, state.overflow)
  }

  fun setAssociatedPagerDispatcher(dispatcher: ((MotionEvent) -> Boolean)?) {
    associatedPagerDispatcher = dispatcher
  }

  fun bind(events: List<CalendarEvent>, epochDay: Int, generation: Int = 0) {
    bindPages(events, epochDay, 0f, generation)
  }

  fun bindPages(
    events: List<CalendarEvent>,
    centerEpochDay: Int,
    initialProgress: Float = 0f,
    generation: Int = 0,
  ) {
    if (scrollGeneration != generation) {
      scrollOffsetsByEpochDay.clear()
      scrollGeneration = generation
    }
    pages.forEach { page ->
      if (page.boundGeneration == generation) {
        page.boundEpochDay?.let { rememberScrollOffset(it, page.currentScrollY()) }
      }
    }
    val pageEvents = DayPagerContract.pageSlots.map { slot ->
      DayAllDaySectionContract.orderedEvents(events, centerEpochDay + slot.dayDelta)
    }
    pageEventCounts = pageEvents.map(List<CalendarEvent>::size)
    pages.forEachIndexed { index, page ->
      val epochDay = DayPagerContract.epochDayForPosition(centerEpochDay, index)
      page.bind(
        epochDay = epochDay,
        events = pageEvents[index],
        expanded = state.expanded,
        reserveExpandSpace = false,
        restoredScrollY = scrollOffsetsByEpochDay[epochDay] ?: 0,
        generation = generation,
      )
    }
    hasBoundEvents = true
    setPositionProgress(initialProgress, animatedHeight = isLaidOut)
  }

  fun setPositionProgress(value: Float) {
    setPositionProgress(value, animatedHeight = isLaidOut)
  }

  fun setExpanded(value: Boolean, animated: Boolean = true) {
    val previous = state
    val next = state.withExpanded(value)
    if (next == previous) return
    state = next
    if (!state.expanded) pages.forEach(DayAllDayPageView::scrollToTop)
    updatePresentation()
    updateHeight(animated)
    dispatchStateChange(previous)
  }

  fun isExpanded(): Boolean = state.expanded

  fun collapse(animated: Boolean = true) {
    setExpanded(false, animated)
  }

  internal fun currentPositionProgress(): Float = positionProgress

  internal fun stableEventCount(): Int = state.eventCount

  internal fun renderedHeight(): Int = renderedHeightPx

  override fun dispatchTouchEvent(event: MotionEvent): Boolean =
    touchRouter.route(event, associatedPagerDispatcher) { super.dispatchTouchEvent(it) }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val resolvedHeight = resolveSize(renderedHeightPx, heightMeasureSpec)
    super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(resolvedHeight, MeasureSpec.EXACTLY))
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    if (width <= 0) return
    track.layoutParams = LayoutParams(width * DayPagerContract.PAGE_COUNT, LayoutParams.MATCH_PARENT)
    pages.forEach { page ->
      page.layoutParams = LinearLayout.LayoutParams(width, LinearLayout.LayoutParams.MATCH_PARENT)
    }
    updateTrackPosition()
  }

  override fun onDetachedFromWindow() {
    touchRouter.cancel(associatedPagerDispatcher)
    pages.forEach { page ->
      if (page.boundGeneration == scrollGeneration) {
        page.boundEpochDay?.let { rememberScrollOffset(it, page.currentScrollY()) }
      }
    }
    val settledHeight = targetHeightPx()
    heightAnimator?.cancel()
    heightAnimator = null
    heightAnimationTargetPx = null
    renderedHeightPx = settledHeight
    requestLayout()
    super.onDetachedFromWindow()
  }

  private fun setPositionProgress(value: Float, animatedHeight: Boolean) {
    positionProgress = value.coerceIn(-1f, 1f)
    val previous = state
    state = state.withEventCount(
      DayAllDaySectionContract.stableEventCount(pageEventCounts, positionProgress),
    )
    updateTrackPosition()
    updatePresentation()
    updateHeight(animatedHeight)
    dispatchStateChange(previous)
  }

  private fun updateTrackPosition() {
    if (width <= 0) return
    track.translationX = 0f
    trackViewport.scrollTo(
      ((DayPagerContract.CENTER_PAGE + positionProgress) * width).roundToInt(),
      0,
    )
    val accessiblePage = (DayPagerContract.CENTER_PAGE + positionProgress).roundToInt()
      .coerceIn(0, DayPagerContract.PAGE_COUNT - 1)
    pages.forEachIndexed { index, page ->
      page.importantForAccessibility = if (index == accessiblePage) {
        View.IMPORTANT_FOR_ACCESSIBILITY_YES
      } else {
        View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      }
    }
  }

  private fun updatePresentation() {
    val overflow = state.overflow
    pages.forEach { page -> page.setExpanded(state.expanded, overflow) }
  }

  private fun updateHeight(animated: Boolean) {
    val targetHeight = targetHeightPx()
    if (heightAnimator?.isRunning == true && heightAnimationTargetPx == targetHeight) return
    heightAnimator?.cancel()
    heightAnimator = null
    heightAnimationTargetPx = null
    if (!animated || !isLaidOut || renderedHeightPx == targetHeight) {
      renderedHeightPx = targetHeight
      requestLayout()
      return
    }
    val startHeight = renderedHeightPx.coerceAtLeast(0)
    val animator = ValueAnimator.ofInt(startHeight, targetHeight)
    heightAnimator = animator
    heightAnimationTargetPx = targetHeight
    animator.apply {
      duration = DayAllDaySectionContract.HEIGHT_ANIMATION_DURATION_MS
      addUpdateListener { valueAnimator ->
        renderedHeightPx = valueAnimator.animatedValue as Int
        requestLayout()
      }
      addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) {
          if (heightAnimator !== animation) return
          renderedHeightPx = targetHeight
          heightAnimator = null
          heightAnimationTargetPx = null
          requestLayout()
        }

        override fun onAnimationCancel(animation: Animator) {
          if (heightAnimator !== animation) return
          heightAnimator = null
          heightAnimationTargetPx = null
        }
      })
      start()
    }
  }

  private fun targetHeightPx(): Int = DayAllDaySectionContract.visibleHeightPx(
    state.eventCount,
    state.expanded,
    rowHeightPx,
  )

  private fun rememberScrollOffset(epochDay: Int, offset: Int) {
    scrollOffsetsByEpochDay.remove(epochDay)
    scrollOffsetsByEpochDay[epochDay] = offset.coerceAtLeast(0)
    while (scrollOffsetsByEpochDay.size > MAX_SCROLL_OFFSET_ENTRIES) {
      val eldest = scrollOffsetsByEpochDay.entries.firstOrNull()?.key ?: break
      scrollOffsetsByEpochDay.remove(eldest)
    }
  }

  private fun dispatchStateChange(previous: DayAllDaySectionState) {
    if (previous.expanded == state.expanded && previous.overflow == state.overflow) return
    listener?.onAllDayExpandedChanged(state.expanded, state.overflow)
  }

}

// CAL-ALLDAY-001: one native drawable owner renders the source-shaped all-day
// instance list and the overflow instance; the pager/height owner stays above it.
internal class DayAllDayInstanceCanvasView(context: Context) : View(context) {
  private val palette = CalendarUi.palette(context)
  private val density = resources.displayMetrics.density
  private val rowHeightPx = DayAllDaySectionContract.rowHeightPx(density)
  private val horizontalGapPx = DayAllDaySectionContract.horizontalSpacePx(density)
  private val textPaint = CalendarUi.textPaint(context, palette.eventText, 11f, true)
  private val overflowTextPaint = CalendarUi.textPaint(context, palette.textSecondary, 11f, true)
  private val eventPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.eventFill }
  private val overflowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.surface }
  private val overflowStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.divider
    style = Paint.Style.STROKE
    strokeWidth = maxOf(1f, CalendarUi.dp(context, 0.5f))
  }
  private val pressedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(26, Color.red(palette.eventPressedOverlay), Color.green(palette.eventPressedOverlay), Color.blue(palette.eventPressedOverlay))
  }
  private val chevronPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.textSecondary
    style = Paint.Style.STROKE
    strokeWidth = maxOf(1.5f, CalendarUi.dp(context, 1.5f))
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val chevronPath = Path()
  private var events: List<CalendarEvent> = emptyList()
  private var overflowCount = 0
  private var pressedRow = -1
  private var boundEpochDay: Int? = null
  private var onEventOpened: ((CalendarEvent) -> Unit)? = null
  private var onExpandRequested: (() -> Unit)? = null

  init {
    setWillNotDraw(false)
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  fun bind(
    epochDay: Int,
    events: List<CalendarEvent>,
    overflowCount: Int,
    onEventOpened: ((CalendarEvent) -> Unit)?,
    onExpandRequested: (() -> Unit)?,
  ) {
    this.boundEpochDay = epochDay
    this.events = events
    this.overflowCount = overflowCount.coerceAtLeast(0)
    this.onEventOpened = onEventOpened
    this.onExpandRequested = onExpandRequested
    contentDescription = buildString {
      append("全天日程")
      if (events.isNotEmpty()) append("，${events.size}项")
      if (this@DayAllDayInstanceCanvasView.overflowCount > 0) append("，还有${this@DayAllDayInstanceCanvasView.overflowCount}项，点击展开")
    }
    pressedRow = -1
    invalidate()
  }

  internal fun labelsForTest(): List<String> = buildList {
    addAll(events.map { CalendarUi.listEventTitle(it.title) })
    if (overflowCount > 0) add("还有 $overflowCount 项")
  }

  internal fun performOverflowClickForTest(): Boolean {
    if (overflowCount <= 0) return false
    onExpandRequested?.invoke()
    return true
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val rowWidth = (width - horizontalGapPx).coerceAtLeast(1).toFloat()
    events.forEachIndexed { index, event ->
      val visual = CalendarUi.eventVisual(context, event.category)
      eventPaint.color = visual.fill
      textPaint.color = visual.text
      pressedPaint.color = visual.pressedOverlay
      drawChip(canvas, index, rowWidth, CalendarUi.listEventTitle(event.title), eventPaint, textPaint, false)
    }
    if (overflowCount > 0) {
      pressedPaint.color = Color.argb(
        26,
        Color.red(palette.eventPressedOverlay),
        Color.green(palette.eventPressedOverlay),
        Color.blue(palette.eventPressedOverlay),
      )
      drawChip(
        canvas,
        events.size,
        rowWidth,
        "还有 $overflowCount 项",
        overflowPaint,
        overflowTextPaint,
        true,
      )
    }
  }

  private fun drawChip(
    canvas: Canvas,
    row: Int,
    rowWidth: Float,
    label: String,
    fill: Paint,
    text: Paint,
    overflow: Boolean,
  ) {
    val top = row * rowHeightPx.toFloat()
    val rect = android.graphics.RectF(0f, top, rowWidth, top + rowHeightPx)
    canvas.drawRoundRect(rect, CalendarUi.dp(context, 3f), CalendarUi.dp(context, 3f), fill)
    if (overflow) canvas.drawRoundRect(rect, CalendarUi.dp(context, 3f), CalendarUi.dp(context, 3f), overflowStrokePaint)
    if (pressedRow == row) canvas.drawRoundRect(rect, CalendarUi.dp(context, 3f), CalendarUi.dp(context, 3f), pressedPaint)
    val textLeft = CalendarUi.dp(context, 9f)
    val available = (rowWidth - textLeft - CalendarUi.dp(context, 26f)).coerceAtLeast(1f)
    val clipped = CalendarUi.ellipsize(label, text, available)
    val metrics = text.fontMetrics
    val baseline = top + rowHeightPx / 2f - (metrics.ascent + metrics.descent) / 2f
    canvas.drawText(clipped, textLeft, baseline, text)
    if (overflow) {
      val centerX = rowWidth - CalendarUi.dp(context, 13f)
      val centerY = top + rowHeightPx / 2f
      chevronPath.reset()
      chevronPath.moveTo(centerX - CalendarUi.dp(context, 3f), centerY - CalendarUi.dp(context, 2f))
      chevronPath.lineTo(centerX, centerY + CalendarUi.dp(context, 2f))
      chevronPath.lineTo(centerX + CalendarUi.dp(context, 3f), centerY - CalendarUi.dp(context, 2f))
      canvas.drawPath(chevronPath, chevronPaint)
    }
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    val row = (event.y / rowHeightPx.coerceAtLeast(1)).toInt()
    val rowCount = events.size + if (overflowCount > 0) 1 else 0
    if (row !in 0 until rowCount) {
      if (event.actionMasked != MotionEvent.ACTION_DOWN) pressedRow = -1
      invalidate()
      return false
    }
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        pressedRow = row
        invalidate()
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        if (pressedRow != row) pressedRow = -1
        invalidate()
        return true
      }
      MotionEvent.ACTION_UP -> {
        val clicked = pressedRow == row
        pressedRow = -1
        invalidate()
        if (!clicked) return true
        if (row == events.size && overflowCount > 0) onExpandRequested?.invoke()
        else events.getOrNull(row)?.let { onEventOpened?.invoke(it) }
        performClick()
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        pressedRow = -1
        invalidate()
        return true
      }
    }
    return true
  }

  override fun performClick(): Boolean {
    super.performClick()
    return true
  }
}

internal class DayAllDayPageView(context: Context) : FrameLayout(context) {
  private val palette = CalendarUi.palette(context)
  private val density = resources.displayMetrics.density
  private val rowHeightPx = DayAllDaySectionContract.rowHeightPx(density)
  private val rowHorizontalSpacePx = DayAllDaySectionContract.horizontalSpacePx(density)
  private val contentColumn = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
  private val scrollView = DayAllDayScrollView(context).apply {
    isFillViewport = false
    isNestedScrollingEnabled = true
    isVerticalScrollBarEnabled = false
    overScrollMode = View.OVER_SCROLL_NEVER
    clipToPadding = true
  }
  private var events: List<CalendarEvent> = emptyList()
  private var expanded = false
  private var reserveExpandSpace = false
  private var instanceCanvas: DayAllDayInstanceCanvasView? = null
  private var bindGeneration = 0L
  internal var boundEpochDay: Int? = null
    private set
  internal var boundGeneration: Int? = null
    private set
  var onEventOpened: ((CalendarEvent) -> Unit)? = null
  var onExpandRequested: (() -> Unit)? = null

  init {
    setBackgroundColor(palette.surfaceMuted)
    scrollView.addView(
      contentColumn,
      FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT),
    )
    addView(scrollView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun bind(
    epochDay: Int,
    events: List<CalendarEvent>,
    expanded: Boolean,
    reserveExpandSpace: Boolean,
    restoredScrollY: Int,
    generation: Int = 0,
  ) {
    val restoreToken = ++bindGeneration
    boundEpochDay = epochDay
    boundGeneration = generation
    this.events = events
    this.expanded = expanded
    this.reserveExpandSpace = reserveExpandSpace
    render()
    post {
      if (restoreToken == bindGeneration && boundEpochDay == epochDay && boundGeneration == generation) {
        scrollView.scrollTo(0, restoredScrollY.coerceIn(0, maxScrollY()))
      }
    }
  }

  fun setExpanded(value: Boolean, reserveExpandSpace: Boolean) {
    val changed = expanded != value || this.reserveExpandSpace != reserveExpandSpace
    expanded = value
    this.reserveExpandSpace = reserveExpandSpace
    if (changed) render()
  }

  fun currentScrollY(): Int = scrollView.scrollY

  fun scrollToTop() = scrollView.scrollTo(0, 0)

  internal fun visibleLabelsForTest(): List<String> = instanceCanvas?.labelsForTest().orEmpty()

  internal fun performOverflowClickForTest(): Boolean = instanceCanvas?.performOverflowClickForTest() == true

  private fun render() {
    val collapsedContent = DayAllDaySectionContract.collapsedContent(events.size)
    val visibleEvents = if (expanded) events else events.take(collapsedContent.visibleEventCount)
    val remainingCount = if (!expanded && collapsedContent.hasMoreRow) collapsedContent.remainingCount else 0
    val rows = visibleEvents.size + if (remainingCount > 0) 1 else 0
    // Keep the positioned all-day view owners alive
    // while only rebinding the drawable list. Reusing this Canvas preserves the
    // pressed layer and accessibility owner across the 100ms height transition.
    val canvas = instanceCanvas ?: DayAllDayInstanceCanvasView(context).also { created ->
      instanceCanvas = created
      contentColumn.addView(
        created,
        LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0).apply {
          marginEnd = rowHorizontalSpacePx
        },
      )
    }
    canvas.bind(
      epochDay = boundEpochDay ?: 0,
      events = visibleEvents,
      overflowCount = remainingCount,
      onEventOpened = this@DayAllDayPageView.onEventOpened,
      onExpandRequested = this@DayAllDayPageView.onExpandRequested,
    )
    (canvas.layoutParams as? LinearLayout.LayoutParams)?.let { params ->
      val nextHeight = rows * rowHeightPx
      if (params.height != nextHeight || params.marginEnd != rowHorizontalSpacePx) {
        params.height = nextHeight
        params.marginEnd = rowHorizontalSpacePx
        canvas.layoutParams = params
      }
    }
    contentColumn.setPadding(0, 0, 0, 0)
    val scrollable = expanded && DayAllDaySectionContract.isExpandedScrollable(events.size, rowHeightPx)
    scrollView.userScrollingEnabled = scrollable
    scrollView.isVerticalScrollBarEnabled = scrollable
    scrollView.overScrollMode = if (scrollable) {
      View.OVER_SCROLL_IF_CONTENT_SCROLLS
    } else {
      View.OVER_SCROLL_NEVER
    }
    if (!scrollable) scrollView.scrollTo(0, 0)
  }

  private fun maxScrollY(): Int = (contentColumn.measuredHeight - scrollView.height).coerceAtLeast(0)

  internal fun instanceLayerForTest(): DayAllDayInstanceCanvasView? = instanceCanvas
}

internal class DayAllDayScrollView(context: Context) : ScrollView(context) {
  var userScrollingEnabled = false

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean =
    userScrollingEnabled && super.onInterceptTouchEvent(event)

  override fun onTouchEvent(event: MotionEvent): Boolean =
    userScrollingEnabled && super.onTouchEvent(event)

  override fun onGenericMotionEvent(event: MotionEvent): Boolean =
    userScrollingEnabled && super.onGenericMotionEvent(event)

  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
    if (
      !userScrollingEnabled &&
      (action == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD ||
        action == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
    ) {
      return false
    }
    return super.performAccessibilityAction(action, arguments)
  }
}
