package com.laoji.nativeplatform.calendarpages

// UI-TITLE-COMMON-001: source-shaped CommonTitleBar primitive for the retained
// calendar detail/edit/time families only. Main calendar, search and Minutes
// title systems have separate source owners and must not reuse this class.

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.os.SystemClock
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.DrawableCompat
import kotlin.math.max
import kotlin.math.min

internal object CalendarCommonTitleBarContract {
  const val FULL_SCREEN_HEIGHT_DP = 44f
  const val BOTTOM_SHEET_HEIGHT_DP = 56f
  const val MAIN_TITLE_SP = 18f
  const val ACTION_TEXT_SP = 17f
  const val SECONDARY_TITLE_SP = 17f
  const val SUBTITLE_SP = 12f
  const val NORMAL_ICON_DP = 24f
  const val SMALL_ICON_DP = 20f
  const val NORMAL_RIGHT_SLOT_DP = 48f
  const val SMALL_RIGHT_SLOT_DP = 44f
  const val OUTER_PADDING_DP = 15f
  const val RIGHT_ACTION_START_PADDING_DP = 9f
  const val RIGHT_ACTION_END_PADDING_DP = 15f
  const val LEFT_TEXT_END_PADDING_DP = 8f
  const val MIN_SIDE_PADDING_DP = 8f
  const val DETAIL_TITLE_START_PADDING_DP = 9f
  const val DETAIL_TITLE_BASE_END_PADDING_DP = 42f
  const val DIVIDER_HEIGHT_PX = 1
  const val ACTION_DEBOUNCE_MS = 1_000L

  fun dpToPx(value: Float, density: Float): Int = (value * density + 0.5f).toInt()

  fun fullScreenHeightPx(context: Context): Int =
    dpToPx(FULL_SCREEN_HEIGHT_DP, context.resources.displayMetrics.density)

  data class CenterBounds(val left: Int, val right: Int)

  fun centerBounds(
    totalWidth: Int,
    measuredCenterWidth: Int,
    leftVisibleWidth: Int,
    rightVisibleWidth: Int,
    minSidePadding: Int,
    centerAlways: Boolean = false,
    leftAligned: Boolean = false,
  ): CenterBounds {
    val width = totalWidth.coerceAtLeast(0)
    val leftOccupied = (leftVisibleWidth.coerceAtLeast(0) + minSidePadding).coerceAtMost(width)
    val rightOccupied = (rightVisibleWidth.coerceAtLeast(0) + minSidePadding).coerceAtMost(width)
    val centerWidth = measuredCenterWidth.coerceIn(0, width)

    if (leftAligned) {
      val left = leftOccupied
      return CenterBounds(left, (left + centerWidth).coerceAtMost(width))
    }

    if (centerAlways) {
      val side = max(leftOccupied, rightOccupied).coerceAtMost(width / 2)
      return CenterBounds(side, width - side)
    }

    val midpoint = width / 2
    val leftRoom = midpoint - leftOccupied
    val rightRoom = midpoint - rightOccupied
    val symmetricRoom = min(leftRoom, rightRoom).coerceAtLeast(0) * 2
    val proposedLeft = when {
      centerWidth <= symmetricRoom -> midpoint - centerWidth / 2
      leftRoom > rightRoom -> width - centerWidth - rightOccupied
      else -> leftOccupied
    }
    val left = proposedLeft.coerceIn(0, (width - centerWidth).coerceAtLeast(0))
    return CenterBounds(left, left + centerWidth)
  }
}

internal class CalendarTitleClickGate(
  private val nowMs: () -> Long = SystemClock::uptimeMillis,
) {
  private var lastAcceptedAt = 0L

  fun run(block: () -> Unit): Boolean {
    val now = nowMs()
    if (now - lastAcceptedAt <= CalendarCommonTitleBarContract.ACTION_DEBOUNCE_MS) return false
    block()
    lastAcceptedAt = now
    return true
  }
}

