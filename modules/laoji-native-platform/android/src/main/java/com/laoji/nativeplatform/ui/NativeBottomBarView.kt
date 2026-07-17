package com.laoji.nativeplatform.ui

// UI-SHELL-BOTTOM-MAIN-001 / UI-ANDROID-COMPOSITION-001: active native roots
// own a source-shaped main bottom bar. Exact retained-destination glyphs remain
// blocked by UI-ICON-PRIMITIVES-001.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.os.Build
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.animation.AccelerateInterpolator
import android.view.animation.Animation
import android.view.animation.ScaleAnimation
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import com.laoji.nativeplatform.evidence.FeishuEvidence
import com.laoji.nativeplatform.evidence.FeishuEvidenceRuntime
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

@SuppressLint("ViewConstructor")
@FeishuEvidence("UI-SHELL-BOTTOM-MAIN-001")
private class NativeBottomTabItemView(
  context: Context,
  private val tab: NativeBottomTab,
  private val palette: NativeUiPalette,
  private val onClick: () -> Unit,
) : FrameLayout(context) {
  private val selectedColor = Color.rgb(20, 86, 240)
  private val iconDrawable = NativeBottomTabIconDrawable(tab, palette.textSecondary, selectedColor)
  private val iconContainer = FrameLayout(context).apply {
    clipChildren = false
    clipToPadding = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }
  private val icon = ImageView(context).apply {
    scaleType = ImageView.ScaleType.CENTER
    setImageDrawable(iconDrawable)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }
  private val label = TextView(context).apply {
    text = tab.label
    textSize = NativeBottomBarContract.LABEL_TEXT_SP
    gravity = Gravity.CENTER
    setTextColor(palette.textSecondary)
    val horizontalPadding = dp(NativeBottomBarContract.LABEL_HORIZONTAL_PADDING_DP)
    setPadding(horizontalPadding, 0, horizontalPadding, 0)
    isSingleLine = true
    ellipsize = TextUtils.TruncateAt.END
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }
  private val selectAnimation = ScaleAnimation(
    NativeBottomBarContract.PRESS_SCALE_FROM,
    NativeBottomBarContract.PRESS_SCALE_TO,
    NativeBottomBarContract.PRESS_SCALE_FROM,
    NativeBottomBarContract.PRESS_SCALE_TO,
    Animation.RELATIVE_TO_SELF,
    0.5f,
    Animation.RELATIVE_TO_SELF,
    0.5f,
  ).apply {
    duration = NativeBottomBarContract.PRESS_LEG_DURATION_MS
    interpolator = AccelerateInterpolator()
    repeatCount = 1
    repeatMode = Animation.REVERSE
  }
  private var selectionAnimationPlayCount = 0

  init {
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    contentDescription = tab.label
    minimumHeight = dp(NativeBottomBarContract.CONTENT_HEIGHT_DP)
    clipChildren = false
    clipToPadding = false

    FeishuEvidenceRuntime.bind(this, "UI-SHELL-BOTTOM-MAIN-001", "tab", "bottom-tab-${tab.wireName}")
    FeishuEvidenceRuntime.bind(
      iconContainer,
      "UI-SHELL-BOTTOM-MAIN-001",
      "icon-container",
      "bottom-tab-${tab.wireName}-icon-container",
    )
    FeishuEvidenceRuntime.bind(icon, "UI-SHELL-BOTTOM-MAIN-001", "icon", "bottom-tab-${tab.wireName}-icon")
    FeishuEvidenceRuntime.bind(label, "UI-SHELL-BOTTOM-MAIN-001", "label", "bottom-tab-${tab.wireName}-label")

    iconContainer.addView(
      icon,
      LayoutParams(dp(NativeBottomBarContract.ICON_SIZE_DP), dp(NativeBottomBarContract.ICON_SIZE_DP), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL),
    )
    addView(
      iconContainer,
      LayoutParams(
        dp(NativeBottomBarContract.ICON_CONTAINER_WIDTH_DP),
        dp(NativeBottomBarContract.ICON_CONTAINER_HEIGHT_DP),
        Gravity.TOP or Gravity.CENTER_HORIZONTAL,
      ).apply { topMargin = dp(NativeBottomBarContract.ICON_CONTAINER_TOP_DP) },
    )
    addView(
      label,
      LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
        topMargin = dp(NativeBottomBarContract.LABEL_TOP_DP)
      },
    )
    setOnClickListener { onClick() }
  }

  fun setItemSelected(value: Boolean, animateSelection: Boolean = false) {
    if (!value) icon.clearAnimation()
    isSelected = value
    icon.isSelected = value
    label.isSelected = value
    iconDrawable.setSelected(value)
    label.setTextColor(if (value) selectedColor else palette.textSecondary)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      stateDescription = if (value) "当前页面" else null
    }
    if (value && animateSelection) {
      icon.clearAnimation()
      selectAnimation.reset()
      selectionAnimationPlayCount += 1
      icon.startAnimation(selectAnimation)
    }
  }

  internal fun selectionAnimationPlayCount(): Int = selectionAnimationPlayCount

  override fun onDetachedFromWindow() {
    icon.clearAnimation()
    super.onDetachedFromWindow()
  }

  private fun dp(value: Float): Int =
    NativeBottomBarContract.dpToPx(value, resources.displayMetrics.density)
}

