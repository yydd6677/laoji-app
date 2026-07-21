package com.laoji.nativeplatform.minutes

// MIN-DETAIL-STICKY-001: MmDetailStickyNavLayout.java:187-297 nested-scroll contract.

import android.content.Context
import android.view.View
import android.view.ViewGroup
import androidx.core.view.NestedScrollingParent2
import androidx.core.view.ViewCompat

internal interface MinutesDetailStickyListener {
  fun onNonTouchBoundary() = Unit
  fun onCollapseDirection() = Unit
  fun onExpandDirection() = Unit
  fun onBoundaryState(atTop: Boolean, headerVisible: Boolean) = Unit
  fun onCollapseOffsetChanged(offsetPx: Int) = Unit
}

internal class MinutesDetailStickyLayout(context: Context) : ViewGroup(context), NestedScrollingParent2 {
  private lateinit var header: View
  private lateinit var tabs: View
  private lateinit var pager: View
  private var nestedScrollAxes = ViewCompat.SCROLL_AXIS_NONE
  private var scrollEnabled = true
  private var forceHideTopView = false
  private var topViewNotScroll = false
  private var directionAccumulatorPx = 0
  private var trackingCollapseDirection = true
  private var listener: MinutesDetailStickyListener? = null

  internal var headerCollapseOffsetPx: Int = 0
    private set

  internal val headerMeasuredHeightPx: Int
    get() = if (::header.isInitialized) header.measuredHeight else 0

  internal val visibleHeaderHeightPx: Int
    get() = (headerMeasuredHeightPx - headerCollapseOffsetPx).coerceAtLeast(0)

