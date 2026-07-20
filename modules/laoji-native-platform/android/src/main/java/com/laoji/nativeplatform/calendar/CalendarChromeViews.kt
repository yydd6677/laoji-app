package com.laoji.nativeplatform.calendar

// CAL-PICKER-001 / CAL-PICKER-HOST-001: QuickChoose state and motion stay outside React frames.

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ArgbEvaluator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Space
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import com.laoji.nativeplatform.evidence.FeishuEvidence
import com.laoji.nativeplatform.evidence.FeishuEvidenceRuntime
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt

interface CalendarToolbarListener {
  fun onProfileClicked()
  fun onSearchClicked()
  fun onTitleClicked()
  fun onModeClicked(mode: CalendarMode)
}

class CalendarToolbarView(context: Context) : LinearLayout(context) {
  private val palette = CalendarUi.palette(context)
  private val profileView = CalendarShellIconView(context, CalendarShellIcon.PROFILE)
  private val titleCluster = LinearLayout(context)
  private val titleView = TextView(context)
  private val titleExpandIcon = CalendarTitleExpandIconView(context)
  private val searchView = CalendarShellIconView(context, CalendarShellIcon.SEARCH)
  private var listener: CalendarToolbarListener? = null

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(
      CalendarUi.dp(context, 12f).toInt(),
      0,
      CalendarUi.dp(context, 12f).toInt(),
      0
    )
    setBackgroundColor(palette.surface)

    profileView.setOnClickListener { listener?.onProfileClicked() }
    addView(
      profileView,
      LayoutParams(
        CalendarUi.dp(context, CalendarShellContract.ICON_HIT_SIZE_DP).toInt(),
        CalendarUi.dp(context, CalendarShellContract.ICON_HIT_SIZE_DP).toInt()
      )
    )

    titleCluster.apply {
      orientation = HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      isClickable = true
      isFocusable = true
      setPadding(CalendarUi.dp(context, 6f).toInt(), 0, CalendarUi.dp(context, 12f).toInt(), 0)
      setOnClickListener { listener?.onTitleClicked() }
    }
    titleView.apply {
      textSize = 17f
      setTextColor(palette.textPrimary)
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      gravity = Gravity.CENTER_VERTICAL
      maxLines = 1
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    titleCluster.addView(titleView, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT))
    titleCluster.addView(
      titleExpandIcon,
      LayoutParams(CalendarUi.dp(context, 22f).roundToInt(), CalendarUi.dp(context, 22f).roundToInt()).apply {
        marginStart = CalendarUi.dp(context, 4f).roundToInt()
      },
    )
    addView(titleCluster, LayoutParams(0, LayoutParams.MATCH_PARENT, 1f))

    searchView.setOnClickListener { listener?.onSearchClicked() }
    addView(
      searchView,
      LayoutParams(
        CalendarUi.dp(context, CalendarShellContract.ICON_HIT_SIZE_DP).toInt(),
        CalendarUi.dp(context, CalendarShellContract.ICON_HIT_SIZE_DP).toInt()
      )
    )

  }

  fun setListener(listener: CalendarToolbarListener?) {
    this.listener = listener
  }

  fun setTitle(title: String) {
    titleView.text = title
    titleCluster.contentDescription = "$title，选择年月"
  }

  fun setExpandProgress(progress: Float) {
    titleExpandIcon.setExpandProgress(progress)
  }

}

// UI-CALENDAR-INDICATOR-001: view_indicator.xml is a separate 50dp band with
// one 32dp trailing mode entry. The removed Feishu sidebar is the approved
// product replacement point for toggling the retained month/day modes.
@FeishuEvidence("UI-CALENDAR-INDICATOR-001")
class CalendarIndicatorView(context: Context) : FrameLayout(context) {
  private val palette = CalendarUi.palette(context)
  private val label = TextView(context).apply {
    text = "日历"
    textSize = 14f
    gravity = Gravity.CENTER
    setTextColor(palette.textPrimary)
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }
  private val modeEntry = CalendarViewModeIconView(context)
  private val divider = View(context).apply { setBackgroundColor(palette.divider) }
  private var mode = CalendarMode.MONTH
  private var listener: CalendarToolbarListener? = null

  init {
    setBackgroundColor(palette.surface)
    setPadding(0, 0, 0, CalendarUi.dp(context, 10f).roundToInt())
    FeishuEvidenceRuntime.bind(this, "UI-CALENDAR-INDICATOR-001", "indicator", "calendar-view-indicator")
    FeishuEvidenceRuntime.bind(label, "UI-CALENDAR-INDICATOR-001", "tab", "calendar-tab")
    FeishuEvidenceRuntime.bind(modeEntry, "UI-CALENDAR-INDICATOR-001", "mode-entry", "calendar-mode-entry")
    FeishuEvidenceRuntime.bind(divider, "UI-CALENDAR-INDICATOR-001", "divider", "calendar-indicator-divider")
    addView(
      label,
      LayoutParams(CalendarUi.dp(context, 60f).roundToInt(), LayoutParams.MATCH_PARENT).apply {
        gravity = Gravity.START
        marginStart = CalendarUi.dp(context, 10f).roundToInt()
      },
    )
    addView(
      modeEntry,
      LayoutParams(CalendarUi.dp(context, 32f).roundToInt(), CalendarUi.dp(context, 32f).roundToInt()).apply {
        gravity = Gravity.END or Gravity.TOP
        marginEnd = CalendarUi.dp(context, 10f).roundToInt()
        topMargin = CalendarUi.dp(context, 4f).roundToInt()
      },
    )
    addView(
      divider,
      LayoutParams(LayoutParams.MATCH_PARENT, CalendarUi.dp(context, 0.5f).coerceAtLeast(1f).roundToInt()).apply {
        gravity = Gravity.BOTTOM
      },
    )
    modeEntry.setOnClickListener {
      listener?.onModeClicked(if (mode == CalendarMode.MONTH) CalendarMode.DAY else CalendarMode.MONTH)
    }
    updateModeDescription()
  }

  fun setListener(listener: CalendarToolbarListener?) {
    this.listener = listener
  }

  fun setMode(mode: CalendarMode) {
    this.mode = mode
    updateModeDescription()
  }

  private fun updateModeDescription() {
    modeEntry.contentDescription = if (mode == CalendarMode.MONTH) "切换到单日视图" else "切换到月视图"
  }

  companion object {
    const val HEIGHT_DP = 50f
    const val MODE_ENTRY_SIZE_DP = 32f
  }
}