internal enum class CalendarTitleIconSize(
  val iconDp: Float,
  val rightSlotDp: Float,
) {
  NORMAL(
    CalendarCommonTitleBarContract.NORMAL_ICON_DP,
    CalendarCommonTitleBarContract.NORMAL_RIGHT_SLOT_DP,
  ),
  SMALL(
    CalendarCommonTitleBarContract.SMALL_ICON_DP,
    CalendarCommonTitleBarContract.SMALL_RIGHT_SLOT_DP,
  ),
}

internal enum class CalendarTitleSaveType {
  ENABLE_SAVE,
  DISABLE_SAVE_WITH_FEEDBACK,
  DISABLE_SAVE_TOTALLY,
}

internal object CalendarTitleSaveContract {
  fun resolve(
    loadState: CalendarPageLoadState,
    saving: Boolean,
    draftValid: Boolean,
  ): CalendarTitleSaveType = when {
    loadState != CalendarPageLoadState.READY || saving -> CalendarTitleSaveType.DISABLE_SAVE_TOTALLY
    draftValid -> CalendarTitleSaveType.ENABLE_SAVE
    else -> CalendarTitleSaveType.DISABLE_SAVE_WITH_FEEDBACK
  }

  fun color(type: CalendarTitleSaveType): Int = when (type) {
    CalendarTitleSaveType.ENABLE_SAVE -> CalendarPagePalette.primary
    CalendarTitleSaveType.DISABLE_SAVE_WITH_FEEDBACK -> CalendarPagePalette.disabled
    CalendarTitleSaveType.DISABLE_SAVE_TOTALLY -> CalendarPagePalette.placeholder
  }
}

internal class CalendarCommonTitleBar(context: Context) : LinearLayout(context) {
  private enum class TitlePlacement { CENTER, SECONDARY_LEFT }

