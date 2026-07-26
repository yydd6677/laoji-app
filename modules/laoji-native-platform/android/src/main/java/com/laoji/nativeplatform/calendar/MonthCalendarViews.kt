package com.laoji.nativeplatform.calendar

// UI-SHELL-RESELECT-001: the month branch reuses the source ordinary-today-tap state machine.

// CAL-MONTH-001: ViewPager2 uses fixed left/center/right pages and advances exactly one month per gesture.
// CAL-MONTH-001 DEPENDENCY: The Android module requires androidx.viewpager2:viewpager2:1.1.0.
// CAL-MONTH-EXPAND-001: Month pages use independent week rows and a dedicated selected-day event owner.

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.AnimatorSet
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.StateListDrawable
import android.os.Bundle
import android.os.SystemClock
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import com.laoji.nativeplatform.evidence.FeishuEvidence
import com.laoji.nativeplatform.evidence.FeishuEvidenceRuntime
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

interface MonthCalendarListener {
  fun onMonthChanged(monthEpochDay: Int)
  fun onDateSelected(epochDay: Int)
  fun onEventOpened(event: CalendarEvent)
  fun onEmptyCreateRequested(epochDay: Int)
}

private interface MonthWeekRowListener {
  fun onDateTapped(epochDay: Int, row: Int, column: Int)
  fun onWeekEventTapped(event: CalendarEvent)
}

private interface SelectedDayPageListener {
  fun onSelectedDayPageChanged(epochDay: Int, row: Int, column: Int)
}

private data class MonthEventHit(
  val rect: CalendarRect,
  val event: CalendarEvent,
)

// CAL-MONTH-EXPAND-001: Weekday chrome stays outside the independently moving week rows.
@FeishuEvidence("CAL-MONTH-EXPAND-001")
private class MonthWeekdayHeaderView(context: Context) : View(context) {
  private val palette = CalendarUi.palette(context)
  private val weekdayPaint = CalendarUi.textPaint(context, palette.textPrimary, 12f, true)
  private var todayWeekdayIndex: Int? = null
  private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.divider
    strokeWidth = maxOf(1f, CalendarUi.dp(context, 0.5f))
  }

  init {
    setBackgroundColor(palette.surface)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun bind(monthEpochDay: Int, todayEpochDay: Int?) {
    val gridStart = CalendarDateMath.monthGridStart(monthEpochDay)
    val gridEndExclusive = gridStart + CalendarDateMath.monthWeekCount(monthEpochDay) *
      MonthExpandedLayoutContract.DAY_PAGE_COUNT
    todayWeekdayIndex = todayEpochDay
      ?.takeIf { it in gridStart until gridEndExclusive }
      ?.let { (it - gridStart) % MonthExpandedLayoutContract.DAY_PAGE_COUNT }
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val labels = CalendarUi.weekdayLabels()
    val gridStart = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_START_MARGIN_DP)
    val gridEnd = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_END_MARGIN_DP)
    val cellWidth = ((width - gridStart - gridEnd) / MonthExpandedLayoutContract.DAY_PAGE_COUNT).coerceAtLeast(1f)
    labels.forEachIndexed { index, label ->
      weekdayPaint.color = if (index == todayWeekdayIndex) palette.accent else palette.textPrimary
      canvas.drawText(
        label,
        gridStart + index * cellWidth + (cellWidth - weekdayPaint.measureText(label)) / 2f,
        CalendarUi.dp(context, 22f),
        weekdayPaint,
      )
    }
    canvas.drawLine(0f, height - dividerPaint.strokeWidth / 2f, width.toFloat(), height.toFloat(), dividerPaint)
  }
}

// CAL-MONTH-EXPAND-001: Each visible week is its own View and owns only that row's date/event drawing.
// CAL-MONTH-SPAN-001: one MonthEventSegment maps to one continuous week-local hit/draw rectangle.
@FeishuEvidence("CAL-MONTH-SPAN-001")
private class MonthWeekRowView(context: Context) : View(context) {
  companion object {
    private const val DATE_VIRTUAL_ID_BASE = 1
    private const val EVENT_VIRTUAL_ID_BASE = 100
    private const val INVALID_VIRTUAL_ID = Int.MIN_VALUE
  }

