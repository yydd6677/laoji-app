package com.laoji.nativeplatform.minutes

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.PointF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.view.animation.AccelerateInterpolator
import android.view.animation.OvershootInterpolator
import com.laoji.nativeplatform.evidence.FeishuEvidence
import java.lang.ref.WeakReference
import kotlin.math.abs
import kotlin.math.max

/** Source-shaped counterpart of MinutesListItemView -> SwipeMenuLayout. */
@FeishuEvidence("MIN-ROOT-001")
internal class MinutesSwipeMenuLayout @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
) : ViewGroup(context, attrs) {
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
  private val minimumFlingVelocity = ViewConfiguration.get(context).scaledMinimumFlingVelocity
  private val touchStart = PointF()
  private var lastRawX = 0f
  private var dragging = false
  private var closeOnTap = false
  private var menuWidth = 0
  private var velocityTracker: VelocityTracker? = null
  private var settleAnimator: ValueAnimator? = null

  val isMenuOpen: Boolean
    get() = menuWidth > 0 && scrollX == menuWidth

  init {
    isClickable = true
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    if (childCount != 2) {
      setMeasuredDimension(resolveSize(0, widthMeasureSpec), resolveSize(0, heightMeasureSpec))
      return
    }
    val content = getChildAt(0)
    measureChildWithMargins(content, widthMeasureSpec, 0, heightMeasureSpec, 0)
    val measuredWidth = resolveSize(content.measuredWidth + paddingLeft + paddingRight, widthMeasureSpec)
    val contentHeight = content.measuredHeight
    val exactContentHeight = MeasureSpec.makeMeasureSpec(contentHeight, MeasureSpec.EXACTLY)
    val menu = getChildAt(1)
    measureChildWithMargins(menu, widthMeasureSpec, 0, exactContentHeight, 0)
    val previousMenuWidth = menuWidth
    menuWidth = menu.measuredWidth
    setMeasuredDimension(
      measuredWidth,
      resolveSize(max(contentHeight, menu.measuredHeight) + paddingTop + paddingBottom, heightMeasureSpec),
    )
    if (previousMenuWidth != menuWidth && scrollX > 0) {
      scrollTo(menuWidth, 0)
    }
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (childCount != 2) return
    val content = getChildAt(0)
    val contentLeft = paddingLeft
    val contentTop = paddingTop
    content.layout(
      contentLeft,
      contentTop,
      contentLeft + content.measuredWidth,
      contentTop + content.measuredHeight,
    )
    val menu = getChildAt(1)
    val menuLeft = contentLeft + content.measuredWidth
    menu.layout(menuLeft, contentTop, menuLeft + menu.measuredWidth, contentTop + menu.measuredHeight)
  }

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        settleAnimator?.cancel()
        dragging = false
        closeOnTap = false
        touchStart.set(event.rawX, event.rawY)
        lastRawX = event.rawX
        resetVelocityTracker(event)
        val other = openRow?.get()
        if (other != null && other !== this) other.closeMenu()
        if (scrollX > touchSlop && event.x < width - scrollX) {
          closeOnTap = true
          return true
        }
      }

      MotionEvent.ACTION_MOVE -> {
        velocityTracker?.addMovement(event)
        val dx = event.rawX - touchStart.x
        val dy = event.rawY - touchStart.y
        if (!dragging && abs(dx) > touchSlop && abs(dx) > abs(dy) && !(scrollX == 0 && dx > 0f)) {
          dragging = true
          parent?.requestDisallowInterceptTouchEvent(true)
          return true
        }
      }

      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (dragging || closeOnTap) return true
        recycleVelocityTracker()
      }
    }
    return super.onInterceptTouchEvent(event)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    velocityTracker?.addMovement(event)
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> return true

      MotionEvent.ACTION_MOVE -> {
        if (closeOnTap) return true
        val delta = (lastRawX - event.rawX).toInt()
        lastRawX = event.rawX
        scrollTo((scrollX + delta).coerceIn(0, menuWidth), 0)
        return true
      }

      MotionEvent.ACTION_UP -> {
        if (closeOnTap) {
          closeMenu()
        } else {
          velocityTracker?.computeCurrentVelocity(1000)
          val xVelocity = velocityTracker?.xVelocity ?: 0f
          when {
            xVelocity >= minimumFlingVelocity -> closeMenu()
            xVelocity <= -minimumFlingVelocity -> openMenu()
            scrollX > menuWidth / 5 -> openMenu()
            else -> closeMenu()
          }
        }
        recycleVelocityTracker()
        dragging = false
        closeOnTap = false
        parent?.requestDisallowInterceptTouchEvent(false)
        return true
      }

      MotionEvent.ACTION_CANCEL -> {
        if (scrollX > menuWidth / 5) openMenu() else closeMenu()
        recycleVelocityTracker()
        dragging = false
        closeOnTap = false
        parent?.requestDisallowInterceptTouchEvent(false)
        return true
      }
    }
    return super.onTouchEvent(event)
  }

  fun openMenu() {
    if (menuWidth <= 0) return
    val other = openRow?.get()
    if (other != null && other !== this) other.closeMenu()
    openRow = WeakReference(this)
    animateScrollTo(menuWidth, OPEN_DURATION_MS, OvershootInterpolator())
    updateMenuAccessibility(open = true)
  }

  fun closeMenu(animated: Boolean = true) {
    if (openRow?.get() === this) openRow = null
    if (!animated) {
      settleAnimator?.cancel()
      scrollTo(0, 0)
    } else if (scrollX != 0) {
      animateScrollTo(0, CLOSE_DURATION_MS, AccelerateInterpolator())
    }
    updateMenuAccessibility(open = false)
  }

  override fun onDetachedFromWindow() {
    if (openRow?.get() === this) openRow = null
    settleAnimator?.cancel()
    recycleVelocityTracker()
    super.onDetachedFromWindow()
  }

  override fun generateDefaultLayoutParams(): LayoutParams =
    MarginLayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)

  override fun generateLayoutParams(attrs: AttributeSet): LayoutParams = MarginLayoutParams(context, attrs)

  override fun generateLayoutParams(params: LayoutParams): LayoutParams = MarginLayoutParams(params)

  override fun checkLayoutParams(params: LayoutParams): Boolean = params is MarginLayoutParams

  private fun animateScrollTo(target: Int, durationMs: Long, interpolator: android.animation.TimeInterpolator) {
    settleAnimator?.cancel()
    settleAnimator = ValueAnimator.ofInt(scrollX, target).apply {
      duration = durationMs
      this.interpolator = interpolator
      addUpdateListener { scrollTo((it.animatedValue as Int).coerceIn(0, menuWidth), 0) }
      start()
    }
  }

  private fun updateMenuAccessibility(open: Boolean) {
    if (childCount < 2) return
    getChildAt(1).importantForAccessibility = if (open) {
      View.IMPORTANT_FOR_ACCESSIBILITY_YES
    } else {
      View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }
  }

  private fun resetVelocityTracker(event: MotionEvent) {
    recycleVelocityTracker()
    velocityTracker = VelocityTracker.obtain().also { it.addMovement(event) }
  }

  private fun recycleVelocityTracker() {
    velocityTracker?.recycle()
    velocityTracker = null
  }

  companion object {
    private const val OPEN_DURATION_MS = 300L
    private const val CLOSE_DURATION_MS = 200L
    private var openRow: WeakReference<MinutesSwipeMenuLayout>? = null

    fun closeOpenMenu() {
      openRow?.get()?.closeMenu()
      openRow = null
    }
  }
}