private class CalendarViewModeIconView(context: Context) : View(context) {
  private val palette = CalendarUi.palette(context)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.textSecondary
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 1.5f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val cell = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.textSecondary
    style = Paint.Style.FILL
  }

  init {
    isClickable = true
    isFocusable = true
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val left = width / 2f - CalendarUi.dp(context, 9f)
    val top = height / 2f - CalendarUi.dp(context, 8f)
    val right = width / 2f + CalendarUi.dp(context, 9f)
    val bottom = height / 2f + CalendarUi.dp(context, 8f)
    canvas.drawRoundRect(left, top, right, bottom, CalendarUi.dp(context, 1.5f), CalendarUi.dp(context, 1.5f), stroke)
    canvas.drawLine(left, top + CalendarUi.dp(context, 4f), right, top + CalendarUi.dp(context, 4f), stroke)
    val radius = CalendarUi.dp(context, 1.15f)
    for (row in 0..1) {
      for (column in 0..2) {
        canvas.drawCircle(
          left + CalendarUi.dp(context, 4.5f + column * 4.5f),
          top + CalendarUi.dp(context, 8f + row * 4.5f),
          radius,
          cell,
        )
      }
    }
  }
}

// ShellView -> CalendarTitleProxyNewImpl -> TitleBarIconView continuously maps panel progress to 180 degrees.
internal class CalendarTitleExpandIconView(context: Context) : View(context) {
  private val palette = CalendarUi.palette(context)
  private val circlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = (palette.textSecondary and 0x00ffffff) or 0x1a000000
  }
  private val trianglePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.textSecondary
    style = Paint.Style.FILL
  }
  private val triangle = Path()

  init {
    isClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun setExpandProgress(progress: Float) {
    rotation = progress.coerceIn(0f, 1f) * 180f
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val diameter = minOf(width, height).toFloat()
    val centerX = width / 2f
    val centerY = height / 2f
    canvas.drawCircle(centerX, centerY, diameter / 2f, circlePaint)
    val iconWidth = diameter * 5f / 11f
    val iconHeight = diameter * 3f / 11f
    triangle.reset()
    triangle.moveTo(centerX - iconWidth / 2f, centerY - iconHeight / 2f)
    triangle.lineTo(centerX + iconWidth / 2f, centerY - iconHeight / 2f)
    triangle.lineTo(centerX, centerY + iconHeight / 2f)
    triangle.close()
    canvas.drawPath(triangle, trianglePaint)
  }
}

interface CalendarPickerListener {
  fun onPickerDateCommitted(epochDay: Int)
  fun onPickerExpandStateChanged(state: CalendarPickerExpandState)
  fun onPickerExpandProgressChanged(progress: Float) = Unit
  fun onPickerContentStateChanged(state: CalendarPickerContentState) = Unit
}

// CAL-PICKER-HOST-001: page-local transparent owner remains full screen while its measured panel moves.
class CalendarQuickChooseHostView(context: Context) : FrameLayout(context) {
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
  private val quickChooseContent = CalendarQuickChooseContentView(context)
  private val contentWrapper = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    clipChildren = false
  }
  private val panel = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    clipChildren = false
  }
  private val dragBar = QuickChooseDragBarView(context)
  private val shadowTail = View(context).apply { alpha = 0f }
  private val topDivider = View(context).apply {
    setBackgroundColor(CalendarUi.palette(context).divider)
    alpha = 0f
  }
  private var listener: CalendarPickerListener? = null
  private var expandAnimator: ValueAnimator? = null
  private var gestureIntercepted = false
  private var downRawY = 0f
  private var lastRawY = 0f
  private var virtualTranslationY = 0f

  var expandProgress: Float = 0f
    private set
  var expandState: CalendarPickerExpandState = CalendarPickerExpandState.CLOSED
    private set
  var lastExpandAnimationDurationMs: Long = 0L
    private set

  val contentState: CalendarPickerContentState
    get() = quickChooseContent.contentState

  init {
    // Feishu keeps the panel in the measured tree while its content is translated
    // off-screen. INVISIBLE preserves that contract without accepting touches.
    visibility = INVISIBLE
    isClickable = true
    isFocusable = false
    clipChildren = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO

    contentWrapper.addView(
      quickChooseContent,
      LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
    )
    contentWrapper.addView(
      dragBar,
      LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        CalendarUi.dp(context, CalendarQuickChooseContract.DRAG_BAR_HEIGHT_DP).roundToInt(),
      ).apply {
        topMargin = CalendarUi.dp(context, CalendarQuickChooseContract.DRAG_BAR_TOP_MARGIN_DP).roundToInt()
      },
    )
    panel.addView(
      contentWrapper,
      LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
    )
    panel.addView(
      shadowTail,
      LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        CalendarUi.dp(context, CalendarQuickChooseContract.SHADOW_TAIL_HEIGHT_DP).roundToInt(),
      ),
    )
    addView(
      panel,
      FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP),
    )
    addView(
      topDivider,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        CalendarUi.dp(context, CalendarQuickChooseContract.DIVIDER_HEIGHT_DP).roundToInt().coerceAtLeast(1),
        Gravity.TOP,
      ),
    )

    dragBar.setOnClickListener { close() }
    dragBar.setOnTouchListener { _, event -> handleDragTouch(event, dragBar) }
    shadowTail.setOnTouchListener { _, event -> handleDragTouch(event, this) }
    quickChooseContent.setListener(object : CalendarQuickChooseContentListener {
      override fun onDateCommitted(epochDay: Int) {
        listener?.onPickerDateCommitted(epochDay)
      }

      override fun onContentStateChanged(state: CalendarPickerContentState) {
        listener?.onPickerContentStateChanged(state)
      }
    })
  }

  fun setListener(listener: CalendarPickerListener?) {
    this.listener = listener
  }

  /**
   * Bind the closed-state content before the first open so the panel has a stable
   * measured size and the first title tap does not depend on a late remeasure.
   */
  fun prepare(committedEpochDay: Int, mode: CalendarMode) {
    if (expandState != CalendarPickerExpandState.CLOSED) return
    quickChooseContent.bind(committedEpochDay, mode)
    applyExpandProgress(0f)
    visibility = INVISIBLE
  }

  fun open(committedEpochDay: Int, mode: CalendarMode) {
    quickChooseContent.bind(committedEpochDay, mode)
    visibility = VISIBLE
    bringToFront()
    animateExpandTo(1f)
  }

  fun close() {
    if (expandState == CalendarPickerExpandState.CLOSED) return
    animateExpandTo(0f)
  }

  fun updateCommittedDate(epochDay: Int) {
    quickChooseContent.updateCommittedDate(epochDay)
  }

  fun setDateData(data: CalendarQuickChooseDateData) {
    quickChooseContent.setDateData(data)
  }

  fun dispose() {
    expandAnimator?.cancel()
    expandAnimator = null
    quickChooseContent.dispose()
    setListener(null)
    expandProgress = 0f
    setExpandState(CalendarPickerExpandState.CLOSED)
    visibility = INVISIBLE
  }

  fun measuredPanelHeight(): Int = panel.measuredHeight

  fun dragTargetHeight(): Int = contentWrapper.measuredHeight

  fun wheelConfiguration(): QuickChooseWheelConfiguration = quickChooseContent.wheelConfiguration()

  fun settleYearForTest(year: Int) = quickChooseContent.settleYearForTest(year)

  fun settleMonthForTest(month: Int) = quickChooseContent.settleMonthForTest(month)

  fun toggleContentForTest() = quickChooseContent.toggleContent()

  fun datePageMonthForTest(): Int = quickChooseContent.datePageMonth()

  fun shiftDateMonthForTest(deltaMonths: Int) = quickChooseContent.shiftDateMonth(deltaMonths)

  fun lastContentAnimationDurationMs(): Long = quickChooseContent.lastContentAnimationDurationMs

  fun lastDateHeightAnimationDurationMs(): Long = quickChooseContent.lastDateHeightAnimationDurationMs

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val visiblePanelTop = contentWrapper.translationY
        val dragRegionTop = visiblePanelTop + quickChooseContent.height
        val visiblePanelBottom = visiblePanelTop + contentWrapper.height + shadowTail.height
        gestureIntercepted = event.y >= dragRegionTop || event.y >= visiblePanelBottom
        if (gestureIntercepted) beginDrag(event)
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (!gestureIntercepted) gestureIntercepted = false
    }
    return gestureIntercepted || super.onInterceptTouchEvent(event)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN && !gestureIntercepted) beginDrag(event)
    return handleDragTouch(event, this)
  }

  override fun performClick(): Boolean {
    super.performClick()
    close()
    return true
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    applyExpandProgress(expandProgress)
  }

  override fun onDetachedFromWindow() {
    expandAnimator?.cancel()
    expandAnimator = null
    super.onDetachedFromWindow()
  }

  private fun beginDrag(event: MotionEvent) {
    expandAnimator?.cancel()
    expandAnimator = null
    downRawY = event.rawY
    lastRawY = event.rawY
    virtualTranslationY = CalendarQuickChooseContract.translationForProgress(expandProgress, contentWrapper.height)
    gestureIntercepted = true
  }

  private fun handleDragTouch(event: MotionEvent, clickTarget: View): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> beginDrag(event)
      MotionEvent.ACTION_MOVE -> {
        val rawY = event.rawY
        virtualTranslationY = (virtualTranslationY + rawY - lastRawY)
          .coerceIn(-contentWrapper.height.toFloat(), 0f)
        applyExpandProgress(
          CalendarQuickChooseContract.progressForTranslation(virtualTranslationY, contentWrapper.height),
        )
        lastRawY = rawY
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val moved = abs(event.rawY - downRawY) > touchSlop
        val target = CalendarQuickChooseContract.releaseTarget(expandState, moved)
        gestureIntercepted = false
        if (!moved && event.actionMasked == MotionEvent.ACTION_UP) {
          clickTarget.performClick()
        } else {
          animateExpandTo(if (target == CalendarPickerExpandState.OPENED) 1f else 0f)
        }
      }
    }
    return true
  }

  private fun animateExpandTo(targetProgress: Float) {
    val target = targetProgress.coerceIn(0f, 1f)
    expandAnimator?.cancel()
    expandAnimator = null
    if (target > 0f) visibility = VISIBLE
    val duration = CalendarQuickChooseContract.animationDurationMs(expandProgress, target)
    lastExpandAnimationDurationMs = duration
    if (duration == 0L) {
      applyExpandProgress(target)
      if (target == 0f) visibility = INVISIBLE
      return
    }
    setExpandState(
      if (target > expandProgress) CalendarPickerExpandState.OPENING else CalendarPickerExpandState.CLOSING,
    )
    val animator = ValueAnimator.ofFloat(expandProgress, target).apply {
      this.duration = duration
      addUpdateListener { applyExpandProgress(it.animatedValue as Float) }
      addListener(object : AnimatorListenerAdapter() {
        private var cancelled = false

        override fun onAnimationCancel(animation: Animator) {
          cancelled = true
        }

        override fun onAnimationEnd(animation: Animator) {
          if (cancelled || expandAnimator !== animation) return
          expandAnimator = null
          applyExpandProgress(target)
          if (target == 0f) visibility = INVISIBLE
        }
      })
    }
    expandAnimator = animator
    animator.start()
  }

  private fun applyExpandProgress(value: Float) {
    val previous = expandProgress
    expandProgress = value.coerceIn(0f, 1f)
    val translationY = CalendarQuickChooseContract.translationForProgress(expandProgress, contentWrapper.height)
    contentWrapper.translationY = translationY
    shadowTail.translationY = translationY
    shadowTail.alpha = expandProgress
    topDivider.alpha = expandProgress
    setExpandState(CalendarQuickChooseContract.stateForProgress(previous, expandProgress, expandState))
    listener?.onPickerExpandProgressChanged(expandProgress)
  }

  private fun setExpandState(next: CalendarPickerExpandState) {
    if (next == expandState) return
    expandState = next
    listener?.onPickerExpandStateChanged(next)
  }
}

