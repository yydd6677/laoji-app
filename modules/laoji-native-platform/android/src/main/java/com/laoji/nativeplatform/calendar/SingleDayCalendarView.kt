package com.laoji.nativeplatform.calendar

// UI-SHELL-RESELECT-001, CAL-DAY-PAGER-001, CAL-DAY-DRAG-001, CAL-TIME-PRECISION-001:
// the single-day surface composes independent header, all-day, pager, canvas, and gesture owners.

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import java.util.Calendar
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

internal class AssociatedDayPagerTouchRouter(context: Context) {
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
  private var downEvent: MotionEvent? = null
  private var downX = 0f
  private var downY = 0f
  private var forwarding = false
  private var rejected = false

  fun route(
    event: MotionEvent,
    pagerDispatch: ((MotionEvent) -> Boolean)?,
    localDispatch: (MotionEvent) -> Boolean,
  ): Boolean {
    if (pagerDispatch == null) return localDispatch(event)
    return when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        reset()
        downX = event.x
        downY = event.y
        downEvent = MotionEvent.obtain(event)
        localDispatch(event)
        true
      }
      MotionEvent.ACTION_MOVE -> {
        if (!forwarding && !rejected) {
          val deltaX = event.x - downX
          val deltaY = event.y - downY
          if (abs(deltaX) > touchSlop && abs(deltaX) > abs(deltaY)) {
            if (downEvent?.let(pagerDispatch) == true) {
              forwarding = true
              dispatchWithAction(event, MotionEvent.ACTION_CANCEL, localDispatch)
            } else {
              rejected = true
            }
          } else if (abs(deltaY) > touchSlop && abs(deltaY) >= abs(deltaX)) {
            rejected = true
          }
        }
        if (forwarding) {
          pagerDispatch(event)
          true
        } else {
          localDispatch(event)
        }
      }
      MotionEvent.ACTION_UP -> {
        val handled = if (forwarding) {
          pagerDispatch(event)
          true
        } else {
          localDispatch(event)
        }
        reset()
        handled
      }
      MotionEvent.ACTION_CANCEL -> {
        val handled = if (forwarding) pagerDispatch(event) else localDispatch(event)
        reset()
        handled
      }
      else -> if (forwarding) pagerDispatch(event) else localDispatch(event)
    }
  }

  fun cancel(pagerDispatch: ((MotionEvent) -> Boolean)?) {
    val source = downEvent ?: return reset()
    if (forwarding && pagerDispatch != null) {
      dispatchWithAction(source, MotionEvent.ACTION_CANCEL, pagerDispatch)
    }
    reset()
  }

  private fun reset() {
    downEvent?.recycle()
    downEvent = null
    forwarding = false
    rejected = false
  }

  private fun dispatchWithAction(
    source: MotionEvent,
    action: Int,
    dispatch: (MotionEvent) -> Boolean,
  ): Boolean {
    val copy = MotionEvent.obtain(source).apply { this.action = action }
    return try {
      dispatch(copy)
    } finally {
      copy.recycle()
    }
  }
}

class DayWeekHeaderView(context: Context) : FrameLayout(context) {
  private val palette = CalendarUi.palette(context)
  private val touchRouter = AssociatedDayPagerTouchRouter(context)
  private val track = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
  private val trackViewport = FrameLayout(context).apply {
    clipChildren = true
    clipToPadding = true
    addView(track)
  }
  private val pages = Array(DayPagerContract.PAGE_COUNT) { DayWeekHeaderPage(context) }
  private var selectedEpochDay = currentEpochDay()
  private var todayEpochDay: Int? = null
  private var positionProgress = 0f
  private var dateSelectedListener: ((Int) -> Unit)? = null
  private var associatedPagerDispatcher: ((MotionEvent) -> Boolean)? = null

