package com.laoji.nativeplatform.calendarpages

// CAL-EDIT-TIME-001: source-style wheel drawing, fling inertia, final snap and a11y actions.

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.DecelerateInterpolator
import android.widget.OverScroller
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt

internal class CalendarEditWheelView(context: Context) : View(context) {
  private val centerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = CalendarPagePalette.text
    textAlign = Paint.Align.CENTER
    textSize = sp(17f)
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
  }
  private val outerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = CalendarPagePalette.secondary
    textAlign = Paint.Align.CENTER
    textSize = sp(14f)
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
  }
  private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = CalendarPagePalette.divider
    strokeWidth = context.pageDp(0.5f).coerceAtLeast(1).toFloat()
  }
  private val itemHeightPx = context.pageDp(ITEM_HEIGHT_DP).toFloat()
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private val minimumFlingVelocity = ViewConfiguration.get(context).scaledMinimumFlingVelocity
  private val maximumFlingVelocity = ViewConfiguration.get(context).scaledMaximumFlingVelocity
  private val scroller = OverScroller(context)
  private var minimum = 0
  private var maximum = 0
  private var looping = false
  private var role = "滚轮"
  private var labelProvider: (Int) -> String = { it.toString() }
  private var settledListener: ((Int) -> Unit)? = null
  private var scrollPositionPx = 0f
  private var downY = 0f
  private var lastY = 0f
  private var velocityTracker: VelocityTracker? = null
  private var snapAnimator: ValueAnimator? = null
  private var inertiaRunning = false
  private var settledValue = 0

  val selectedValue: Int
    get() = valueForVirtualIndex((scrollPositionPx / itemHeightPx).roundToInt())

  init {
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  fun configure(
    minimum: Int,
    maximum: Int,
    looping: Boolean,
    role: String,
    labelProvider: (Int) -> String,
    onSettled: (Int) -> Unit,
  ) {
    require(minimum <= maximum)
    cancelMotion()
    this.minimum = minimum
    this.maximum = maximum
    this.looping = looping
    this.role = role
    this.labelProvider = labelProvider
    this.settledListener = onSettled
    settledValue = minimum
    scrollPositionPx = 0f
    refreshAccessibilityLabel()
    invalidate()
  }

  fun setValue(value: Int) {
    cancelMotion()
    val normalized = normalizeValue(value)
    scrollPositionPx = (normalized - minimum) * itemHeightPx
    settledValue = normalized
    refreshAccessibilityLabel()
    invalidate()
  }

  fun dispose() {
    cancelMotion()
    velocityTracker?.recycle()
    velocityTracker = null
    settledListener = null
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val desiredHeight = context.pageDp(ITEM_HEIGHT_DP * VISIBLE_ITEM_COUNT)
    setMeasuredDimension(
      resolveSize(suggestedMinimumWidth, widthMeasureSpec),
      resolveSize(desiredHeight, heightMeasureSpec),
    )
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val centerY = height / 2f
    val halfItem = itemHeightPx / 2f
    canvas.drawLine(0f, centerY - halfItem, width.toFloat(), centerY - halfItem, dividerPaint)
    canvas.drawLine(0f, centerY + halfItem, width.toFloat(), centerY + halfItem, dividerPaint)

    val centerVirtualIndex = floor(scrollPositionPx / itemHeightPx).toInt()
    for (virtualIndex in (centerVirtualIndex - 4)..(centerVirtualIndex + 4)) {
      val value = valueForVirtualIndexOrNull(virtualIndex) ?: continue
      val itemCenter = centerY + virtualIndex * itemHeightPx - scrollPositionPx
      if (itemCenter < -itemHeightPx || itemCenter > height + itemHeightPx) continue
      val distance = abs(itemCenter - centerY) / itemHeightPx
      val paint = if (distance < 0.5f) centerPaint else outerPaint
      paint.alpha = (255f * (1f - (distance / 4f).coerceIn(0f, 0.72f))).roundToInt()
      val baseline = itemCenter - (paint.fontMetrics.ascent + paint.fontMetrics.descent) / 2f
      canvas.drawText(labelProvider(value), width / 2f, baseline, paint)
    }
    centerPaint.alpha = 255
    outerPaint.alpha = 255
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        parent?.requestDisallowInterceptTouchEvent(true)
        cancelMotion()
        canonicalizeLoopPosition()
        downY = event.y
        lastY = event.y
        velocityTracker?.recycle()
        velocityTracker = VelocityTracker.obtain().also { it.addMovement(event) }
        isPressed = true
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        velocityTracker?.addMovement(event)
        val delta = event.y - lastY
        lastY = event.y
        scrollPositionPx -= delta
        constrainPosition()
        invalidate()
        return true
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        velocityTracker?.addMovement(event)
        velocityTracker?.computeCurrentVelocity(1000, maximumFlingVelocity.toFloat())
        val velocityY = velocityTracker?.yVelocity ?: 0f
        velocityTracker?.recycle()
        velocityTracker = null
        if (event.actionMasked == MotionEvent.ACTION_UP && abs(velocityY) >= minimumFlingVelocity) {
          startInertia((-velocityY).roundToInt())
        } else {
          startSnap()
        }
        isPressed = false
        if (abs(event.y - downY) <= touchSlop) performClick()
        parent?.requestDisallowInterceptTouchEvent(false)
        return true
      }
    }
    return super.onTouchEvent(event)
  }

  override fun computeScroll() {
    if (!inertiaRunning) return
    if (scroller.computeScrollOffset()) {
      scrollPositionPx = scroller.currY.toFloat()
      constrainPosition()
      invalidate()
      if (!scroller.isFinished) {
        postInvalidateOnAnimation()
        return
      }
    }
    inertiaRunning = false
    startSnap()
  }

  override fun performClick(): Boolean = super.performClick()

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    val value = selectedValue
    val label = labelProvider(value)
    info.className = javaClass.name
    info.text = label
    info.contentDescription = "$role，当前$label"
    info.isScrollable = itemCount > 1
    if (!looping) {
      info.rangeInfo = AccessibilityNodeInfo.RangeInfo.obtain(
        AccessibilityNodeInfo.RangeInfo.RANGE_TYPE_INT,
        minimum.toFloat(),
        maximum.toFloat(),
        value.toFloat(),
      )
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) info.stateDescription = label
    if (canStep(1)) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)
    if (canStep(-1)) info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD)
  }

  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
    val delta = when (action) {
      AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> 1
      AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> -1
      else -> return super.performAccessibilityAction(action, arguments)
    }
    if (!canStep(delta)) return false
    cancelMotion()
    val virtualIndex = (scrollPositionPx / itemHeightPx).roundToInt() + delta
    scrollPositionPx = virtualIndex * itemHeightPx
    finishSelection()
    return true
  }

  override fun onDetachedFromWindow() {
    cancelMotion()
    velocityTracker?.recycle()
    velocityTracker = null
    super.onDetachedFromWindow()
  }

  private fun startInertia(velocityY: Int) {
    canonicalizeLoopPosition()
    val start = scrollPositionPx.roundToInt()
    val maxPosition = ((itemCount - 1) * itemHeightPx).roundToInt()
    val loopExtent = (itemCount * itemHeightPx * LOOP_FLING_RANGES).roundToInt()
    scroller.fling(
      0,
      start,
      0,
      velocityY,
      0,
      0,
      if (looping) -loopExtent else 0,
      if (looping) loopExtent else maxPosition,
    )
    inertiaRunning = true
    postInvalidateOnAnimation()
  }

  private fun startSnap() {
    val target = (scrollPositionPx / itemHeightPx).roundToInt() * itemHeightPx
    val start = scrollPositionPx
    if (abs(target - start) < 0.5f) {
      scrollPositionPx = target
      finishSelection()
      return
    }
    snapAnimator?.cancel()
    snapAnimator = ValueAnimator.ofFloat(start, target).apply {
      duration = SNAP_DURATION_MS
      interpolator = DecelerateInterpolator()
      addUpdateListener {
        scrollPositionPx = it.animatedValue as Float
        constrainPosition()
        invalidate()
      }
      addListener(object : AnimatorListenerAdapter() {
        private var cancelled = false

        override fun onAnimationCancel(animation: Animator) {
          cancelled = true
        }

        override fun onAnimationEnd(animation: Animator) {
          snapAnimator = null
          if (!cancelled) finishSelection()
        }
      })
      start()
    }
  }

  private fun finishSelection() {
    canonicalizeLoopPosition()
    val value = selectedValue
    refreshAccessibilityLabel()
    invalidate()
    if (value == settledValue) return
    settledValue = value
    sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_SELECTED)
    announceForAccessibility(labelProvider(value))
    settledListener?.invoke(value)
  }

  private fun cancelMotion() {
    inertiaRunning = false
    if (!scroller.isFinished) scroller.abortAnimation()
    snapAnimator?.cancel()
    snapAnimator = null
  }

  private fun constrainPosition() {
    if (looping) return
    scrollPositionPx = scrollPositionPx.coerceIn(0f, (itemCount - 1) * itemHeightPx)
  }

  private fun canonicalizeLoopPosition() {
    if (!looping) {
      constrainPosition()
      return
    }
    scrollPositionPx = (selectedValue - minimum) * itemHeightPx
  }

  private fun canStep(delta: Int): Boolean = when {
    itemCount <= 1 -> false
    looping -> true
    else -> selectedValue + delta in minimum..maximum
  }

  private fun normalizeValue(value: Int): Int {
    if (!looping) return value.coerceIn(minimum, maximum)
    return minimum + Math.floorMod(value - minimum, itemCount)
  }

  private fun valueForVirtualIndex(index: Int): Int =
    valueForVirtualIndexOrNull(index) ?: if (index < 0) minimum else maximum

  private fun valueForVirtualIndexOrNull(index: Int): Int? {
    if (!looping && index !in 0 until itemCount) return null
    return minimum + if (looping) Math.floorMod(index, itemCount) else index
  }

  private fun refreshAccessibilityLabel() {
    val label = labelProvider(selectedValue)
    contentDescription = "$role，当前$label"
  }

  private fun sp(value: Float): Float =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)

  private val itemCount: Int
    get() = maximum - minimum + 1

  companion object {
    const val VISIBLE_ITEM_COUNT = 7
    const val ITEM_HEIGHT_DP = 40
    const val SNAP_DURATION_MS = 120L
    private const val LOOP_FLING_RANGES = 256
  }
}