private interface CalendarQuickChooseContentListener {
  fun onDateCommitted(epochDay: Int)
  fun onContentStateChanged(state: CalendarPickerContentState)
}

// CAL-PICKER-001: date and year/month owners coexist and transition by progress instead of replacement.
private class CalendarQuickChooseContentView(context: Context) : LinearLayout(context) {
  private val palette = CalendarUi.palette(context)
  private val header = LinearLayout(context)
  private val titleView = TextView(context)
  private val titleArrow = QuickChooseChevronView(context, QuickChooseChevron.RIGHT)
  private val previousMonth = QuickChooseChevronView(context, QuickChooseChevron.LEFT)
  private val nextMonth = QuickChooseChevronView(context, QuickChooseChevron.RIGHT)
  private val body = FrameLayout(context)
  private val datePicker = CalendarQuickChooseDateView(context)
  private val yearMonthPicker = LinearLayout(context)
  private val yearWheel = CalendarQuickChooseWheelView(context)
  private val monthWheel = CalendarQuickChooseWheelView(context)
  private var listener: CalendarQuickChooseContentListener? = null
  private var contentAnimator: ValueAnimator? = null
  private var dateHeightAnimator: ValueAnimator? = null
  private var contentProgress = 0f
  private var committedEpochDay = CalendarDateMath.toEpochDay(2000, 1, 1)
  private var pageMonthEpochDay = committedEpochDay
  private var dateData = CalendarQuickChooseDateData.EMPTY
  private var monthOnly = false

  var contentState: CalendarPickerContentState = CalendarPickerContentState.DATE_PANEL
    private set
  var lastContentAnimationDurationMs: Long = 0L
    private set
  var lastDateHeightAnimationDurationMs: Long = 0L
    private set