  init {
    setBackgroundColor(palette.surface)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    clipChildren = true
    pages.forEach { page ->
      page.setOnDateSelectedListener { dateSelectedListener?.invoke(it) }
      track.addView(page)
    }
    addView(trackViewport, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    bind(selectedEpochDay, null)
  }

  fun setOnDateSelectedListener(listener: ((Int) -> Unit)?) {
    dateSelectedListener = listener
  }

  fun setAssociatedPagerDispatcher(dispatcher: ((MotionEvent) -> Boolean)?) {
    associatedPagerDispatcher = dispatcher
  }

  fun bind(selectedEpochDay: Int, todayEpochDay: Int?, initialProgress: Float = 0f) {
    this.selectedEpochDay = selectedEpochDay
    this.todayEpochDay = todayEpochDay
    pages.forEachIndexed { position, page ->
      page.bind(
        selectedEpochDay = DayPagerContract.epochDayForPosition(selectedEpochDay, position),
        todayEpochDay = todayEpochDay,
      )
    }
    setPositionProgress(initialProgress)
  }

  fun setPositionProgress(value: Float) {
    positionProgress = value.coerceIn(-1f, 1f)
    updateTrackPosition()
  }

  internal fun currentPositionProgress(): Float = positionProgress

  override fun dispatchTouchEvent(event: MotionEvent): Boolean =
    touchRouter.route(event, associatedPagerDispatcher) { super.dispatchTouchEvent(it) }

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
    super.onDetachedFromWindow()
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
        IMPORTANT_FOR_ACCESSIBILITY_YES
      } else {
        IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      }
    }
  }

  private class DayWeekHeaderPage(context: Context) : LinearLayout(context) {
    private val cells = List(7) { DayWeekHeaderCell(context) }
    private var dateSelectedListener: ((Int) -> Unit)? = null

    init {
      orientation = HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
      cells.forEach { cell ->
        addView(cell, LayoutParams(0, LayoutParams.MATCH_PARENT, 1f))
        cell.setOnClickListener { dateSelectedListener?.invoke(cell.epochDay) }
      }
    }

    fun setOnDateSelectedListener(listener: ((Int) -> Unit)?) {
      dateSelectedListener = listener
    }

    fun bind(selectedEpochDay: Int, todayEpochDay: Int?) {
      val weekStart = CalendarDateMath.startOfWeekSunday(selectedEpochDay)
      val weekdayLabels = CalendarUi.weekdayLabels()
      cells.forEachIndexed { index, cell ->
        val epochDay = weekStart + index
        cell.bind(
          epochDay = epochDay,
          weekdayLabel = weekdayLabels[index],
          selected = epochDay == selectedEpochDay,
          today = epochDay == todayEpochDay,
        )
      }
    }
  }

  private class DayWeekHeaderCell(context: Context) : LinearLayout(context) {
    private val palette = CalendarUi.palette(context)
    private val weekdayView = TextView(context).apply {
      gravity = Gravity.CENTER
      includeFontPadding = false
      textSize = 12f
      setTextColor(palette.textSecondary)
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val dayView = TextView(context).apply {
      gravity = Gravity.CENTER
      includeFontPadding = false
      textSize = 16f
      setTypeface(Typeface.DEFAULT, Typeface.BOLD)
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    var epochDay: Int = 0
      private set

    init {
      orientation = VERTICAL
      gravity = Gravity.CENTER
      isClickable = true
      isFocusable = true
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
      background = ColorDrawable(Color.TRANSPARENT)
      addView(
        weekdayView,
        LayoutParams(LayoutParams.MATCH_PARENT, CalendarUi.dp(context, 18f).toInt()),
      )
      addView(
        dayView,
        LayoutParams(CalendarUi.dp(context, 32f).toInt(), CalendarUi.dp(context, 32f).toInt()),
      )
    }

    fun bind(epochDay: Int, weekdayLabel: String, selected: Boolean, today: Boolean) {
      this.epochDay = epochDay
      val date = CalendarDateMath.fromEpochDay(epochDay)
      weekdayView.text = weekdayLabel
      dayView.text = date.day.toString()
      val marker = MonthExpandedLayoutContract.dateMarker(
        epochDay = epochDay,
        selectedEpochDay = epochDay.takeIf { selected },
        todayEpochDay = epochDay.takeIf { today },
      )
      dayView.setTextColor(
        when (marker) {
          MonthDateMarker.TODAY -> if (selected) palette.accentText else palette.accent
          MonthDateMarker.SELECTED -> palette.textPrimary
          MonthDateMarker.NONE -> palette.textPrimary
        },
      )
      dayView.background = when (marker) {
        MonthDateMarker.TODAY -> if (selected) {
          CalendarUi.background(palette.accent, 16f, context)
        } else {
          ColorDrawable(Color.TRANSPARENT)
        }
        MonthDateMarker.SELECTED -> CalendarUi.background(palette.selectionMarker, 16f, context)
        MonthDateMarker.NONE -> ColorDrawable(Color.TRANSPARENT)
      }
      isSelected = selected
      contentDescription = buildString {
        append(String.format(Locale.getDefault(), "%d年%d月%d日，%s", date.year, date.month, date.day, weekdayLabel))
        if (today) append("，今天")
        if (selected) append("，已选择")
      }
    }
  }
}

interface ThreePageDayPagerListener {
  fun onPagerPositionProgress(binding: DayPageBinding, positionProgress: Float)
  fun onPagerDaySettled(binding: DayPageBinding, nextEpochDay: Int)
  fun onPagerEventOpened(binding: DayPageBinding, event: CalendarEvent)
  fun onPagerCreateRequested(binding: DayPageBinding, draft: CalendarDraft)
  fun onPagerDraftChanged(binding: DayPageBinding, draft: CalendarDraft?, reason: String)
  fun onPagerMutationRequested(
    binding: DayPageBinding,
    kind: CalendarMutationKind,
    original: CalendarEvent,
    optimistic: CalendarEvent,
  ): Boolean
}

class ThreePageDayPager(context: Context) : FrameLayout(context), DayTimelinePageListener {
  private val pager = ViewPager2(context)
  private val pages = Array(DayPagerContract.PAGE_COUNT) { DayTimelinePageView(context) }
  private val pageAdapter = FixedDayPageAdapter()
  private var snapshot: CalendarSnapshot? = null
  private var centerEpochDay = currentEpochDay()
  private var sessionId = 0L
  private var sharedScrollOffset: Float? = null
  private var externalListener: ThreePageDayPagerListener? = null
  private var hasBinding = false
  private var recentering = false
  private var motionToken = 0L
  private var positionProgress = 0f
  private var progressDispatchCount = 0
  private var associatedDragActive = false
  private var associatedDragLastX = 0f
  private var verticalScrollAnimator: ValueAnimator? = null
  private var programmaticDayMotionActive = false

  private val pageCallback = object : ViewPager2.OnPageChangeCallback() {
    override fun onPageScrolled(position: Int, positionOffset: Float, positionOffsetPixels: Int) {
      if (!hasBinding) return
      val progress = DayPagerContract.positionProgress(position, positionOffset)
      positionProgress = progress
      progressDispatchCount += 1
      externalListener?.onPagerPositionProgress(centerBinding(), progress)
    }

    override fun onPageScrollStateChanged(state: Int) {
      if (state != ViewPager2.SCROLL_STATE_IDLE || !hasBinding) return
      if (recentering) {
        if (!pager.isUserInputEnabled && pager.currentItem == DayPagerContract.CENTER_PAGE) {
          finishProgrammaticAnimation(motionToken)
        }
        return
      }
      val position = pager.currentItem
      val settlement = DayPagerContract.settle(centerEpochDay, position)
      if (settlement.dayDelta == 0) return
      val callbackBinding = centerBinding()
      externalListener?.onPagerDaySettled(callbackBinding, settlement.nextCenterEpochDay)
      if (centerEpochDay != settlement.nextCenterEpochDay) {
        centerEpochDay = settlement.nextCenterEpochDay
        bindAllPages()
        pageAdapter.notifyDataSetChanged()
        recenterWithoutAnimation()
      }
    }
  }

  init {
    pages.forEach { page -> page.setListener(this) }
    pager.apply {
      orientation = ViewPager2.ORIENTATION_HORIZONTAL
      offscreenPageLimit = DayPagerContract.PAGE_COUNT - 1
      adapter = pageAdapter
      isSaveEnabled = false
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
      registerOnPageChangeCallback(pageCallback)
    }
    addView(pager, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    (pager.getChildAt(0) as? RecyclerView)?.apply {
      setItemViewCacheSize(DayPagerContract.PAGE_COUNT)
      overScrollMode = OVER_SCROLL_NEVER
      itemAnimator = null
    }
    clipChildren = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    recenterWithoutAnimation()
  }

  fun setListener(listener: ThreePageDayPagerListener?) {
    externalListener = listener
  }

  fun dispatchAssociatedTouchEvent(event: MotionEvent): Boolean {
    if (!hasBinding || !pager.isUserInputEnabled || pager.width <= 0 || pager.height <= 0) return false
    return when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (recentering || associatedDragActive || pager.isFakeDragging ||
          pager.scrollState != ViewPager2.SCROLL_STATE_IDLE
        ) {
          return false
        }
        associatedDragLastX = event.x
        associatedDragActive = runCatching { pager.beginFakeDrag() }.getOrDefault(false)
        associatedDragActive
      }
      MotionEvent.ACTION_MOVE -> {
        if (!associatedDragActive || !pager.isFakeDragging) return false
        val deltaX = event.x - associatedDragLastX
        associatedDragLastX = event.x
        runCatching { pager.fakeDragBy(deltaX) }.getOrElse {
          associatedDragActive = false
          false
        }
      }
      MotionEvent.ACTION_UP,
      MotionEvent.ACTION_CANCEL -> {
        val handled = associatedDragActive
        if (pager.isFakeDragging) runCatching { pager.endFakeDrag() }
        associatedDragActive = false
        handled
      }
      else -> associatedDragActive
    }
  }

  fun bind(
    snapshot: CalendarSnapshot?,
    centerEpochDay: Int,
    sessionId: Long,
    animateFromPreviousDay: Boolean,
    preserveReturnMotion: Boolean = false,
  ) {
    if (preserveReturnMotion && hasBinding && centerEpochDay == this.centerEpochDay) {
      this.snapshot = snapshot
      this.sessionId = sessionId
      bindAllPages()
      pageAdapter.notifyDataSetChanged()
      return
    }
    val previousCenter = this.centerEpochDay
    val canAnimate = hasBinding &&
      snapshot != null &&
      animateFromPreviousDay &&
      DayPagerContract.shouldAnimateProgrammaticSwitch(previousCenter, centerEpochDay)
    val motion = prepareForPagerMutation()
    this.snapshot = snapshot
    this.centerEpochDay = centerEpochDay
    this.sessionId = sessionId
    hasBinding = true
    bindAllPages()
    pageAdapter.notifyDataSetChanged()
    if (canAnimate) {
      animateFromPreviousCenter(previousCenter, centerEpochDay, motion)
    } else {
      recenterWithoutAnimation(motion)
    }
  }

  fun clearDraft(reason: String = "cancelled", emit: Boolean = true) {
    pages[DayPagerContract.CENTER_PAGE].clearDraft(reason, emit)
  }

  fun clearTransientState(reason: String, emitDraft: Boolean) {
    pages.forEachIndexed { index, page ->
      page.clearTransientState(reason, emitDraft && index == DayPagerContract.CENTER_PAGE)
    }
  }

  fun scrollToMinuteCentered(minute: Int, animate: Boolean = true) {
    val centerPage = pages[DayPagerContract.CENTER_PAGE]
    val target = centerPage.centeredScrollOffset(minute)
    verticalScrollAnimator?.cancel()
    verticalScrollAnimator = null
    val start = sharedScrollOffset ?: centerPage.currentScrollOffset()
    if (!animate || !isLaidOut || start == target) {
      applySynchronizedScrollOffset(target)
      return
    }
    verticalScrollAnimator = ValueAnimator.ofFloat(start, target).apply {
      duration = DayPagerContract.PROGRAMMATIC_VERTICAL_SCROLL_DURATION_MS
      interpolator = DecelerateInterpolator()
      addUpdateListener { applySynchronizedScrollOffset(it.animatedValue as Float) }
      start()
    }
  }

  internal fun currentMinuteScreenY(minute: Int): Float =
    pages[DayPagerContract.CENTER_PAGE].timelineCanvas.minuteToScreenY(minute)

  internal fun currentTimelineViewportHeight(): Int =
    pages[DayPagerContract.CENTER_PAGE].timelineCanvas.height

  fun currentDraft(): CalendarDraft? = pages[DayPagerContract.CENTER_PAGE].currentDraft()

  fun currentCenterEpochDay(): Int = centerEpochDay

  internal fun currentPositionProgress(): Float = positionProgress

  internal fun positionProgressDispatchCount(): Int = progressDispatchCount

  internal fun hasActiveReturnMotion(): Boolean =
    programmaticDayMotionActive || verticalScrollAnimator?.isRunning == true

  override fun onTimelineEventOpened(binding: DayPageBinding, event: CalendarEvent) {
    if (acceptsCenter(binding)) externalListener?.onPagerEventOpened(binding, event)
  }

  override fun onTimelineCreateRequested(binding: DayPageBinding, draft: CalendarDraft) {
    if (acceptsCenter(binding)) externalListener?.onPagerCreateRequested(binding, draft)
  }

  override fun onTimelineDraftChanged(
    binding: DayPageBinding,
    draft: CalendarDraft?,
    reason: String,
  ) {
    if (acceptsCenter(binding)) externalListener?.onPagerDraftChanged(binding, draft, reason)
  }

  override fun onTimelineMutationRequested(
    binding: DayPageBinding,
    kind: CalendarMutationKind,
    original: CalendarEvent,
    optimistic: CalendarEvent,
  ): Boolean = acceptsCenter(binding) &&
    externalListener?.onPagerMutationRequested(binding, kind, original, optimistic) == true

  override fun onTimelineScrollChanged(binding: DayPageBinding, scrollOffset: Float) {
    if (!acceptsCenter(binding)) return
    verticalScrollAnimator?.cancel()
    verticalScrollAnimator = null
    applySynchronizedScrollOffset(scrollOffset)
  }

  override fun onDetachedFromWindow() {
    val motion = prepareForPagerMutation()
    setCurrentItemAfterFakeDrag(DayPagerContract.CENTER_PAGE)
    pager.isUserInputEnabled = snapshot != null
    if (motion == motionToken) recentering = false
    super.onDetachedFromWindow()
  }

  private fun bindAllPages() {
    pages.forEachIndexed { position, page ->
      page.bind(
        DayPageBinding(
          sessionId = sessionId,
          epochDay = DayPagerContract.epochDayForPosition(centerEpochDay, position),
        ),
        snapshot,
      )
      page.setInteractive(position == DayPagerContract.CENTER_PAGE && snapshot != null)
      sharedScrollOffset?.let(page::setSynchronizedScrollOffset)
    }
  }

  private fun bindPage(position: Int) {
    val page = pages[position]
    page.bind(
      DayPageBinding(
        sessionId = sessionId,
        epochDay = DayPagerContract.epochDayForPosition(centerEpochDay, position),
      ),
      snapshot,
    )
    page.setInteractive(position == DayPagerContract.CENTER_PAGE && snapshot != null)
    sharedScrollOffset?.let(page::setSynchronizedScrollOffset)
  }

  private fun centerBinding(): DayPageBinding = DayPageBinding(sessionId, centerEpochDay)

  private fun acceptsCenter(binding: DayPageBinding): Boolean = centerBinding() == binding

  private fun recenterWithoutAnimation(token: Long = prepareForPagerMutation()) {
    pager.isUserInputEnabled = snapshot != null
    setCurrentItemAfterFakeDrag(DayPagerContract.CENTER_PAGE)
    positionProgress = 0f
    pager.post {
      if (token == motionToken) recentering = false
    }
  }

  private fun animateFromPreviousCenter(
    previousEpochDay: Int,
    nextEpochDay: Int,
    token: Long = prepareForPagerMutation(),
  ) {
    val startPosition = DayPagerContract.programmaticStartPosition(previousEpochDay, nextEpochDay)
    if (startPosition == DayPagerContract.CENTER_PAGE) {
      recenterWithoutAnimation(token)
      return
    }
    programmaticDayMotionActive = true
    positionProgress = (startPosition - DayPagerContract.CENTER_PAGE).toFloat()
    pager.isUserInputEnabled = false
    setCurrentItemAfterFakeDrag(startPosition)
    pager.post {
      if (token != motionToken) return@post
      val recyclerView = pager.getChildAt(0) as? RecyclerView
      val pageWidth = pager.width
      if (recyclerView == null || pageWidth <= 0) {
        finishProgrammaticAnimation(token)
        return@post
      }
      recyclerView.smoothScrollBy(
        (DayPagerContract.CENTER_PAGE - startPosition) * pageWidth,
        0,
        DecelerateInterpolator(),
        DayPagerContract.PROGRAMMATIC_DAY_SWITCH_DURATION_MS.toInt(),
      )
      pager.postDelayed(
        { finishProgrammaticAnimation(token) },
        DayPagerContract.PROGRAMMATIC_DAY_SWITCH_DURATION_MS + 32L,
      )
    }
  }

  private fun finishProgrammaticAnimation(token: Long) {
    if (token != motionToken) return
    programmaticDayMotionActive = false
    setCurrentItemAfterFakeDrag(DayPagerContract.CENTER_PAGE)
    pager.isUserInputEnabled = snapshot != null
    recentering = false
  }

  private fun prepareForPagerMutation(): Long {
    programmaticDayMotionActive = false
    verticalScrollAnimator?.cancel()
    verticalScrollAnimator = null
    val token = ++motionToken
    recentering = true
    endAssociatedFakeDrag()
    (pager.getChildAt(0) as? RecyclerView)?.stopScroll()
    return token
  }

  private fun applySynchronizedScrollOffset(value: Float) {
    sharedScrollOffset = value
    pages.forEach { page -> page.setSynchronizedScrollOffset(value) }
  }

  private fun setCurrentItemAfterFakeDrag(position: Int) {
    endAssociatedFakeDrag()
    pager.setCurrentItem(position, false)
  }

  private fun endAssociatedFakeDrag() {
    associatedDragActive = false
    if (pager.isFakeDragging) runCatching { pager.endFakeDrag() }
  }

  private inner class FixedDayPageAdapter : RecyclerView.Adapter<DayPageHolder>() {
    init {
      setHasStableIds(true)
    }

    override fun getItemCount(): Int = DayPagerContract.PAGE_COUNT

    override fun getItemId(position: Int): Long = position.toLong()

    override fun getItemViewType(position: Int): Int = position

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): DayPageHolder {
      val container = FrameLayout(parent.context).apply {
        layoutParams = RecyclerView.LayoutParams(
          RecyclerView.LayoutParams.MATCH_PARENT,
          RecyclerView.LayoutParams.MATCH_PARENT,
        )
      }
      return DayPageHolder(container)
    }

    override fun onBindViewHolder(holder: DayPageHolder, position: Int) {
      val page = pages[position]
      (page.parent as? ViewGroup)?.removeView(page)
      holder.container.removeAllViews()
      holder.container.addView(
        page,
        FrameLayout.LayoutParams(
          FrameLayout.LayoutParams.MATCH_PARENT,
          FrameLayout.LayoutParams.MATCH_PARENT,
        ),
      )
      bindPage(position)
    }

    override fun onViewRecycled(holder: DayPageHolder) {
      holder.container.removeAllViews()
    }
  }

  private class DayPageHolder(val container: FrameLayout) : RecyclerView.ViewHolder(container)
}

