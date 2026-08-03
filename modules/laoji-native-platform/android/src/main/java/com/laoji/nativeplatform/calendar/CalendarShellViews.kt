package com.laoji.nativeplatform.calendar

// UI-SHELL-001, UI-MOTION-001: Native shell owns one 48dp create FAB and semantic icon actions.

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.DecelerateInterpolator
import kotlin.math.abs
import kotlin.math.hypot

enum class CalendarShellIcon {
  PROFILE,
  SEARCH
}

class CalendarShellIconView(
  context: Context,
  private val icon: CalendarShellIcon
) : View(context) {
  private val palette = CalendarUi.palette(context)
  private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.textPrimary
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 1.8f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val pressedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.surfaceMuted }

  init {
    isClickable = true
    isFocusable = true
    contentDescription = when (icon) {
      CalendarShellIcon.PROFILE -> "个人资料"
      CalendarShellIcon.SEARCH -> "搜索日程"
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) tooltipText = contentDescription
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val centerX = width / 2f
    val centerY = height / 2f
    if (isPressed) canvas.drawCircle(centerX, centerY, CalendarUi.dp(context, 18f), pressedPaint)
    when (icon) {
      CalendarShellIcon.PROFILE -> {
        canvas.drawCircle(centerX, centerY - CalendarUi.dp(context, 5f), CalendarUi.dp(context, 4.5f), iconPaint)
        canvas.drawArc(
          RectF(
            centerX - CalendarUi.dp(context, 8f),
            centerY + CalendarUi.dp(context, 2f),
            centerX + CalendarUi.dp(context, 8f),
            centerY + CalendarUi.dp(context, 14f)
          ),
          200f,
          140f,
          false,
          iconPaint
        )
      }
      CalendarShellIcon.SEARCH -> {
        canvas.drawCircle(centerX - CalendarUi.dp(context, 2f), centerY - CalendarUi.dp(context, 2f), CalendarUi.dp(context, 6.5f), iconPaint)
        canvas.drawLine(
          centerX + CalendarUi.dp(context, 3f),
          centerY + CalendarUi.dp(context, 3f),
          centerX + CalendarUi.dp(context, 9f),
          centerY + CalendarUi.dp(context, 9f),
          iconPaint
        )
      }
    }
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }
}

enum class CalendarCreateAction(val semanticType: String) {
  MENU("create-menu"),
  VOICE("create-voice"),
  MANUAL("create-manual")
}

fun interface CalendarCreateActionListener {
  fun onCreateAction(action: CalendarCreateAction)
}