  private val palette = CalendarUi.palette(context)
  private val density = context.resources.displayMetrics.density
  private val dayPaint = CalendarUi.textPaint(
    context,
    palette.textPrimary,
    MonthExpandedLayoutContract.DATE_TEXT_SIZE_SP,
  )
  private val mutedDayPaint = CalendarUi.textPaint(
    context,
    // Feishu re3/C153854f uses ud_N400 for dates outside the displayed month.
    palette.textDisabled,
    MonthExpandedLayoutContract.DATE_TEXT_SIZE_SP,
  )
  private val weekendDayPaint = CalendarUi.textPaint(
    context,
    palette.accent,
    MonthExpandedLayoutContract.DATE_TEXT_SIZE_SP,
  )
  private val selectedDayPaint = CalendarUi.textPaint(
    context,
    palette.textPrimary,
    MonthExpandedLayoutContract.DATE_TEXT_SIZE_SP,
  )
  private val todayDayPaint = CalendarUi.textPaint(
    context,
    palette.accentText,
    MonthExpandedLayoutContract.DATE_TEXT_SIZE_SP,
  )
  private val eventPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.eventFill }
  private val eventTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.eventText
    // Feishu's compact month canvas uses a dp-sized paint, independently from
    // the 14sp title used by the expanded event list and day timeline.
    textSize = CalendarUi.dp(context, MonthExpandedLayoutContract.EVENT_TEXT_SIZE_DP)
  }
  // [PRODUCT] LaoJi replaces Feishu's one-sided calendar strip with one
  // continuous border around the full event entry.
  private val eventBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.eventBorder
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, CalendarProductVisualContract.EVENT_BORDER_WIDTH_DP)
  }
  private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.divider
    strokeWidth = maxOf(1f, 0.5f * density)
  }
  private val selectionPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.selectionMarker
    style = Paint.Style.FILL
  }
  private val todayPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.accent
    style = Paint.Style.FILL
  }
  private val collapseOverlayPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.surfaceMuted
    alpha = 230
    style = Paint.Style.FILL
  }
  private val collapseChevronPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.textPlaceholder
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 1.6f)
    strokeCap = Paint.Cap.SQUARE
    strokeJoin = Paint.Join.MITER
  }
  private val collapseChevronPath = Path()
  private val overflowBadgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(31, 143, 149, 158)
    style = Paint.Style.FILL
  }
  private val overflowBadgeTextPaint = CalendarUi.textPaint(context, palette.textSecondary, 10f)
  private val eventHits = mutableListOf<MonthEventHit>()
  private val eventVirtualIds = linkedMapOf<String, Int>()
  private val accessibilityManager =
    context.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
  private val accessibilityProvider = MonthWeekAccessibilityProvider()
  private var accessibilityFocusedVirtualId = INVALID_VIRTUAL_ID
  private var hoveredVirtualId = INVALID_VIRTUAL_ID
  private var monthEpochDay = CalendarDateMath.monthStart(0)
  private var rowStartEpochDay = 0
  private var rowIndex = 0
  private var selectedEpochDay: Int? = null
  private var collapseColumn: Int? = null
  private var todayEpochDay: Int? = null
  private var segments: List<MonthEventSegment> = emptyList()
  private var listener: MonthWeekRowListener? = null
  private var downX = 0f
  private var downY = 0f

  init {
    setBackgroundColor(palette.surface)
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  fun bind(
    monthEpochDay: Int,
    rowStartEpochDay: Int,
    rowIndex: Int,
    selectedEpochDay: Int?,
    collapseColumn: Int?,
    todayEpochDay: Int?,
    segments: List<MonthEventSegment>,
    listener: MonthWeekRowListener?,
  ) {
    FeishuEvidenceRuntime.bind(
      this,
      "CAL-MONTH-SPAN-001",
      "month-week-row",
      "calendar-month-week-row-$monthEpochDay-$rowIndex",
    )
    this.monthEpochDay = monthEpochDay
    this.rowStartEpochDay = rowStartEpochDay
    this.rowIndex = rowIndex
    this.selectedEpochDay = selectedEpochDay
    this.collapseColumn = collapseColumn
    this.todayEpochDay = todayEpochDay
    this.segments = segments
    this.listener = listener
    eventHits.clear()
    eventVirtualIds.clear()
    accessibilityFocusedVirtualId = INVALID_VIRTUAL_ID
    hoveredVirtualId = INVALID_VIRTUAL_ID
    val first = CalendarDateMath.fromEpochDay(rowStartEpochDay)
    val last = CalendarDateMath.fromEpochDay(rowStartEpochDay + 6)
    contentDescription = String.format(
      Locale.getDefault(),
      "%d-%d-%d - %d-%d-%d",
      first.year,
      first.month,
      first.day,
      last.year,
      last.month,
      last.day,
    )
    post { sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) }
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    eventHits.clear()
    eventVirtualIds.clear()
    val gridStart = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_START_MARGIN_DP)
    val gridEnd = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_END_MARGIN_DP)
    val cellWidth = ((width - gridStart - gridEnd) / MonthExpandedLayoutContract.DAY_PAGE_COUNT).coerceAtLeast(1f)
    val monthParts = CalendarDateMath.fromEpochDay(monthEpochDay)
    canvas.drawLine(0f, 0f, width.toFloat(), 0f, dividerPaint)

    for (column in 0 until MonthExpandedLayoutContract.DAY_PAGE_COUNT) {
      val epochDay = rowStartEpochDay + column
      val parts = CalendarDateMath.fromEpochDay(epochDay)
      val centerX = gridStart + column * cellWidth + cellWidth / 2f
      val marker = MonthExpandedLayoutContract.dateMarker(epochDay, selectedEpochDay, todayEpochDay)
      when (marker) {
        MonthDateMarker.SELECTED -> {
          canvas.drawCircle(
            centerX,
            CalendarUi.dp(context, MonthExpandedLayoutContract.DATE_MARKER_CENTER_DP),
            CalendarUi.dp(context, MonthExpandedLayoutContract.DATE_RADIUS_DP),
            selectionPaint,
          )
        }
        MonthDateMarker.TODAY -> {
          canvas.drawCircle(
            centerX,
            CalendarUi.dp(context, MonthExpandedLayoutContract.DATE_MARKER_CENTER_DP),
            CalendarUi.dp(context, MonthExpandedLayoutContract.DATE_RADIUS_DP),
            todayPaint,
          )
        }
        MonthDateMarker.NONE -> Unit
      }
      val dayText = parts.day.toString()
      val outsideDisplayedMonth = parts.year != monthParts.year || parts.month != monthParts.month
      val paint = when {
        marker == MonthDateMarker.TODAY -> todayDayPaint
        outsideDisplayedMonth -> mutedDayPaint
        CalendarProductVisualContract.isWeekendColumn(column) -> weekendDayPaint
        marker == MonthDateMarker.SELECTED -> selectedDayPaint
        else -> dayPaint
      }
      canvas.drawText(
        dayText,
        centerX - paint.measureText(dayText) / 2f,
        CalendarUi.dp(context, MonthExpandedLayoutContract.DATE_BASELINE_DP),
        paint,
      )
    }

    val chipTopInset = CalendarUi.dp(context, 31f)
    val chipHeight = CalendarUi.dp(context, MonthExpandedLayoutContract.EVENT_HEIGHT_DP)
    val chipGap = CalendarUi.dp(context, MonthExpandedLayoutContract.EVENT_VERTICAL_GAP_DP)
    val maxLanes = (((height - chipTopInset - CalendarUi.dp(context, 13f)) / (chipHeight + chipGap)).toInt())
      .coerceIn(1, 3)
    val hiddenCounts = mutableMapOf<Int, Int>()
    segments.forEach { segment ->
      if (segment.lane >= maxLanes) {
        for (column in segment.startColumn..segment.endColumn) {
          hiddenCounts[column] = (hiddenCounts[column] ?: 0) + 1
        }
        return@forEach
      }
      val horizontal = MonthExpandedLayoutContract.eventSpanBounds(
        gridStart = gridStart,
        cellWidth = cellWidth,
        startColumn = segment.startColumn,
        endColumn = segment.endColumn,
        rightGap = CalendarUi.dp(context, MonthExpandedLayoutContract.EVENT_RIGHT_GAP_DP),
      )
      val top = chipTopInset + segment.lane * (chipHeight + chipGap)
      val rect = RectF(horizontal.left, top, horizontal.right, top + chipHeight)
      val radius = CalendarUi.dp(context, MonthExpandedLayoutContract.EVENT_RADIUS_DP)
      canvas.drawRoundRect(rect, radius, radius, eventPaint)
      val borderInset = eventBorderPaint.strokeWidth / 2f
      val borderRect = RectF(rect).apply { inset(borderInset, borderInset) }
      val borderRadius = (radius - borderInset).coerceAtLeast(0f)
      canvas.drawRoundRect(borderRect, borderRadius, borderRadius, eventBorderPaint)
      val title = CalendarUi.ellipsize(
        CalendarUi.listEventTitle(segment.event.title),
        eventTextPaint,
        rect.width() - CalendarUi.dp(context, 12f),
      )
      val titleBaseline = rect.centerY() - (eventTextPaint.ascent() + eventTextPaint.descent()) / 2f
      canvas.drawText(title, rect.left + CalendarUi.dp(context, 6f), titleBaseline, eventTextPaint)
      eventHits += MonthEventHit(CalendarRect(rect.left, rect.top, rect.right, rect.bottom), segment.event)
      eventVirtualIds.getOrPut(segment.event.identity) { EVENT_VIRTUAL_ID_BASE + eventVirtualIds.size }
    }

    hiddenCounts.forEach { (column, count) ->
      val badgeRight = gridStart + (column + 1) * cellWidth - CalendarUi.dp(context, 3f)
      val badgeWidth = CalendarUi.dp(context, MonthExpandedLayoutContract.OVERFLOW_BADGE_WIDTH_DP)
      val badgeHeight = CalendarUi.dp(context, MonthExpandedLayoutContract.OVERFLOW_BADGE_HEIGHT_DP)
      val badgeTop = height - CalendarUi.dp(context, 16f)
      val badge = RectF(badgeRight - badgeWidth, badgeTop, badgeRight, badgeTop + badgeHeight)
      canvas.drawRoundRect(
        badge,
        CalendarUi.dp(context, MonthExpandedLayoutContract.OVERFLOW_BADGE_RADIUS_DP),
        CalendarUi.dp(context, MonthExpandedLayoutContract.OVERFLOW_BADGE_RADIUS_DP),
        overflowBadgePaint,
      )
      val label = if (count > 9) "+N" else "+$count"
      canvas.drawText(
        label,
        badge.centerX() - overflowBadgeTextPaint.measureText(label) / 2f,
        badge.centerY() - (overflowBadgeTextPaint.ascent() + overflowBadgeTextPaint.descent()) / 2f,
        overflowBadgeTextPaint,
      )
    }

    drawCollapseControl(canvas, gridStart, cellWidth)
  }

  private fun drawCollapseControl(canvas: Canvas, gridStart: Float, cellWidth: Float) {
    val column = collapseColumn ?: return
    val left = gridStart + column * cellWidth
    val top = CalendarUi.dp(context, MonthExpandedLayoutContract.COLLAPSE_OVERLAY_TOP_DP)
      .coerceAtMost(height.toFloat())
    val right = left + cellWidth
    canvas.drawRect(left, top, right, height.toFloat(), collapseOverlayPaint)

    val centerX = (left + right) / 2f
    val centerY = top + (height - top) / 2f
    val halfWidth = CalendarUi.dp(context, MonthExpandedLayoutContract.COLLAPSE_CHEVRON_HALF_WIDTH_DP)
    val halfHeight = CalendarUi.dp(context, MonthExpandedLayoutContract.COLLAPSE_CHEVRON_HALF_HEIGHT_DP)
    collapseChevronPath.reset()
    collapseChevronPath.moveTo(centerX - halfWidth, centerY + halfHeight)
    collapseChevronPath.lineTo(centerX, centerY - halfHeight)
    collapseChevronPath.lineTo(centerX + halfWidth, centerY + halfHeight)
    canvas.drawPath(collapseChevronPath, collapseChevronPaint)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.x
        downY = event.y
        isPressed = true
        return true
      }
      MotionEvent.ACTION_UP -> {
        isPressed = false
        if (MonthExpandedLayoutContract.isTapWithinThreshold(
            event.x - downX,
            event.y - downY,
            density,
          )
        ) {
          eventHits.asReversed().firstOrNull { it.rect.contains(event.x, event.y) }?.let {
            listener?.onWeekEventTapped(it.event)
            performClick()
            return true
          }
          if (width > 0) {
            val gridStart = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_START_MARGIN_DP)
            val gridEnd = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_END_MARGIN_DP)
            val cellWidth = ((width - gridStart - gridEnd) / MonthExpandedLayoutContract.DAY_PAGE_COUNT)
              .coerceAtLeast(1f)
            val column = ((event.x - gridStart) / cellWidth).toInt()
              .coerceIn(0, MonthExpandedLayoutContract.DAY_PAGE_COUNT - 1)
            listener?.onDateTapped(rowStartEpochDay + column, rowIndex, column)
            performClick()
          }
        }
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        isPressed = false
        return true
      }
    }
    return true
  }

  override fun getAccessibilityNodeProvider(): AccessibilityNodeProvider = accessibilityProvider

  override fun dispatchHoverEvent(event: MotionEvent): Boolean {
    if (!accessibilityManager.isEnabled || !accessibilityManager.isTouchExplorationEnabled) {
      return super.dispatchHoverEvent(event)
    }
    val next = accessibilityProvider.virtualViewAt(event.x, event.y)
    return when (event.actionMasked) {
      MotionEvent.ACTION_HOVER_ENTER,
      MotionEvent.ACTION_HOVER_MOVE -> {
        updateHoveredVirtualView(next)
        next != INVALID_VIRTUAL_ID
      }
      MotionEvent.ACTION_HOVER_EXIT -> {
        val handled = hoveredVirtualId != INVALID_VIRTUAL_ID
        updateHoveredVirtualView(INVALID_VIRTUAL_ID)
        handled
      }
      else -> super.dispatchHoverEvent(event)
    }
  }

  private fun dateBounds(column: Int): CalendarRect {
    val gridStart = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_START_MARGIN_DP)
    val gridEnd = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_END_MARGIN_DP)
    val cellWidth = ((width - gridStart - gridEnd) / MonthExpandedLayoutContract.DAY_PAGE_COUNT)
      .coerceAtLeast(1f)
    return CalendarRect(
      gridStart + column * cellWidth,
      0f,
      gridStart + (column + 1) * cellWidth,
      CalendarUi.dp(context, 31f),
    )
  }

  private fun eventHitForVirtualId(virtualId: Int): MonthEventHit? {
    val identity = eventVirtualIds.entries.firstOrNull { it.value == virtualId }?.key ?: return null
    return eventHits.firstOrNull { it.event.identity == identity }
  }

  private fun dateDescription(column: Int): String {
    val epochDay = rowStartEpochDay + column
    val parts = CalendarDateMath.fromEpochDay(epochDay)
    val eventCount = segments.count { column in it.startColumn..it.endColumn }
    return buildString {
      append(String.format(Locale.getDefault(), "%d年%d月%d日", parts.year, parts.month, parts.day))
      if (epochDay == todayEpochDay) append("，今天")
      if (epochDay == selectedEpochDay) append("，已选择")
      if (column == collapseColumn) append("，再次点击收起日程")
      if (eventCount > 0) append("，$eventCount 项日程")
    }
  }

  private fun clippedAccessibilityBounds(bounds: CalendarRect): Pair<Rect, Rect>? {
    val visibleLocalBounds = Rect()
    if (!getLocalVisibleRect(visibleLocalBounds)) return null
    val clippedParentBounds = bounds.toAndroidRect()
    if (!clippedParentBounds.intersect(visibleLocalBounds)) return null
    val location = IntArray(2)
    getLocationOnScreen(location)
    val clippedScreenBounds = Rect(clippedParentBounds).apply {
      offset(location[0], location[1])
    }
    return clippedParentBounds to clippedScreenBounds
  }

  private fun accessibilityBoundsForVirtualId(virtualId: Int): Pair<Rect, Rect>? {
    val dateColumn = (virtualId - DATE_VIRTUAL_ID_BASE)
      .takeIf { it in 0 until MonthExpandedLayoutContract.DAY_PAGE_COUNT }
    val bounds = dateColumn?.let(::dateBounds) ?: eventHitForVirtualId(virtualId)?.rect ?: return null
    return clippedAccessibilityBounds(bounds)
  }

  private fun updateHoveredVirtualView(next: Int) {
    if (hoveredVirtualId == next) return
    val previous = hoveredVirtualId
    hoveredVirtualId = next
    if (previous != INVALID_VIRTUAL_ID) {
      sendVirtualAccessibilityEvent(previous, AccessibilityEvent.TYPE_VIEW_HOVER_EXIT)
    }
    if (next != INVALID_VIRTUAL_ID) {
      sendVirtualAccessibilityEvent(next, AccessibilityEvent.TYPE_VIEW_HOVER_ENTER)
    }
  }

  private fun sendVirtualAccessibilityEvent(virtualId: Int, eventType: Int) {
    if (!accessibilityManager.isEnabled) return
    if (accessibilityBoundsForVirtualId(virtualId) == null) return
    val description = when {
      virtualId in DATE_VIRTUAL_ID_BASE until DATE_VIRTUAL_ID_BASE + MonthExpandedLayoutContract.DAY_PAGE_COUNT ->
        dateDescription(virtualId - DATE_VIRTUAL_ID_BASE)
      else -> eventHitForVirtualId(virtualId)?.event?.title?.let(CalendarUi::listEventTitle)
    } ?: return
    val event = AccessibilityEvent.obtain(eventType).apply {
      packageName = context.packageName
      className = "android.widget.Button"
      contentDescription = description
      text.add(description)
      isEnabled = this@MonthWeekRowView.isEnabled
      setSource(this@MonthWeekRowView, virtualId)
    }
    parent?.requestSendAccessibilityEvent(this, event)
  }

  private inner class MonthWeekAccessibilityProvider : AccessibilityNodeProvider() {
    override fun createAccessibilityNodeInfo(virtualViewId: Int): AccessibilityNodeInfo? {
      if (virtualViewId == View.NO_ID) {
        return AccessibilityNodeInfo.obtain(this@MonthWeekRowView).apply {
          this@MonthWeekRowView.onInitializeAccessibilityNodeInfo(this)
          className = MonthWeekRowView::class.java.name
          contentDescription = null
          repeat(MonthExpandedLayoutContract.DAY_PAGE_COUNT) { column ->
            val id = DATE_VIRTUAL_ID_BASE + column
            if (accessibilityBoundsForVirtualId(id) != null) addChild(this@MonthWeekRowView, id)
          }
          eventHits.forEach { hit ->
            eventVirtualIds[hit.event.identity]?.let { id ->
              if (accessibilityBoundsForVirtualId(id) != null) addChild(this@MonthWeekRowView, id)
            }
          }
        }
      }

      val dateColumn = (virtualViewId - DATE_VIRTUAL_ID_BASE)
        .takeIf { it in 0 until MonthExpandedLayoutContract.DAY_PAGE_COUNT }
      val eventHit = eventHitForVirtualId(virtualViewId)
      if (dateColumn == null && eventHit == null) return null
      val bounds = dateColumn?.let(::dateBounds) ?: requireNotNull(eventHit).rect
      val (parentBounds, screenBounds) = clippedAccessibilityBounds(bounds) ?: return null
      val description = dateColumn?.let(::dateDescription)
        ?: requireNotNull(eventHit).event.let { hitEvent ->
          "${CalendarUi.listEventTitle(hitEvent.title)}，${dateDescription(hitEvent.startEpochDay.coerceIn(rowStartEpochDay, rowStartEpochDay + 6) - rowStartEpochDay)}"
        }
      return AccessibilityNodeInfo.obtain().apply {
        setSource(this@MonthWeekRowView, virtualViewId)
        setParent(this@MonthWeekRowView)
        packageName = context.packageName
        className = "android.widget.Button"
        text = description
        contentDescription = description
        setBoundsInParent(parentBounds)
        setBoundsInScreen(screenBounds)
        isClickable = true
        isFocusable = true
        isEnabled = this@MonthWeekRowView.isEnabled
        isVisibleToUser = true
        isSelected = dateColumn?.let { rowStartEpochDay + it == selectedEpochDay } == true
        isAccessibilityFocused = accessibilityFocusedVirtualId == virtualViewId
        addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)
        addAction(
          if (isAccessibilityFocused) {
            AccessibilityNodeInfo.AccessibilityAction.ACTION_CLEAR_ACCESSIBILITY_FOCUS
          } else {
            AccessibilityNodeInfo.AccessibilityAction.ACTION_ACCESSIBILITY_FOCUS
          },
        )
      }
    }

    override fun performAction(virtualViewId: Int, action: Int, arguments: Bundle?): Boolean {
      if (virtualViewId == View.NO_ID) return false
      if (accessibilityBoundsForVirtualId(virtualViewId) == null) return false
      return when (action) {
        AccessibilityNodeInfo.ACTION_CLICK -> {
          val column = virtualViewId - DATE_VIRTUAL_ID_BASE
          if (column in 0 until MonthExpandedLayoutContract.DAY_PAGE_COUNT) {
            listener?.onDateTapped(rowStartEpochDay + column, rowIndex, column)
          } else {
            val hit = eventHitForVirtualId(virtualViewId) ?: return false
            listener?.onWeekEventTapped(hit.event)
          }
          sendVirtualAccessibilityEvent(virtualViewId, AccessibilityEvent.TYPE_VIEW_CLICKED)
          true
        }
        AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS -> {
          if (accessibilityFocusedVirtualId == virtualViewId) return false
          val previous = accessibilityFocusedVirtualId
          accessibilityFocusedVirtualId = virtualViewId
          if (previous != INVALID_VIRTUAL_ID) {
            sendVirtualAccessibilityEvent(previous, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED)
          }
          sendVirtualAccessibilityEvent(virtualViewId, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED)
          invalidate()
          true
        }
        AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS -> {
          if (accessibilityFocusedVirtualId != virtualViewId) return false
          accessibilityFocusedVirtualId = INVALID_VIRTUAL_ID
          sendVirtualAccessibilityEvent(virtualViewId, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED)
          invalidate()
          true
        }
        else -> false
      }
    }

    override fun findFocus(focus: Int): AccessibilityNodeInfo? =
      if (
        focus == AccessibilityNodeInfo.FOCUS_ACCESSIBILITY &&
        accessibilityFocusedVirtualId != INVALID_VIRTUAL_ID
      ) {
        createAccessibilityNodeInfo(accessibilityFocusedVirtualId)
      } else {
        null
      }

    fun virtualViewAt(x: Float, y: Float): Int {
      eventHits.asReversed().firstOrNull { it.rect.contains(x, y) }?.let { hit ->
        val id = eventVirtualIds[hit.event.identity] ?: return INVALID_VIRTUAL_ID
        return id.takeIf { accessibilityBoundsForVirtualId(it) != null } ?: INVALID_VIRTUAL_ID
      }
      if (y !in 0f..CalendarUi.dp(context, 31f) || width <= 0) return INVALID_VIRTUAL_ID
      val gridStart = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_START_MARGIN_DP)
      val gridEnd = CalendarUi.dp(context, MonthExpandedLayoutContract.GRID_END_MARGIN_DP)
      val cellWidth = ((width - gridStart - gridEnd) / MonthExpandedLayoutContract.DAY_PAGE_COUNT)
        .coerceAtLeast(1f)
      val column = ((x - gridStart) / cellWidth).toInt()
      val id = DATE_VIRTUAL_ID_BASE + column
      return if (column in 0 until MonthExpandedLayoutContract.DAY_PAGE_COUNT &&
        accessibilityBoundsForVirtualId(id) != null
      ) {
        id
      } else {
        INVALID_VIRTUAL_ID
      }
    }
  }

  private fun CalendarRect.toAndroidRect(): Rect = Rect(
    floor(left).toInt(),
    floor(top).toInt(),
    ceil(right).toInt(),
    ceil(bottom).toInt(),
  )

  override fun performClick(): Boolean = super.performClick()
}