class SingleDayCalendarView(context: Context) : LinearLayout(context),
  DayAllDaySectionListener,
  ThreePageDayPagerListener {
  val dayWeekHeaderView = DayWeekHeaderView(context)
  val dayAllDaySectionView = DayAllDaySectionView(context)
  val threePageDayPager = ThreePageDayPager(context)

  private var listener: DayCalendarListener? = null
  private var snapshot: CalendarSnapshot? = null
  private var selectedEpochDay = currentEpochDay()
  private var sessionId = 0L

  init {
    orientation = VERTICAL
    clipChildren = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    dayWeekHeaderView.setOnDateSelectedListener { epochDay ->
      selectDay(
        requestedEpochDay = epochDay,
        emitSelection = true,
        animateFromPreviousDay = true,
        reason = "header-date-changed",
      )
    }
    dayAllDaySectionView.setListener(this)
    threePageDayPager.setListener(this)
    val associatedPagerDispatcher: (MotionEvent) -> Boolean = threePageDayPager::dispatchAssociatedTouchEvent
    dayWeekHeaderView.setAssociatedPagerDispatcher(associatedPagerDispatcher)
    dayAllDaySectionView.setAssociatedPagerDispatcher(associatedPagerDispatcher)
    addView(
      dayWeekHeaderView,
      LayoutParams(LayoutParams.MATCH_PARENT, CalendarUi.dp(context, 58f).toInt()),
    )
    addView(
      dayAllDaySectionView,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT),
    )
    addView(
      threePageDayPager,
      LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f),
    )
    bindComposition(animateFromPreviousDay = false)
  }

  fun setListener(listener: DayCalendarListener?) {
    this.listener = listener
  }

  fun setSnapshot(snapshot: CalendarSnapshot?) {
    if (snapshot == null) {
      threePageDayPager.clearTransientState("snapshot-cleared", emitDraft = false)
      this.snapshot = null
      advanceSession()
      bindComposition(animateFromPreviousDay = false)
      return
    }

    val normalized = snapshot.normalized()
    val preserveReturnMotion = selectedEpochDay == normalized.selectedEpochDay &&
      threePageDayPager.hasActiveReturnMotion()
    val ownershipChanged = this.snapshot == null ||
      this.snapshot?.generation != normalized.generation ||
      selectedEpochDay != normalized.selectedEpochDay
    if (ownershipChanged) {
      threePageDayPager.clearTransientState("snapshot-session-changed", emitDraft = true)
      advanceSession()
    }
    this.snapshot = normalized
    selectedEpochDay = normalized.selectedEpochDay
    bindComposition(
      animateFromPreviousDay = false,
      preserveReturnMotion = preserveReturnMotion,
    )
  }

  fun setSelectedEpochDay(epochDay: Int) {
    selectDay(
      requestedEpochDay = epochDay,
      emitSelection = false,
      animateFromPreviousDay = true,
      reason = "programmatic-date-changed",
    )
  }

  fun clearDraft(reason: String = "cancelled", emit: Boolean = true) {
    threePageDayPager.clearDraft(reason, emit)
  }

  fun returnToToday(epochDay: Int, minute: Int) {
    returnToToday(snapshot, epochDay, minute)
  }

  fun returnToToday(nextSnapshot: CalendarSnapshot?, epochDay: Int, minute: Int) {
    threePageDayPager.clearTransientState("tab-reselect", emitDraft = true)
    val normalized = nextSnapshot?.normalized()
    val previousEpochDay = selectedEpochDay
    val generationChanged = snapshot?.generation != normalized?.generation
    snapshot = normalized
    val targetEpochDay = clampToSnapshotRange(epochDay)
    if (targetEpochDay != previousEpochDay) {
      selectedEpochDay = targetEpochDay
      advanceSession()
      bindComposition(animateFromPreviousDay = true, previousEpochDay = previousEpochDay)
    } else {
      if (generationChanged) advanceSession()
      bindComposition(animateFromPreviousDay = false)
    }
    post { threePageDayPager.scrollToMinuteCentered(minute, animate = true) }
  }

  internal fun currentSelectedEpochDay(): Int = selectedEpochDay

  internal fun currentMinuteScreenY(minute: Int): Float =
    threePageDayPager.currentMinuteScreenY(minute)

  internal fun currentTimelineViewportHeight(): Int =
    threePageDayPager.currentTimelineViewportHeight()

  internal fun hasActiveReturnMotion(): Boolean = threePageDayPager.hasActiveReturnMotion()

  fun currentDraft(): CalendarDraft? = threePageDayPager.currentDraft()

  override fun onAllDayEventOpened(event: CalendarEvent) {
    listener?.onEventOpened(event)
  }

  override fun onAllDayExpandedChanged(expanded: Boolean, overflow: Boolean) = Unit

  override fun onPagerPositionProgress(binding: DayPageBinding, positionProgress: Float) {
    if (!accepts(binding)) return
    dayWeekHeaderView.setPositionProgress(positionProgress)
    dayAllDaySectionView.setPositionProgress(positionProgress)
  }

  override fun onPagerDaySettled(binding: DayPageBinding, nextEpochDay: Int) {
    if (!accepts(binding)) return
    selectDay(
      requestedEpochDay = nextEpochDay,
      emitSelection = true,
      animateFromPreviousDay = false,
      reason = "pager-date-changed",
    )
  }

  override fun onPagerEventOpened(binding: DayPageBinding, event: CalendarEvent) {
    if (accepts(binding)) listener?.onEventOpened(event)
  }

  override fun onPagerCreateRequested(binding: DayPageBinding, draft: CalendarDraft) {
    if (accepts(binding)) listener?.onCreateRequested(draft)
  }

  override fun onPagerDraftChanged(
    binding: DayPageBinding,
    draft: CalendarDraft?,
    reason: String,
  ) {
    if (accepts(binding)) listener?.onDraftChanged(draft, reason)
  }

  override fun onPagerMutationRequested(
    binding: DayPageBinding,
    kind: CalendarMutationKind,
    original: CalendarEvent,
    optimistic: CalendarEvent,
  ): Boolean = accepts(binding) &&
    listener?.onMutationRequested(kind, original, optimistic) == true

  private fun selectDay(
    requestedEpochDay: Int,
    emitSelection: Boolean,
    animateFromPreviousDay: Boolean,
    reason: String,
  ) {
    val nextEpochDay = clampToSnapshotRange(requestedEpochDay)
    if (nextEpochDay == selectedEpochDay) return
    val previousEpochDay = selectedEpochDay
    threePageDayPager.clearTransientState(reason, emitDraft = true)
    selectedEpochDay = nextEpochDay
    advanceSession()
    bindComposition(animateFromPreviousDay, previousEpochDay)
    if (emitSelection) listener?.onDateSelected(nextEpochDay)
  }

  private fun bindComposition(
    animateFromPreviousDay: Boolean,
    previousEpochDay: Int? = null,
    preserveReturnMotion: Boolean = false,
  ) {
    val initialProgress = if (preserveReturnMotion) {
      threePageDayPager.currentPositionProgress()
    } else {
      previousEpochDay
        ?.takeIf { animateFromPreviousDay && DayPagerContract.shouldAnimateProgrammaticSwitch(it, selectedEpochDay) }
        ?.let { DayPagerContract.programmaticStartPosition(it, selectedEpochDay) - DayPagerContract.CENTER_PAGE }
        ?.toFloat()
        ?: 0f
    }
    dayWeekHeaderView.bind(selectedEpochDay, snapshot?.todayEpochDay, initialProgress)
    dayAllDaySectionView.bindPages(
      snapshot?.events.orEmpty(),
      selectedEpochDay,
      initialProgress,
      snapshot?.generation ?: 0,
    )
    threePageDayPager.bind(
      snapshot = snapshot,
      centerEpochDay = selectedEpochDay,
      sessionId = sessionId,
      animateFromPreviousDay = animateFromPreviousDay,
      preserveReturnMotion = preserveReturnMotion,
    )
  }

  private fun accepts(binding: DayPageBinding): Boolean =
    binding.accepts(sessionId, selectedEpochDay)

  private fun clampToSnapshotRange(epochDay: Int): Int = snapshot?.let { activeSnapshot ->
    epochDay.coerceIn(
      activeSnapshot.rangeStartEpochDay,
      activeSnapshot.rangeEndEpochDayExclusive - 1,
    )
  } ?: epochDay

  private fun advanceSession() {
    sessionId = if (sessionId == Long.MAX_VALUE) 1L else sessionId + 1L
  }
}

private fun currentEpochDay(): Int {
  val now = Calendar.getInstance()
  return CalendarDateMath.toEpochDay(
    now.get(Calendar.YEAR),
    now.get(Calendar.MONTH) + 1,
    now.get(Calendar.DAY_OF_MONTH),
  )
}