class CalendarCreateFabView(context: Context) : View(context) {
  private val palette = CalendarUi.palette(context)
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
  private val fabPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.accent }
  private val pressedFabPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.accent
  }
  private val actionPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.surface }
  private val selectedActionPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.accent }
  private val actionShadowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(28, 0, 0, 0) }
  private val actionRingBaseAlpha = Color.alpha(palette.divider)
  private val actionRingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.rgb(Color.red(palette.divider), Color.green(palette.divider), Color.blue(palette.divider))
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 0.5f).coerceAtLeast(1f)
  }
  private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.accent
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 1f)
  }
  private val lightIconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.accentText
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 2f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val darkIconPaint = Paint(lightIconPaint).apply { color = palette.textPrimary }
  private val labelPaint = CalendarUi.textPaint(context, palette.textPrimary, 11f).apply {
    textAlign = Paint.Align.CENTER
  }
  private val selectedLabelPaint = CalendarUi.textPaint(context, palette.accentText, 11f).apply {
    textAlign = Paint.Align.CENTER
  }
  private var listener: CalendarCreateActionListener? = null
  private var dragSelecting = false
  private var radialVisible = false
  private var selectedAction: CalendarCreateAction? = null
  private var downX = 0f
  private var downY = 0f
  private var cancelledBeforeLongPress = false
  private var expansionProgress = 0f
  private var expansionAnimator: ValueAnimator? = null
  private var transitionGeneration = 0

  private val activateDragSelection = Runnable {
    if (!isPressed) return@Runnable
    dragSelecting = true
    radialVisible = true
    cancelledBeforeLongPress = false
    selectedAction = null
    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    transitionGeneration += 1
    expansionAnimator?.cancel()
    expansionAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = CalendarShellContract.FAB_EXPANSION_DURATION_MS
      interpolator = DecelerateInterpolator()
      addUpdateListener {
        expansionProgress = it.animatedValue as Float
        invalidate()
      }
      start()
    }
  }

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "新建日程"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) tooltipText = contentDescription
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  fun setActionListener(listener: CalendarCreateActionListener?) {
    this.listener = listener
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (radialVisible) {
      drawRadialArc(canvas)
      drawActionCircle(canvas, voiceRect(), CalendarCreateAction.VOICE)
      drawActionCircle(canvas, manualRect(), CalendarCreateAction.MANUAL)
    }
    val fab = fabRect()
    canvas.drawCircle(
      fab.centerX(),
      fab.centerY(),
      fab.width() / 2f,
      if (isPressed || radialVisible) pressedFabPaint else fabPaint,
    )
    val arm = CalendarUi.dp(context, 7f)
    lightIconPaint.alpha = 255
    canvas.save()
    canvas.rotate(CalendarShellContract.FAB_OPEN_ROTATION_DEGREES * expansionProgress, fab.centerX(), fab.centerY())
    canvas.drawLine(fab.centerX() - arm, fab.centerY(), fab.centerX() + arm, fab.centerY(), lightIconPaint)
    canvas.drawLine(fab.centerX(), fab.centerY() - arm, fab.centerX(), fab.centerY() + arm, lightIconPaint)
    canvas.restore()
  }

  private fun drawRadialArc(canvas: Canvas) {
    val fab = fabRect()
    val radius = CalendarUi.dp(context, CalendarShellContract.FAB_ARC_RADIUS_DP)
    arcPaint.alpha = ((if (selectedAction == null) 0.30f else 1f) * expansionProgress * 255f).toInt()
    canvas.drawArc(
      RectF(
        fab.centerX() - radius,
        fab.centerY() - radius,
        fab.centerX() + radius,
        fab.centerY() + radius,
      ),
      180f,
      90f,
      false,
      arcPaint,
    )
  }

  private fun drawActionCircle(canvas: Canvas, rect: RectF, action: CalendarCreateAction) {
    val centerX = rect.centerX()
    val centerY = rect.centerY()
    val selected = selectedAction == action
    val scale = if (selected) {
      CalendarShellContract.FAB_HOVER_SCALE
    } else {
      0.72f + 0.28f * expansionProgress
    }
    val radius = rect.width() / 2f * scale
    val alpha = (expansionProgress * 255f).toInt()
    actionShadowPaint.alpha = (expansionProgress * 28f).toInt()
    canvas.drawCircle(centerX, centerY + CalendarUi.dp(context, 2f), radius + CalendarUi.dp(context, 1f), actionShadowPaint)
    val fill = if (selected) selectedActionPaint else actionPaint
    fill.alpha = alpha
    canvas.drawCircle(centerX, centerY, radius, fill)
    if (!selected) {
      actionRingPaint.alpha = (actionRingBaseAlpha * expansionProgress).toInt()
      canvas.drawCircle(centerX, centerY, radius, actionRingPaint)
    }
    val paint = if (selected) lightIconPaint else darkIconPaint
    paint.alpha = alpha
    if (expansionProgress < 0.65f) return
    val iconCenterY = centerY - CalendarUi.dp(context, 7f)
    when (action) {
      CalendarCreateAction.VOICE -> drawMicrophone(canvas, centerX, iconCenterY, paint)
      CalendarCreateAction.MANUAL -> drawManual(canvas, centerX, iconCenterY, paint)
      CalendarCreateAction.MENU -> Unit
    }
    val textPaint = if (selected) selectedLabelPaint else labelPaint
    textPaint.alpha = alpha
    canvas.drawText(
      if (action == CalendarCreateAction.VOICE) "语音" else "手动",
      centerX,
      centerY + CalendarUi.dp(context, 20f),
      textPaint,
    )
  }

  private fun drawMicrophone(canvas: Canvas, centerX: Float, centerY: Float, paint: Paint) {
    val body = RectF(
      centerX - CalendarUi.dp(context, 3.5f),
      centerY - CalendarUi.dp(context, 8f),
      centerX + CalendarUi.dp(context, 3.5f),
      centerY + CalendarUi.dp(context, 3f)
    )
    canvas.drawRoundRect(body, CalendarUi.dp(context, 3.5f), CalendarUi.dp(context, 3.5f), paint)
    canvas.drawArc(
      RectF(
        centerX - CalendarUi.dp(context, 8f),
        centerY - CalendarUi.dp(context, 3f),
        centerX + CalendarUi.dp(context, 8f),
        centerY + CalendarUi.dp(context, 8f)
      ),
      0f,
      180f,
      false,
      paint
    )
    canvas.drawLine(centerX, centerY + CalendarUi.dp(context, 8f), centerX, centerY + CalendarUi.dp(context, 12f), paint)
  }

  private fun drawManual(canvas: Canvas, centerX: Float, centerY: Float, paint: Paint) {
    // A closed pencil silhouette reads as editing/manual creation at a glance.
    // The old three-line mark looked like an abstract wand once antialiased.
    val body = RectF(
      centerX - CalendarUi.dp(context, 3.5f),
      centerY - CalendarUi.dp(context, 10f),
      centerX + CalendarUi.dp(context, 3.5f),
      centerY + CalendarUi.dp(context, 7f),
    )
    val tip = Path().apply {
      moveTo(centerX - CalendarUi.dp(context, 3.5f), centerY + CalendarUi.dp(context, 7f))
      lineTo(centerX + CalendarUi.dp(context, 3.5f), centerY + CalendarUi.dp(context, 7f))
      lineTo(centerX, centerY + CalendarUi.dp(context, 12f))
      close()
    }
    val eraser = RectF(
      centerX - CalendarUi.dp(context, 3.5f),
      centerY - CalendarUi.dp(context, 12f),
      centerX + CalendarUi.dp(context, 3.5f),
      centerY - CalendarUi.dp(context, 9f),
    )
    canvas.save()
    canvas.rotate(-42f, centerX, centerY)
    val originalStyle = paint.style
    paint.style = Paint.Style.FILL
    canvas.drawRoundRect(body, CalendarUi.dp(context, 1.5f), CalendarUi.dp(context, 1.5f), paint)
    canvas.drawRect(eraser, paint)
    canvas.drawPath(tip, paint)
    paint.style = originalStyle
    canvas.restore()
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (!fabRect().contains(event.x, event.y)) return false
        downX = event.x
        downY = event.y
        dragSelecting = false
        selectedAction = null
        cancelledBeforeLongPress = false
        isPressed = true
        postDelayed(activateDragSelection, CalendarShellContract.FAB_LONG_PRESS_DELAY_MS)
        invalidate()
        return true
      }
      MotionEvent.ACTION_MOVE -> {
        if (!isPressed) return false
        if (!dragSelecting && (abs(event.x - downX) > touchSlop || abs(event.y - downY) > touchSlop)) {
          removeCallbacks(activateDragSelection)
          cancelledBeforeLongPress = true
        }
        if (dragSelecting) updateDragSelection(event.x, event.y)
        return true
      }
      MotionEvent.ACTION_UP -> {
        if (!isPressed) return false
        removeCallbacks(activateDragSelection)
        if (cancelledBeforeLongPress) {
          resetGesture()
          return true
        }
        if (!dragSelecting) {
          isPressed = false
          performClick()
        } else {
          val action = targetAt(event.x, event.y)
          isPressed = false
          dragSelecting = false
          selectedAction = action
          closeRadial(action)
          super.performClick()
        }
        invalidate()
        return true
      }
      MotionEvent.ACTION_CANCEL -> {
        resetGesture()
        return true
      }
    }
    return false
  }

  private fun updateDragSelection(x: Float, y: Float) {
    val next = targetAt(x, y)
    if (next != selectedAction) {
      selectedAction = next
      performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      invalidate()
    }
  }

  private fun targetAt(x: Float, y: Float): CalendarCreateAction? {
    val hitRadius = CalendarUi.dp(context, CalendarShellContract.FAB_TARGET_HIT_RADIUS_DP)
    return listOf(
      CalendarCreateAction.VOICE to voiceRect(),
      CalendarCreateAction.MANUAL to manualRect(),
    ).map { (action, rect) -> action to hypot(x - rect.centerX(), y - rect.centerY()) }
      .minByOrNull { it.second }
      ?.takeIf { it.second <= hitRadius }
      ?.first
  }

  private fun closeRadial(action: CalendarCreateAction?) {
    transitionGeneration += 1
    val generation = transitionGeneration
    expansionAnimator?.cancel()
    expansionAnimator = ValueAnimator.ofFloat(expansionProgress, 0f).apply {
      duration = CalendarShellContract.FAB_COLLAPSE_DURATION_MS
      interpolator = DecelerateInterpolator()
      addUpdateListener {
        expansionProgress = it.animatedValue as Float
        invalidate()
      }
      addListener(object : AnimatorListenerAdapter() {
        private var cancelled = false

        override fun onAnimationCancel(animation: Animator) {
          cancelled = true
        }

        override fun onAnimationEnd(animation: Animator) {
          if (cancelled || transitionGeneration != generation) return
          radialVisible = false
          selectedAction = null
          expansionAnimator = null
          invalidate()
          action?.let { listener?.onCreateAction(it) }
        }
      })
      start()
    }
  }

  private fun resetGesture() {
    removeCallbacks(activateDragSelection)
    transitionGeneration += 1
    expansionAnimator?.cancel()
    expansionAnimator = null
    expansionProgress = 0f
    isPressed = false
    dragSelecting = false
    radialVisible = false
    selectedAction = null
    cancelledBeforeLongPress = false
    invalidate()
  }

  override fun performClick(): Boolean {
    listener?.onCreateAction(CalendarCreateAction.MENU)
    return super.performClick()
  }

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    info.className = "android.widget.Button"
    val bounds = fabRect()
    info.setBoundsInParent(
      Rect(
        left + bounds.left.toInt(),
        top + bounds.top.toInt(),
        left + bounds.right.toInt(),
        top + bounds.bottom.toInt(),
      ),
    )
    val screenLocation = IntArray(2).also(::getLocationOnScreen)
    info.setBoundsInScreen(
      Rect(
        screenLocation[0] + bounds.left.toInt(),
        screenLocation[1] + bounds.top.toInt(),
        screenLocation[0] + bounds.right.toInt(),
        screenLocation[1] + bounds.bottom.toInt(),
      ),
    )
    info.addAction(AccessibilityNodeInfo.AccessibilityAction(ACTION_CREATE_VOICE, "语音创建"))
    info.addAction(AccessibilityNodeInfo.AccessibilityAction(ACTION_CREATE_MANUAL, "手动创建"))
  }

  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean = when (action) {
    ACTION_CREATE_VOICE -> {
      listener?.onCreateAction(CalendarCreateAction.VOICE)
      true
    }
    ACTION_CREATE_MANUAL -> {
      listener?.onCreateAction(CalendarCreateAction.MANUAL)
      true
    }
    else -> super.performAccessibilityAction(action, arguments)
  }

  override fun onDetachedFromWindow() {
    resetGesture()
    super.onDetachedFromWindow()
  }

  private fun fabRect(): RectF {
    val size = CalendarUi.dp(context, CalendarShellContract.FAB_SIZE_DP)
    return RectF(width - size, height - size, width.toFloat(), height.toFloat())
  }

  private fun voiceRect(): RectF {
    val fab = fabRect()
    val size = CalendarUi.dp(context, CalendarShellContract.FAB_OPTION_SIZE_DP)
    val centerX = fab.centerX() + CalendarUi.dp(context, CalendarShellContract.FAB_VOICE_OFFSET_X_DP)
    val centerY = fab.centerY() + CalendarUi.dp(context, CalendarShellContract.FAB_VOICE_OFFSET_Y_DP)
    return RectF(centerX - size / 2f, centerY - size / 2f, centerX + size / 2f, centerY + size / 2f)
  }

  private fun manualRect(): RectF {
    val fab = fabRect()
    val size = CalendarUi.dp(context, CalendarShellContract.FAB_OPTION_SIZE_DP)
    val centerX = fab.centerX() + CalendarUi.dp(context, CalendarShellContract.FAB_MANUAL_OFFSET_X_DP)
    val centerY = fab.centerY() + CalendarUi.dp(context, CalendarShellContract.FAB_MANUAL_OFFSET_Y_DP)
    return RectF(centerX - size / 2f, centerY - size / 2f, centerX + size / 2f, centerY + size / 2f)
  }

  companion object {
    private const val ACTION_CREATE_VOICE = 0x0102_0001
    private const val ACTION_CREATE_MANUAL = 0x0102_0002
  }
}