// CAL-MONTH-EXPAND-001: Each day page owns its ScrollView so same-week column changes preserve scroll state.
@FeishuEvidence("CAL-MONTH-EXPAND-001")
private class SelectedDayPageView(context: Context) : FrameLayout(context) {
  private val palette = CalendarUi.palette(context)
  private val timeFormatter = CalendarTimeFormatter()
  private val eventList = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    setBackgroundColor(palette.surfaceMuted)
  }
  private val scrollView = ScrollView(context).apply {
    isFillViewport = true
    clipToPadding = false
    addView(
      eventList,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT),
    )
  }
  private val emptyView = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.CENTER
    setBackgroundColor(palette.background)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    contentDescription = "暂无日程安排"
  }
  private val emptyImage = ImageView(context).apply {
    setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_calendar_empty)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }
  private val emptyMessage = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER
  }
  private val emptyMessageText = TextView(context).apply {
    text = "暂无日程安排，"
    setTextColor(palette.textSecondary)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
  }
  private val emptyCreateText = TextView(context).apply {
    text = "点击创建"
    setTextColor(palette.accent)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    isClickable = true
    isFocusable = true
    contentDescription = "点击创建日程"
  }
  private var boundEpochDay: Int? = null
  private var bindGeneration = 0

  init {
    setBackgroundColor(palette.surfaceMuted)
    addView(scrollView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    emptyMessage.addView(emptyMessageText)
    emptyMessage.addView(emptyCreateText)
    emptyView.addView(
      emptyImage,
      LinearLayout.LayoutParams(
        CalendarUi.dp(context, 100f).roundToInt(),
        CalendarUi.dp(context, 100f).roundToInt(),
      ),
    )
    emptyView.addView(emptyMessage, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = CalendarUi.dp(context, 12f).roundToInt()
    })
    addView(emptyView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    emptyImage.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    emptyMessageText.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun bind(
    epochDay: Int,
    sourceEvents: List<CalendarEvent>,
    listener: MonthCalendarListener?,
    preserveScroll: Boolean,
  ) {
    val keepScroll = preserveScroll && boundEpochDay == epochDay
    val savedScrollY = if (keepScroll) scrollView.scrollY else 0
    boundEpochDay = epochDay
    val generation = ++bindGeneration
    val allDayEvents = CalendarGeometry.visibleAllDayEvents(sourceEvents, epochDay)
    val timedEvents = CalendarGeometry.daySegments(sourceEvents, epochDay).map { it.event }
    val events = allDayEvents + timedEvents
    eventList.removeAllViews()
    emptyView.visibility = if (events.isEmpty()) VISIBLE else GONE
    scrollView.visibility = if (events.isEmpty()) GONE else VISIBLE
    emptyCreateText.setOnClickListener { listener?.onEmptyCreateRequested(epochDay) }
    val date = CalendarDateMath.fromEpochDay(epochDay)
    contentDescription = String.format(Locale.getDefault(), "%d-%d-%d", date.year, date.month, date.day)

    events.forEach { event ->
      eventList.addView(
        createEventRow(epochDay, event, listener),
        LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
          marginStart = CalendarUi.dp(context, 16f).roundToInt()
          marginEnd = CalendarUi.dp(context, 12f).roundToInt()
          bottomMargin = CalendarUi.dp(context, 6f).roundToInt()
        },
      )
    }
    scrollView.post {
      if (generation == bindGeneration && boundEpochDay == epochDay) {
        scrollView.scrollTo(0, savedScrollY)
      }
    }
  }

  private fun createEventRow(
    epochDay: Int,
    event: CalendarEvent,
    listener: MonthCalendarListener?,
  ): View = LinearLayout(context).apply {
    FeishuEvidenceRuntime.bind(
      this,
      "CAL-MONTH-EXPAND-001",
      "selected-event-row",
      "calendar-selected-event-${event.identity}",
    )
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.TOP
    minimumHeight = CalendarUi.dp(context, MonthExpandedLayoutContract.EVENT_ROW_HEIGHT_DP).roundToInt()
    setPadding(
      CalendarUi.dp(context, 12f).roundToInt(),
      CalendarUi.dp(context, 7f).roundToInt(),
      CalendarUi.dp(context, 12f).roundToInt(),
      CalendarUi.dp(context, 7f).roundToInt(),
    )
    isClickable = true
    isFocusable = true
    background = StateListDrawable().apply {
      addState(
        intArrayOf(android.R.attr.state_pressed),
        CalendarUi.background(
          palette.eventFill,
          CalendarProductVisualContract.EVENT_BORDER_RADIUS_DP,
          context,
          palette.eventBorder,
          CalendarProductVisualContract.EVENT_BORDER_WIDTH_DP,
        ),
      )
      addState(
        intArrayOf(),
        CalendarUi.background(
          palette.surfaceMuted,
          CalendarProductVisualContract.EVENT_BORDER_RADIUS_DP,
          context,
          palette.eventBorder,
          CalendarProductVisualContract.EVENT_BORDER_WIDTH_DP,
        ),
      )
    }
    contentDescription = "${CalendarUi.listEventTitle(event.title)}，${eventTimeLabel(epochDay, event)}"
    setOnClickListener { listener?.onEventOpened(event) }

    addView(
      LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        addView(
          TextView(context).apply {
            text = CalendarUi.listEventTitle(event.title)
            setTextColor(palette.textPrimary)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
          },
          LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT),
        )
        addView(
          TextView(context).apply {
            text = eventTimeLabel(epochDay, event)
            setTextColor(palette.textPrimary)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
          },
          LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = CalendarUi.dp(context, 2f).roundToInt()
          },
        )
      },
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT),
    )
  }

  private fun eventTimeLabel(epochDay: Int, event: CalendarEvent): String {
    if (event.allDay) return "全天"
    val bounds = MonthExpandedLayoutContract.eventTimeBounds(epochDay, event)
    return timeFormatter.range(bounds.startMinute, bounds.endMinute)
  }
}

