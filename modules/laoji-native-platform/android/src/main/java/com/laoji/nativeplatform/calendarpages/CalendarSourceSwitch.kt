package com.laoji.nativeplatform.calendarpages

// CAL-REPEAT-RRULE-001: source-shaped replacement for Universe Design UDSwitch.

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.widget.CompoundButton
import androidx.core.content.ContextCompat
import com.laoji.nativeplatform.R
import com.laoji.nativeplatform.evidence.FeishuEvidence
import kotlin.math.abs

@SuppressLint("ViewConstructor")
@FeishuEvidence("CAL-REPEAT-RRULE-001")
internal class CalendarSourceSwitch(context: Context) : CompoundButton(context) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val switchBounds = RectF()
  private val trackBounds = RectF()
  private var thumbPosition = 0f
  private var positionAnimator: ValueAnimator? = null
  private var externalCheckedChangeListener: OnCheckedChangeListener? = null
  private val velocityTracker = VelocityTracker.obtain()
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private val minimumFlingVelocity = ViewConfiguration.get(context).scaledMinimumFlingVelocity
  private var touchMode = TOUCH_MODE_IDLE
  private var touchX = 0f
  private var touchY = 0f

  init {
    buttonDrawable = null
    gravity = Gravity.CENTER_VERTICAL
    isClickable = true
    isFocusable = true
  }

  override fun setChecked(checked: Boolean) {
    super.setChecked(checked)
    animateThumb(if (isChecked) 1f else 0f)
  }

  override fun setOnCheckedChangeListener(listener: OnCheckedChangeListener?) {
    super.setOnCheckedChangeListener(listener)
    externalCheckedChangeListener = listener
  }

  fun setCheckedIgnoreEvent(checked: Boolean) {
    val listener = externalCheckedChangeListener
    if (listener == null) {
      setChecked(checked)
      return
    }
    super.setOnCheckedChangeListener(null)
    setChecked(checked)
    super.setOnCheckedChangeListener(listener)
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    velocityTracker.addMovement(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (isEnabled && isPointInThumb(event.x, event.y)) {
          touchMode = TOUCH_MODE_DOWN
          touchX = event.x
          touchY = event.y
        }
      }

      MotionEvent.ACTION_MOVE -> when (touchMode) {
        TOUCH_MODE_DOWN -> {
          if (abs(event.x - touchX) > touchSlop || abs(event.y - touchY) > touchSlop) {
            touchMode = TOUCH_MODE_DRAGGING
            parent?.requestDisallowInterceptTouchEvent(true)
            touchX = event.x
            touchY = event.y
            return true
          }
        }

        TOUCH_MODE_DRAGGING -> {
          val range = thumbScrollRange()
          val delta = if (range == 0f) {
            if (event.x > touchX) 1f else -1f
          } else {
            (event.x - touchX) / range
          }
          val directionalDelta = if (layoutDirection == View.LAYOUT_DIRECTION_RTL) -delta else delta
          val next = (thumbPosition + directionalDelta).coerceIn(0f, 1f)
          if (next != thumbPosition) {
            touchX = event.x
            thumbPosition = next
            invalidate()
          }
          return true
        }
      }

      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (touchMode == TOUCH_MODE_DRAGGING) {
          finishDrag(event)
          super.onTouchEvent(event)
          return true
        }
        touchMode = TOUCH_MODE_IDLE
        velocityTracker.clear()
      }
    }
    return super.onTouchEvent(event)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val desiredWidth = paddingLeft + context.pageDp(TRACK_WIDTH_DP) + paddingRight
    val desiredHeight = paddingTop + context.pageDp(SWITCH_HEIGHT_DP) + paddingBottom
    setMeasuredDimension(
      resolveSize(desiredWidth, widthMeasureSpec),
      resolveSize(desiredHeight, heightMeasureSpec),
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    updateSwitchBounds()
  }

  override fun onRtlPropertiesChanged(layoutDirection: Int) {
    super.onRtlPropertiesChanged(layoutDirection)
    requestLayout()
    invalidate()
  }

  private fun updateSwitchBounds() {
    val switchWidth = context.pageDp(TRACK_WIDTH_DP).toFloat()
    val switchHeight = context.pageDp(SWITCH_HEIGHT_DP).toFloat()
    val switchLeft = if (layoutDirection == View.LAYOUT_DIRECTION_RTL) {
      paddingLeft.toFloat()
    } else {
      width - paddingRight - switchWidth
    }
    val switchTop = when (gravity and Gravity.VERTICAL_GRAVITY_MASK) {
      Gravity.BOTTOM -> height - paddingBottom - switchHeight
      Gravity.TOP -> paddingTop.toFloat()
      else -> ((paddingTop + height - paddingBottom) / 2f) - (switchHeight / 2f)
    }
    switchBounds.set(switchLeft, switchTop, switchLeft + switchWidth, switchTop + switchHeight)
    val trackInset = context.pageDp(TRACK_VERTICAL_PADDING_DP).toFloat()
    trackBounds.set(
      switchBounds.left,
      switchBounds.top + trackInset,
      switchBounds.right,
      switchBounds.bottom - trackInset,
    )
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val thumbSize = context.pageDp(THUMB_SIZE_DP).toFloat()

    paint.color = color(
      when {
        !isEnabled && isChecked -> R.color.laoji_ud_switch_on_disabled_track
        !isEnabled -> R.color.laoji_ud_switch_off_disabled_track
        isChecked -> R.color.laoji_ud_switch_on_track
        else -> R.color.laoji_ud_switch_off_track
      },
    )
    canvas.drawRoundRect(trackBounds, trackBounds.height() / 2f, trackBounds.height() / 2f, paint)

    val thumbLeft = switchBounds.left + thumbOffset()
    paint.color = color(
      when {
        !isEnabled && isChecked -> R.color.laoji_ud_switch_on_disabled_thumb
        !isEnabled -> R.color.laoji_ud_switch_off_disabled_thumb
        isChecked -> R.color.laoji_ud_switch_on_thumb
        else -> R.color.laoji_ud_switch_off_thumb
      },
    )
    canvas.drawCircle(
      thumbLeft + thumbSize / 2f,
      switchBounds.centerY(),
      thumbSize / 2f,
      paint,
    )
  }

  override fun jumpDrawablesToCurrentState() {
    super.jumpDrawablesToCurrentState()
    positionAnimator?.takeIf(ValueAnimator::isStarted)?.end()
    positionAnimator = null
  }

  override fun onDetachedFromWindow() {
    positionAnimator?.cancel()
    positionAnimator = null
    touchMode = TOUCH_MODE_IDLE
    velocityTracker.clear()
    super.onDetachedFromWindow()
  }

  internal fun switchBoundsForTest(): RectF = RectF(switchBounds)

  internal fun thumbPositionForTest(): Float = thumbPosition

  private fun finishDrag(event: MotionEvent) {
    val commit = event.actionMasked == MotionEvent.ACTION_UP && isEnabled
    val target = if (commit) {
      velocityTracker.computeCurrentVelocity(1_000)
      val xVelocity = velocityTracker.xVelocity
      if (abs(xVelocity) > minimumFlingVelocity) {
        if (layoutDirection == View.LAYOUT_DIRECTION_RTL) xVelocity < 0f else xVelocity > 0f
      } else {
        thumbPosition > 0.5f
      }
    } else {
      isChecked
    }
    touchMode = TOUCH_MODE_IDLE
    setChecked(target)
    val cancelEvent = MotionEvent.obtain(event)
    cancelEvent.action = MotionEvent.ACTION_CANCEL
    super.onTouchEvent(cancelEvent)
    cancelEvent.recycle()
    velocityTracker.clear()
  }

  private fun isPointInThumb(x: Float, y: Float): Boolean {
    val thumbSize = context.pageDp(THUMB_SIZE_DP).toFloat()
    val thumbLeft = switchBounds.left + thumbOffset()
    return x > thumbLeft - touchSlop &&
      x < thumbLeft + thumbSize &&
      y > switchBounds.top - touchSlop &&
      y < switchBounds.bottom + touchSlop
  }

  private fun thumbOffset(): Float {
    val logicalPosition = if (layoutDirection == View.LAYOUT_DIRECTION_RTL) 1f - thumbPosition else thumbPosition
    return logicalPosition * thumbScrollRange()
  }

  private fun thumbScrollRange(): Float = (
    context.pageDp(TRACK_WIDTH_DP) - context.pageDp(THUMB_SIZE_DP)
  ).coerceAtLeast(0).toFloat()

  private fun animateThumb(target: Float) {
    positionAnimator?.cancel()
    positionAnimator = null
    if (!isLaidOut || windowToken == null) {
      thumbPosition = target
      invalidate()
      return
    }
    positionAnimator = ValueAnimator.ofFloat(thumbPosition, target).apply {
      duration = ANIMATION_DURATION_MS
      addUpdateListener {
        thumbPosition = it.animatedValue as Float
        invalidate()
      }
      start()
    }
  }

  private fun color(resource: Int): Int = ContextCompat.getColor(context, resource)

  companion object {
    const val TRACK_WIDTH_DP = 36f
    const val TRACK_HEIGHT_DP = 14f
    const val THUMB_SIZE_DP = 20f
    const val SWITCH_HEIGHT_DP = 20f
    const val HOST_HEIGHT_DP = 24f
    const val TRACK_VERTICAL_PADDING_DP = 3f
    const val ANIMATION_DURATION_MS = 250L

    private const val TOUCH_MODE_IDLE = 0
    private const val TOUCH_MODE_DOWN = 1
    private const val TOUCH_MODE_DRAGGING = 2
  }
}
