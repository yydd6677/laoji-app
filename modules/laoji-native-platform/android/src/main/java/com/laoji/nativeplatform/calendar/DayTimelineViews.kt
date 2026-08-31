package com.laoji.nativeplatform.calendar

// CAL-DAY-PAGER-001, CAL-DAY-DRAG-001, CAL-TIME-PRECISION-001:
// rendering and gesture state have separate native owners.

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import android.widget.FrameLayout
import android.widget.OverScroller
import java.util.Calendar
import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor

private const val INVALID_VIRTUAL_VIEW_ID = Int.MIN_VALUE

private data class TimelineEventGeometry(
  val segment: DayEventSegment,
  val contentRect: CalendarRect,
)

private data class TimelineTouchHit(
  val kind: CalendarHitKind,
  val event: CalendarEvent? = null,
  val inTimeline: Boolean = false,
  val canCreate: Boolean = false,
)

// CAL-TIMEFORMAT-001: LaoJi Calendar has one product-level 24-hour clock. Its
// labels do not switch to 上午/下午 when the Android system uses a 12-hour clock.
internal class CalendarTimeFormatter {
  private val locale = Locale.SIMPLIFIED_CHINESE

  fun hourLine(hour: Int): String =
    DayTimeFormatter.formatHourLine(hour, true, locale = locale)

  fun minute(value: Int): String =
    DayTimeFormatter.formatMinute(value, true, locale = locale)

  fun range(startMinute: Int, endMinute: Int): String =
    DayTimeFormatter.formatRange(startMinute, endMinute, true, locale = locale)
}

internal interface DayTimelinePageListener {
  fun onTimelineEventOpened(binding: DayPageBinding, event: CalendarEvent)
  fun onTimelineCreateRequested(binding: DayPageBinding, draft: CalendarDraft)
  fun onTimelineDraftChanged(binding: DayPageBinding, draft: CalendarDraft?, reason: String)
  fun onTimelineMutationRequested(
    binding: DayPageBinding,
    kind: CalendarMutationKind,
    original: CalendarEvent,
    optimistic: CalendarEvent,
  ): Boolean
  fun onTimelineScrollChanged(binding: DayPageBinding, scrollOffset: Float)
}

internal class DayTimelinePageView(context: Context) : FrameLayout(context) {
  val timelineCanvas = DayTimelineCanvasView(context)
  val gestureLayer = DayTimelineGestureLayer(context)

  private var binding: DayPageBinding? = null
  private var listener: DayTimelinePageListener? = null

  init {
    clipChildren = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(
      timelineCanvas,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )
    addView(
      gestureLayer,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT),
    )
    gestureLayer.attachTimelineCanvas(timelineCanvas)
    gestureLayer.setPageListener(object : DayTimelinePageListener {
      override fun onTimelineEventOpened(binding: DayPageBinding, event: CalendarEvent) {
        if (accepts(binding)) listener?.onTimelineEventOpened(binding, event)
      }

      override fun onTimelineCreateRequested(binding: DayPageBinding, draft: CalendarDraft) {
        if (accepts(binding)) listener?.onTimelineCreateRequested(binding, draft)
      }

      override fun onTimelineDraftChanged(
        binding: DayPageBinding,
        draft: CalendarDraft?,
        reason: String,
      ) {
        if (accepts(binding)) listener?.onTimelineDraftChanged(binding, draft, reason)
      }

      override fun onTimelineMutationRequested(
        binding: DayPageBinding,
        kind: CalendarMutationKind,
        original: CalendarEvent,
        optimistic: CalendarEvent,
      ): Boolean = accepts(binding) &&
        listener?.onTimelineMutationRequested(binding, kind, original, optimistic) == true

      override fun onTimelineScrollChanged(binding: DayPageBinding, scrollOffset: Float) {
        if (accepts(binding)) listener?.onTimelineScrollChanged(binding, scrollOffset)
      }
    })
    timelineCanvas.setEventSemanticClickListener { callbackBinding, event ->
      if (accepts(callbackBinding)) {
        gestureLayer.selectEventFromAccessibility(event)
        listener?.onTimelineEventOpened(callbackBinding, event)
      }
    }
    timelineCanvas.setAccessibilityScrollListener { direction ->
      gestureLayer.performAccessibilityScroll(direction)
    }
  }

  fun setListener(listener: DayTimelinePageListener?) {
    this.listener = listener
  }

  fun bind(binding: DayPageBinding, snapshot: CalendarSnapshot?) {
    this.binding = binding
    timelineCanvas.bind(binding, snapshot)
    gestureLayer.bind(binding, snapshot)
  }

  fun setInteractive(value: Boolean) {
    importantForAccessibility = if (value) {
      IMPORTANT_FOR_ACCESSIBILITY_NO
    } else {
      IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }
    gestureLayer.setInteractive(value)
  }

  fun clearTransientState(reason: String, emitDraft: Boolean) {
    gestureLayer.clearTransientState(reason, emitDraft)
  }

  fun clearDraft(reason: String, emit: Boolean) {
    gestureLayer.clearDraft(reason, emit)
  }

  fun currentDraft(): CalendarDraft? = gestureLayer.currentDraft()

  fun setSynchronizedScrollOffset(value: Float) {
    gestureLayer.setSynchronizedScrollOffset(value)
  }

  fun currentScrollOffset(): Float = timelineCanvas.scrollOffset()

  fun centeredScrollOffset(minute: Int): Float =
    (CalendarGeometry.minuteToY(minute, timelineCanvas.topPadding(), timelineCanvas.hourHeight()) -
      timelineCanvas.height / 2f)
      .coerceIn(0f, timelineCanvas.maxScrollOffset(timelineCanvas.height))

  override fun dispatchHoverEvent(event: MotionEvent): Boolean =
    timelineCanvas.dispatchTimelineHoverEvent(event) || super.dispatchHoverEvent(event)

  private fun accepts(callbackBinding: DayPageBinding): Boolean = binding == callbackBinding
}

