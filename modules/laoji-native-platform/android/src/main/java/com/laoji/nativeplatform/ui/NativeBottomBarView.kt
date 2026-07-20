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
import android.graphics.Path
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
import androidx.core.graphics.PathParser
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

// UI-ICON-PRIMITIVES-001: the retained Meetings destination uses the source
// Minutes tab silhouette while LaoJi keeps its own Chinese product label.
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
  private val meetingsPath: Path = requireNotNull(PathParser.createPathFromPathData(
    "M10.466 8.146l-3.444 7.402a0.831 0.831 0 0 1-1.104 0.403l-3.514-1.639A0.831 0.831 0 0 1 2 13.21l3.443-7.4a2.77 2.77 0 0 1 5.022 2.337zm-2.017 6.743l1.212 3.33a2.489 2.489 0 0 0 3.189 1.489l0.012-0.005a2.478 2.478 0 0 0 1.018-0.695c0.15-0.163 0.277-0.351 0.376-0.562l3.309-7.096a2.216 2.216 0 0 0-4.016-1.873l-0.988 2.119-1.133-3.113-2.98 6.406zm10.599-1.307l0.784-1.681a1.662 1.662 0 1 1 3.011 1.405l-2.492 5.345a1.946 1.946 0 0 1-1.13 1.081l-0.027 0.01a1.939 1.939 0 0 1-2.485-1.159l-0.654-1.797 2.336-5.009 0.657 1.805zM5.544 18.187l-2.986 1.57a0.564 0.564 0 0 1-0.815-0.38l-0.729-3.302a0.565 0.565 0 0 1 0.791-0.635l3.715 1.734a0.566 0.566 0 0 1 0.024 1.013z",
  ))
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
    val saved = canvas.save()
    canvas.translate(bounds.left.toFloat(), bounds.top.toFloat())
    canvas.scale(bounds.width() / 24f, bounds.height() / 24f)
    paint.style = Paint.Style.FILL
    canvas.drawPath(meetingsPath, paint)
    paint.style = Paint.Style.STROKE
    canvas.restoreToCount(saved)
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
  private var navigationInset = currentNavigationBarInsetBottom()
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
      val nextNavigationInset = insets.navigationBarInsetBottom()
      if (navigationInset != nextNavigationInset) {
        navigationInset = nextNavigationInset
        requestLayout()
      }
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