// CAL-MONTH-EXPAND-001: The middle owner is a fixed seven-page pager, matching one page per weekday.
@FeishuEvidence("CAL-MONTH-EXPAND-001")
private class SelectedDayEventsOwner(context: Context) : FrameLayout(context) {
  private val palette = CalendarUi.palette(context)
  private val pager = ViewPager2(context)
  private val adapter = SelectedDayPageAdapter()
  private var boundWeekStartEpochDay: Int? = null
  private var boundRow = -1
  private var selectedColumn = 0
  private var pageListener: SelectedDayPageListener? = null
  private var suppressPageCallbacks = false
  private var selectionGeneration = 0

  private val pageCallback = object : ViewPager2.OnPageChangeCallback() {
    override fun onPageSelected(position: Int) {
      val weekStart = boundWeekStartEpochDay ?: return
      if (suppressPageCallbacks || position == selectedColumn) return
      selectedColumn = position
      pageListener?.onSelectedDayPageChanged(weekStart + position, boundRow, position)
    }
  }

  init {
    setBackgroundColor(palette.surface)
    pager.apply {
      adapter = this@SelectedDayEventsOwner.adapter
      setSourceOffscreenPageLimit(this)
      isSaveEnabled = false
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
      registerOnPageChangeCallback(pageCallback)
    }
    addView(pager, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    (pager.getChildAt(0) as? RecyclerView)?.apply {
      setItemViewCacheSize(MonthExpandedLayoutContract.DAY_PAGE_COUNT)
      overScrollMode = OVER_SCROLL_NEVER
      // Data rebinding is part of a date tap, not a page transition. The
      // default RecyclerView change animator can move/reveal the old page
      // while notifyItemRangeChanged runs, which looks like an unintended
      // right-swipe even when ViewPager2 is told to jump without smoothing.
      itemAnimator = null
      setOnTouchListener { _, event ->
        if (event.actionMasked != MotionEvent.ACTION_UP && event.actionMasked != MotionEvent.ACTION_CANCEL) {
          this@SelectedDayEventsOwner.parent?.requestDisallowInterceptTouchEvent(true)
        }
        false
      }
    }
    visibility = INVISIBLE
    alpha = 1f
  }

  // ViewPager2's lint annotation only accepts its sentinel constant, while the
  // source uses a positive cache size to retain all seven selected-day pages.
  @SuppressLint("WrongConstant")
  private fun setSourceOffscreenPageLimit(target: ViewPager2) {
    target.offscreenPageLimit = MonthExpandedLayoutContract.DAY_PAGE_COUNT
  }

  fun bindWeek(
    selection: MonthExpandedSelection,
    sourceEvents: List<CalendarEvent>,
    calendarListener: MonthCalendarListener?,
    pageListener: SelectedDayPageListener?,
    smoothColumn: Boolean,
  ) {
    val weekStartEpochDay = selection.epochDay - selection.column
    val sameWeek = boundWeekStartEpochDay == weekStartEpochDay
    boundWeekStartEpochDay = weekStartEpochDay
    boundRow = selection.row
    this.pageListener = pageListener
    suppressPageCallbacks = true
    val generation = ++selectionGeneration
    if (!smoothColumn) {
      // ViewPager2 can draw the previously attached page for one frame after a
      // non-animated setCurrentItem/adapter rebind. Hide only its content until
      // RecyclerView has completed two frame passes so a date tap cannot look
      // like a right-swipe.
      pager.visibility = INVISIBLE
    }
    adapter.bindWeek(weekStartEpochDay, sourceEvents, calendarListener, sameWeek)
    selectedColumn = selection.column.coerceIn(0, MonthExpandedLayoutContract.DAY_PAGE_COUNT - 1)
    pager.setCurrentItem(selectedColumn, smoothColumn && sameWeek)
    pager.postOnAnimation {
      pager.postOnAnimation {
        if (generation == selectionGeneration) {
          suppressPageCallbacks = false
          pager.visibility = VISIBLE
        }
      }
    }
  }

  fun reset() {
    selectionGeneration += 1
    suppressPageCallbacks = true
    boundWeekStartEpochDay = null
    boundRow = -1
    selectedColumn = 0
    pageListener = null
    adapter.reset()
    pager.setCurrentItem(0, false)
    pager.visibility = INVISIBLE
  }

  private inner class SelectedDayPageAdapter : RecyclerView.Adapter<SelectedDayPageHolder>() {
    private var weekStartEpochDay = 0
    private var sourceEvents: List<CalendarEvent> = emptyList()
    private var calendarListener: MonthCalendarListener? = null
    private var preserveScroll = false

    init {
      setHasStableIds(true)
    }

    fun bindWeek(
      weekStartEpochDay: Int,
      sourceEvents: List<CalendarEvent>,
      calendarListener: MonthCalendarListener?,
      preserveScroll: Boolean,
    ) {
      this.weekStartEpochDay = weekStartEpochDay
      this.sourceEvents = sourceEvents
      this.calendarListener = calendarListener
      this.preserveScroll = preserveScroll
      notifyItemRangeChanged(0, MonthExpandedLayoutContract.DAY_PAGE_COUNT)
    }

    fun reset() {
      weekStartEpochDay = 0
      sourceEvents = emptyList()
      calendarListener = null
      preserveScroll = false
      notifyItemRangeChanged(0, MonthExpandedLayoutContract.DAY_PAGE_COUNT)
    }

    override fun getItemCount(): Int = MonthExpandedLayoutContract.DAY_PAGE_COUNT

    override fun getItemId(position: Int): Long = position.toLong()

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): SelectedDayPageHolder {
      val page = SelectedDayPageView(parent.context).apply {
        layoutParams = RecyclerView.LayoutParams(
          RecyclerView.LayoutParams.MATCH_PARENT,
          RecyclerView.LayoutParams.MATCH_PARENT,
        )
      }
      return SelectedDayPageHolder(page)
    }

    override fun onBindViewHolder(holder: SelectedDayPageHolder, position: Int) {
      holder.page.bind(
        epochDay = weekStartEpochDay + position,
        sourceEvents = sourceEvents,
        listener = calendarListener,
        preserveScroll = preserveScroll,
      )
    }
  }