  init {
    orientation = VERTICAL
    setBackgroundColor(palette.surface)

    header.orientation = HORIZONTAL
    header.gravity = Gravity.CENTER_VERTICAL
    header.setPadding(
      CalendarUi.dp(context, 16f).roundToInt(),
      CalendarUi.dp(context, 16f).roundToInt(),
      CalendarUi.dp(context, 15f).roundToInt(),
      CalendarUi.dp(context, 8f).roundToInt(),
    )
    val titleCluster = LinearLayout(context).apply {
      orientation = HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      isClickable = true
      isFocusable = true
      contentDescription = "切换日期或年月选择"
      setOnClickListener { toggleContent() }
    }
    titleView.apply {
      textSize = 14f
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      setTextColor(palette.textPrimary)
      gravity = Gravity.CENTER_VERTICAL
      maxLines = 1
      isClickable = true
      isFocusable = false
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
      setOnClickListener { toggleContent() }
    }
    titleArrow.apply {
      isClickable = true
      isFocusable = false
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
      contentDescription = "切换日期或年月选择"
      setOnClickListener { toggleContent() }
    }
    titleCluster.addView(titleView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, CalendarUi.dp(context, 22f).roundToInt()))
    titleCluster.addView(titleArrow, LinearLayout.LayoutParams(CalendarUi.dp(context, 22f).roundToInt(), CalendarUi.dp(context, 22f).roundToInt()))
    header.addView(titleCluster, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
    header.addView(previousMonth, LinearLayout.LayoutParams(CalendarUi.dp(context, 22f).roundToInt(), CalendarUi.dp(context, 22f).roundToInt()))
    header.addView(Space(context), LinearLayout.LayoutParams(CalendarUi.dp(context, 39f).roundToInt(), 1))
    header.addView(nextMonth, LinearLayout.LayoutParams(CalendarUi.dp(context, 22f).roundToInt(), CalendarUi.dp(context, 22f).roundToInt()))
    addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, CalendarUi.dp(context, 46f).roundToInt()))

    datePicker.setOnDateClickListener { commitDate(it) }
    datePicker.setOnPageMonthChangedListener { onDatePageMonthChanged(it) }
    body.addView(datePicker, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))

    yearMonthPicker.orientation = HORIZONTAL
    yearMonthPicker.setPadding(
      0,
      CalendarUi.dp(context, CalendarQuickChooseContract.WHEEL_VERTICAL_PADDING_DP).roundToInt(),
      0,
      CalendarUi.dp(context, CalendarQuickChooseContract.WHEEL_VERTICAL_PADDING_DP).roundToInt(),
    )
    yearWheel.configure(CalendarQuickChooseContract.MIN_YEAR, CalendarQuickChooseContract.MAX_YEAR, false, "年")
    monthWheel.configure(1, 12, true, "月")
    yearMonthPicker.addView(
      yearWheel,
      LinearLayout.LayoutParams(0, CalendarUi.dp(context, CalendarQuickChooseContract.WHEEL_HEIGHT_DP).roundToInt(), 1f),
    )
    yearMonthPicker.addView(
      monthWheel,
      LinearLayout.LayoutParams(0, CalendarUi.dp(context, CalendarQuickChooseContract.WHEEL_HEIGHT_DP).roundToInt(), 1f),
    )
    body.addView(
      yearMonthPicker,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        CalendarUi.dp(context, CalendarQuickChooseContract.YEAR_MONTH_HEIGHT_DP).roundToInt(),
      ),
    )
    addView(body, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0))

    previousMonth.contentDescription = "上个月"
    nextMonth.contentDescription = "下个月"
    previousMonth.setOnClickListener { shiftDateMonth(-1) }
    nextMonth.setOnClickListener { shiftDateMonth(1) }
    yearWheel.setOnSettledListener { commitYearMonth(it, monthWheel.selectedValue) }
    monthWheel.setOnSettledListener { commitYearMonth(yearWheel.selectedValue, it) }
  }

  fun setListener(listener: CalendarQuickChooseContentListener?) {
    this.listener = listener
  }

  fun bind(epochDay: Int, mode: CalendarMode) {
    contentAnimator?.cancel()
    dateHeightAnimator?.cancel()
    committedEpochDay = normalizeCommittedDate(epochDay)
    pageMonthEpochDay = CalendarDateMath.monthStart(committedEpochDay)
    monthOnly = mode == CalendarMode.MONTH
    header.visibility = if (monthOnly) GONE else VISIBLE
    syncChildren()
    applyContentProgress(if (monthOnly) 1f else 0f, notifyState = true)
  }

  fun updateCommittedDate(epochDay: Int) {
    val normalized = normalizeCommittedDate(epochDay)
    if (normalized == committedEpochDay) return
    committedEpochDay = normalized
    pageMonthEpochDay = CalendarDateMath.monthStart(normalized)
    syncChildren()
  }

  fun setDateData(data: CalendarQuickChooseDateData) {
    dateData = data
    datePicker.setDateData(data)
  }

  fun toggleContent() {
    if (monthOnly) return
    val target = when (contentState) {
      CalendarPickerContentState.DATE_PANEL,
      CalendarPickerContentState.TO_DATE_PANEL -> 1f
      CalendarPickerContentState.YEAR_MONTH_PANEL,
      CalendarPickerContentState.TO_YEAR_MONTH_PANEL -> 0f
    }
    animateContentTo(target)
  }

  fun shiftDateMonth(deltaMonths: Int) {
    if (monthOnly || contentProgress > 0f || deltaMonths == 0) return
    datePicker.pageBy(deltaMonths)
  }

  fun datePageMonth(): Int = pageMonthEpochDay

  fun settleYearForTest(year: Int) = yearWheel.settleToValue(year)

  fun settleMonthForTest(month: Int) = monthWheel.settleToValue(month)

  fun wheelConfiguration(): QuickChooseWheelConfiguration = QuickChooseWheelConfiguration(
    yearMin = yearWheel.minimumValue,
    yearMax = yearWheel.maximumValue,
    yearLoops = yearWheel.loops,
    monthMin = monthWheel.minimumValue,
    monthMax = monthWheel.maximumValue,
    monthLoops = monthWheel.loops,
    visibleItems = CalendarQuickChooseContract.VISIBLE_WHEEL_ITEMS,
    itemHeightPx = yearWheel.itemHeightPx.roundToInt(),
    wheelHeightPx = yearWheel.measuredHeight,
    yearMonthHeightPx = yearMonthPicker.measuredHeight,
  )

  fun dispose() {
    contentAnimator?.cancel()
    contentAnimator = null
    dateHeightAnimator?.cancel()
    dateHeightAnimator = null
    yearWheel.dispose()
    monthWheel.dispose()
    datePicker.dispose()
    listener = null
  }

  private fun syncChildren() {
    val date = CalendarDateMath.fromEpochDay(committedEpochDay)
    yearWheel.setValue(date.year)
    monthWheel.setValue(date.month)
    datePicker.setMonth(pageMonthEpochDay, committedEpochDay, dateData)
    updateTitle()
    val bodyHeight = if (monthOnly) {
      CalendarUi.dp(context, CalendarQuickChooseContract.YEAR_MONTH_HEIGHT_DP).roundToInt()
    } else {
      dateContentHeightPx(pageMonthEpochDay)
    }
    setBodyHeight(bodyHeight)
  }

  private fun commitDate(epochDay: Int) {
    committedEpochDay = normalizeCommittedDate(epochDay)
    pageMonthEpochDay = CalendarDateMath.monthStart(committedEpochDay)
    syncChildren()
    listener?.onDateCommitted(committedEpochDay)
  }

  private fun commitYearMonth(year: Int, month: Int) {
    committedEpochDay = CalendarQuickChooseContract.commitYearMonth(committedEpochDay, year, month)
    pageMonthEpochDay = CalendarDateMath.monthStart(committedEpochDay)
    syncChildren()
    listener?.onDateCommitted(committedEpochDay)
  }

  private fun normalizeCommittedDate(epochDay: Int): Int {
    val date = CalendarDateMath.fromEpochDay(epochDay)
    return CalendarQuickChooseContract.commitYearMonth(epochDay, date.year, date.month)
  }

  private fun updateTitle() {
    val epochDay = if (contentProgress < 0.5f) pageMonthEpochDay else committedEpochDay
    titleView.text = CalendarUi.monthTitle(epochDay)
  }

  private fun animateContentTo(targetProgress: Float) {
    val target = targetProgress.coerceIn(0f, 1f)
    contentAnimator?.cancel()
    val duration = (abs(target - contentProgress) * CalendarQuickChooseContract.CONTENT_SWITCH_DURATION_MS).toLong()
    lastContentAnimationDurationMs = duration
    if (duration == 0L) {
      applyContentProgress(target, notifyState = true)
      return
    }
    val animator = ValueAnimator.ofFloat(contentProgress, target).apply {
      this.duration = duration
      addUpdateListener { applyContentProgress(it.animatedValue as Float, notifyState = true) }
      addListener(object : AnimatorListenerAdapter() {
        private var cancelled = false

        override fun onAnimationCancel(animation: Animator) {
          cancelled = true
        }

        override fun onAnimationEnd(animation: Animator) {
          if (!cancelled && contentAnimator === animation) applyContentProgress(target, notifyState = true)
          if (contentAnimator === animation) contentAnimator = null
        }
      })
    }
    contentAnimator = animator
    animator.start()
  }

  private fun applyContentProgress(value: Float, notifyState: Boolean) {
    val previous = contentProgress
    contentProgress = value.coerceIn(0f, 1f)
    datePicker.visibility = if (contentProgress < 1f) VISIBLE else INVISIBLE
    yearMonthPicker.visibility = if (contentProgress > 0f) VISIBLE else INVISIBLE
    datePicker.alpha = 1f - contentProgress
    yearMonthPicker.alpha = contentProgress
    datePicker.isEnabled = contentProgress == 0f
    datePicker.setPagingEnabled(contentProgress == 0f)
    yearMonthPicker.isEnabled = contentProgress == 1f
    datePicker.importantForAccessibility = if (contentProgress == 0f) IMPORTANT_FOR_ACCESSIBILITY_YES else IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    yearMonthPicker.importantForAccessibility = if (contentProgress == 1f) IMPORTANT_FOR_ACCESSIBILITY_YES else IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    val navAlpha = 1f - contentProgress
    previousMonth.alpha = navAlpha
    nextMonth.alpha = navAlpha
    previousMonth.isClickable = contentProgress == 0f
    nextMonth.isClickable = contentProgress == 0f
    titleArrow.rotation = 90f * contentProgress
    titleView.setTextColor(ArgbEvaluator().evaluate(contentProgress, palette.textPrimary, palette.accent) as Int)
    val dateHeight = dateContentHeightPx(pageMonthEpochDay)
    val yearMonthHeight = CalendarUi.dp(context, CalendarQuickChooseContract.YEAR_MONTH_HEIGHT_DP).roundToInt()
    setBodyHeight((dateHeight + (yearMonthHeight - dateHeight) * contentProgress).roundToInt())
    updateTitle()
    val nextState = when {
      contentProgress == 0f -> CalendarPickerContentState.DATE_PANEL
      contentProgress == 1f -> CalendarPickerContentState.YEAR_MONTH_PANEL
      contentProgress > previous -> CalendarPickerContentState.TO_YEAR_MONTH_PANEL
      contentProgress < previous -> CalendarPickerContentState.TO_DATE_PANEL
      else -> contentState
    }
    if (nextState != contentState) {
      contentState = nextState
      if (notifyState) listener?.onContentStateChanged(nextState)
    }
  }

  private fun dateContentHeightPx(monthEpochDay: Int): Int = CalendarUi.dp(
    context,
    CalendarQuickChooseContract.dateContentHeightDp(monthEpochDay),
  ).roundToInt()

  private fun onDatePageMonthChanged(monthEpochDay: Int) {
    val nextMonth = CalendarDateMath.monthStart(monthEpochDay)
    if (nextMonth == pageMonthEpochDay) return
    val oldHeight = dateContentHeightPx(pageMonthEpochDay)
    pageMonthEpochDay = nextMonth
    updateTitle()
    val newHeight = dateContentHeightPx(pageMonthEpochDay)
    datePicker.setViewportHeight(newHeight)
    dateHeightAnimator?.cancel()
    if (oldHeight == newHeight) {
      lastDateHeightAnimationDurationMs = 0L
      setBodyHeight(newHeight)
      return
    }
    lastDateHeightAnimationDurationMs = CalendarQuickChooseContract.DATE_HEIGHT_DURATION_MS
    dateHeightAnimator = ValueAnimator.ofInt(body.height.takeIf { it > 0 } ?: oldHeight, newHeight).apply {
      duration = CalendarQuickChooseContract.DATE_HEIGHT_DURATION_MS
      addUpdateListener { setBodyHeight(it.animatedValue as Int) }
      start()
    }
  }

  private fun setBodyHeight(height: Int) {
    val params = body.layoutParams ?: LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, height)
    if (params.height == height) return
    params.height = height
    body.layoutParams = params
  }
}

