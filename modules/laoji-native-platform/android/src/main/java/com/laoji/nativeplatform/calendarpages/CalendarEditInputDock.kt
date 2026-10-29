package com.laoji.nativeplatform.calendarpages

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.laoji.nativeplatform.R

/** A projection of the editor's input, not a second draft, parser or recorder. */
@SuppressLint("ViewConstructor")
internal class CalendarEditInputDock(context: Context, private val emit: (Map<String, Any?>) -> Unit) : LinearLayout(context) {
  private var state = CalendarEditInputState()
  private var syncing = false
  private var textExpanded = false
  private var receivedSnapshot = false
  private var gestureActive = false
  private var suppressTouchClick = false
  private val input: EditText = EditText(context).apply {
    hint = "输入日程"
    background = null
    pageTextColor { CalendarPagePalette.text }
    pageDrawing { setHintTextColor(CalendarPagePalette.placeholder) }
    pageTypeface(Typeface.NORMAL)
    textSize = 16f
    gravity = Gravity.TOP
    maxLines = 3
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    setPadding(context.pageDp(4), context.pageDp(8), context.pageDp(4), context.pageDp(8))
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        if (!syncing) { applyTextVisibility(); emit(mapOf("type" to "inputTextChange", "text" to s.toString())) }
      }
    })
  }
  private val applyAction: TextView = textAction("应用") {
    input.clearFocus()
    context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(windowToken, 0)
    emit(mapOf("type" to "inputSubmit", "text" to input.text.toString()))
  }
  private val textRow = LinearLayout(context).apply {
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.pageDp(12), 0, context.pageDp(8), 0)
    addView(input, LayoutParams(0, context.pageDp(92), 1f))
    addView(applyAction, LayoutParams(context.pageDp(48), context.pageDp(48)))
  }
  private val feedback = context.pageText(sizeSp = 14f, color = { CalendarPagePalette.danger }).apply {
    setPadding(context.pageDp(16), context.pageDp(4), context.pageDp(16), context.pageDp(8))
  }
  private val level = InputLevelView(context)
  private val timer = context.pageText(sizeSp = 14f, color = { CalendarPagePalette.secondary }).apply { gravity = Gravity.CENTER }
  private val liveRow = LinearLayout(context).apply {
    gravity = Gravity.CENTER
    addView(timer, LayoutParams(context.pageDp(54), context.pageDp(28)))
    addView(level, LayoutParams(context.pageDp(78), context.pageDp(28)))
  }
  private val textToggle = textAction("文字") { toggleText() }
  private val undo = textAction("撤销") { emit(mapOf("type" to "inputUndo")) }
  private val cancel = textAction("取消") { emit(mapOf("type" to "inputCancel")) }
  private val more = context.pageIconButton(R.drawable.laoji_ic_more_outline, "输入选项").apply {
    setOnClickListener { emit(mapOf("type" to "inputOptions")) }
  }
  private val microphone = context.pageIconButton(R.drawable.laoji_ic_microphone_ai_filled, "语音输入").apply {
    setOnClickListener {
      if (!suppressTouchClick) emit(mapOf("type" to if (state.phase == "recording") "inputStop" else "inputStart"))
    }
    setPadding(context.pageDp(16), context.pageDp(16), context.pageDp(16), context.pageDp(16))
    pageShape({ if (state.phase == "recording") CalendarPagePalette.danger else CalendarPagePalette.primary }, 32f)
    pageIconTint { ColorStateList.valueOf(CalendarPagePalette.float) }
    setOnTouchListener { _, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          if (state.phase == "editing") {
            rootView.findFocus()?.clearFocus()
            context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(windowToken, 0)
            gestureActive = true; isPressed = true
            emit(mapOf("type" to "inputStart"))
          } else if (state.phase == "recording") emit(mapOf("type" to "inputStop"))
          true
        }
        MotionEvent.ACTION_UP -> {
          if (gestureActive) emit(mapOf("type" to "inputStop"))
          gestureActive = false; isPressed = false
          suppressTouchClick = true; performClick(); suppressTouchClick = false
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          if (gestureActive) emit(mapOf("type" to "inputCancel"))
          gestureActive = false; isPressed = false; true
        }
        else -> true
      }
    }
  }
  private val progress = ProgressBar(context).apply {
    pageDrawing { indeterminateTintList = ColorStateList.valueOf(CalendarPagePalette.primary) }
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }
  private val rightActions = LinearLayout(context).apply {
    gravity = Gravity.CENTER_VERTICAL
    addView(undo, LayoutParams(context.pageDp(48), context.pageDp(48)))
    addView(more, LayoutParams(context.pageDp(48), context.pageDp(48)))
    addView(cancel, LayoutParams(context.pageDp(48), context.pageDp(48)))
  }
  init {
    orientation = VERTICAL
    pageBackgroundColor { CalendarPagePalette.body }
    addView(context.pageDivider(0))
    addView(textRow, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(feedback, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(liveRow, LayoutParams(LayoutParams.MATCH_PARENT, context.pageDp(28)))
    addView(FrameLayout(context).apply {
      addView(textToggle, FrameLayout.LayoutParams(context.pageDp(64), context.pageDp(48), Gravity.START or Gravity.CENTER_VERTICAL).apply {
        marginStart = context.pageDp(8)
      })
      addView(microphone, FrameLayout.LayoutParams(context.pageDp(60), context.pageDp(60), Gravity.CENTER))
      addView(progress, FrameLayout.LayoutParams(context.pageDp(26), context.pageDp(26), Gravity.CENTER))
      addView(rightActions, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.pageDp(48), Gravity.END or Gravity.CENTER_VERTICAL).apply {
        marginEnd = context.pageDp(8)
      })
    }, LayoutParams(LayoutParams.MATCH_PARENT, context.pageDp(80)))
    // Construction paints an empty shell, not the first restored snapshot.
    render(state, acceptSnapshot = false)
  }

  fun render(next: CalendarEditInputState, acceptSnapshot: Boolean = true, acceptTextSnapshot: Boolean = true) {
    val changedPhase = state.phase != next.phase
    val started = state.phase != "recording" && next.phase == "recording"
    if (started || acceptSnapshot && !receivedSnapshot && next.text.isNotBlank()) textExpanded = true
    if (acceptSnapshot) receivedSnapshot = true
    state = next
    syncing = true
    if (acceptTextSnapshot && input.text.toString() != next.text) {
      val selection = input.selectionStart.coerceAtLeast(0)
      input.setText(next.text)
      if (input.hasFocus()) input.setSelection(selection.coerceAtMost(next.text.length))
    }
    syncing = false
    input.isEnabled = next.phase == "editing"
    textToggle.isEnabled = next.phase == "editing"
    val busy = next.phase == "recording" || next.phase == "parsing"
    cancel.visibility = if (busy) VISIBLE else GONE
    undo.visibility = if (!busy && next.canUndo) VISIBLE else GONE
    more.visibility = if (!busy) VISIBLE else GONE
    more.isEnabled = next.phase == "editing"
    undo.isEnabled = next.phase == "editing"
    microphone.visibility = if (next.phase == "parsing") INVISIBLE else VISIBLE
    progress.visibility = if (next.phase == "parsing") VISIBLE else GONE
    microphone.isEnabled = next.phase == "editing" || next.phase == "recording"
    microphone.contentDescription = if (next.phase == "recording") "结束语音输入" else "语音输入"
    // Theme binding retains this View; state only changes its local drawing.
    if (changedPhase) microphone.pageShape({ if (state.phase == "recording") CalendarPagePalette.danger else CalendarPagePalette.primary }, 32f)
    liveRow.visibility = if (next.phase == "recording") VISIBLE else GONE
    timer.text = "%02d:%02d".format(next.durationMs / 60000, next.durationMs / 1000 % 60)
    level.amplitude = next.level
    feedback.text = next.error
    feedback.visibility = if (next.error.isBlank()) GONE else VISIBLE
    applyTextVisibility()
  }

  private fun applyTextVisibility() {
    textRow.visibility = if (textExpanded || state.phase == "recording" || state.phase == "parsing" || state.error.isNotBlank()) VISIBLE else GONE
    applyAction.visibility = if (state.phase == "editing" && input.text.isNotBlank()) VISIBLE else INVISIBLE
  }

  private fun toggleText() {
    textExpanded = !textExpanded
    applyTextVisibility()
    if (textExpanded) {
      input.requestFocus()
      input.post { context.getSystemService(InputMethodManager::class.java)?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT) }
    } else {
      input.clearFocus()
      context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(windowToken, 0)
    }
  }

  private fun textAction(label: String, action: () -> Unit): TextView = context.pageText(label, 14f, { CalendarPagePalette.primary }).apply {
    gravity = Gravity.CENTER; minimumHeight = context.pageDp(48); minimumWidth = context.pageDp(44)
    isClickable = true; isFocusable = true; contentDescription = label
    setOnClickListener { action() }
  }
}

private class InputLevelView(context: Context) : View(context) {
  var amplitude = 0f
    set(value) { field = value.coerceIn(0f, 1f); invalidate() }
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  override fun onDraw(canvas: Canvas) {
    paint.color = CalendarPagePalette.danger
    val step = width / 7f
    for (i in 0..4) {
      val envelope = 1f - kotlin.math.abs(i - 2) * .18f
      val h = context.pageDp(3).toFloat() + height * .72f * amplitude * envelope
      val x = step * (i + 1)
      canvas.drawRoundRect(x, (height - h) / 2, x + step * .35f, (height + h) / 2, step, step, paint)
    }
  }
}