// UI-ICON-PRIMITIVES-001: slot and state are source-shaped; these neutral
// destination glyph paths remain an explicit release blocker until that closure.
private class NativeBottomTabIconDrawable(
  private val tab: NativeBottomTab,
  private val normalColor: Int,
  private val selectedColor: Int,
) : Drawable() {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private var selected = false

  fun setSelected(value: Boolean) {
    if (selected == value) return
    selected = value
    invalidateSelf()
  }

  override fun draw(canvas: Canvas) {
    val scale = minOf(bounds.width(), bounds.height()) / NativeBottomBarContract.ICON_SIZE_DP
    val centerX = bounds.exactCenterX()
    val centerY = bounds.exactCenterY()
    paint.color = if (selected) selectedColor else normalColor
    paint.strokeWidth = 1.7f * scale
    when (tab) {
      NativeBottomTab.SCHEDULE -> drawSchedule(canvas, centerX, centerY, scale)
      NativeBottomTab.MEETINGS -> drawMeetings(canvas, centerX, centerY, scale)
    }
  }

  private fun drawSchedule(canvas: Canvas, centerX: Float, centerY: Float, scale: Float) {
    val rect = RectF(centerX - 9f * scale, centerY - 8f * scale, centerX + 9f * scale, centerY + 9f * scale)
    canvas.drawRoundRect(rect, 2f * scale, 2f * scale, paint)
    canvas.drawLine(rect.left, centerY - 2f * scale, rect.right, centerY - 2f * scale, paint)
    canvas.drawLine(centerX - 4f * scale, rect.top - scale, centerX - 4f * scale, rect.top + 3f * scale, paint)
    canvas.drawLine(centerX + 4f * scale, rect.top - scale, centerX + 4f * scale, rect.top + 3f * scale, paint)
  }

  private fun drawMeetings(canvas: Canvas, centerX: Float, centerY: Float, scale: Float) {
    canvas.drawCircle(centerX, centerY - 4f * scale, 3.5f * scale, paint)
    canvas.drawArc(
      RectF(centerX - 8f * scale, centerY + scale, centerX + 8f * scale, centerY + 10f * scale),
      200f,
      140f,
      false,
      paint,
    )
  }

  override fun setAlpha(alpha: Int) {
    paint.alpha = alpha
    invalidateSelf()
  }

  override fun setColorFilter(colorFilter: ColorFilter?) {
    paint.colorFilter = colorFilter
    invalidateSelf()
  }

  @Deprecated("Deprecated in Java")
  override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

@SuppressLint("ViewConstructor")
@FeishuEvidence("UI-SHELL-BOTTOM-MAIN-001")
class LaojiNativeBottomBarView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  private val palette = NativeUiTokens.palette(context)
  private var navigationInset = 0
  private var selectedTab = NativeBottomTab.SCHEDULE
  private val selectionCommandGate = NativeBottomBarSelectionCommandGate()
  private var bridgeEventsEnabled = true
  private var tabPressListener: ((NativeBottomTab) -> Unit)? = null
  private val divider = View(context).apply {
    setBackgroundColor(palette.divider)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }
  private val scheduleItem = NativeBottomTabItemView(context, NativeBottomTab.SCHEDULE, palette) {
    emitTabPress(NativeBottomTab.SCHEDULE)
  }
  private val meetingsItem = NativeBottomTabItemView(context, NativeBottomTab.MEETINGS, palette) {
    emitTabPress(NativeBottomTab.MEETINGS)
  }
  private val onTabPress by EventDispatcher<Map<String, Any?>>()

  init {
    setWillNotDraw(false)
    setBackgroundColor(palette.surface)
    clipChildren = false
    clipToPadding = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    FeishuEvidenceRuntime.bind(this, "UI-SHELL-BOTTOM-MAIN-001", "navigation", "bottom-bar")
    FeishuEvidenceRuntime.bind(divider, "UI-SHELL-BOTTOM-MAIN-001", "divider", "bottom-bar-divider")
    addView(divider)
    addView(scheduleItem)
    addView(meetingsItem)
    updateSelection(animateTab = null)
    setOnApplyWindowInsetsListener { _, insets ->
      navigationInset = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        insets.getInsets(android.view.WindowInsets.Type.navigationBars()).bottom
      } else {
        @Suppress("DEPRECATION")
        insets.systemWindowInsetBottom
      }
      requestLayout()
      insets
    }
    requestInsetsWhenAttached()
  }

  fun setSelectedTab(value: String?) {
    selectedTab = NativeBottomTab.fromWireName(value)
    updateSelection(animateTab = null)
  }

  fun setSelectionAnimationCommand(command: Int?) {
    if (!selectionCommandGate.accept(command)) return
    post { updateSelection(animateTab = selectedTab) }
  }

  internal fun selectedAnimationPlayCount(): Int = when (selectedTab) {
    NativeBottomTab.SCHEDULE -> scheduleItem.selectionAnimationPlayCount()
    NativeBottomTab.MEETINGS -> meetingsItem.selectionAnimationPlayCount()
  }

  fun setBridgeEventsEnabled(value: Boolean) {
    bridgeEventsEnabled = value
  }

  fun setTabPressListener(listener: ((NativeBottomTab) -> Unit)?) {
    tabPressListener = listener
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val contentHeight = dp(NativeBottomBarContract.CONTENT_HEIGHT_DP)
    val dividerHeight = NativeBottomBarContract.DIVIDER_HEIGHT_PX
    val desiredHeight = dividerHeight + contentHeight + navigationInset
    setMeasuredDimension(resolveSize(width, widthMeasureSpec), resolveSize(desiredHeight, heightMeasureSpec))
    divider.measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(dividerHeight, MeasureSpec.EXACTLY),
    )
    val split = width / 2
    scheduleItem.measure(
      MeasureSpec.makeMeasureSpec(split, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(contentHeight, MeasureSpec.EXACTLY),
    )
    meetingsItem.measure(
      MeasureSpec.makeMeasureSpec(width - split, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(contentHeight, MeasureSpec.EXACTLY),
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    val dividerHeight = NativeBottomBarContract.DIVIDER_HEIGHT_PX
    val contentHeight = dp(NativeBottomBarContract.CONTENT_HEIGHT_DP)
    val split = width / 2
    divider.layout(0, 0, width, dividerHeight)
    scheduleItem.layout(0, dividerHeight, split, dividerHeight + contentHeight)
    meetingsItem.layout(split, dividerHeight, width, dividerHeight + contentHeight)
  }

  private fun updateSelection(animateTab: NativeBottomTab?) {
    scheduleItem.setItemSelected(
      selectedTab == NativeBottomTab.SCHEDULE,
      animateSelection = animateTab == NativeBottomTab.SCHEDULE,
    )
    meetingsItem.setItemSelected(
      selectedTab == NativeBottomTab.MEETINGS,
      animateSelection = animateTab == NativeBottomTab.MEETINGS,
    )
  }

  private fun emitTabPress(tab: NativeBottomTab) {
    if (bridgeEventsEnabled) {
      onTabPress(mapOf("type" to "tabPress", "tab" to tab.wireName))
    }
    tabPressListener?.invoke(tab)
  }

  private fun dp(value: Float): Int =
    NativeBottomBarContract.dpToPx(value, resources.displayMetrics.density)
}