data class QuickChooseWheelConfiguration(
  val yearMin: Int,
  val yearMax: Int,
  val yearLoops: Boolean,
  val monthMin: Int,
  val monthMax: Int,
  val monthLoops: Boolean,
  val visibleItems: Int,
  val itemHeightPx: Int,
  val wheelHeightPx: Int,
  val yearMonthHeightPx: Int,
)

// CAL-PICKER-001 / CAL-PICKER-WHEEL-TAP-001: five visible 48dp rows implement
// bounded year and looping month wheels; a short tap settles the touched row.
@FeishuEvidence("CAL-PICKER-WHEEL-TAP-001")
internal class CalendarQuickChooseWheelView(context: Context) : View(context) {
  private val palette = CalendarUi.palette(context)
  private val centerPaint = CalendarUi.textPaint(context, palette.textPrimary, 17f)
  private val outerPaint = CalendarUi.textPaint(context, palette.textSecondary, 14f)
  private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.divider
    strokeWidth = CalendarUi.dp(context, CalendarQuickChooseContract.DIVIDER_HEIGHT_DP).coerceAtLeast(1f)
  }
  private val minimumFlingVelocity = ViewConfiguration.get(context).scaledMinimumFlingVelocity
  private var minimum = 0
  private var maximum = 0
  private var loop = false
  private var suffix = ""
  private var settledListener: ((Int) -> Unit)? = null
  private var downY = 0f
  private var tapUpY = 0f
  private var lastY = 0f
  private var dragOffset = 0f
  private var lastSettledValue = 0
  private var velocityTracker: android.view.VelocityTracker? = null
  private var settleAnimator: ValueAnimator? = null
  @Volatile private var inertiaFuture: ScheduledFuture<*>? = null
  @Volatile private var motionGeneration = 0

  var selectedValue: Int = 0
    private set
  val minimumValue: Int get() = minimum
  val maximumValue: Int get() = maximum
  val loops: Boolean get() = loop
  val itemHeightPx: Float get() = CalendarUi.dp(context, CalendarQuickChooseContract.WHEEL_ITEM_HEIGHT_DP)

  init {
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    FeishuEvidenceRuntime.bind(this, "CAL-PICKER-WHEEL-TAP-001", "wheel", "quick-choose-wheel")
  }

  fun configure(minimum: Int, maximum: Int, loop: Boolean, suffix: String) {
    require(minimum <= maximum)
    this.minimum = minimum
    this.maximum = maximum
    this.loop = loop
    this.suffix = suffix
    selectedValue = minimum
    lastSettledValue = selectedValue
    contentDescription = "${suffix}选择器"
    invalidate()
  }

  fun setOnSettledListener(listener: ((Int) -> Unit)?) {
    settledListener = listener
  }

  fun setValue(value: Int) {
    cancelWheelMotion()
    selectedValue = normalize(value)
    lastSettledValue = selectedValue
    dragOffset = 0f
    invalidate()
  }

  fun settleToValue(value: Int) {
    cancelWheelMotion()
    val next = normalize(value)
    selectedValue = next
    dragOffset = 0f
    invalidate()
    dispatchSettledSelectionIfChanged()
  }

  fun dispose() {
    cancelWheelMotion()
    velocityTracker?.recycle()
    velocityTracker = null
    settledListener = null
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val targetHeight = CalendarUi.dp(context, CalendarQuickChooseContract.WHEEL_HEIGHT_DP).roundToInt()
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), resolveSize(targetHeight, heightMeasureSpec))
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val centerY = height / 2f
    val halfItem = itemHeightPx / 2f
    canvas.drawLine(0f, centerY - halfItem, width.toFloat(), centerY - halfItem, dividerPaint)
    canvas.drawLine(0f, centerY + halfItem, width.toFloat(), centerY + halfItem, dividerPaint)
    for (offset in -3..3) {
      val value = valueAtOffset(offset) ?: continue
      val itemCenter = centerY + offset * itemHeightPx + dragOffset
      if (itemCenter < -itemHeightPx || itemCenter > height + itemHeightPx) continue
      val distance = abs(itemCenter - centerY) / itemHeightPx
      val paint = if (distance < 0.5f) centerPaint else outerPaint
      paint.alpha = (255f * (1f - (distance / 3.5f).coerceIn(0f, 0.68f))).roundToInt()
      val baseline = itemCenter - (paint.fontMetrics.ascent + paint.fontMetrics.descent) / 2f
      canvas.drawText("$value$suffix", width / 2f, baseline, paint.apply { textAlign = Paint.Align.CENTER })
    }
    centerPaint.alpha = 255
    outerPaint.alpha = 255
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        parent?.requestDisallowInterceptTouchEvent(true)
        cancelWheelMotion()
        downY = event.y
        lastY = event.y
        velocityTracker?.recycle()
        velocityTracker = android.view.VelocityTracker.obtain().also { it.addMovement(event) }
        isPressed = true
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        velocityTracker?.addMovement(event)
        dragOffset += event.y - lastY
        lastY = event.y
        normalizeDragOffset()
        invalidate()
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        velocityTracker?.addMovement(event)
        velocityTracker?.computeCurrentVelocity(1000)
        val velocity = velocityTracker?.yVelocity ?: 0f
        velocityTracker?.recycle()
        velocityTracker = null
        val isTap = event.actionMasked == MotionEvent.ACTION_UP &&
          abs(event.y - downY) < ViewConfiguration.get(context).scaledTouchSlop
        if (isTap) {
          tapUpY = event.y
          performClick()
        } else if (event.actionMasked == MotionEvent.ACTION_UP && abs(velocity) >= minimumFlingVelocity) {
          startInertia(velocity)
        } else {
          settleResidualOffset(motionGeneration)
        }
        isPressed = false
        parent?.requestDisallowInterceptTouchEvent(false)
        return true
      }
    }
    return super.onTouchEvent(event)
  }

  override fun performClick(): Boolean {
    super.performClick()
    val touchedRow = (tapUpY / itemHeightPx).toInt().coerceIn(0, CalendarQuickChooseContract.VISIBLE_WHEEL_ITEMS - 1)
    val rowOffset = touchedRow - CalendarQuickChooseContract.VISIBLE_WHEEL_ITEMS / 2
    val next = valueBySteps(selectedValue, rowOffset)
    if (next == selectedValue || rowOffset == 0) {
      settleResidualOffset(motionGeneration)
      return true
    }
    selectedValue = next
    dragOffset += rowOffset * itemHeightPx
    animateOffsetToCenter(motionGeneration)
    return true
  }

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    info.className = "android.widget.NumberPicker"
    info.text = "$selectedValue$suffix"
    info.isScrollable = true
    info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)
    info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD)
  }

  override fun performAccessibilityAction(action: Int, arguments: android.os.Bundle?): Boolean {
    val delta = when (action) {
      AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> 1
      AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> -1
      else -> return super.performAccessibilityAction(action, arguments)
    }
    val next = valueBySteps(selectedValue, delta)
    if (next == selectedValue) return false
    cancelWheelMotion()
    selectedValue = next
    dragOffset = 0f
    invalidate()
    dispatchSettledSelectionIfChanged()
    return true
  }

  override fun onDetachedFromWindow() {
    cancelWheelMotion()
    velocityTracker?.recycle()
    velocityTracker = null
    super.onDetachedFromWindow()
  }

  private fun normalizeDragOffset(): Boolean {
    var hitBoundary = false
    while (dragOffset <= -itemHeightPx) {
      val next = valueBySteps(selectedValue, 1)
      if (next == selectedValue) {
        dragOffset = -itemHeightPx / 2f
        hitBoundary = true
        break
      }
      selectedValue = next
      dragOffset += itemHeightPx
    }
    while (dragOffset >= itemHeightPx) {
      val next = valueBySteps(selectedValue, -1)
      if (next == selectedValue) {
        dragOffset = itemHeightPx / 2f
        hitBoundary = true
        break
      }
      selectedValue = next
      dragOffset -= itemHeightPx
    }
    return hitBoundary
  }

  private fun startInertia(initialVelocity: Float) {
    val generation = motionGeneration
    var velocity = initialVelocity.coerceIn(
      -CalendarQuickChooseContract.WHEEL_MAX_FLING_VELOCITY,
      CalendarQuickChooseContract.WHEEL_MAX_FLING_VELOCITY,
    )
    inertiaFuture = inertiaExecutor.scheduleWithFixedDelay(
      {
        if (generation != motionGeneration) return@scheduleWithFixedDelay
        if (abs(velocity) <= CalendarQuickChooseContract.WHEEL_STOP_FLING_VELOCITY) {
          post { finishInertia(generation) }
          return@scheduleWithFixedDelay
        }
        val delta = velocity * CalendarQuickChooseContract.WHEEL_FLING_DISTANCE_SAMPLE_MS / 1_000f
        velocity += if (velocity < 0f) {
          CalendarQuickChooseContract.WHEEL_FLING_DECELERATION_PER_TICK
        } else {
          -CalendarQuickChooseContract.WHEEL_FLING_DECELERATION_PER_TICK
        }
        post {
          if (generation != motionGeneration || inertiaFuture == null) return@post
          dragOffset += delta
          val hitBoundary = normalizeDragOffset()
          invalidate()
          if (hitBoundary) finishInertia(generation)
        }
      },
      0L,
      CalendarQuickChooseContract.WHEEL_INERTIA_TICK_MS,
      TimeUnit.MILLISECONDS,
    )
  }

  private fun finishInertia(generation: Int) {
    if (generation != motionGeneration) return
    val future = inertiaFuture ?: return
    future.cancel(true)
    inertiaFuture = null
    settleResidualOffset(generation)
  }

  private fun cancelWheelMotion() {
    motionGeneration += 1
    inertiaFuture?.cancel(true)
    inertiaFuture = null
    settleAnimator?.cancel()
    settleAnimator = null
  }

  private fun settleResidualOffset(generation: Int) {
    if (generation != motionGeneration) return
    if (dragOffset <= -itemHeightPx / 2f) {
      val next = valueBySteps(selectedValue, 1)
      if (next != selectedValue) {
        selectedValue = next
        dragOffset += itemHeightPx
      }
    } else if (dragOffset >= itemHeightPx / 2f) {
      val next = valueBySteps(selectedValue, -1)
      if (next != selectedValue) {
        selectedValue = next
        dragOffset -= itemHeightPx
      }
    }
    animateOffsetToCenter(generation)
  }

  private fun animateOffsetToCenter(generation: Int) {
    if (generation != motionGeneration) return
    val startOffset = dragOffset
    settleAnimator?.cancel()
    settleAnimator = ValueAnimator.ofFloat(startOffset, 0f).apply {
      duration = 150L
      addUpdateListener {
        if (generation != motionGeneration) return@addUpdateListener
        dragOffset = it.animatedValue as Float
        invalidate()
      }
      addListener(object : AnimatorListenerAdapter() {
        private var cancelled = false

        override fun onAnimationCancel(animation: Animator) {
          cancelled = true
        }

        override fun onAnimationEnd(animation: Animator) {
          if (cancelled || settleAnimator !== animation || generation != motionGeneration) return
          settleAnimator = null
          dragOffset = 0f
          invalidate()
          dispatchSettledSelectionIfChanged()
        }
      })
      start()
    }
  }

  private fun valueAtOffset(offset: Int): Int? {
    val raw = selectedValue + offset
    if (loop) return normalize(raw)
    return raw.takeIf { it in minimum..maximum }
  }

  private fun valueBySteps(value: Int, steps: Int): Int = normalize(value + steps)

  private fun normalize(value: Int): Int {
    if (!loop) return value.coerceIn(minimum, maximum)
    val count = maximum - minimum + 1
    return minimum + CalendarDateMath.floorMod(value - minimum, count)
  }

  private fun announceSelection() {
    contentDescription = "$selectedValue$suffix"
    announceForAccessibility(contentDescription)
  }

  private fun dispatchSettledSelectionIfChanged() {
    if (selectedValue == lastSettledValue) return
    lastSettledValue = selectedValue
    announceSelection()
    settledListener?.invoke(selectedValue)
  }

  companion object {
    private val inertiaExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "calendar-quick-choose-wheel").apply { isDaemon = true }
    }
  }
}