  private class SelectedDayPageHolder(val page: SelectedDayPageView) : RecyclerView.ViewHolder(page)
}

// CAL-MONTH-EXPAND-001: A month page composes 4-6 week Views plus one selected-day events owner.
@FeishuEvidence("CAL-MONTH-EXPAND-001", "CAL-MONTH-EXPAND-HOST-001", "CAL-MONTH-SPAN-001")
private class MonthPageView(context: Context) : FrameLayout(context), MonthWeekRowListener, SelectedDayPageListener {
  private val palette = CalendarUi.palette(context)
  private val weekdayHeight = CalendarUi.dp(context, 34f).roundToInt()
  private val weekdayHeader = MonthWeekdayHeaderView(context)
  private val rowsContainer = FrameLayout(context).apply {
    setBackgroundColor(palette.surface)
    clipChildren = true
    clipToPadding = true
  }
  private val eventOwner = SelectedDayEventsOwner(context)
  private val rowViews = mutableListOf<MonthWeekRowView>()
  private var monthEpochDay = CalendarDateMath.monthStart(0)
  private var weekCount = 4
  private var snapshot: CalendarSnapshot? = null
  private var listener: MonthCalendarListener? = null
  private var displayedSelectedEpochDay: Int? = null
  private var expandedSelection: MonthExpandedSelection? = null
  private var pendingSelection: MonthExpandedSelection? = null
  private var pendingCrossMonthEpochDay: Int? = null
  private var transitionAnimator: AnimatorSet? = null
  private var animationGeneration = 0
  private var transitionStartedAtMs = 0L
  private var transitioning = false
  private var selectionClearedByClose = false