internal class DayTimelineCanvasView(context: Context) : FrameLayout(context) {
  private val palette = CalendarUi.palette(context)
  private val hourHeight = CalendarUi.dp(context, DayPagerContract.HOUR_HEIGHT_DP)
  private val rulerWidth = CalendarUi.dp(context, DayPagerContract.RULER_WIDTH_DP)
  private val timelinePaddingTop = CalendarUi.dp(context, DayPagerContract.TIMELINE_PADDING_TOP_DP)
  private val timelinePaddingRight = CalendarUi.dp(context, DayPagerContract.TIMELINE_PADDING_RIGHT_DP)
  private val timelineTotalHeight = CalendarUi.dp(context, DayPagerContract.TIMELINE_TOTAL_HEIGHT_DP)
  private val eventFallbackGap = CalendarUi.dp(context, 2f)
  private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.divider
    strokeWidth = maxOf(1f, CalendarUi.dp(context, 0.5f))
  }
  private val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.surface }
  private val eventPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.eventFill }
  private val eventBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.eventBorder
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, DayEventVisualContract.EVENT_BORDER_WIDTH_DP)
  }
  private val eventPressedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(
      (255f * DayEventVisualContract.PRESSED_OVERLAY_ALPHA).toInt(),
      Color.red(palette.eventPressedOverlay),
      Color.green(palette.eventPressedOverlay),
      Color.blue(palette.eventPressedOverlay),
    )
  }
  private val currentTimePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.destructive
    strokeWidth = CalendarUi.dp(context, 1f)
  }
  // CAL-RULER-001: DayTimeRulerView centers 12sp labels in the 56dp ruler
  // and uses text_placeholder rather than the regular secondary text token.
  private val timePaint = CalendarUi.textPaint(
    context,
    palette.textPlaceholder,
    DayRulerContract.TEXT_SIZE_SP,
  ).apply {
    textAlign = Paint.Align.CENTER
  }
  private val eventTitlePaint = CalendarUi.textPaint(
    context,
    palette.eventText,
    DayEventVisualContract.TITLE_TEXT_SIZE_SP,
  )
  private val eventTimePaint = CalendarUi.textPaint(
    context,
    palette.eventText,
    DayEventVisualContract.DESCRIPTION_TEXT_SIZE_SP,
  )
  private val timeFormatter = CalendarTimeFormatter()
  private val accessibilityManager =
    context.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
  private val virtualIdByIdentity = linkedMapOf<String, Int>()
  private val accessibilityProvider = TimelineAccessibilityProvider()
  private var nextVirtualId = 1
  private var accessibilityFocusedVirtualId = INVALID_VIRTUAL_VIEW_ID
  private var hoveredVirtualId = INVALID_VIRTUAL_VIEW_ID
  private var binding: DayPageBinding? = null
  private var snapshot: CalendarSnapshot? = null
  private var previewEvent: CalendarEvent? = null
  private var selectedEventIdentity: String? = null
  private var eventGeometry: List<TimelineEventGeometry> = emptyList()
  private var scrollOffset = 0f
  private var eventSemanticClickListener: ((DayPageBinding, CalendarEvent) -> Unit)? = null
  private var accessibilityScrollListener: ((Int) -> Boolean)? = null

  private val minuteTickRunnable = object : Runnable {
    override fun run() {
      invalidate()
      val delay = 60_000L - System.currentTimeMillis() % 60_000L
      postDelayed(this, delay)
    }
  }

  init {
    setWillNotDraw(false)
    setBackgroundColor(palette.surface)
    clipChildren = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    isFocusable = true
    contentDescription = "日程时间轴"
  }

  fun bind(binding: DayPageBinding, snapshot: CalendarSnapshot?) {
    val changedOwner = this.binding != binding
    this.binding = binding
    this.snapshot = snapshot
    previewEvent = null
    if (changedOwner || eventByIdentity(selectedEventIdentity) == null) selectedEventIdentity = null
    rebuildEventGeometry()
    invalidate()
  }

  fun setEventSemanticClickListener(listener: ((DayPageBinding, CalendarEvent) -> Unit)?) {
    eventSemanticClickListener = listener
  }

  fun setAccessibilityScrollListener(listener: ((Int) -> Boolean)?) {
    accessibilityScrollListener = listener
  }

  fun setPreviewEvent(event: CalendarEvent?) {
    previewEvent = event
    rebuildEventGeometry(notifyAccessibility = event == null)
    invalidate()
  }

  fun setSelectedEventIdentity(identity: String?) {
    selectedEventIdentity = identity?.takeIf { eventByIdentity(it) != null }
    invalidate()
  }

  fun selectedEvent(): CalendarEvent? = eventByIdentity(selectedEventIdentity)

  fun eventByIdentity(identity: String?): CalendarEvent? {
    if (identity == null) return null
    return displayEvents().firstOrNull { it.identity == identity }
  }

  fun eventAt(x: Float, y: Float): CalendarEvent? =
    eventGeometry.asReversed().firstOrNull { screenRect(it.contentRect).contains(x, y) }?.segment?.event

  fun selectedEventRect(): CalendarRect? {
    val identity = selectedEventIdentity ?: return null
    val geometry = eventGeometry.firstOrNull { it.segment.event.identity == identity } ?: return null
    return screenRect(geometry.contentRect)
  }

  fun rulerWidth(): Float = rulerWidth

  fun rightPadding(): Float = timelinePaddingRight

  fun topPadding(): Float = timelinePaddingTop

  fun hourHeight(): Float = hourHeight

  fun contentHeight(): Float = timelineTotalHeight

  fun minuteToScreenY(minute: Int): Float =
    CalendarGeometry.minuteToY(minute, timelinePaddingTop, hourHeight) - scrollOffset

  fun minuteAt(screenY: Float): Float =
    CalendarGeometry.yToMinute(screenY + scrollOffset, timelinePaddingTop, hourHeight)

  fun maxScrollOffset(viewportHeight: Int): Float =
    (contentHeight() - viewportHeight.coerceAtLeast(0)).coerceAtLeast(0f)

  fun setScrollOffset(value: Float) {
    val next = value.coerceIn(0f, maxScrollOffset(height))
    if (next == scrollOffset) return
    scrollOffset = next
    clearHiddenAccessibilityState()
    if (isAttachedToWindow && accessibilityManager.isEnabled) {
      sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
    }
    invalidate()
  }

  fun scrollOffset(): Float = scrollOffset

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    scrollOffset = scrollOffset.coerceIn(0f, maxScrollOffset(h))
    rebuildEventGeometry(notifyAccessibility = false)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), backgroundPaint)
    val save = canvas.save()
    canvas.clipRect(0f, 0f, width.toFloat(), height.toFloat())
    canvas.translate(0f, -scrollOffset)
    drawHourRuler(canvas)
    eventGeometry.forEach { drawEvent(canvas, it) }
    drawCurrentTime(canvas)
    canvas.restoreToCount(save)
  }

  private fun drawHourRuler(canvas: Canvas) {
    DayPagerContract.hourLines().forEach { hour ->
      val y = timelinePaddingTop + hour * hourHeight
      canvas.drawLine(rulerWidth, y, width - timelinePaddingRight, y, gridPaint)
      val label = timeFormatter.hourLine(hour)
      canvas.drawText(
        label,
        DayRulerContract.labelCenterX(rulerWidth),
        DayRulerContract.centeredBaseline(
          centerY = y,
          ascent = timePaint.fontMetrics.ascent,
          descent = timePaint.fontMetrics.descent,
        ),
        timePaint,
      )
    }
  }

  // CAL-DAY-COMPOSE-001: timed events are rendered from the geometry contract;
  // layout, text insets and pressed state stay in this native owner.
  private fun drawEvent(canvas: Canvas, geometry: TimelineEventGeometry) {
    val rect = geometry.contentRect
    val androidRect = RectF(rect.left, rect.top, rect.right, rect.bottom)
    val radius = CalendarUi.dp(
      context,
      CalendarUi.eventRadiusDp(context, DayEventVisualContract.EVENT_RADIUS_DP),
    )
    val visual = CalendarUi.eventVisual(context, geometry.segment.event.category)
    eventPaint.color = visual.fill
    eventBorderPaint.color = visual.border
    eventPressedPaint.color = visual.pressedOverlay
    eventTitlePaint.color = visual.text
    eventTimePaint.color = visual.text
    canvas.drawRoundRect(androidRect, radius, radius, eventPaint)
    if (geometry.segment.startsBeforeDay) {
      canvas.drawRect(rect.left, rect.top, rect.right, rect.top + CalendarUi.dp(context, 4f), eventPaint)
    }
    if (geometry.segment.continuesAfterDay) {
      canvas.drawRect(rect.left, rect.bottom - CalendarUi.dp(context, 4f), rect.right, rect.bottom, eventPaint)
    }
    if (selectedEventIdentity == geometry.segment.event.identity) {
      canvas.drawRoundRect(androidRect, radius, radius, eventPressedPaint)
    }
    val borderInset = eventBorderPaint.strokeWidth / 2f
    val borderRect = RectF(androidRect).apply { inset(borderInset, borderInset) }
    val borderRadius = (radius - borderInset).coerceAtLeast(0f)
    canvas.drawRoundRect(borderRect, borderRadius, borderRadius, eventBorderPaint)

    val textRect = CalendarRect(
      left = rect.left + CalendarUi.dp(context, DayEventVisualContract.TEXT_MARGIN_LEFT_DP),
      top = rect.top + CalendarUi.dp(context, DayEventVisualContract.TEXT_MARGIN_TOP_DP),
      right = rect.right - CalendarUi.dp(context, DayEventVisualContract.TEXT_MARGIN_RIGHT_DP),
      bottom = rect.bottom - CalendarUi.dp(context, DayEventVisualContract.TEXT_MARGIN_BOTTOM_DP),
    )
    if (textRect.width <= 0f || textRect.height <= 0f) return
    val title = CalendarUi.ellipsize(
      CalendarUi.listEventTitle(geometry.segment.event.title),
      eventTitlePaint,
      textRect.width,
    )
    val save = canvas.save()
    canvas.clipRect(textRect.left, textRect.top, textRect.right, textRect.bottom)
    val titleMetrics = eventTitlePaint.fontMetrics
    canvas.drawText(title, textRect.left, textRect.top - titleMetrics.top, eventTitlePaint)
    val titleLineHeight = titleMetrics.bottom - titleMetrics.top
    val descriptionMetrics = eventTimePaint.fontMetrics
    val descriptionTop = textRect.top + titleLineHeight +
      CalendarUi.dp(context, DayEventVisualContract.TEXT_VERTICAL_SPACE_DP)
    if (descriptionTop + (descriptionMetrics.bottom - descriptionMetrics.top) <= textRect.bottom) {
      val description = CalendarUi.ellipsize(
        formatTimeRange(geometry.segment.startMinute, geometry.segment.endMinute),
        eventTimePaint,
        textRect.width,
      )
      canvas.drawText(
        description,
        textRect.left,
        descriptionTop - descriptionMetrics.top,
        eventTimePaint,
      )
    }
    canvas.restoreToCount(save)
  }

  private fun drawCurrentTime(canvas: Canvas) {
    val activeBinding = binding ?: return
    if (snapshot?.todayEpochDay != activeBinding.epochDay) return
    val now = Calendar.getInstance()
    val minute = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
    val y = CalendarGeometry.minuteToY(minute, timelinePaddingTop, hourHeight)
    val dotRadius = CalendarUi.dp(context, DayEventVisualContract.CURRENT_TIME_DOT_RADIUS_DP)
    val dotCenterX = rulerWidth + dotRadius
    val lineStartX = dotCenterX + CalendarUi.dp(context, DayEventVisualContract.CURRENT_TIME_LINE_GAP_DP) + dotRadius
    canvas.drawLine(lineStartX, y, width - timelinePaddingRight, y, currentTimePaint)
    canvas.drawCircle(dotCenterX, y, dotRadius, currentTimePaint)
  }

  private fun rebuildEventGeometry(notifyAccessibility: Boolean = true) {
    val activeBinding = binding
    if (activeBinding == null || width <= 0) {
      eventGeometry = emptyList()
      syncVirtualEventIds(notifyAccessibility)
      return
    }
    val usableWidth = (width - rulerWidth - timelinePaddingRight).coerceAtLeast(1f)
    eventGeometry = CalendarGeometry.daySegments(displayEvents(), activeBinding.epochDay).map { segment ->
      val columnWidth = usableWidth / segment.columnCount.coerceAtLeast(1)
      val left = rulerWidth + segment.column * columnWidth
      val right = maxOf(
        left + 1f,
        rulerWidth + (segment.column + segment.columnSpan) * columnWidth - eventFallbackGap,
      )
      val naturalTop = CalendarGeometry.minuteToY(segment.startMinute, timelinePaddingTop, hourHeight)
      val naturalBottom = CalendarGeometry.minuteToY(segment.endMinute, timelinePaddingTop, hourHeight)
      val fallbackRect = CalendarRect(
        left = left,
        top = naturalTop,
        right = right,
        bottom = maxOf(naturalBottom, naturalTop + CalendarUi.dp(context, 20f)),
      )
      TimelineEventGeometry(
        segment = segment,
        contentRect = segment.instanceLayout?.let { layout ->
          DayEventVisualContract.instanceLayoutRect(
            layout = layout,
            eventAreaLeft = rulerWidth,
            eventAreaWidth = usableWidth,
            timelineTop = timelinePaddingTop,
            timelineHeight = timelineTotalHeight,
          ).takeIf { it.width > 0f && it.height > 0f }
        } ?: fallbackRect,
      )
    }
    syncVirtualEventIds(notifyAccessibility)
  }

  private fun syncVirtualEventIds(notifyAccessibility: Boolean) {
    val identities = eventGeometry.map { it.segment.event.identity }.toSet()
    virtualIdByIdentity.keys.toList().filterNot(identities::contains).forEach { identity ->
      val removedId = virtualIdByIdentity.remove(identity)
      if (removedId == accessibilityFocusedVirtualId) accessibilityFocusedVirtualId = INVALID_VIRTUAL_VIEW_ID
      if (removedId == hoveredVirtualId) hoveredVirtualId = INVALID_VIRTUAL_VIEW_ID
    }
    eventGeometry.forEach { geometry ->
      val identity = geometry.segment.event.identity
      virtualIdByIdentity.getOrPut(identity) { nextVirtualId++ }
    }
    if (notifyAccessibility && isAttachedToWindow && accessibilityManager.isEnabled) {
      sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
    }
  }

  private fun eventAccessibilityDescription(
    activeBinding: DayPageBinding?,
    geometry: TimelineEventGeometry,
  ): String {
    val date = activeBinding?.let { CalendarDateMath.fromEpochDay(it.epochDay) }
    val dateText = date?.let { "${it.year}年${it.month}月${it.day}日" }.orEmpty()
    val mutability = if (geometry.segment.event.canMutateInDayView()) "可调整" else "只读"
    return listOf(
      CalendarUi.listEventTitle(geometry.segment.event.title),
      dateText,
      formatTimeRange(geometry.segment.startMinute, geometry.segment.endMinute),
      mutability,
    ).filter(String::isNotBlank).joinToString("，")
  }

  private fun displayEvents(): List<CalendarEvent> {
    val events = snapshot?.events.orEmpty()
    val preview = previewEvent ?: return events
    return events.map { if (it.identity == preview.identity) preview else it }
  }

  private fun screenRect(contentRect: CalendarRect): CalendarRect = CalendarRect(
    contentRect.left,
    contentRect.top - scrollOffset,
    contentRect.right,
    contentRect.bottom - scrollOffset,
  )

  private fun clippedScreenRect(geometry: TimelineEventGeometry): CalendarRect? {
    val visible = Rect()
    if (!getLocalVisibleRect(visible)) return null
    val event = screenRect(geometry.contentRect)
    val clipped = CalendarRect(
      left = maxOf(event.left, visible.left.toFloat()),
      top = maxOf(event.top, visible.top.toFloat()),
      right = minOf(event.right, visible.right.toFloat()),
      bottom = minOf(event.bottom, visible.bottom.toFloat()),
    )
    return clipped.takeIf { it.right > it.left && it.bottom > it.top }
  }

  private fun visibleEventGeometry(): List<TimelineEventGeometry> =
    eventGeometry.filter { clippedScreenRect(it) != null }

  private fun clearHiddenAccessibilityState() {
    if (accessibilityFocusedVirtualId != INVALID_VIRTUAL_VIEW_ID &&
      geometryForVirtualId(accessibilityFocusedVirtualId, requireVisible = true) == null
    ) {
      accessibilityFocusedVirtualId = INVALID_VIRTUAL_VIEW_ID
    }
    if (hoveredVirtualId != INVALID_VIRTUAL_VIEW_ID &&
      geometryForVirtualId(hoveredVirtualId, requireVisible = true) == null
    ) {
      hoveredVirtualId = INVALID_VIRTUAL_VIEW_ID
    }
  }

  fun formatTimeRange(startMinute: Int, endMinute: Int): String =
    timeFormatter.range(startMinute, endMinute)

  fun dispatchTimelineHoverEvent(event: MotionEvent): Boolean = dispatchHoverEvent(event)

  override fun getAccessibilityNodeProvider(): AccessibilityNodeProvider = accessibilityProvider

  override fun dispatchHoverEvent(event: MotionEvent): Boolean {
    if (!accessibilityManager.isEnabled || !accessibilityManager.isTouchExplorationEnabled) {
      return super.dispatchHoverEvent(event)
    }
    val virtualId = accessibilityProvider.virtualViewAt(event.x, event.y)
    return when (event.actionMasked) {
      MotionEvent.ACTION_HOVER_ENTER,
      MotionEvent.ACTION_HOVER_MOVE -> {
        updateHoveredVirtualView(virtualId)
        virtualId != INVALID_VIRTUAL_VIEW_ID
      }
      MotionEvent.ACTION_HOVER_EXIT -> {
        val handled = hoveredVirtualId != INVALID_VIRTUAL_VIEW_ID
        updateHoveredVirtualView(INVALID_VIRTUAL_VIEW_ID)
        handled
      }
      else -> super.dispatchHoverEvent(event)
    }
  }

  private fun updateHoveredVirtualView(nextVirtualId: Int) {
    if (hoveredVirtualId == nextVirtualId) return
    val previous = hoveredVirtualId
    hoveredVirtualId = nextVirtualId
    if (previous != INVALID_VIRTUAL_VIEW_ID) {
      sendVirtualAccessibilityEvent(previous, AccessibilityEvent.TYPE_VIEW_HOVER_EXIT)
    }
    if (nextVirtualId != INVALID_VIRTUAL_VIEW_ID) {
      sendVirtualAccessibilityEvent(nextVirtualId, AccessibilityEvent.TYPE_VIEW_HOVER_ENTER)
    }
  }

  private fun sendVirtualAccessibilityEvent(virtualId: Int, eventType: Int) {
    if (!accessibilityManager.isEnabled) return
    val geometry = geometryForVirtualId(virtualId) ?: return
    val event = AccessibilityEvent.obtain(eventType).apply {
      packageName = context.packageName
      className = "android.widget.Button"
      text.add(CalendarUi.listEventTitle(geometry.segment.event.title))
      contentDescription = eventAccessibilityDescription(binding, geometry)
      isEnabled = this@DayTimelineCanvasView.isEnabled
      setSource(this@DayTimelineCanvasView, virtualId)
    }
    parent?.requestSendAccessibilityEvent(this, event)
  }

  private fun geometryForVirtualId(
    virtualId: Int,
    requireVisible: Boolean = true,
  ): TimelineEventGeometry? {
    val identity = virtualIdByIdentity.entries.firstOrNull { it.value == virtualId }?.key ?: return null
    val geometry = eventGeometry.firstOrNull { it.segment.event.identity == identity } ?: return null
    return geometry.takeIf { !requireVisible || clippedScreenRect(it) != null }
  }

  private inner class TimelineAccessibilityProvider : AccessibilityNodeProvider() {
    override fun createAccessibilityNodeInfo(virtualViewId: Int): AccessibilityNodeInfo? {
      if (virtualViewId == View.NO_ID) {
        return AccessibilityNodeInfo.obtain(this@DayTimelineCanvasView).apply {
          this@DayTimelineCanvasView.onInitializeAccessibilityNodeInfo(this)
          className = DayTimelineCanvasView::class.java.name
          isScrollable = maxScrollOffset(height) > 0f
          if (scrollOffset < maxScrollOffset(height)) {
            addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)
          }
          if (scrollOffset > 0f) {
            addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD)
          }
          visibleEventGeometry().forEach { geometry ->
            virtualIdByIdentity[geometry.segment.event.identity]?.let { id ->
              addChild(this@DayTimelineCanvasView, id)
            }
          }
        }
      }
      val geometry = geometryForVirtualId(virtualViewId) ?: return null
      val clippedBounds = clippedScreenRect(geometry) ?: return null
      val parentBounds = clippedBounds.toAndroidRect()
      val location = IntArray(2)
      getLocationOnScreen(location)
      val screenBounds = CalendarRect(
        left = location[0] + clippedBounds.left,
        top = location[1] + clippedBounds.top,
        right = location[0] + clippedBounds.right,
        bottom = location[1] + clippedBounds.bottom,
      ).toAndroidRect()
      return AccessibilityNodeInfo.obtain().apply {
        setSource(this@DayTimelineCanvasView, virtualViewId)
        setParent(this@DayTimelineCanvasView)
        packageName = context.packageName
        className = "android.widget.Button"
        text = CalendarUi.listEventTitle(geometry.segment.event.title)
        contentDescription = eventAccessibilityDescription(binding, geometry)
        setBoundsInParent(parentBounds)
        setBoundsInScreen(screenBounds)
        isClickable = true
        isFocusable = true
        isEnabled = this@DayTimelineCanvasView.isEnabled
        isVisibleToUser = true
        isSelected = geometry.segment.event.identity == selectedEventIdentity
        isAccessibilityFocused = virtualViewId == accessibilityFocusedVirtualId
        addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)
        if (isAccessibilityFocused) {
          addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLEAR_ACCESSIBILITY_FOCUS)
        } else {
          addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_ACCESSIBILITY_FOCUS)
        }
      }
    }

    override fun performAction(virtualViewId: Int, action: Int, arguments: Bundle?): Boolean {
      if (virtualViewId == View.NO_ID) {
        return when (action) {
          AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> accessibilityScrollListener?.invoke(1) == true
          AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> accessibilityScrollListener?.invoke(-1) == true
          else -> false
        }
      }
      val geometry = geometryForVirtualId(virtualViewId) ?: return false
      return when (action) {
        AccessibilityNodeInfo.ACTION_CLICK -> {
          val activeBinding = binding ?: return false
          selectedEventIdentity = geometry.segment.event.identity
          invalidate()
          eventSemanticClickListener?.invoke(activeBinding, geometry.segment.event)
          sendVirtualAccessibilityEvent(virtualViewId, AccessibilityEvent.TYPE_VIEW_CLICKED)
          true
        }
        AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS -> {
          if (accessibilityFocusedVirtualId == virtualViewId) return false
          val previous = accessibilityFocusedVirtualId
          accessibilityFocusedVirtualId = virtualViewId
          if (previous != INVALID_VIRTUAL_VIEW_ID) {
            sendVirtualAccessibilityEvent(previous, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED)
          }
          sendVirtualAccessibilityEvent(virtualViewId, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED)
          invalidate()
          true
        }
        AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS -> {
          if (accessibilityFocusedVirtualId != virtualViewId) return false
          accessibilityFocusedVirtualId = INVALID_VIRTUAL_VIEW_ID
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
        accessibilityFocusedVirtualId != INVALID_VIRTUAL_VIEW_ID
      ) {
        createAccessibilityNodeInfo(accessibilityFocusedVirtualId)
      } else {
        null
      }

    fun virtualViewAt(x: Float, y: Float): Int {
      val geometry = eventGeometry.asReversed().firstOrNull {
        clippedScreenRect(it)?.contains(x, y) == true
      } ?: return INVALID_VIRTUAL_VIEW_ID
      return virtualIdByIdentity[geometry.segment.event.identity] ?: INVALID_VIRTUAL_VIEW_ID
    }
  }

  private fun CalendarRect.toAndroidRect(): Rect = Rect(
    floor(left).toInt(),
    floor(top).toInt(),
    ceil(right).toInt(),
    ceil(bottom).toInt(),
  )

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    removeCallbacks(minuteTickRunnable)
    post(minuteTickRunnable)
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(minuteTickRunnable)
    super.onDetachedFromWindow()
  }
}