// QuickChooseDateMonthIndicator owns a real ViewPager2 with one source-derived month per page.
internal class CalendarQuickChooseDateView(context: Context) : LinearLayout(context) {
  private val palette = CalendarUi.palette(context)
  private var dateClickListener: ((Int) -> Unit)? = null
  private var pageMonthChangedListener: ((Int) -> Unit)? = null
  private var currentPosition = CalendarQuickChooseContract.DATE_PAGER_ANCHOR_POSITION
  private var selectedEpochDay = CalendarDateMath.toEpochDay(2000, 1, 1)
  private var dateData = CalendarQuickChooseDateData.EMPTY
  private val monthAdapter = CalendarQuickChooseMonthAdapter { dateClickListener?.invoke(it) }
  private val pager = ViewPager2(context).apply {
    orientation = ViewPager2.ORIENTATION_HORIZONTAL
    adapter = monthAdapter
    offscreenPageLimit = 1
    setCurrentItem(CalendarQuickChooseContract.DATE_PAGER_ANCHOR_POSITION, false)
  }
  private val pageCallback = object : ViewPager2.OnPageChangeCallback() {
    override fun onPageSelected(position: Int) {
      if (position == currentPosition) return
      currentPosition = position
      pageMonthChangedListener?.invoke(CalendarQuickChooseContract.datePagerMonthForPosition(position))
    }
  }

