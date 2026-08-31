package com.laoji.nativeplatform.calendarpages

// CAL-PICKER-WHEEL-TAP-001 / CAL-REPEAT-RRULE-001: this is reconstructed from
// Calendar's pickerview.WheelView, not the separate flat Universe wheel family.

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.InputDevice
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.DecelerateInterpolator
import android.widget.OverScroller
import com.laoji.nativeplatform.ui.LaojiThemeTypography
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

internal data class CalendarEditWheelGeometry(
  val textHeightPx: Float,
  val itemHeightPx: Float,
  val measuredHeightPx: Int,
  val radiusPx: Float,
  val firstLineY: Float,
  val secondLineY: Float,
)

internal object CalendarEditWheelContract {
  const val VISIBLE_ITEM_COUNT = 7
  const val LINE_SPACING_MULTIPLIER = 2.5f
  const val CENTER_SCALE = 1.176f
  const val OUTER_ALPHA_POWER = 2.2f
  const val SHORT_TAP_MS = 120L
  const val MAX_FLING_VELOCITY = 2_000
  const val EDGE_OVERSCROLL_RATIO = 0.25f

  fun geometry(textHeightPx: Float): CalendarEditWheelGeometry {
    require(textHeightPx > 0f)
    val itemHeight = textHeightPx * LINE_SPACING_MULTIPLIER
    val measuredHeight = (itemHeight * (VISIBLE_ITEM_COUNT - 1) * 2f / PI.toFloat()).toInt()
    val radius = measuredHeight / 2f
    return CalendarEditWheelGeometry(
      textHeightPx = textHeightPx,
      itemHeightPx = itemHeight,
      measuredHeightPx = measuredHeight,
      radiusPx = radius,
      firstLineY = (measuredHeight - itemHeight) / 2f,
      secondLineY = (measuredHeight + itemHeight) / 2f,
    )
  }

  fun rowTop(slot: Int, remainderPx: Float, geometry: CalendarEditWheelGeometry): Float {
    val radians = (geometry.itemHeightPx * slot - remainderPx) / geometry.radiusPx
    return (
      geometry.radiusPx - cos(radians) * geometry.radiusPx -
        sin(radians) * geometry.textHeightPx / 2f +
        (sin(radians) - 1f) * geometry.textHeightPx
      )
  }

  fun shortTapOffset(
    touchY: Float,
    scrollPositionPx: Float,
    geometry: CalendarEditWheelGeometry,
  ): Float {
    val y = touchY.coerceIn(0f, geometry.measuredHeightPx.toFloat())
    val cosine = ((geometry.radiusPx - y) / geometry.radiusPx).coerceIn(-1f, 1f)
    val arcLength = acos(cosine) * geometry.radiusPx
    val slot = ((arcLength + geometry.itemHeightPx / 2f) / geometry.itemHeightPx).toInt()
    return (slot - VISIBLE_ITEM_COUNT / 2) * geometry.itemHeightPx -
      positiveModulo(scrollPositionPx, geometry.itemHeightPx)
  }

  fun nearestSnapOffset(scrollPositionPx: Float, itemHeightPx: Float): Float {
    val remainder = positiveModulo(scrollPositionPx, itemHeightPx)
    return if (remainder > itemHeightPx / 2f) itemHeightPx - remainder else -remainder
  }

  fun outerAlpha(angleDegrees: Float): Int {
    val fade = (abs(angleDegrees) / 90f).coerceIn(0f, 1f).pow(OUTER_ALPHA_POWER)
    return ((1f - fade) * 255f).roundToInt()
  }

  private fun positiveModulo(value: Float, modulus: Float): Float = ((value % modulus) + modulus) % modulus
}

