package com.laoji.nativeplatform.calendar

// UI-SHELL-001, UI-MOTION-001: Native shell owns one 48dp create FAB and semantic icon actions.

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.os.Build
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import com.laoji.nativeplatform.ui.NativeUiTokens

enum class CalendarShellIcon {
  PROFILE,
  SEARCH
}

class CalendarShellIconView(
  context: Context,
  private val icon: CalendarShellIcon
) : View(context) {
  private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 1.8f)
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val pressedPaint = Paint(Paint.ANTI_ALIAS_FLAG)

  init {
    isClickable = true
    isFocusable = true
    contentDescription = when (icon) {
      CalendarShellIcon.PROFILE -> "个人资料"
      CalendarShellIcon.SEARCH -> "搜索日程"
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) tooltipText = contentDescription
    NativeUiTokens.bindTheme(this) {
      val palette = CalendarUi.palette(context)
      iconPaint.color = palette.textPrimary
      pressedPaint.color = palette.surfaceMuted
    }
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

fun interface CalendarCreateActionListener {
  fun onCreateAction()
}

/** One packaged create action. Input methods belong inside the editor. */
class CalendarCreateFabView(context: Context) : View(context) {
  private val fabPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = CalendarUi.dp(context, 2f)
    strokeCap = Paint.Cap.ROUND
  }
  private var listener: CalendarCreateActionListener? = null

  init {
    isClickable = true
    isFocusable = true
    contentDescription = "新建日程"
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    NativeUiTokens.bindTheme(this) {
      val palette = CalendarUi.palette(context)
      fabPaint.color = palette.accent
      iconPaint.color = palette.accentText
    }
  }

  fun setActionListener(listener: CalendarCreateActionListener?) {
    this.listener = listener
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val x = width / 2f
    val y = height / 2f
    fabPaint.alpha = if (isPressed) 205 else 255
    canvas.drawCircle(x, y, minOf(width, height) / 2f, fabPaint)
    val arm = CalendarUi.dp(context, 7f)
    canvas.drawLine(x - arm, y, x + arm, y, iconPaint)
    canvas.drawLine(x, y - arm, x, y + arm, iconPaint)
  }

  override fun drawableStateChanged() {
    super.drawableStateChanged()
    invalidate()
  }

  override fun performClick(): Boolean {
    if (!isEnabled) return false
    listener?.onCreateAction()
    return super.performClick()
  }

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    info.className = "android.widget.Button"
  }
}