  private val paletteReady = CalendarPagePalette.configure(context)
  private val leftAction = sourceText().apply {
    gravity = Gravity.CENTER_VERTICAL
    visibility = GONE
  }
  private val secondaryTitle = sourceText().apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, CalendarCommonTitleBarContract.SECONDARY_TITLE_SP)
    gravity = Gravity.CENTER_VERTICAL
    visibility = GONE
  }
  private val centerTitle = sourceText().apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, CalendarCommonTitleBarContract.MAIN_TITLE_SP)
    gravity = Gravity.CENTER
  }
  private val centerDefaultTypeface = centerTitle.typeface
  private val subtitle = sourceText().apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, CalendarCommonTitleBarContract.SUBTITLE_SP)
    gravity = Gravity.CENTER
    visibility = GONE
  }
  private val centerLayout = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.CENTER
    addView(centerTitle, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    addView(subtitle, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
  }
  private val rightActions = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private val leftAuxLayout = LinearLayout(context).apply {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.dp(CalendarCommonTitleBarContract.OUTER_PADDING_DP), 0, 0, 0)
  }
  private val divider = View(context).apply {
    setBackgroundColor(CalendarPagePalette.divider)
    visibility = GONE
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  private var placement = TitlePlacement.CENTER
  private var centerAlways = false
  private var leftAligned = false
  private var nextActionIndex = 0
  private var detailTitleBaseEndPadding = context.dp(CalendarCommonTitleBarContract.DETAIL_TITLE_BASE_END_PADDING_DP)

  init {
    orientation = HORIZONTAL
    setBackgroundColor(CalendarPagePalette.float)
    minimumHeight = context.dp(CalendarCommonTitleBarContract.FULL_SCREEN_HEIGHT_DP)
    clipChildren = false
    clipToPadding = false


    addView(leftAction)
    addView(secondaryTitle)
    addView(leftAuxLayout)
    addView(centerLayout)
    addView(rightActions)
    addView(divider)
  }

  fun setCenterTitle(
    value: CharSequence,
    color: Int = CalendarPagePalette.text,
    alpha: Float = 1f,
    bold: Boolean = false,
  ) {
    placement = TitlePlacement.CENTER
    secondaryTitle.visibility = GONE
    centerLayout.visibility = VISIBLE
    centerTitle.text = value
    centerTitle.setTextColor(color)
    centerTitle.alpha = alpha.coerceIn(0f, 1f)
    centerTitle.typeface = if (bold) {
      Typeface.create(centerDefaultTypeface, Typeface.BOLD)
    } else {
      centerDefaultTypeface
    }
    requestLayout()
  }

  fun setSecondaryLeftTitle(
    value: CharSequence,
    color: Int = CalendarPagePalette.text,
    alpha: Float = 1f,
  ) {
    placement = TitlePlacement.SECONDARY_LEFT
    centerLayout.visibility = VISIBLE
    secondaryTitle.visibility = if (value.isEmpty()) GONE else VISIBLE
    secondaryTitle.text = value
    secondaryTitle.setTextColor(color)
    secondaryTitle.alpha = alpha.coerceIn(0f, 1f)
    requestLayout()
  }

  fun setTitleAlpha(value: Float) {
    val alpha = value.coerceIn(0f, 1f)
    if (placement == TitlePlacement.SECONDARY_LEFT) {
      secondaryTitle.alpha = alpha
    } else {
      centerTitle.alpha = alpha
    }
  }

  fun setSubtitle(value: CharSequence, color: Int = CalendarPagePalette.text) {
    subtitle.text = value
    subtitle.setTextColor(color)
    subtitle.visibility = if (value.isEmpty()) GONE else VISIBLE
    centerLayout.visibility = VISIBLE
    requestLayout()
  }

  fun clearActions() {
    leftAction.visibility = GONE
    leftAction.text = ""
    leftAction.setCompoundDrawables(null, null, null, null)
    leftAction.setOnClickListener(null)
    leftAction.isClickable = false
    leftAction.isFocusable = false
    leftAction.contentDescription = null
    leftAction.background = null
    leftAction.minimumHeight = 0
    rightActions.removeAllViews()
    nextActionIndex = 0
    requestLayout()
  }

  fun setLeftTextAction(
    label: String,
    color: Int = CalendarPagePalette.text,
    debounce: Boolean = false,
    onClick: () -> Unit,
  ) {
    configureActionText(leftAction, label, color)
    leftAction.setCompoundDrawables(null, null, null, null)
    if (label == "取消") {
      // The source app uses a text-only cancel action, but LaoJi's edit page
      // deliberately makes this destructive-to-navigation escape hatch read as
      // a control. Keep the pill inside the 44dp title bar so it does not alter
      // title alignment or the save action's geometry.
      val pill = GradientDrawable().apply {
        setColor(CalendarPagePalette.neutralBackground)
        cornerRadius = context.dp(18f).toFloat()
      }
      val outerInset = context.dp(CalendarCommonTitleBarContract.OUTER_PADDING_DP)
      leftAction.background = InsetDrawable(pill, outerInset, context.dp(5f), 0, context.dp(5f))
      leftAction.minimumHeight = context.dp(34f)
      // The action view still owns the edge-to-edge 44dp hit region, while the
      // visible capsule begins at the same 15dp margin as every other leading
      // title-bar action. Without this inset the rounded shape is visibly cut
      // off by the left edge of the screen.
      leftAction.setPadding(outerInset + context.dp(10f), 0, context.dp(10f), 0)
    } else {
      leftAction.background = null
      leftAction.minimumHeight = 0
      leftAction.setPadding(
        context.dp(CalendarCommonTitleBarContract.OUTER_PADDING_DP),
        0,
        context.dp(CalendarCommonTitleBarContract.LEFT_TEXT_END_PADDING_DP),
        0,
      )
    }
    bindClick(leftAction, label, debounce, onClick)
    leftAction.visibility = VISIBLE
    requestLayout()
  }

  fun setLeftIconAction(
    drawableRes: Int,
    description: String,
    tint: Int = CalendarPagePalette.text,
    size: CalendarTitleIconSize = CalendarTitleIconSize.NORMAL,
    trailingPaddingDp: Float = CalendarCommonTitleBarContract.OUTER_PADDING_DP,
    debounce: Boolean = false,
    onClick: () -> Unit,
  ) {
    leftAction.text = ""
    leftAction.setTextSize(TypedValue.COMPLEX_UNIT_SP, CalendarCommonTitleBarContract.ACTION_TEXT_SP)
    leftAction.setTextColor(tint)
    val icon = tintedDrawable(drawableRes, tint).apply {
      val iconPx = context.dp(size.iconDp)
      setBounds(0, 0, iconPx, iconPx)
    }
    leftAction.setCompoundDrawables(icon, null, null, null)
    leftAction.compoundDrawablePadding = 0
    leftAction.setPadding(
      context.dp(CalendarCommonTitleBarContract.OUTER_PADDING_DP),
      0,
      context.dp(trailingPaddingDp),
      0,
    )
    bindClick(leftAction, description, debounce, onClick)
    leftAction.visibility = VISIBLE
    requestLayout()
  }

  fun addRightTextAction(
    label: String,
    color: Int = CalendarPagePalette.text,
    debounce: Boolean = true,
    onClick: () -> Unit,
  ): TextView {
    val action = sourceText().apply {
      configureActionText(this, label, color)
      gravity = Gravity.CENTER_VERTICAL
      setPadding(
        context.dp(CalendarCommonTitleBarContract.RIGHT_ACTION_START_PADDING_DP),
        0,
        context.dp(CalendarCommonTitleBarContract.OUTER_PADDING_DP),
        0,
      )
      bindClick(this, label, debounce, onClick)
    }
    bindRightAction(action, "text-action")
    rightActions.addView(action, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT))
    requestLayout()
    return action
  }

  fun addRightIconAction(
    drawableRes: Int,
    description: String,
    tint: Int = CalendarPagePalette.text,
    size: CalendarTitleIconSize = CalendarTitleIconSize.NORMAL,
    debounce: Boolean = true,
    onClick: () -> Unit,
  ): ImageView {
    val slotPx = context.dp(size.rightSlotDp)
    val startPadding = context.dp(CalendarCommonTitleBarContract.RIGHT_ACTION_START_PADDING_DP)
    val endPadding = context.dp(CalendarCommonTitleBarContract.RIGHT_ACTION_END_PADDING_DP)
    val action = ImageView(context).apply {
      scaleType = ImageView.ScaleType.FIT_CENTER
      setImageDrawable(tintedDrawable(drawableRes, tint))
      setPadding(startPadding, 0, endPadding, 0)
      bindClick(this, description, debounce, onClick)
    }
    bindRightAction(action, "icon-action")
    rightActions.addView(action, LinearLayout.LayoutParams(slotPx, LayoutParams.MATCH_PARENT))
    requestLayout()
    return action
  }

  fun setDividerVisible(visible: Boolean) {
    divider.visibility = if (visible) VISIBLE else GONE
    requestLayout()
  }

  fun setCenterAlways(value: Boolean) {
    centerAlways = value
    requestLayout()
  }

  fun setLeftAlignMode(value: Boolean) {
    leftAligned = value
    requestLayout()
  }

  fun setTransparentBackground() {
    setBackgroundColor(Color.TRANSPARENT)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val desiredWidth = suggestedMinimumWidth
    val width = resolveSize(desiredWidth, widthMeasureSpec)
    val desiredHeight = context.dp(CalendarCommonTitleBarContract.FULL_SCREEN_HEIGHT_DP)
    val height = when (MeasureSpec.getMode(heightMeasureSpec)) {
      MeasureSpec.EXACTLY -> MeasureSpec.getSize(heightMeasureSpec)
      MeasureSpec.AT_MOST -> min(desiredHeight, MeasureSpec.getSize(heightMeasureSpec))
      else -> desiredHeight
    }.coerceAtLeast(suggestedMinimumHeight)
    val exactHeight = MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
    val atMostWidth = MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST)

    measureVisible(leftAction, atMostWidth, exactHeight)
    measureVisible(rightActions, atMostWidth, exactHeight)
    measureVisible(leftAuxLayout, atMostWidth, exactHeight)

    if (secondaryTitle.visibility != GONE) {
      secondaryTitle.setPadding(
        context.dp(CalendarCommonTitleBarContract.DETAIL_TITLE_START_PADDING_DP),
        0,
        detailTitleBaseEndPadding + rightActions.measuredWidth,
        0,
      )
      secondaryTitle.measure(atMostWidth, exactHeight)
    } else {
      secondaryTitle.measure(
        MeasureSpec.makeMeasureSpec(0, MeasureSpec.EXACTLY),
        exactHeight,
      )
    }
    val minSide = context.dp(CalendarCommonTitleBarContract.MIN_SIDE_PADDING_DP)
    val leftOwnerWidth = leftOwnerWidth()
    val maxCenterWidth = if (centerAlways) {
      val side = max(leftOwnerWidth, rightActions.measuredWidth) + minSide
      (width - side * 2).coerceAtLeast(0)
    } else {
      (width - leftOwnerWidth - rightActions.measuredWidth - minSide * 2).coerceAtLeast(0)
    }
    val centerMode = if (centerAlways) MeasureSpec.EXACTLY else MeasureSpec.AT_MOST
    centerLayout.measure(MeasureSpec.makeMeasureSpec(maxCenterWidth, centerMode), exactHeight)

    divider.measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(CalendarCommonTitleBarContract.DIVIDER_HEIGHT_PX, MeasureSpec.EXACTLY),
    )
    setMeasuredDimension(width, height)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    val height = bottom - top
    leftAuxLayout.layout(0, 0, leftAuxLayout.measuredWidth, height)
    leftAction.layout(0, 0, leftAction.measuredWidth, height)
    rightActions.layout(width - rightActions.measuredWidth, 0, width, height)
    secondaryTitle.layout(
      leftAction.measuredWidth,
      0,
      leftAction.measuredWidth + secondaryTitle.measuredWidth,
      height,
    )
    val bounds = CalendarCommonTitleBarContract.centerBounds(
      totalWidth = width,
      measuredCenterWidth = centerLayout.measuredWidth,
      leftVisibleWidth = leftOwnerWidth(),
      rightVisibleWidth = rightActions.measuredWidth,
      minSidePadding = context.dp(CalendarCommonTitleBarContract.MIN_SIDE_PADDING_DP),
      centerAlways = centerAlways,
      leftAligned = leftAligned,
    )
    centerLayout.layout(bounds.left, 0, bounds.right, height)

    if (divider.visibility == VISIBLE && centerAlways) {
      divider.layout(0, height - CalendarCommonTitleBarContract.DIVIDER_HEIGHT_PX, width, height)
    } else {
      divider.layout(0, height, width, height + CalendarCommonTitleBarContract.DIVIDER_HEIGHT_PX)
    }
  }

  private fun sourceText(): TextView = TextView(context).apply {
    setTextColor(CalendarPagePalette.text)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, CalendarCommonTitleBarContract.ACTION_TEXT_SP)
    isSingleLine = true
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
  }

  private fun configureActionText(view: TextView, label: String, color: Int) {
    view.text = label
    view.setTextSize(TypedValue.COMPLEX_UNIT_SP, CalendarCommonTitleBarContract.ACTION_TEXT_SP)
    view.setTextColor(color)
  }

  private fun bindClick(
    view: View,
    description: String,
    debounce: Boolean,
    onClick: () -> Unit,
  ) {
    view.contentDescription = description
    view.isClickable = true
    view.isFocusable = true
    if (debounce) {
      val clickGate = CalendarTitleClickGate()
      view.setOnClickListener { clickGate.run(onClick) }
    } else {
      view.setOnClickListener { onClick() }
    }
  }

  private fun bindRightAction(view: View, role: String) {
    val index = nextActionIndex++
  }

  private fun tintedDrawable(drawableRes: Int, tint: Int): Drawable {
    val drawable = requireNotNull(ContextCompat.getDrawable(context, drawableRes)).mutate()
    DrawableCompat.setTint(drawable, tint)
    return drawable
  }

  private fun measureVisible(view: View, widthMeasureSpec: Int, heightMeasureSpec: Int) {
    if (view.visibility == GONE) {
      view.measure(
        MeasureSpec.makeMeasureSpec(0, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(0, MeasureSpec.EXACTLY),
      )
    } else {
      view.measure(widthMeasureSpec, heightMeasureSpec)
    }
  }

  private fun leftOwnerWidth(): Int = max(
    leftAction.measuredWidth + secondaryTitle.measuredWidth,
    leftAuxLayout.measuredWidth,
  )

  private fun Context.dp(value: Float): Int =
    CalendarCommonTitleBarContract.dpToPx(value, resources.displayMetrics.density)
}