  init {
    orientation = VERTICAL
    val weekHeader = LinearLayout(context).apply { orientation = HORIZONTAL }
    CalendarUi.weekdayLabels().forEach { label ->
      weekHeader.addView(
        TextView(context).apply {
          text = label
          textSize = 12f
          gravity = Gravity.CENTER
          setTextColor(palette.textSecondary)
          importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        },
        LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f),
      )
    }
    addView(
      weekHeader,
      LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        CalendarUi.dp(context, CalendarQuickChooseContract.DATE_WEEK_HEADER_HEIGHT_DP).roundToInt(),
      ),
    )
    addView(pager, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    pager.registerOnPageChangeCallback(pageCallback)
  }

  fun setOnDateClickListener(listener: ((Int) -> Unit)?) {
    dateClickListener = listener
  }

  fun setOnPageMonthChangedListener(listener: ((Int) -> Unit)?) {
    pageMonthChangedListener = listener
  }

  fun setMonth(
    monthEpochDay: Int,
    selectedEpochDay: Int,
    data: CalendarQuickChooseDateData,
  ) {
    this.selectedEpochDay = selectedEpochDay
    dateData = data
    monthAdapter.update(selectedEpochDay, data)
    val position = CalendarQuickChooseContract.datePagerPositionForMonth(monthEpochDay)
    currentPosition = position
    if (pager.currentItem != position) pager.setCurrentItem(position, false)
    setViewportHeight(
      CalendarUi.dp(context, CalendarQuickChooseContract.dateContentHeightDp(monthEpochDay)).roundToInt(),
    )
  }

  fun setDateData(data: CalendarQuickChooseDateData) {
    dateData = data
    monthAdapter.update(selectedEpochDay, dateData)
  }

  fun setPagingEnabled(enabled: Boolean) {
    pager.isUserInputEnabled = enabled
  }

  fun pageBy(deltaMonths: Int) {
    if (deltaMonths == 0) return
    val target = (pager.currentItem.toLong() + deltaMonths)
      .coerceIn(0L, (CalendarQuickChooseContract.DATE_PAGER_ITEM_COUNT - 1).toLong())
      .toInt()
    pager.setCurrentItem(target, true)
  }

  fun setViewportHeight(height: Int) {
    layoutParams = (layoutParams ?: FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, height)).apply {
      this.height = height
    }
  }

  fun dispose() {
    pager.unregisterOnPageChangeCallback(pageCallback)
    dateClickListener = null
    pageMonthChangedListener = null
  }
}