  init {
    setBackgroundColor(palette.surface)
    clipChildren = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    addView(
      weekdayHeader,
      LayoutParams(LayoutParams.MATCH_PARENT, weekdayHeight),
    )
    addView(
      rowsContainer,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
        topMargin = weekdayHeight
      },
    )
    rowsContainer.addView(eventOwner, LayoutParams(LayoutParams.MATCH_PARENT, 0))
  }

  fun bind(monthEpochDay: Int, snapshot: CalendarSnapshot?, listener: MonthCalendarListener?) {
    val normalizedMonth = CalendarDateMath.monthStart(monthEpochDay)
    val monthChanged = normalizedMonth != this.monthEpochDay
    if (monthChanged) {
      cancelActiveAnimation()
      expandedSelection = null
      pendingSelection = null
      pendingCrossMonthEpochDay = null
      transitioning = false
      selectionClearedByClose = false
      eventOwner.reset()
    }
    this.monthEpochDay = normalizedMonth
    this.snapshot = snapshot
    this.listener = listener
    weekCount = CalendarDateMath.monthWeekCount(normalizedMonth)
    weekdayHeader.bind(normalizedMonth, snapshot?.todayEpochDay)
    ensureWeekRows()
    if (!transitioning) {
      displayedSelectedEpochDay = expandedSelection?.epochDay
        ?: snapshot?.selectedEpochDay?.takeUnless { selectionClearedByClose }
    } else if (expandedSelection != null) {
      displayedSelectedEpochDay = expandedSelection?.epochDay
    }
    bindWeekRows()
    expandedSelection?.let {
      bindEventOwner(it, smoothColumn = false)
    }
    contentDescription = CalendarUi.monthTitle(normalizedMonth)
    if (!transitioning) applyGeometryImmediately()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    val measuredBodyHeight = (measuredHeight - weekdayHeight).coerceAtLeast(0)
    var geometryChanged = updateRowHeightLayoutParams(measuredBodyHeight)
    if (!transitioning) {
      geometryChanged = updateRowTopLayoutParams(
        MonthExpandedLayoutContract.rowTargetTops(
          measuredBodyHeight.toFloat(),
          weekCount,
          expandedSelection?.row,
        ),
      ) || geometryChanged
    }
    expandedSelection?.let { selection ->
      geometryChanged = updateEventOwnerLayoutParams(selection, measuredBodyHeight) || geometryChanged
    }
    if (geometryChanged) super.onMeasure(widthMeasureSpec, heightMeasureSpec)
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    if (width != oldWidth || height != oldHeight) {
      if (transitioning) settleInterruptedTransition() else applyGeometryImmediately()
    }
  }

  override fun onDateTapped(epochDay: Int, row: Int, column: Int) {
    if (transitioning) return
    if (CalendarDateMath.monthStart(epochDay) != monthEpochDay) {
      closeBeforeCrossMonthSelection(epochDay)
      return
    }
    val transition = MonthExpandedLayoutContract.resolveTap(expandedSelection, epochDay, row, column)
    when (transition.action) {
      MonthExpandedTapAction.OPEN -> {
        openSelection(requireNotNull(transition.targetSelection))
        listener?.onDateSelected(epochDay)
      }
      MonthExpandedTapAction.CLOSE -> {
        closeSelection()
        listener?.onDateSelected(closeSelectionEpochDay())
      }
      MonthExpandedTapAction.SWITCH_WITHIN_ROW -> {
        switchWithinRow(requireNotNull(transition.targetSelection))
        listener?.onDateSelected(epochDay)
      }
      MonthExpandedTapAction.CLOSE_THEN_OPEN -> {
        closeThenOpen(requireNotNull(transition.targetSelection))
        listener?.onDateSelected(epochDay)
      }
    }
  }

  fun openCrossMonthSelection(epochDay: Int): Boolean {
    if (CalendarDateMath.monthStart(epochDay) != monthEpochDay || transitioning || !hasStableOpenGeometry()) {
      return false
    }
    val gridStart = CalendarDateMath.monthGridStart(monthEpochDay)
    val dayOffset = epochDay - gridStart
    if (dayOffset !in 0 until weekCount * MonthExpandedLayoutContract.DAY_PAGE_COUNT) return false
    openSelection(
      MonthExpandedSelection(
        epochDay = epochDay,
        row = dayOffset / MonthExpandedLayoutContract.DAY_PAGE_COUNT,
        column = dayOffset % MonthExpandedLayoutContract.DAY_PAGE_COUNT,
      ),
    )
    return true
  }

  fun returnToDate(epochDay: Int): Boolean {
    if (CalendarDateMath.monthStart(epochDay) != monthEpochDay || transitioning || !hasStableOpenGeometry()) {
      return false
    }
    val gridStart = CalendarDateMath.monthGridStart(monthEpochDay)
    val dayOffset = epochDay - gridStart
    if (dayOffset !in 0 until weekCount * MonthExpandedLayoutContract.DAY_PAGE_COUNT) return false
    val selection = MonthExpandedSelection(
      epochDay = epochDay,
      row = dayOffset / MonthExpandedLayoutContract.DAY_PAGE_COUNT,
      column = dayOffset % MonthExpandedLayoutContract.DAY_PAGE_COUNT,
    )
    val transition = MonthExpandedLayoutContract.resolveTap(
      expandedSelection,
      selection.epochDay,
      selection.row,
      selection.column,
    )
    when (transition.action) {
      MonthExpandedTapAction.OPEN -> openSelection(requireNotNull(transition.targetSelection))
      MonthExpandedTapAction.CLOSE -> closeSelection()
      MonthExpandedTapAction.SWITCH_WITHIN_ROW -> switchWithinRow(requireNotNull(transition.targetSelection))
      MonthExpandedTapAction.CLOSE_THEN_OPEN -> closeThenOpen(requireNotNull(transition.targetSelection))
    }
    return true
  }

  fun expandedEpochDay(): Int? = expandedSelection?.epochDay

  private fun hasStableOpenGeometry(): Boolean =
    isLaidOut && !isLayoutRequested && !rowsContainer.isLayoutRequested && bodyHeight() > 0 &&
      rowViews.size == weekCount && rowViews.all { row ->
        row.isLaidOut && !row.isLayoutRequested && row.width > 0 && row.height > 1
      }

  override fun onWeekEventTapped(event: CalendarEvent) {
    listener?.onEventOpened(event)
  }

  override fun onSelectedDayPageChanged(epochDay: Int, row: Int, column: Int) {
    if (transitioning) return
    val current = expandedSelection ?: return
    if (current.row != row || current.epochDay == epochDay) return
    val transition = MonthExpandedLayoutContract.resolveTap(current, epochDay, row, column)
    if (transition.action != MonthExpandedTapAction.SWITCH_WITHIN_ROW) return
    val selection = requireNotNull(transition.targetSelection)
    expandedSelection = selection
    displayedSelectedEpochDay = selection.epochDay
    bindWeekRows()
    listener?.onDateSelected(selection.epochDay)
  }

  private fun openSelection(selection: MonthExpandedSelection) {
    pendingSelection = null
    selectionClearedByClose = false
    expandedSelection = selection
    displayedSelectedEpochDay = selection.epochDay
    bindWeekRows()
    bindEventOwner(selection, smoothColumn = false)
    transitioning = true
    animateRows(selection) { transitioning = false }
  }

  private fun closeSelection() {
    pendingSelection = null
    expandedSelection = null
    displayedSelectedEpochDay = null
    selectionClearedByClose = true
    bindWeekRows()
    hideEventOwnerImmediately()
    transitioning = true
    animateRows(null) {
      transitioning = false
    }
  }

  private fun switchWithinRow(selection: MonthExpandedSelection) {
    pendingSelection = null
    selectionClearedByClose = false
    expandedSelection = selection
    displayedSelectedEpochDay = selection.epochDay
    bindWeekRows()
    // Feishu's month click path updates the selected column and data in place;
    // it does not run the MonthDayViewPager's horizontal gesture animation.
    // Keep horizontal motion reserved for an actual user swipe so a date tap
    // cannot make the event list appear to slide in from the right.
    bindEventOwner(selection, smoothColumn = false)
    applyGeometryImmediately()
  }

  private fun closeThenOpen(selection: MonthExpandedSelection) {
    pendingSelection = selection
    expandedSelection = null
    displayedSelectedEpochDay = selection.epochDay
    selectionClearedByClose = false
    bindWeekRows()
    // A cross-row change owns one vertical close/open motion. The selected-day
    // pager must jump to the new column here; animating it and rebinding it
    // again after the close produces the visible double right-swipe.
    bindEventOwner(selection, smoothColumn = false)
    eventOwner.visibility = VISIBLE
    eventOwner.alpha = 1f
    transitioning = true
    animateRows(null, keepEventOwnerVisible = true) {
      pendingSelection = null
      selectionClearedByClose = false
      displayedSelectedEpochDay = selection.epochDay
      expandedSelection = selection
      bindWeekRows()
      bindEventOwner(selection, smoothColumn = false)
      animateRows(selection) { transitioning = false }
    }
  }

  private fun closeBeforeCrossMonthSelection(epochDay: Int) {
    pendingCrossMonthEpochDay = epochDay
    pendingSelection = null
    if (expandedSelection == null) {
      pendingCrossMonthEpochDay = null
      listener?.onDateSelected(epochDay)
      return
    }
    expandedSelection = null
    displayedSelectedEpochDay = null
    selectionClearedByClose = true
    bindWeekRows()
    hideEventOwnerImmediately()
    transitioning = true
    animateRows(null) {
      transitioning = false
      val target = pendingCrossMonthEpochDay
      pendingCrossMonthEpochDay = null
      if (target != null) listener?.onDateSelected(target)
    }
  }

  private fun settleInterruptedTransition() {
    val target = pendingSelection
    val crossMonthTarget = pendingCrossMonthEpochDay
    val remainingCrossMonthCloseMs = (
      MonthExpandedLayoutContract.ROW_ANIMATION_DURATION_MS -
        (SystemClock.uptimeMillis() - transitionStartedAtMs)
      ).coerceAtLeast(0L)
    cancelActiveAnimation()
    pendingSelection = null
    if (crossMonthTarget != null) {
      expandedSelection = null
      displayedSelectedEpochDay = null
      selectionClearedByClose = true
      hideEventOwnerImmediately()
      bindWeekRows()
      applyGeometryImmediately()
      transitioning = true
      val completionGeneration = animationGeneration
      postDelayed(
        {
          if (completionGeneration != animationGeneration || pendingCrossMonthEpochDay != crossMonthTarget) {
            return@postDelayed
          }
          pendingCrossMonthEpochDay = null
          transitioning = false
          listener?.onDateSelected(crossMonthTarget)
        },
        remainingCrossMonthCloseMs,
      )
      return
    }
    pendingCrossMonthEpochDay = null
    if (target != null) {
      selectionClearedByClose = false
      expandedSelection = target
      displayedSelectedEpochDay = target.epochDay
      bindWeekRows()
      bindEventOwner(target, smoothColumn = false)
    }
    transitioning = false
    if (expandedSelection == null) {
      displayedSelectedEpochDay = null
      hideEventOwnerImmediately()
      bindWeekRows()
    }
    applyGeometryImmediately()
  }

  private fun bindEventOwner(selection: MonthExpandedSelection, smoothColumn: Boolean) {
    eventOwner.bindWeek(
      selection = selection,
      sourceEvents = snapshot?.events.orEmpty(),
      calendarListener = listener,
      pageListener = this,
      smoothColumn = smoothColumn,
    )
  }

  private fun ensureWeekRows() {
    if (rowViews.size == weekCount) return
    rowViews.forEach(rowsContainer::removeView)
    rowViews.clear()
    repeat(weekCount) {
      MonthWeekRowView(context).also { row ->
        rowViews += row
        rowsContainer.addView(row, LayoutParams(LayoutParams.MATCH_PARENT, 0))
      }
    }
  }

  private fun bindWeekRows() {
    val gridStart = CalendarDateMath.monthGridStart(monthEpochDay)
    val allSegments = CalendarGeometry.monthSegments(snapshot?.events.orEmpty(), gridStart, weekCount)
    rowViews.forEachIndexed { row, rowView ->
      rowView.bind(
        monthEpochDay = monthEpochDay,
        rowStartEpochDay = gridStart + row * 7,
        rowIndex = row,
        selectedEpochDay = displayedSelectedEpochDay,
        collapseColumn = expandedSelection?.takeIf { it.row == row }?.column,
        todayEpochDay = snapshot?.todayEpochDay,
        segments = allSegments.filter { it.weekIndex == row },
        listener = this,
      )
    }
  }

  private fun applyGeometryImmediately() {
    cancelActiveAnimation()
    transitioning = false
    updateRowHeights()
    val selection = expandedSelection
    val targets = MonthExpandedLayoutContract.rowTargetTops(bodyHeight().toFloat(), weekCount, selection?.row)
    updateRowTops(targets)
    if (selection == null) {
      eventOwner.visibility = INVISIBLE
      eventOwner.alpha = 1f
    } else {
      updateEventOwnerLayout(selection)
      eventOwner.visibility = VISIBLE
      eventOwner.alpha = 1f
    }
  }

  private fun animateRows(
    selection: MonthExpandedSelection?,
    keepEventOwnerVisible: Boolean = false,
    onEnd: () -> Unit,
  ) {
    cancelActiveAnimation()
    updateRowHeights()
    if (selection != null) {
      updateEventOwnerLayout(selection)
      eventOwner.visibility = VISIBLE
      eventOwner.alpha = 1f
    }

    val targets = MonthExpandedLayoutContract.rowTargetTops(bodyHeight().toFloat(), weekCount, selection?.row)
    if (bodyHeight() == 0 || rowViews.isEmpty()) {
      updateRowTops(targets)
      finishOwnerVisibility(selection, keepEventOwnerVisible)
      onEnd()
      return
    }

    val animators = mutableListOf<Animator>()
    rowViews.forEachIndexed { index, row ->
      row.translationY = 0f
      val targetTop = targets[index].roundToInt()
      val startTop = row.top.takeIf { row.isLaidOut } ?: (row.layoutParams as LayoutParams).topMargin
      animators += ValueAnimator.ofInt(startTop, targetTop).apply {
        addUpdateListener { animation ->
          val top = animation.animatedValue as Int
          val params = row.layoutParams as LayoutParams
          if (params.leftMargin != 0 || params.topMargin != top) {
            params.leftMargin = 0
            params.topMargin = top
            row.layoutParams = params
          }
        }
      }
    }

    val generation = ++animationGeneration
    transitionStartedAtMs = SystemClock.uptimeMillis()
    transitionAnimator = AnimatorSet().apply {
      playTogether(animators)
      duration = MonthExpandedLayoutContract.ROW_ANIMATION_DURATION_MS
      interpolator = AccelerateDecelerateInterpolator()
      addListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: Animator) {
          if (generation != animationGeneration) return
          transitionAnimator = null
          updateRowTops(targets)
          finishOwnerVisibility(selection, keepEventOwnerVisible)
          onEnd()
        }
      })
      start()
    }
  }

  private fun finishOwnerVisibility(
    selection: MonthExpandedSelection?,
    keepEventOwnerVisible: Boolean = false,
  ) {
    if (selection == null && !keepEventOwnerVisible) {
      eventOwner.visibility = INVISIBLE
      eventOwner.alpha = 1f
    } else {
      eventOwner.visibility = VISIBLE
      eventOwner.alpha = 1f
    }
  }

  private fun hideEventOwnerImmediately() {
    eventOwner.visibility = INVISIBLE
    eventOwner.alpha = 1f
    eventOwner.reset()
  }

  private fun updateRowHeights() {
    if (updateRowHeightLayoutParams(bodyHeight())) rowsContainer.requestLayout()
  }

  private fun updateRowHeightLayoutParams(availableHeight: Int): Boolean {
    val rowHeight = availableHeight.toFloat() / weekCount
    var changed = false
    rowViews.forEachIndexed { index, row ->
      val top = (index * rowHeight).roundToInt()
      val bottom = ((index + 1) * rowHeight).roundToInt()
      val params = row.layoutParams as LayoutParams
      val nextHeight = (bottom - top).coerceAtLeast(1)
      if (params.width != LayoutParams.MATCH_PARENT || params.height != nextHeight) {
        params.width = LayoutParams.MATCH_PARENT
        params.height = nextHeight
        changed = true
      }
    }
    return changed
  }

  private fun updateRowTops(targets: List<Float>) {
    if (updateRowTopLayoutParams(targets)) rowsContainer.requestLayout()
  }

  private fun updateRowTopLayoutParams(targets: List<Float>): Boolean {
    var changed = false
    rowViews.forEachIndexed { index, row ->
      row.translationY = 0f
      val top = targets[index].roundToInt()
      val params = row.layoutParams as LayoutParams
      if (params.leftMargin != 0 || params.topMargin != top) {
        params.leftMargin = 0
        params.topMargin = top
        changed = true
      }
    }
    return changed
  }

  private fun updateEventOwnerLayout(selection: MonthExpandedSelection) {
    if (updateEventOwnerLayoutParams(selection, bodyHeight())) rowsContainer.requestLayout()
  }

  private fun updateEventOwnerLayoutParams(
    selection: MonthExpandedSelection,
    availableHeight: Int,
  ): Boolean {
    val bounds = MonthExpandedLayoutContract.selectedEventsBounds(
      availableHeight.toFloat(),
      weekCount,
      selection.row,
    )
    val top = bounds.top.roundToInt()
    val bottom = bounds.bottom.roundToInt()
    val params = eventOwner.layoutParams as LayoutParams
    val nextHeight = (bottom - top).coerceAtLeast(0)
    if (params.width == LayoutParams.MATCH_PARENT && params.height == nextHeight && params.topMargin == top) {
      return false
    }
    params.width = LayoutParams.MATCH_PARENT
    params.height = nextHeight
    params.topMargin = top
    return true
  }

  private fun bodyHeight(): Int = (height - weekdayHeight).coerceAtLeast(0)

  private fun closeSelectionEpochDay(): Int = MonthExpandedLayoutContract.closeSelectionEpochDay(
    todayEpochDay = snapshot?.todayEpochDay,
    monthEpochDay = monthEpochDay,
    gridStartEpochDay = CalendarDateMath.monthGridStart(monthEpochDay),
    weekCount = weekCount,
  )

  private fun cancelActiveAnimation() {
    animationGeneration += 1
    transitionAnimator?.cancel()
    transitionAnimator = null
  }

}

