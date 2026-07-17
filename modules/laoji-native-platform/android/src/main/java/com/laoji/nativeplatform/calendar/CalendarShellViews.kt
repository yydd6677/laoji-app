package com.laoji.nativeplatform.calendar

// UI-SHELL-001, UI-MOTION-001: Native shell owns one 48dp create FAB and semantic icon actions.

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
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
  private val actionPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.surface }
  private val selectedActionPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = palette.accent }
  private val actionRingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.divider
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 0.5f).coerceAtLeast(1f)
  }
  private val lightIconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = palette.accentText
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 2f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val darkIconPaint = Paint(lightIconPaint).apply { color = palette.textPrimary }
  private var listener: CalendarCreateActionListener? = null
  private var dragSelecting = false
  private var selectedAction: CalendarCreateAction? = null
  private var downX = 0f
  private var downY = 0f
  private var cancelledBeforeLongPress = false
  private var expansionProgress = 0f
  private var expansionAnimator: ValueAnimator? = null

  private val activateDragSelection = Runnable {
    if (!isPressed) return@Runnable
    dragSelecting = true
    cancelledBeforeLongPress = false
    selectedAction = CalendarCreateAction.VOICE
    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
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
    if (dragSelecting) {
      drawActionCircle(canvas, voiceRect(), CalendarCreateAction.VOICE)
      drawActionCircle(canvas, manualRect(), CalendarCreateAction.MANUAL)
    }
    val fab = fabRect()
    canvas.drawCircle(fab.centerX(), fab.centerY(), fab.width() / 2f, fabPaint)
    val arm = CalendarUi.dp(context, 7f)
    canvas.drawLine(fab.centerX() - arm, fab.centerY(), fab.centerX() + arm, fab.centerY(), lightIconPaint)
    canvas.drawLine(fab.centerX(), fab.centerY() - arm, fab.centerX(), fab.centerY() + arm, lightIconPaint)
  }

  private fun drawActionCircle(canvas: Canvas, rect: RectF, action: CalendarCreateAction) {
    val fab = fabRect()
    val centerX = fab.centerX() + (rect.centerX() - fab.centerX()) * expansionProgress
    val centerY = fab.centerY() + (rect.centerY() - fab.centerY()) * expansionProgress
    val radius = rect.width() / 2f * expansionProgress
    val selected = selectedAction == action
    canvas.drawCircle(centerX, centerY, radius, if (selected) selectedActionPaint else actionPaint)
    if (!selected) canvas.drawCircle(centerX, centerY, radius, actionRingPaint)
    val paint = if (selected) lightIconPaint else darkIconPaint
    if (expansionProgress < 0.65f) return
    when (action) {
      CalendarCreateAction.VOICE -> drawMicrophone(canvas, centerX, centerY, paint)
      CalendarCreateAction.MANUAL -> drawManual(canvas, centerX, centerY, paint)
      CalendarCreateAction.MENU -> Unit
    }
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
    canvas.drawLine(
      centerX - CalendarUi.dp(context, 7f),
      centerY + CalendarUi.dp(context, 7f),
      centerX + CalendarUi.dp(context, 6f),
      centerY - CalendarUi.dp(context, 6f),
      paint
    )
    canvas.drawLine(
      centerX - CalendarUi.dp(context, 8f),
      centerY + CalendarUi.dp(context, 8f),
      centerX - CalendarUi.dp(context, 3f),
      centerY + CalendarUi.dp(context, 7f),
      paint
    )
    canvas.drawLine(
      centerX + CalendarUi.dp(context, 3f),
      centerY - CalendarUi.dp(context, 8f),
      centerX + CalendarUi.dp(context, 8f),
      centerY - CalendarUi.dp(context, 3f),
      paint
    )
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
        postDelayed(activateDragSelection, ViewConfiguration.getLongPressTimeout().toLong())
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
        val action = if (dragSelecting) selectedAction ?: CalendarCreateAction.VOICE else CalendarCreateAction.MENU
        isPressed = false
        dragSelecting = false
        selectedAction = null
        if (action == CalendarCreateAction.MENU) {
          performClick()
        } else {
          listener?.onCreateAction(action)
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
    val next = when {
      manualRect().contains(x, y) -> CalendarCreateAction.MANUAL
      voiceRect().contains(x, y) -> CalendarCreateAction.VOICE
      x < fabRect().left -> CalendarCreateAction.MANUAL
      else -> CalendarCreateAction.VOICE
    }
    if (next != selectedAction) {
      selectedAction = next
      performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
      invalidate()
    }
  }

  private fun resetGesture() {
    removeCallbacks(activateDragSelection)
    expansionAnimator?.cancel()
    expansionAnimator = null
    expansionProgress = 0f
    isPressed = false
    dragSelecting = false
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
    val size = CalendarUi.dp(context, 40f)
    val centerX = width - CalendarUi.dp(context, 24f)
    val centerY = height - CalendarUi.dp(context, 96f)
    return RectF(centerX - size / 2f, centerY - size / 2f, centerX + size / 2f, centerY + size / 2f)
  }

  private fun manualRect(): RectF {
    val size = CalendarUi.dp(context, 40f)
    val centerX = width - CalendarUi.dp(context, 96f)
    val centerY = height - CalendarUi.dp(context, 24f)
    return RectF(centerX - size / 2f, centerY - size / 2f, centerX + size / 2f, centerY + size / 2f)
  }

  companion object {
    private const val ACTION_CREATE_VOICE = 0x0102_0001
    private const val ACTION_CREATE_MANUAL = 0x0102_0002
  }
}