private class CalendarQuickChooseMonthAdapter(
  private val onDateClick: (Int) -> Unit,
) : RecyclerView.Adapter<CalendarQuickChooseMonthAdapter.MonthViewHolder>() {
  private var selectedEpochDay = CalendarDateMath.toEpochDay(2000, 1, 1)
  private var dateData = CalendarQuickChooseDateData.EMPTY

  override fun getItemCount(): Int = CalendarQuickChooseContract.DATE_PAGER_ITEM_COUNT

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): MonthViewHolder = MonthViewHolder(
    CalendarQuickChooseMonthPageView(parent.context).apply {
      layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, RecyclerView.LayoutParams.MATCH_PARENT)
    },
  )

  override fun onBindViewHolder(holder: MonthViewHolder, position: Int) {
    holder.page.bind(
      CalendarQuickChooseContract.datePagerMonthForPosition(position),
      selectedEpochDay,
      dateData,
      onDateClick,
    )
  }

  fun update(selectedEpochDay: Int, data: CalendarQuickChooseDateData) {
    if (this.selectedEpochDay == selectedEpochDay && dateData == data) return
    this.selectedEpochDay = selectedEpochDay
    dateData = data
    notifyDataSetChanged()
  }

  class MonthViewHolder(val page: CalendarQuickChooseMonthPageView) : RecyclerView.ViewHolder(page)
}

private class CalendarQuickChooseMonthPageView(context: Context) : LinearLayout(context) {
  private val palette = CalendarUi.palette(context)

  init {
    orientation = VERTICAL
  }

  fun bind(
    monthEpochDay: Int,
    selectedEpochDay: Int,
    dateData: CalendarQuickChooseDateData,
    onDateClick: (Int) -> Unit,
  ) {
    removeAllViews()
    val monthStart = CalendarDateMath.monthStart(monthEpochDay)
    val month = CalendarDateMath.fromEpochDay(monthStart)
    val gridStart = CalendarDateMath.monthGridStart(monthStart)
    repeat(CalendarDateMath.monthWeekCount(monthStart)) { rowIndex ->
      val row = LinearLayout(context).apply { orientation = HORIZONTAL }
      repeat(7) { column ->
        val epochDay = gridStart + rowIndex * 7 + column
        val date = CalendarDateMath.fromEpochDay(epochDay)
        val cell = FrameLayout(context)
        if (date.year == month.year && date.month == month.month) {
          val isSelected = epochDay == selectedEpochDay
          val isToday = epochDay == dateData.todayEpochDay
          val eventCount = dateData.eventCount(epochDay)
          val dayView = TextView(context).apply {
            text = date.day.toString()
            textSize = 14f
            gravity = Gravity.CENTER
            setTextColor(
              when {
                isSelected -> palette.accentText
                isToday -> palette.accent
                else -> palette.textPrimary
              },
            )
            if (isSelected) background = CalendarUi.background(palette.accent, 15f, context)
            isClickable = true
            isFocusable = true
            this.isSelected = isSelected
            contentDescription = buildString {
              append("${date.year}年${date.month}月${date.day}日")
              if (isSelected) append("，已选择")
              if (isToday) append("，今天")
              if (eventCount > 0) append("，有${eventCount}个日程")
            }
            setOnClickListener { onDateClick(epochDay) }
          }
          cell.addView(
            dayView,
            FrameLayout.LayoutParams(
              CalendarUi.dp(context, 30f).roundToInt(),
              CalendarUi.dp(context, 30f).roundToInt(),
              Gravity.CENTER,
            ).apply { bottomMargin = CalendarUi.dp(context, 2f).roundToInt() },
          )
        }
        row.addView(cell, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
      }
      addView(
        row,
        LinearLayout.LayoutParams(
          LinearLayout.LayoutParams.MATCH_PARENT,
          CalendarUi.dp(context, CalendarQuickChooseContract.DATE_ROW_HEIGHT_DP).roundToInt(),
        ),
      )
    }
  }
}

internal enum class QuickChooseChevron { LEFT, RIGHT }

// CAL-PICKER-001 / CAL-PICKER-HOST-001: source icons are represented by semantic native chevrons.
internal class QuickChooseChevronView(context: Context, private val chevron: QuickChooseChevron) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = CalendarUi.palette(context).textSecondary
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 1.8f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }

  init {
    isClickable = true
    isFocusable = true
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val direction = if (chevron == QuickChooseChevron.RIGHT) 1f else -1f
    val centerX = width / 2f
    val centerY = height / 2f
    val horizontal = CalendarUi.dp(context, 3.5f) * direction
    val vertical = CalendarUi.dp(context, 4.5f)
    canvas.drawLine(centerX - horizontal, centerY - vertical, centerX + horizontal, centerY, paint)
    canvas.drawLine(centerX + horizontal, centerY, centerX - horizontal, centerY + vertical, paint)
  }
}

// CAL-PICKER-HOST-001: the 28dp drag owner is separate from transparent outside-hit handling.
internal class QuickChooseDragBarView(context: Context) : View(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = CalendarUi.palette(context).divider
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 2f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }

  init {
    setBackgroundColor(CalendarUi.palette(context).surface)
    contentDescription = "收起日期选择"
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    info.className = "android.widget.Button"
    info.addAction(AccessibilityNodeInfo.AccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, "收起"))
  }

  override fun performAccessibilityAction(action: Int, arguments: android.os.Bundle?): Boolean {
    if (action == AccessibilityNodeInfo.ACTION_CLICK) return performClick()
    return super.performAccessibilityAction(action, arguments)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val centerX = width / 2f
    val centerY = height / 2f
    val horizontal = CalendarUi.dp(context, 5f)
    val vertical = CalendarUi.dp(context, 3f)
    canvas.drawLine(centerX - horizontal, centerY + vertical, centerX, centerY - vertical, paint)
    canvas.drawLine(centerX, centerY - vertical, centerX + horizontal, centerY + vertical, paint)
  }
}

fun calendarContentLayoutParams(): FrameLayout.LayoutParams = FrameLayout.LayoutParams(
  FrameLayout.LayoutParams.MATCH_PARENT,
  FrameLayout.LayoutParams.MATCH_PARENT
)