// CAL-MONTH-EXPAND-HOST-001: snapshot refresh rebinds existing pages in place;
// it must not destroy MonthPageView-owned expandedSelection or active motion.
@FeishuEvidence("CAL-MONTH-EXPAND-HOST-001")
class ThreePageMonthPager(context: Context) : FrameLayout(context), MonthCalendarListener {
  private val pager = ViewPager2(context)
  private val adapter = MonthPageAdapter()
  private var snapshot: CalendarSnapshot? = null
  private var centerMonthEpochDay = CalendarDateMath.monthStart(0)
  private var externalListener: MonthCalendarListener? = null
  private var recentering = false
  private var pendingCrossMonthEpochDay: Int? = null
  private var crossMonthOpenToken = 0

  private val pageCallback = object : ViewPager2.OnPageChangeCallback() {
    override fun onPageScrollStateChanged(state: Int) {
      if (state != ViewPager2.SCROLL_STATE_IDLE || recentering) return
      val delta = MonthPagerContract.monthDeltaForSettledPage(pager.currentItem)
      if (delta == 0) return
      centerMonthEpochDay = CalendarDateMath.addMonths(centerMonthEpochDay, delta, false)
      recenterToBoundPages()
      externalListener?.onMonthChanged(centerMonthEpochDay)
    }
  }