  fun setOwners(header: View, tabs: View, pager: View) {
    check(childCount == 0) { "Minutes detail sticky owners can only be installed once" }
    this.header = header
    this.tabs = tabs
    this.pager = pager
    addView(header, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(tabs, LayoutParams(LayoutParams.MATCH_PARENT, context.dpRounded(MinutesDetailLayoutContract.TAB_BAR_HEIGHT_DP)))
    addView(pager, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setListener(listener: MinutesDetailStickyListener?) {
    this.listener = listener
  }

  fun setScrollEnabled(enabled: Boolean) {
    scrollEnabled = enabled
  }

  fun setForceHideTopView(force: Boolean) {
    forceHideTopView = force
    if (force) setHeaderCollapseOffset(headerMeasuredHeightPx)
  }

  fun setTopViewNotScroll(notScroll: Boolean) {
    topViewNotScroll = notScroll
    if (notScroll) setHeaderCollapseOffset(0)
  }

  fun restoreHeaderCollapseOffset(offsetPx: Int) {
    setHeaderCollapseOffset(offsetPx)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    if (!::header.isInitialized) {
      setMeasuredDimension(resolveSize(0, widthMeasureSpec), resolveSize(0, heightMeasureSpec))
      return
    }
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val height = MeasureSpec.getSize(heightMeasureSpec)
    val exactWidth = MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY)
    header.measure(exactWidth, MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    val maxCollapse = if (topViewNotScroll) 0 else header.measuredHeight
    headerCollapseOffsetPx = if (forceHideTopView) maxCollapse else headerCollapseOffsetPx.coerceIn(0, maxCollapse)
    val tabHeight = context.dpRounded(MinutesDetailLayoutContract.TAB_BAR_HEIGHT_DP)
    tabs.measure(exactWidth, MeasureSpec.makeMeasureSpec(tabHeight, MeasureSpec.EXACTLY))
    val pagerHeight = MinutesDetailLayoutContract.pagerHeightPx(
      stickyHeightPx = height,
      tabHeightPx = tabHeight,
    )
    pager.measure(exactWidth, MeasureSpec.makeMeasureSpec(pagerHeight, MeasureSpec.EXACTLY))
    setMeasuredDimension(resolveSize(width, widthMeasureSpec), resolveSize(height, heightMeasureSpec))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (!::header.isInitialized) return
    val width = right - left
    val headerTop = -headerCollapseOffsetPx
    header.layout(0, headerTop, width, headerTop + header.measuredHeight)
    val tabsTop = headerTop + header.measuredHeight
    tabs.layout(0, tabsTop, width, tabsTop + tabs.measuredHeight)
    val pagerTop = tabsTop + tabs.measuredHeight
    pager.layout(0, pagerTop, width, pagerTop + pager.measuredHeight)
  }

  override fun onStartNestedScroll(child: View, target: View, axes: Int, type: Int): Boolean =
    scrollEnabled && axes and ViewCompat.SCROLL_AXIS_VERTICAL != 0

  override fun onNestedScrollAccepted(child: View, target: View, axes: Int, type: Int) {
    nestedScrollAxes = axes
  }

  override fun onStopNestedScroll(target: View, type: Int) {
    nestedScrollAxes = ViewCompat.SCROLL_AXIS_NONE
  }

  override fun onNestedPreScroll(target: View, dx: Int, dy: Int, consumed: IntArray, type: Int) {
    if (!scrollEnabled) return
    parent?.requestDisallowInterceptTouchEvent(true)
    val headerHeight = if (topViewNotScroll) 0 else headerMeasuredHeightPx
    listener?.onBoundaryState(
      atTop = headerCollapseOffsetPx == 0,
      headerVisible = headerCollapseOffsetPx < headerHeight,
    )
    if (type == ViewCompat.TYPE_NON_TOUCH && headerCollapseOffsetPx == 0) {
      listener?.onNonTouchBoundary()
    }
    if (forceHideTopView && headerCollapseOffsetPx >= headerHeight) {
      if (type == ViewCompat.TYPE_NON_TOUCH) listener?.onNonTouchBoundary()
      return
    }
    val result = MinutesDetailLayoutContract.consumePreScroll(
      collapseOffsetPx = headerCollapseOffsetPx,
      headerHeightPx = headerHeight,
      deltaY = dy,
      childCanScrollUp = target.canScrollVertically(-1),
      forceHideTopView = forceHideTopView,
    )
    if (result.consumedY == 0) return
    setHeaderCollapseOffset(result.collapseOffsetPx)
    // Feishu consumes the whole nested-scroll frame even when scrollTo clamps at an edge.
    consumed[1] += result.consumedY
  }

  private fun setHeaderCollapseOffset(value: Int) {
    val maxCollapse = if (topViewNotScroll) 0 else headerMeasuredHeightPx
    val next = value.coerceIn(0, maxCollapse)
    if (next == headerCollapseOffsetPx) return
    val delta = next - headerCollapseOffsetPx
    headerCollapseOffsetPx = next
    accumulateDirection(delta)
    listener?.onCollapseOffsetChanged(next)
    if (ViewCompat.isLaidOut(this)) {
      header.offsetTopAndBottom(-delta)
      tabs.offsetTopAndBottom(-delta)
      pager.offsetTopAndBottom(-delta)
      invalidate()
    } else {
      requestLayout()
    }
  }

  private fun accumulateDirection(delta: Int) {
    val threshold = context.dp(DIRECTION_THRESHOLD_DP)
    if (trackingCollapseDirection && directionAccumulatorPx > threshold) {
      listener?.onCollapseDirection()
      trackingCollapseDirection = false
      directionAccumulatorPx = 0
    } else if (!trackingCollapseDirection && directionAccumulatorPx < -threshold) {
      listener?.onExpandDirection()
      trackingCollapseDirection = true
      directionAccumulatorPx = 0
    }
    if ((trackingCollapseDirection && delta > 0) || (!trackingCollapseDirection && delta < 0)) {
      directionAccumulatorPx += delta
    }
  }

  override fun onNestedScroll(
    target: View,
    dxConsumed: Int,
    dyConsumed: Int,
    dxUnconsumed: Int,
    dyUnconsumed: Int,
    type: Int,
  ) = Unit

  override fun onStartNestedScroll(child: View, target: View, axes: Int): Boolean =
    onStartNestedScroll(child, target, axes, ViewCompat.TYPE_TOUCH)

  override fun onNestedScrollAccepted(child: View, target: View, axes: Int) =
    onNestedScrollAccepted(child, target, axes, ViewCompat.TYPE_TOUCH)

  override fun onStopNestedScroll(target: View) = onStopNestedScroll(target, ViewCompat.TYPE_TOUCH)

  override fun onNestedPreScroll(target: View, dx: Int, dy: Int, consumed: IntArray) =
    onNestedPreScroll(target, dx, dy, consumed, ViewCompat.TYPE_TOUCH)

  override fun onNestedScroll(
    target: View,
    dxConsumed: Int,
    dyConsumed: Int,
    dxUnconsumed: Int,
    dyUnconsumed: Int,
  ) = onNestedScroll(target, dxConsumed, dyConsumed, dxUnconsumed, dyUnconsumed, ViewCompat.TYPE_TOUCH)

  override fun getNestedScrollAxes(): Int = nestedScrollAxes

  private companion object {
    const val DIRECTION_THRESHOLD_DP = 20
  }
}
