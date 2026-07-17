package com.laoji.nativeplatform.ui

// UI-SHELL-002 / UI-MOTION-001 / UI-ANDROID-COMPOSITION-001: tab roots own this bar internally.

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import android.view.animation.AccelerateInterpolator
import android.view.animation.Animation
import android.view.animation.ScaleAnimation
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

enum class NativeBottomTab(val wireName: String, val label: String) {
  SCHEDULE("schedule", "日程"),
  MEETINGS("meetings", "会议");

  companion object {
    fun fromWireName(value: String?): NativeBottomTab = entries.firstOrNull { it.wireName == value } ?: SCHEDULE
  }
}

private class NativeBottomTabItemView(
  context: Context,
  private val tab: NativeBottomTab,
  private val palette: NativeUiPalette,
  private val onClick: () -> Unit,
) : View(context) {
  private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = NativeUiTokens.dp(context, 1.7f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val labelPaint = NativeUiTokens.textPaint(context, palette.textSecondary, 12f)
  private var selected = false

  init {
    isClickable = true
    isFocusable = true
    minimumHeight = NativeUiTokens.dp(context, NativeUiTokens.ICON_HIT_SIZE_DP).toInt()
    contentDescription = tab.label
    setOnClickListener {
      startAnimation(
        ScaleAnimation(
          1f,
          0.8f,
          1f,
          0.8f,
          Animation.RELATIVE_TO_SELF,
          0.5f,
          Animation.RELATIVE_TO_SELF,
          0.5f,
        ).apply {
          duration = 125L
          interpolator = AccelerateInterpolator()
          repeatCount = 1
          repeatMode = Animation.REVERSE
        },
      )
      onClick()
    }
  }

  fun setItemSelected(value: Boolean) {
    if (selected == value) return
    selected = value
    refreshDrawableState()
    invalidate()
    contentDescription = if (selected) "${tab.label}，当前页面" else tab.label
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val centerX = width / 2f
    val iconCenterY = NativeUiTokens.dp(context, 18f)
    val iconColor = if (selected) palette.primary else palette.textSecondary
    iconPaint.color = iconColor
    labelPaint.color = iconColor
    drawIcon(canvas, centerX, iconCenterY, iconColor)
    val label = tab.label
    val baseline = NativeUiTokens.dp(context, 50f) - (labelPaint.ascent() + labelPaint.descent()) / 2f
    canvas.drawText(label, centerX - labelPaint.measureText(label) / 2f, baseline, labelPaint)
  }

  private fun drawIcon(canvas: Canvas, centerX: Float, centerY: Float, color: Int) {
    val unit = NativeUiTokens.dp(context, 1f)
    when (tab) {
      NativeBottomTab.SCHEDULE -> {
        val rect = RectF(
          centerX - unit * 9f,
          centerY - unit * 8f,
          centerX + unit * 9f,
          centerY + unit * 9f,
        )
        canvas.drawRoundRect(rect, unit * 2f, unit * 2f, iconPaint)
        canvas.drawLine(rect.left, centerY - unit * 2f, rect.right, centerY - unit * 2f, iconPaint)
        canvas.drawLine(centerX - unit * 4f, rect.top - unit, centerX - unit * 4f, rect.top + unit * 3f, iconPaint)
        canvas.drawLine(centerX + unit * 4f, rect.top - unit, centerX + unit * 4f, rect.top + unit * 3f, iconPaint)
        if (selected) {
          val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color; style = Paint.Style.FILL }
          canvas.drawCircle(centerX - unit * 4f, centerY + unit * 3f, unit * 1.2f, dot)
          canvas.drawCircle(centerX + unit * 1f, centerY + unit * 3f, unit * 1.2f, dot)
        }
      }
      NativeBottomTab.MEETINGS -> {
        val headRadius = unit * 3.5f
        canvas.drawCircle(centerX, centerY - unit * 4f, headRadius, iconPaint)
        canvas.drawArc(
          RectF(centerX - unit * 8f, centerY + unit, centerX + unit * 8f, centerY + unit * 10f),
          200f,
          140f,
          false,
          iconPaint,
        )
        if (selected) {
          canvas.drawCircle(centerX + unit * 8f, centerY + unit * 1f, unit * 2f, iconPaint)
        }
      }
    }
  }
}

class LaojiNativeBottomBarView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  private val palette = NativeUiTokens.palette(context)
  private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.divider }
  private var navigationInset = 0
  private var selectedTab = NativeBottomTab.SCHEDULE
  private var bridgeEventsEnabled = true
  private var tabPressListener: ((NativeBottomTab) -> Unit)? = null
  private val scheduleItem = NativeBottomTabItemView(context, NativeBottomTab.SCHEDULE, palette) {
    emitTabPress(NativeBottomTab.SCHEDULE)
  }
  private val meetingsItem = NativeBottomTabItemView(context, NativeBottomTab.MEETINGS, palette) {
    emitTabPress(NativeBottomTab.MEETINGS)
  }
  private val onTabPress by EventDispatcher<Map<String, Any?>>()

  init {
    setWillNotDraw(false)
    clipChildren = false
    clipToPadding = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    addView(scheduleItem)
    addView(meetingsItem)
    updateSelection()
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
      setOnApplyWindowInsetsListener { _, insets ->
        navigationInset = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
          insets.getInsets(android.view.WindowInsets.Type.navigationBars()).bottom
        } else {
          insets.systemWindowInsetBottom
        }
        requestLayout()
        insets
      }
      requestInsetsWhenAttached()
    }
  }

  fun setSelectedTab(value: String?) {
    selectedTab = NativeBottomTab.fromWireName(value)
    updateSelection()
  }

  fun setBridgeEventsEnabled(value: Boolean) {
    bridgeEventsEnabled = value
  }

  fun setTabPressListener(listener: ((NativeBottomTab) -> Unit)?) {
    tabPressListener = listener
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val contentHeight = NativeUiTokens.dp(context, NativeUiTokens.BOTTOM_BAR_HEIGHT_DP).toInt()
    val height = contentHeight + navigationInset
    setMeasuredDimension(width, resolveSize(height, heightMeasureSpec))
    val childWidth = width / 2
    scheduleItem.measure(
      MeasureSpec.makeMeasureSpec(childWidth, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(contentHeight, MeasureSpec.EXACTLY),
    )
    meetingsItem.measure(
      MeasureSpec.makeMeasureSpec(width - childWidth, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(contentHeight, MeasureSpec.EXACTLY),
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    val contentHeight = NativeUiTokens.dp(context, NativeUiTokens.BOTTOM_BAR_HEIGHT_DP).toInt()
    val split = width / 2
    scheduleItem.layout(0, 0, split, contentHeight)
    meetingsItem.layout(split, 0, width, contentHeight)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    canvas.drawColor(palette.surface)
    canvas.drawRect(0f, 0f, width.toFloat(), NativeUiTokens.dp(context, NativeUiTokens.DIVIDER_DP), dividerPaint)
  }

  private fun updateSelection() {
    scheduleItem.setItemSelected(selectedTab == NativeBottomTab.SCHEDULE)
    meetingsItem.setItemSelected(selectedTab == NativeBottomTab.MEETINGS)
  }

  private fun emitTabPress(tab: NativeBottomTab) {
    if (bridgeEventsEnabled) {
      onTabPress(mapOf("type" to "tabPress", "tab" to tab.wireName))
    }
    tabPressListener?.invoke(tab)
  }
}