  init {
    FeishuEvidenceRuntime.bind(this, "CAL-MONTH-EXPAND-HOST-001", "month-pager", "calendar-month-pager")
    pager.apply {
      orientation = ViewPager2.ORIENTATION_HORIZONTAL
      setSourceOffscreenPageLimit(this)
      adapter = this@ThreePageMonthPager.adapter
      isSaveEnabled = false
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
      registerOnPageChangeCallback(pageCallback)
    }
    addView(
      pager,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )
    (pager.getChildAt(0) as? RecyclerView)?.apply {
      setItemViewCacheSize(MonthPagerContract.PAGE_COUNT)
      overScrollMode = OVER_SCROLL_NEVER
    }
    clipChildren = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    recenterToBoundPages()
  }

  // The source keeps the fixed left/center/right month pages warm. A positive
  // limit is valid at runtime even though lint cannot infer that contract.
  @SuppressLint("WrongConstant")
  private fun setSourceOffscreenPageLimit(target: ViewPager2) {
    target.offscreenPageLimit = MonthPagerContract.PAGE_COUNT
  }

  fun setListener(listener: MonthCalendarListener?) {
    externalListener = listener
  }

  fun setSnapshot(snapshot: CalendarSnapshot?) {
    this.snapshot = snapshot
    adapter.rebindSnapshot()
    if (pendingCrossMonthEpochDay != null) schedulePendingCrossMonthOpen(crossMonthOpenToken, 0)
  }

  fun currentMonthEpochDay(): Int = centerMonthEpochDay

  internal fun currentExpandedEpochDay(): Int? =
    adapter.boundPage(MonthPagerContract.CENTER_PAGE)?.expandedEpochDay()

  fun jumpToMonth(epochDay: Int, notify: Boolean = false) {
    pendingCrossMonthEpochDay = null
    crossMonthOpenToken += 1
    centerMonthEpochDay = CalendarDateMath.monthStart(epochDay)
    recenterToBoundPages()
    if (notify) externalListener?.onMonthChanged(centerMonthEpochDay)
  }

  fun returnToToday(epochDay: Int) {
    pendingCrossMonthEpochDay = null
    val token = ++crossMonthOpenToken
    val targetMonth = CalendarDateMath.monthStart(epochDay)
    if (targetMonth != centerMonthEpochDay) {
      pendingCrossMonthEpochDay = epochDay
      centerMonthEpochDay = targetMonth
      recenterToBoundPages()
      externalListener?.onMonthChanged(centerMonthEpochDay)
      schedulePendingCrossMonthOpen(token, 0)
      return
    }
    if (pager.scrollState != ViewPager2.SCROLL_STATE_IDLE || recentering) return
    pager.post {
      if (token != crossMonthOpenToken) return@post
      adapter.boundPage(MonthPagerContract.CENTER_PAGE)?.returnToDate(epochDay)
    }
  }

  private fun recenterToBoundPages() {
    recentering = true
    adapter.notifyDataSetChanged()
    pager.setCurrentItem(MonthPagerContract.CENTER_PAGE, false)
    contentDescription = CalendarUi.monthTitle(centerMonthEpochDay)
    pager.post { recentering = false }
  }

  private inner class MonthPageAdapter : RecyclerView.Adapter<MonthPageHolder>() {
    private val boundPages = mutableMapOf<Int, MonthPageView>()

    override fun getItemCount(): Int = MonthPagerContract.PAGE_COUNT

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): MonthPageHolder {
      val page = MonthPageView(parent.context).apply {
        layoutParams = RecyclerView.LayoutParams(
          RecyclerView.LayoutParams.MATCH_PARENT,
          RecyclerView.LayoutParams.MATCH_PARENT,
        )
      }
      return MonthPageHolder(page)
    }

    override fun onBindViewHolder(holder: MonthPageHolder, position: Int) {
      boundPages[position] = holder.page
      holder.page.bind(
        CalendarDateMath.addMonths(centerMonthEpochDay, position - MonthPagerContract.CENTER_PAGE, false),
        snapshot,
        this@ThreePageMonthPager,
      )
    }

    override fun onViewRecycled(holder: MonthPageHolder) {
      boundPages.entries.removeAll { it.value === holder.page }
    }

    fun boundPage(position: Int): MonthPageView? = boundPages[position]

    fun rebindSnapshot() {
      boundPages.toMap().forEach { (position, page) ->
        page.bind(
          CalendarDateMath.addMonths(centerMonthEpochDay, position - MonthPagerContract.CENTER_PAGE, false),
          snapshot,
          this@ThreePageMonthPager,
        )
      }
    }
  }

  private class MonthPageHolder(val page: MonthPageView) : RecyclerView.ViewHolder(page)

  override fun onMonthChanged(monthEpochDay: Int) = Unit

  override fun onDateSelected(epochDay: Int) {
    externalListener?.onDateSelected(epochDay)
    val selectedMonth = CalendarDateMath.monthStart(epochDay)
    if (selectedMonth == centerMonthEpochDay) return
    pendingCrossMonthEpochDay = epochDay
    val token = ++crossMonthOpenToken
    centerMonthEpochDay = selectedMonth
    recenterToBoundPages()
    externalListener?.onMonthChanged(centerMonthEpochDay)
    schedulePendingCrossMonthOpen(token, 0)
  }

  override fun onEventOpened(event: CalendarEvent) {
    externalListener?.onEventOpened(event)
  }

  override fun onEmptyCreateRequested(epochDay: Int) {
    externalListener?.onEmptyCreateRequested(epochDay)
  }

  private fun schedulePendingCrossMonthOpen(token: Int, attempt: Int) {
    if (token != crossMonthOpenToken || pendingCrossMonthEpochDay == null) return
    pager.postDelayed(
      {
        if (token != crossMonthOpenToken) return@postDelayed
        val target = pendingCrossMonthEpochDay ?: return@postDelayed
        val centerPage = adapter.boundPage(MonthPagerContract.CENTER_PAGE)
        if (centerPage?.openCrossMonthSelection(target) == true) {
          pendingCrossMonthEpochDay = null
        } else if (attempt < MAX_CROSS_MONTH_OPEN_ATTEMPTS) {
          schedulePendingCrossMonthOpen(token, attempt + 1)
        }
      },
      if (attempt == 0) 0L else 16L,
    )
  }

  private companion object {
    const val MAX_CROSS_MONTH_OPEN_ATTEMPTS = 30
  }
}