internal class DayTimelineGestureLayer(context: Context) : View(context) {
  private val palette = CalendarUi.palette(context)
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
  private val minimumFlingVelocity = ViewConfiguration.get(context).scaledMinimumFlingVelocity
  private val maximumFlingVelocity = ViewConfiguration.get(context).scaledMaximumFlingVelocity
  private val scroller = OverScroller(context)
  private val selectedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.accent }
  private val selectedSoftPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.accentSoft }
  private val draftStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.accent
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 1.5f)
    pathEffect = DashPathEffect(
      floatArrayOf(CalendarUi.dp(context, 5f), CalendarUi.dp(context, 3f)),
      0f,
    )
  }
  private val draftTitlePaint = CalendarUi.textPaint(context, palette.textPrimary, 11f, true)
  private val draftTimePaint = CalendarUi.textPaint(context, palette.textSecondary, 9f)
  private var timelineCanvas: DayTimelineCanvasView? = null
  private var pageListener: DayTimelinePageListener? = null
  private var binding: DayPageBinding? = null
  private var snapshot: CalendarSnapshot? = null
  private var interactive = false
  private var draft: CalendarDraft? = null
  private var previewEvent: CalendarEvent? = null
  private var gestureOriginalEvent: CalendarEvent? = null
  private var gestureOriginalDraft: CalendarDraft? = null
  private var gestureOwner = CalendarGestureOwner.PENDING_EMPTY
  private var gestureHit = TimelineTouchHit(CalendarHitKind.EMPTY)
  private var eventStartHandleRect: CalendarRect? = null
  private var eventEndHandleRect: CalendarRect? = null
  private var draftStartHandleRect: CalendarRect? = null
  private var draftEndHandleRect: CalendarRect? = null
  private var draftRect: CalendarRect? = null
  private var downX = 0f
  private var downY = 0f
  private var anchorMinute = 0f
  private var scrollAtDown = 0f
  private var moved = false
  private var longPressCreatedDraft = false
  private var didInitialScroll = false
  private var velocityTracker: VelocityTracker? = null

  private val longPressRunnable = Runnable {
    val activeBinding = binding ?: return@Runnable
    when (gestureOwner) {
      CalendarGestureOwner.PENDING_EVENT -> {
        val event = gestureHit.event ?: return@Runnable
        if (!event.canMutateInDayView()) return@Runnable
        gestureOwner = CalendarGestureOwner.EVENT_MOVE
        gestureOriginalEvent = event
        previewEvent = event
        timelineCanvas?.setSelectedEventIdentity(event.identity)
        timelineCanvas?.setPreviewEvent(event)
        parent?.requestDisallowInterceptTouchEvent(true)
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        invalidate()
      }
      CalendarGestureOwner.PENDING_EMPTY -> {
        if (!gestureHit.canCreate || binding != activeBinding) return@Runnable
        val created = DayPagerContract.createDraft(
          activeBinding.epochDay,
          anchorMinute,
          defaultDurationMinutes(),
        )
        draft = created
        gestureOriginalDraft = created
        gestureOwner = CalendarGestureOwner.DRAFT_RESIZE_END
        longPressCreatedDraft = true
        timelineCanvas?.setSelectedEventIdentity(null)
        parent?.requestDisallowInterceptTouchEvent(true)
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        invalidate()
      }
      else -> Unit
    }
  }

  init {
    setWillNotDraw(false)
    isClickable = true
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun attachTimelineCanvas(canvas: DayTimelineCanvasView) {
    timelineCanvas = canvas
  }

  fun setPageListener(listener: DayTimelinePageListener?) {
    pageListener = listener
  }

  fun bind(binding: DayPageBinding, snapshot: CalendarSnapshot?) {
    val changedOwner = this.binding != binding
    if (changedOwner) clearTransientState("page-rebound", emitDraft = false)
    this.binding = binding
    this.snapshot = snapshot
    if (timelineCanvas?.selectedEvent() == null) timelineCanvas?.setSelectedEventIdentity(null)
    invalidate()
  }

  fun setInteractive(value: Boolean) {
    if (interactive == value) return
    interactive = value
    if (!value) cancelActiveGesture(emitDraftChange = false, clearSelection = true)
  }

  fun currentDraft(): CalendarDraft? = draft

  fun clearDraft(reason: String = "cancelled", emit: Boolean = true) {
    if (draft == null) return
    draft = null
    gestureOriginalDraft = null
    longPressCreatedDraft = false
    if (emit) binding?.let { pageListener?.onTimelineDraftChanged(it, null, reason) }
    invalidate()
  }

  fun clearTransientState(reason: String, emitDraft: Boolean) {
    cancelActiveGesture(emitDraftChange = false, clearSelection = true)
    clearDraft(reason, emitDraft)
    previewEvent = null
    gestureOriginalEvent = null
    gestureOriginalDraft = null
    timelineCanvas?.setPreviewEvent(null)
    timelineCanvas?.setSelectedEventIdentity(null)
    eventStartHandleRect = null
    eventEndHandleRect = null
    invalidate()
  }

  fun selectEventFromAccessibility(event: CalendarEvent) {
    if (!interactive || timelineCanvas?.eventByIdentity(event.identity) == null) return
    clearDraft("event-selected", emit = true)
    timelineCanvas?.setSelectedEventIdentity(event.identity)
    invalidate()
  }

  fun setSynchronizedScrollOffset(value: Float) {
    setScrollOffset(value, notify = false)
  }

  fun performAccessibilityScroll(direction: Int): Boolean {
    if (!interactive || direction == 0) return false
    val canvas = timelineCanvas ?: return false
    val before = canvas.scrollOffset()
    val viewportStep = (height * 0.8f).coerceAtLeast(canvas.hourHeight())
    setScrollOffset(before + viewportStep * direction.coerceIn(-1, 1), notify = true)
    val changed = canvas.scrollOffset() != before
    if (changed) announceForAccessibility(if (direction > 0) "向后滚动时间轴" else "向前滚动时间轴")
    return changed
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    val canvas = timelineCanvas ?: return
    if (!didInitialScroll && h > 0) {
      didInitialScroll = true
      // Keep the first visible ruler label fully inside the viewport. Scrolling
      // to the line itself placed its centered 12sp glyph half above the clip.
      setScrollOffset(7f * canvas.hourHeight(), notify = false)
    } else {
      setScrollOffset(canvas.scrollOffset(), notify = false)
    }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    drawSelectedEventHandles(canvas)
    drawDraft(canvas)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (!interactive || binding == null || timelineCanvas == null) return false
    return when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> handleDown(event)
      MotionEvent.ACTION_MOVE -> handleMove(event)
      MotionEvent.ACTION_UP -> handleUp(event)
      MotionEvent.ACTION_CANCEL -> handleCancel()
      else -> true
    }
  }

  private fun handleDown(event: MotionEvent): Boolean {
    scroller.forceFinished(true)
    removeCallbacks(longPressRunnable)
    recycleVelocityTracker()
    velocityTracker = VelocityTracker.obtain().also { it.addMovement(event) }
    downX = event.x
    downY = event.y
    scrollAtDown = timelineCanvas?.scrollOffset() ?: 0f
    anchorMinute = timelineCanvas?.minuteAt(event.y) ?: 0f
    gestureHit = hitTest(event.x, event.y)
    gestureOwner = CalendarGestureMath.initialOwner(gestureHit.kind)
    gestureOriginalEvent = gestureHit.event
    gestureOriginalDraft = draft?.takeIf {
      gestureOwner in setOf(
        CalendarGestureOwner.DRAFT_MOVE,
        CalendarGestureOwner.DRAFT_RESIZE_START,
        CalendarGestureOwner.DRAFT_RESIZE_END,
      )
    }
    previewEvent = gestureHit.event?.takeIf {
      gestureOwner in setOf(
        CalendarGestureOwner.EVENT_RESIZE_START,
        CalendarGestureOwner.EVENT_RESIZE_END,
      )
    }
    previewEvent?.let { timelineCanvas?.setPreviewEvent(it) }
    moved = false
    longPressCreatedDraft = false
    if (
      (gestureOwner == CalendarGestureOwner.PENDING_EVENT &&
        gestureHit.event?.canMutateInDayView() == true) ||
      (gestureOwner == CalendarGestureOwner.PENDING_EMPTY && gestureHit.canCreate)
    ) {
      postDelayed(longPressRunnable, ViewConfiguration.getLongPressTimeout().toLong())
    }
    parent?.requestDisallowInterceptTouchEvent(
      gestureOwner !in setOf(CalendarGestureOwner.PENDING_EMPTY, CalendarGestureOwner.PENDING_EVENT),
    )
    isPressed = true
    return true
  }

  private fun handleMove(event: MotionEvent): Boolean {
    velocityTracker?.addMovement(event)
    val totalDx = event.x - downX
    val totalDy = event.y - downY
    if (gestureOwner in setOf(CalendarGestureOwner.PENDING_EMPTY, CalendarGestureOwner.PENDING_EVENT)) {
      val verticalIntent = abs(totalDy) > touchSlop && abs(totalDy) >= abs(totalDx)
      val horizontalIntent = abs(totalDx) > touchSlop && abs(totalDx) > abs(totalDy)
      if (verticalIntent && gestureHit.inTimeline) {
        gestureOwner = CalendarGestureOwner.SCROLL
        removeCallbacks(longPressRunnable)
        parent?.requestDisallowInterceptTouchEvent(true)
      } else if (horizontalIntent) {
        removeCallbacks(longPressRunnable)
        parent?.requestDisallowInterceptTouchEvent(false)
      }
    }

    when (gestureOwner) {
      CalendarGestureOwner.SCROLL -> {
        setScrollOffset(scrollAtDown - totalDy, notify = true)
        moved = true
      }
      CalendarGestureOwner.EVENT_MOVE,
      CalendarGestureOwner.EVENT_RESIZE_START,
      CalendarGestureOwner.EVENT_RESIZE_END -> updateEventPreview(event)
      CalendarGestureOwner.DRAFT_MOVE,
      CalendarGestureOwner.DRAFT_RESIZE_START,
      CalendarGestureOwner.DRAFT_RESIZE_END -> updateDraftPreview(event)
      else -> Unit
    }
    return true
  }

  private fun updateEventPreview(event: MotionEvent) {
    val activeBinding = binding ?: return
    val original = gestureOriginalEvent ?: return
    if (!original.canMutateInDayView()) return
    autoScroll(event.y)
    val kind = mutationKindForOwner(gestureOwner)
    val precision = CalendarGestureMath.precisionForGesture(
      kind,
      defaultDurationMinutes(),
    )
    val projected = CalendarGestureMath.projectEvent(
      event = original,
      kind = kind,
      anchorEpochDay = activeBinding.epochDay,
      anchorMinute = anchorMinute,
      currentEpochDay = activeBinding.epochDay,
      currentMinute = timelineCanvas?.minuteAt(event.y) ?: anchorMinute,
      precisionMinutes = precision,
      minimumDurationMinutes = DayPagerContract.minimumDuration(defaultDurationMinutes()),
    )
    previewEvent = projected
    timelineCanvas?.setPreviewEvent(projected)
    moved = moved || projected != original
    invalidate()
  }

  private fun updateDraftPreview(event: MotionEvent) {
    val activeBinding = binding ?: return
    val original = gestureOriginalDraft ?: return
    autoScroll(event.y)
    val kind = mutationKindForOwner(gestureOwner)
    val precision = CalendarGestureMath.precisionForGesture(
      kind,
      defaultDurationMinutes(),
    )
    val projected = CalendarGestureMath.projectDraft(
      draft = original,
      kind = kind,
      anchorEpochDay = activeBinding.epochDay,
      anchorMinute = anchorMinute,
      currentEpochDay = activeBinding.epochDay,
      currentMinute = timelineCanvas?.minuteAt(event.y) ?: anchorMinute,
      precisionMinutes = precision,
      minimumDurationMinutes = DayPagerContract.minimumDuration(defaultDurationMinutes()),
    )
    draft = projected
    moved = moved || projected != original
    invalidate()
  }

  private fun handleUp(event: MotionEvent): Boolean {
    val callbackBinding = binding
    velocityTracker?.addMovement(event)
    removeCallbacks(longPressRunnable)
    isPressed = false
    if (callbackBinding != null && callbackBinding == binding) {
      when (gestureOwner) {
        CalendarGestureOwner.PENDING_EMPTY -> handleEmptyTap(event, callbackBinding)
        CalendarGestureOwner.PENDING_EVENT -> gestureHit.event?.let { selected ->
          clearDraft("event-selected", emit = true)
          timelineCanvas?.setSelectedEventIdentity(selected.identity)
          pageListener?.onTimelineEventOpened(callbackBinding, selected)
          performClick()
        }
        CalendarGestureOwner.SCROLL -> finishScroll()
        CalendarGestureOwner.EVENT_MOVE,
        CalendarGestureOwner.EVENT_RESIZE_START,
        CalendarGestureOwner.EVENT_RESIZE_END -> finishEventMutation(callbackBinding)
        CalendarGestureOwner.DRAFT_MOVE,
        CalendarGestureOwner.DRAFT_RESIZE_START,
        CalendarGestureOwner.DRAFT_RESIZE_END -> finishDraftGesture(callbackBinding)
      }
    }
    recycleVelocityTracker()
    parent?.requestDisallowInterceptTouchEvent(false)
    previewEvent = null
    gestureOriginalEvent = null
    gestureOriginalDraft = null
    longPressCreatedDraft = false
    moved = false
    gestureOwner = CalendarGestureOwner.PENDING_EMPTY
    gestureHit = TimelineTouchHit(CalendarHitKind.EMPTY)
    timelineCanvas?.setPreviewEvent(null)
    invalidate()
    return true
  }

  private fun handleEmptyTap(event: MotionEvent, callbackBinding: DayPageBinding) {
    if (
      !gestureHit.canCreate ||
      abs(event.x - downX) > touchSlop ||
      abs(event.y - downY) > touchSlop
    ) return
    val created = DayPagerContract.createDraft(
      callbackBinding.epochDay,
      timelineCanvas?.minuteAt(event.y) ?: anchorMinute,
      defaultDurationMinutes(),
    )
    draft = created
    timelineCanvas?.setSelectedEventIdentity(null)
    pageListener?.onTimelineDraftChanged(callbackBinding, created, "created")
    val range = timelineCanvas?.formatTimeRange(created.startMinutes, created.endMinutes).orEmpty()
    announceForAccessibility("添加日程 $range")
    performClick()
  }

  private fun finishScroll() {
    val canvas = timelineCanvas ?: return
    velocityTracker?.computeCurrentVelocity(1000, maximumFlingVelocity.toFloat())
    val velocityY = velocityTracker?.yVelocity ?: 0f
    if (abs(velocityY) < minimumFlingVelocity) return
    scroller.fling(
      0,
      canvas.scrollOffset().toInt(),
      0,
      (-velocityY).toInt(),
      0,
      0,
      0,
      canvas.maxScrollOffset(height).toInt(),
    )
    postInvalidateOnAnimation()
  }

  private fun finishEventMutation(callbackBinding: DayPageBinding) {
    val original = gestureOriginalEvent ?: return
    val optimistic = previewEvent ?: original
    if (!original.canMutateInDayView() || !moved || optimistic == original) return
    val accepted = pageListener?.onTimelineMutationRequested(
      callbackBinding,
      mutationKindForOwner(gestureOwner),
      original,
      optimistic,
    ) == true
    if (!accepted) announceForAccessibility("日程修改未提交")
  }

  private fun finishDraftGesture(callbackBinding: DayPageBinding) {
    val activeDraft = draft ?: return
    when {
      longPressCreatedDraft -> pageListener?.onTimelineDraftChanged(
        callbackBinding,
        activeDraft,
        if (moved) "adjusted" else "created",
      )
      moved -> pageListener?.onTimelineDraftChanged(callbackBinding, activeDraft, "adjusted")
      else -> {
        pageListener?.onTimelineCreateRequested(callbackBinding, activeDraft)
        performClick()
      }
    }
  }

  private fun handleCancel(): Boolean {
    cancelActiveGesture(emitDraftChange = true, clearSelection = true)
    return true
  }

  private fun cancelActiveGesture(
    emitDraftChange: Boolean,
    clearSelection: Boolean = false,
  ) {
    val draftBeforeCancel = draft
    if (
      gestureOwner in setOf(
        CalendarGestureOwner.DRAFT_MOVE,
        CalendarGestureOwner.DRAFT_RESIZE_START,
        CalendarGestureOwner.DRAFT_RESIZE_END,
      )
    ) {
      draft = if (longPressCreatedDraft) null else gestureOriginalDraft
    }
    removeCallbacks(longPressRunnable)
    scroller.forceFinished(true)
    isPressed = false
    previewEvent = null
    gestureOriginalEvent = null
    gestureOriginalDraft = null
    longPressCreatedDraft = false
    moved = false
    gestureOwner = CalendarGestureOwner.PENDING_EMPTY
    gestureHit = TimelineTouchHit(CalendarHitKind.EMPTY)
    recycleVelocityTracker()
    parent?.requestDisallowInterceptTouchEvent(false)
    timelineCanvas?.setPreviewEvent(null)
    if (clearSelection || draftBeforeCancel != null && draft == null) {
      timelineCanvas?.setSelectedEventIdentity(null)
    }
    if (emitDraftChange && draftBeforeCancel != draft) {
      binding?.let { pageListener?.onTimelineDraftChanged(it, draft, "gesture-cancelled") }
    }
    invalidate()
  }

  override fun computeScroll() {
    if (scroller.computeScrollOffset()) {
      setScrollOffset(scroller.currY.toFloat(), notify = true)
      postInvalidateOnAnimation()
    }
  }

  override fun performClick(): Boolean = super.performClick()

  private fun hitTest(x: Float, y: Float): TimelineTouchHit {
    val canvas = timelineCanvas ?: return TimelineTouchHit(CalendarHitKind.EMPTY)
    draftStartHandleRect?.takeIf { it.contains(x, y) }?.let {
      return TimelineTouchHit(CalendarHitKind.DRAFT_START_HANDLE, inTimeline = true)
    }
    draftEndHandleRect?.takeIf { it.contains(x, y) }?.let {
      return TimelineTouchHit(CalendarHitKind.DRAFT_END_HANDLE, inTimeline = true)
    }
    eventStartHandleRect?.takeIf { it.contains(x, y) }?.let {
      return TimelineTouchHit(
        CalendarHitKind.EVENT_START_HANDLE,
        canvas.selectedEvent(),
        inTimeline = true,
      )
    }
    eventEndHandleRect?.takeIf { it.contains(x, y) }?.let {
      return TimelineTouchHit(
        CalendarHitKind.EVENT_END_HANDLE,
        canvas.selectedEvent(),
        inTimeline = true,
      )
    }
    draftRect?.takeIf { it.contains(x, y) }?.let {
      return TimelineTouchHit(CalendarHitKind.DRAFT, inTimeline = true)
    }
    canvas.eventAt(x, y)?.let {
      return TimelineTouchHit(CalendarHitKind.EVENT, it, inTimeline = true)
    }
    val inTimeline = y in 0f..height.toFloat()
    return TimelineTouchHit(
      kind = CalendarHitKind.EMPTY,
      inTimeline = inTimeline,
      canCreate = inTimeline && x >= canvas.rulerWidth(),
    )
  }

  private fun drawSelectedEventHandles(canvas: Canvas) {
    eventStartHandleRect = null
    eventEndHandleRect = null
    val timeline = timelineCanvas ?: return
    val selected = timeline.selectedEvent() ?: return
    val rect = timeline.selectedEventRect() ?: return
    if (!selected.canMutateInDayView()) return
    val radius = CalendarUi.dp(context, 6f)
    canvas.drawCircle(rect.left + radius, rect.top, radius, selectedPaint)
    canvas.drawCircle(rect.right - radius, rect.bottom, radius, selectedPaint)
    eventStartHandleRect = CalendarRect(
      rect.left - radius,
      rect.top - radius,
      rect.left + radius * 3f,
      rect.top + radius,
    )
    eventEndHandleRect = CalendarRect(
      rect.right - radius * 3f,
      rect.bottom - radius,
      rect.right + radius,
      rect.bottom + radius,
    )
  }

  private fun drawDraft(canvas: Canvas) {
    draftStartHandleRect = null
    draftEndHandleRect = null
    draftRect = null
    val activeBinding = binding ?: return
    val activeDraft = draft ?: return
    val timeline = timelineCanvas ?: return
    val dayStart = CalendarDateMath.absoluteMinute(activeBinding.epochDay, 0)
    val dayEnd = CalendarDateMath.absoluteMinute(
      activeBinding.epochDay,
      CalendarDateMath.MINUTES_PER_DAY,
    )
    val visibleStart = maxOf(activeDraft.startAbsoluteMinute(), dayStart)
    val visibleEnd = minOf(activeDraft.endAbsoluteMinute(), dayEnd)
    if (visibleStart >= visibleEnd) return
    val startMinute = (visibleStart - dayStart).toInt()
    val endMinute = (visibleEnd - dayStart).toInt()
    val left = timeline.rulerWidth()
    val right = width - timeline.rightPadding()
    val top = timeline.minuteToScreenY(startMinute)
    val bottom = maxOf(
      timeline.minuteToScreenY(endMinute),
      top + CalendarUi.dp(context, 28f),
    )
    val rect = CalendarRect(left, top, right, bottom)
    val androidRect = RectF(rect.left, rect.top, rect.right, rect.bottom)
    canvas.drawRoundRect(
      androidRect,
      CalendarUi.dp(context, 4f),
      CalendarUi.dp(context, 4f),
      selectedSoftPaint,
    )
    canvas.drawRoundRect(
      androidRect,
      CalendarUi.dp(context, 4f),
      CalendarUi.dp(context, 4f),
      draftStrokePaint,
    )
    canvas.drawText(
      "添加日程",
      rect.left + CalendarUi.dp(context, 6f),
      rect.top + CalendarUi.dp(context, 14f),
      draftTitlePaint,
    )
    if (rect.height >= CalendarUi.dp(context, 37f)) {
      canvas.drawText(
        timeline.formatTimeRange(startMinute, endMinute),
        rect.left + CalendarUi.dp(context, 6f),
        rect.top + CalendarUi.dp(context, 28f),
        draftTimePaint,
      )
    }
    val radius = CalendarUi.dp(context, 6f)
    canvas.drawCircle(rect.left + radius, rect.top, radius, selectedPaint)
    canvas.drawCircle(rect.right - radius, rect.bottom, radius, selectedPaint)
    draftRect = rect
    draftStartHandleRect = CalendarRect(
      rect.left - radius,
      rect.top - radius,
      rect.left + radius * 3f,
      rect.top + radius,
    )
    draftEndHandleRect = CalendarRect(
      rect.right - radius * 3f,
      rect.bottom - radius,
      rect.right + radius,
      rect.bottom + radius,
    )
  }

  private fun mutationKindForOwner(owner: CalendarGestureOwner): CalendarMutationKind = when (owner) {
    CalendarGestureOwner.EVENT_RESIZE_START,
    CalendarGestureOwner.DRAFT_RESIZE_START -> CalendarMutationKind.RESIZE_START
    CalendarGestureOwner.EVENT_RESIZE_END,
    CalendarGestureOwner.DRAFT_RESIZE_END -> CalendarMutationKind.RESIZE_END
    else -> CalendarMutationKind.MOVE
  }

  private fun defaultDurationMinutes(): Int =
    snapshot?.settings?.defaultEventDurationMinutes ?: DayPagerContract.DEFAULT_CREATION_DURATION_MINUTES

  private fun autoScroll(screenY: Float) {
    val edge = CalendarUi.dp(context, 36f)
    val amount = CalendarUi.dp(context, 10f)
    val current = timelineCanvas?.scrollOffset() ?: return
    val next = when {
      screenY < edge -> current - amount
      screenY > height - edge -> current + amount
      else -> current
    }
    setScrollOffset(next, notify = true)
  }

  private fun setScrollOffset(value: Float, notify: Boolean) {
    val activeBinding = binding
    val canvas = timelineCanvas ?: return
    val before = canvas.scrollOffset()
    canvas.setScrollOffset(value)
    if (canvas.scrollOffset() == before) return
    invalidate()
    if (notify && activeBinding != null) {
      pageListener?.onTimelineScrollChanged(activeBinding, canvas.scrollOffset())
    }
  }

  private fun recycleVelocityTracker() {
    velocityTracker?.recycle()
    velocityTracker = null
  }

  override fun onDetachedFromWindow() {
    cancelActiveGesture(emitDraftChange = false, clearSelection = true)
    clearDraft("detached", emit = true)
    super.onDetachedFromWindow()
  }
}