internal class CalendarEditWheelView(context: Context) : View(context) {
  private val paletteReady = CalendarPagePalette.configure(context)
  private val baseTextSizePx = sp(17f)
  private val outerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = CalendarPagePalette.placeholder
    textAlign = Paint.Align.CENTER
    textSize = baseTextSizePx
    typeface = LaojiThemeTypography.typeface(context, Typeface.NORMAL)
  }
  private val centerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = CalendarPagePalette.text
    textAlign = Paint.Align.CENTER
    textSize = baseTextSizePx * CalendarEditWheelContract.CENTER_SCALE
    textScaleX = CalendarEditWheelContract.CENTER_SCALE
    typeface = LaojiThemeTypography.typeface(context, Typeface.NORMAL)
  }
  private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = CalendarPagePalette.divider
    strokeWidth = context.pageDp(0.5f).coerceAtLeast(1).toFloat()
  }
  private val scroller = OverScroller(context)
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private val minimumFlingVelocity = ViewConfiguration.get(context).scaledMinimumFlingVelocity
  private val maximumFlingVelocity = ViewConfiguration.get(context).scaledMaximumFlingVelocity
  private var geometry = measureGeometry()
  private var minimum = 0
  private var maximum = 0
  private var looping = false
  private var role = "滚轮"
  private var labelProvider: (Int) -> String = { it.toString() }
  private var settledListener: ((Int) -> Unit)? = null
  private var scrollPositionPx = 0f
  private var downRawY = 0f
  private var lastRawY = 0f
  private var downTimeMs = 0L
  private var dragged = false
  private var velocityTracker: VelocityTracker? = null
  private var snapAnimator: ValueAnimator? = null
  private var inertiaRunning = false
  private var settledValue = 0

  val selectedValue: Int
    get() = valueForVirtualIndex((scrollPositionPx / geometry.itemHeightPx).roundToInt())

  init {
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    setLayerType(LAYER_TYPE_SOFTWARE, null)
    isVerticalFadingEdgeEnabled = false
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
    settledListener = onSettled
    settledValue = minimum
    scrollPositionPx = 0f
    refreshAccessibilityLabel()
    requestLayout()
    invalidate()
  }

  fun setValue(value: Int) {
    cancelMotion()
    val normalized = normalizeValue(value)
    scrollPositionPx = (normalized - minimum) * geometry.itemHeightPx
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

  internal fun geometryForTest(): CalendarEditWheelGeometry = geometry

  internal fun centerTextSizeForTest(): Float = centerPaint.textSize

  internal fun outerTextSizeForTest(): Float = outerPaint.textSize

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    geometry = measureGeometry()
    val desiredWidth = MeasureSpec.getSize(widthMeasureSpec).takeIf { it > 0 } ?: suggestedMinimumWidth
    setMeasuredDimension(
      resolveSize(desiredWidth, widthMeasureSpec),
      resolveSize(geometry.measuredHeightPx, heightMeasureSpec),
    )
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (itemCount <= 0 || width <= 0 || height <= 0) return
    canvas.drawLine(0f, geometry.firstLineY, width.toFloat(), geometry.firstLineY, dividerPaint)
    canvas.drawLine(0f, geometry.secondLineY, width.toFloat(), geometry.secondLineY, dividerPaint)

    val itemHeight = geometry.itemHeightPx
    val centerVirtualIndex = floor(scrollPositionPx / itemHeight).toInt()
    val remainder = scrollPositionPx - centerVirtualIndex * itemHeight
    for (slot in 0 until CalendarEditWheelContract.VISIBLE_ITEM_COUNT) {
      val virtualIndex = centerVirtualIndex - CalendarEditWheelContract.VISIBLE_ITEM_COUNT / 2 + slot
      val value = valueForVirtualIndexOrNull(virtualIndex) ?: continue
      val radians = (itemHeight * slot - remainder) / geometry.radiusPx
      val angle = 90f - Math.toDegrees(radians.toDouble()).toFloat()
      if (angle !in -90f..90f) continue
      val label = labelProvider(value)
      fitText(label)
      val rowTop = CalendarEditWheelContract.rowTop(slot, remainder, geometry)
      drawProjectedRow(canvas, label, rowTop, angle)
    }
    resetPaints()
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        parent?.requestDisallowInterceptTouchEvent(true)
        cancelMotion()
        canonicalizeLoopPosition()
        downRawY = event.rawY
        lastRawY = event.rawY
        downTimeMs = event.eventTime
        dragged = false
        velocityTracker?.recycle()
        velocityTracker = VelocityTracker.obtain().also { it.addMovement(event) }
        isPressed = true
        return true
      }

      MotionEvent.ACTION_MOVE -> {
        velocityTracker?.addMovement(event)
        val delta = lastRawY - event.rawY
        lastRawY = event.rawY
        if (abs(event.rawY - downRawY) > touchSlop) dragged = true
        scrollPositionPx += delta
        constrainPosition(allowEdgeOverscroll = true)
        invalidate()
        return true
      }

      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        velocityTracker?.addMovement(event)
        velocityTracker?.computeCurrentVelocity(1_000, maximumFlingVelocity.toFloat())
        val velocityY = velocityTracker?.yVelocity ?: 0f
        velocityTracker?.recycle()
        velocityTracker = null
        val shortTap = event.actionMasked == MotionEvent.ACTION_UP &&
          !dragged && event.eventTime - downTimeMs <= CalendarEditWheelContract.SHORT_TAP_MS
        when {
          event.actionMasked == MotionEvent.ACTION_CANCEL -> startSnap()
          dragged && abs(velocityY) >= minimumFlingVelocity -> startInertia((-velocityY).roundToInt())
          shortTap -> startSnap(CalendarEditWheelContract.shortTapOffset(event.y, scrollPositionPx, geometry))
          else -> startSnap()
        }
        isPressed = false
        if (shortTap) performClick()
        parent?.requestDisallowInterceptTouchEvent(false)
        return true
      }
    }
    return super.onTouchEvent(event)
  }

  override fun onGenericMotionEvent(event: MotionEvent): Boolean {
    if (event.isFromSource(InputDevice.SOURCE_CLASS_POINTER) && event.action == MotionEvent.ACTION_SCROLL) {
      cancelMotion()
      scrollPositionPx += -event.getAxisValue(MotionEvent.AXIS_VSCROLL) * geometry.itemHeightPx
      constrainPosition(allowEdgeOverscroll = true)
      startSnap()
      return true
    }
    return super.onGenericMotionEvent(event)
  }

  override fun computeScroll() {
    if (!inertiaRunning) return
    if (scroller.computeScrollOffset()) {
      scrollPositionPx = scroller.currY.toFloat()
      constrainPosition(allowEdgeOverscroll = false)
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
    val virtualIndex = (scrollPositionPx / geometry.itemHeightPx).roundToInt() + delta
    scrollPositionPx = virtualIndex * geometry.itemHeightPx
    finishSelection()
    return true
  }

  override fun onDetachedFromWindow() {
    cancelMotion()
    velocityTracker?.recycle()
    velocityTracker = null
    super.onDetachedFromWindow()
  }

  private fun drawProjectedRow(canvas: Canvas, label: String, rowTop: Float, angle: Float) {
    val rowBottom = rowTop + geometry.textHeightPx
    val first = geometry.firstLineY
    val second = geometry.secondLineY
    canvas.save()
    canvas.translate(0f, rowTop)
    when {
      rowTop <= first && rowBottom >= first -> {
        drawClippedOuter(canvas, label, 0f, first - rowTop)
        drawClippedCenter(canvas, label, first - rowTop, geometry.itemHeightPx)
      }

      rowTop <= second && rowBottom >= second -> {
        drawClippedCenter(canvas, label, 0f, second - rowTop)
        drawClippedOuter(canvas, label, second - rowTop, geometry.itemHeightPx)
      }

      rowTop >= first && rowBottom <= second -> drawCenter(canvas, label)

      else -> drawOuter(canvas, label, angle)
    }
    canvas.restore()
  }

  private fun drawClippedOuter(canvas: Canvas, label: String, top: Float, bottom: Float) {
    canvas.save()
    canvas.clipRect(0f, top, width.toFloat(), bottom)
    outerPaint.alpha = 255
    outerPaint.textSkewX = 0f
    canvas.drawText(label, width / 2f, geometry.textHeightPx, outerPaint)
    canvas.restore()
  }

  private fun drawClippedCenter(canvas: Canvas, label: String, top: Float, bottom: Float) {
    canvas.save()
    canvas.clipRect(0f, top, width.toFloat(), bottom)
    centerPaint.alpha = 255
    canvas.drawText(label, width / 2f, geometry.textHeightPx - centerBaselineOffset(), centerPaint)
    canvas.restore()
  }

  private fun drawCenter(canvas: Canvas, label: String) {
    canvas.save()
    canvas.scale(1f, CalendarEditWheelContract.CENTER_SCALE)
    centerPaint.alpha = 255
    canvas.drawText(
      label,
      width / 2f,
      geometry.textHeightPx * 0.916f - centerBaselineOffset(),
      centerPaint,
    )
    canvas.restore()
  }

  private fun drawOuter(canvas: Canvas, label: String, angle: Float) {
    canvas.save()
    canvas.clipRect(0f, 0f, width.toFloat(), geometry.itemHeightPx)
    outerPaint.alpha = CalendarEditWheelContract.outerAlpha(angle)
    outerPaint.textSkewX = 0f
    canvas.drawText(label, width / 2f, geometry.textHeightPx, outerPaint)
    canvas.restore()
  }

  private fun fitText(label: String) {
    outerPaint.textSize = baseTextSizePx
    centerPaint.textSize = baseTextSizePx * CalendarEditWheelContract.CENTER_SCALE
    val availableWidth = width.toFloat().coerceAtLeast(1f)
    while (
      maxOf(outerPaint.measureText(label), centerPaint.measureText(label)) > availableWidth &&
      outerPaint.textSize > 1f
    ) {
      outerPaint.textSize -= 1f
      centerPaint.textSize = outerPaint.textSize * CalendarEditWheelContract.CENTER_SCALE
    }
  }

  private fun resetPaints() {
    outerPaint.alpha = 255
    outerPaint.textSkewX = 0f
    outerPaint.textSize = baseTextSizePx
    centerPaint.alpha = 255
    centerPaint.textSize = baseTextSizePx * CalendarEditWheelContract.CENTER_SCALE
  }

  private fun startInertia(rawVelocityY: Int) {
    canonicalizeLoopPosition()
    val velocityY = rawVelocityY.coerceIn(
      -CalendarEditWheelContract.MAX_FLING_VELOCITY,
      CalendarEditWheelContract.MAX_FLING_VELOCITY,
    )
    val start = scrollPositionPx.roundToInt()
    val maxPosition = ((itemCount - 1) * geometry.itemHeightPx).roundToInt()
    val loopExtent = (itemCount * geometry.itemHeightPx * LOOP_FLING_RANGES).roundToInt()
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

  private fun startSnap(offset: Float = CalendarEditWheelContract.nearestSnapOffset(
    scrollPositionPx,
    geometry.itemHeightPx,
  )) {
    val start = scrollPositionPx
    val unboundedTarget = start + offset
    val target = if (looping) {
      unboundedTarget
    } else {
      unboundedTarget.coerceIn(0f, (itemCount - 1) * geometry.itemHeightPx)
    }
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
        constrainPosition(allowEdgeOverscroll = false)
        invalidate()
      }
      addListener(object : AnimatorListenerAdapter() {
        private var cancelled = false

        override fun onAnimationCancel(animation: Animator) {
          cancelled = true
        }

        override fun onAnimationEnd(animation: Animator) {
          if (snapAnimator === animation) snapAnimator = null
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

  private fun constrainPosition(allowEdgeOverscroll: Boolean) {
    if (looping) return
    val overscroll = if (allowEdgeOverscroll) {
      geometry.itemHeightPx * CalendarEditWheelContract.EDGE_OVERSCROLL_RATIO
    } else {
      0f
    }
    scrollPositionPx = scrollPositionPx.coerceIn(
      -overscroll,
      (itemCount - 1) * geometry.itemHeightPx + overscroll,
    )
  }

  private fun canonicalizeLoopPosition() {
    if (!looping) {
      constrainPosition(allowEdgeOverscroll = false)
      return
    }
    scrollPositionPx = (selectedValue - minimum) * geometry.itemHeightPx
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

  private fun measureGeometry(): CalendarEditWheelGeometry {
    val bounds = Rect()
    centerPaint.getTextBounds("星期", 0, 2, bounds)
    return CalendarEditWheelContract.geometry((bounds.height() + 2).toFloat())
  }

  private fun centerBaselineOffset(): Float {
    val density = resources.displayMetrics.density
    return when {
      density < 1f -> 2.4f
      density < 2f -> 3.6f
      density < 3f -> 6f
      else -> density * 2.5f
    }
  }

  private fun sp(value: Float): Float =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)

  private val itemCount: Int
    get() = maximum - minimum + 1

  companion object {
    const val VISIBLE_ITEM_COUNT = CalendarEditWheelContract.VISIBLE_ITEM_COUNT
    const val SNAP_DURATION_MS = 120L
    private const val LOOP_FLING_RANGES = 256
  }
}
