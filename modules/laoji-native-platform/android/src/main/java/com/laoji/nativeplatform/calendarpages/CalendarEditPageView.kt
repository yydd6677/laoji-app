package com.laoji.nativeplatform.calendarpages

// CAL-EDIT-001 / CAL-EDIT-TIME-001 / CAL-REPEAT-RRULE-001 / UI-FORM-001:
// date/time and repeat-end edits stay inside this native root.

import android.annotation.SuppressLint
import android.content.Context
import android.content.ContextWrapper
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.os.Bundle
import android.os.Parcel
import android.os.Parcelable
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.text.format.DateFormat
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import com.laoji.nativeplatform.evidence.FeishuEvidence
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

@SuppressLint("ViewConstructor")
@FeishuEvidence(
  "CAL-DETAIL-EDIT-001",
  "CAL-PICKER-WHEEL-TAP-001",
  "CAL-REPEAT-RRULE-001",
  "UI-TITLE-COMMON-001",
)
class CalendarEditPageView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  private val onAction by EventDispatcher<Map<String, Any?>>()
  private val root = FrameLayout(context)
  private val titleBar = CalendarCommonTitleBar(context)
  private val scroll = ScrollView(context).apply {
    isFillViewport = true
    overScrollMode = View.OVER_SCROLL_NEVER
    isVerticalScrollBarEnabled = false
  }
  private val content = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(0, 0, 0, context.pageDp(50))
  }
  private val titleInput = EditText(context).apply {
    hint = "添加主题"
    setHintTextColor(CalendarPagePalette.placeholder)
    setTextColor(CalendarPagePalette.text)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    background = null
    minHeight = context.pageDp(52)
    maxLines = 4
    setPadding(context.pageDp(16), context.pageDp(12), context.pageDp(16), context.pageDp(12))
    filters = arrayOf(InputFilter.LengthFilter(400))
    imeOptions = EditorInfo.IME_ACTION_NEXT
  }
  private val startDateValue = context.pageText(sizeSp = 16f)
  private val endDateValue = context.pageText(sizeSp = 16f)
  private val startTimeValue = context.pageText(sizeSp = 16f)
  private val endTimeValue = context.pageText(sizeSp = 16f)
  private lateinit var startDateRow: View
  private lateinit var endDateRow: View
  private lateinit var startTimeRow: View
  private lateinit var endTimeRow: View
  private val repeatValue = context.pageText(sizeSp = 16f)
  private lateinit var repeatRow: View
  private lateinit var repeatIcon: ImageView
  private lateinit var repeatArrow: ImageView
  private val repeatEndValue = context.pageText(sizeSp = 16f)
  private lateinit var repeatEndRow: View
  private lateinit var repeatEndArrow: ImageView
  private val reminderValue = context.pageText(sizeSp = 16f)
  private val locationInput = EditText(context).apply {
    hint = "添加地点"
    setHintTextColor(CalendarPagePalette.placeholder)
    setTextColor(CalendarPagePalette.text)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    background = null
    isSingleLine = true
    maxLines = 1
    setPadding(0, 0, context.pageDp(16), 0)
    imeOptions = EditorInfo.IME_ACTION_NEXT
  }
  private val notesInput = EditText(context).apply {
    hint = "添加备注"
    setHintTextColor(CalendarPagePalette.placeholder)
    setTextColor(CalendarPagePalette.text)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    background = null
    gravity = Gravity.TOP
    minLines = 3
    maxLines = 10
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
      InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    setPadding(0, context.pageDp(12), context.pageDp(16), context.pageDp(12))
  }
  private val deleteRow = buildActionRow(
    android.R.drawable.ic_menu_delete,
    "删除日程",
    CalendarPagePalette.danger,
  ) { requestDelete() }
  private val stateView = CalendarPageStateView(context) {
    dispatchAction(mapOf("type" to "retry"))
  }
  private val busyOverlay = FrameLayout(context).apply {
    setBackgroundColor(CalendarPagePalette.scrim)
    isClickable = true
    isFocusable = true
    contentDescription = "正在保存日程"
    addView(ProgressBar(context), FrameLayout.LayoutParams(context.pageDp(40), context.pageDp(40)).apply {
      gravity = Gravity.CENTER
    })
  }
  private var pendingSnapshot: Map<String, Any?> = emptyMap()
  private var state = CalendarEditPageState()
  private var draft = CalendarEditDraft()
  private var applyingSnapshot = false
  private var lastMessage: String? = null
  private var timePage: CalendarEditTimePageView? = null
  private var repeatEndPage: CalendarRepeatEndPageView? = null
  private val backCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      when {
        repeatEndPage != null -> cancelRepeatEndPage()
        timePage != null -> cancelTimePage()
      }
    }
  }

  init {
    // CAL-EDIT-001: Keep Android-managed page children visible inside ExpoView.
    setWillNotDraw(false)
    clipToPadding = false
    setBackgroundColor(CalendarPagePalette.body)
    scroll.addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    val page = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      addView(titleBar, LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        CalendarCommonTitleBarContract.fullScreenHeightPx(context),
      ))
      addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }
    root.addView(page, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    root.addView(stateView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
      topMargin = CalendarCommonTitleBarContract.fullScreenHeightPx(context)
    })
    root.addView(busyOverlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    buildForm()
    bindInputs()
  }

  fun setSnapshot(value: Map<String, Any?>) {
    pendingSnapshot = value
  }

  fun commitProps() {
    val nextState = CalendarPageSnapshotParser.edit(pendingSnapshot)
    state = nextState
    if (timePage == null && repeatEndPage == null) draft = nextState.draft
    render()
  }

  private fun buildForm() {
    content.addView(titleInput, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addSectionDivider()
    startDateRow = valueRow(android.R.drawable.ic_menu_today, "开始日期", startDateValue) {
      showTimePage(CalendarEditEndpoint.START)
    }
    endDateRow = valueRow(android.R.drawable.ic_menu_today, "结束日期", endDateValue) {
      showTimePage(CalendarEditEndpoint.END)
    }
    startTimeRow = valueRow(android.R.drawable.ic_lock_idle_alarm, "开始时间", startTimeValue) {
      showTimePage(CalendarEditEndpoint.START)
    }
    endTimeRow = valueRow(android.R.drawable.ic_lock_idle_alarm, "结束时间", endTimeValue) {
      showTimePage(CalendarEditEndpoint.END)
    }
    content.addView(startDateRow)
    content.addView(endDateRow)
    content.addView(startTimeRow)
    content.addView(endTimeRow)
    val builtRepeatRow = repeatChoiceRow(com.laoji.nativeplatform.R.drawable.laoji_ic_repeat_outline, "重复", repeatValue) {
      if (state.recurrenceRuleEditable) emitDraftAction("openRepeat")
      else emitFeedback("仅编辑此日程时不能修改重复规则")
    }
    repeatRow = builtRepeatRow
    repeatIcon = builtRepeatRow.getChildAt(0) as ImageView
    repeatArrow = builtRepeatRow.getChildAt(2) as ImageView
    content.addView(repeatRow)
    repeatEndRow = repeatChoiceRow(null, "截止时间", repeatEndValue) {
      if (state.recurrenceRuleEditable) showRepeatEndPage()
      else emitFeedback("仅编辑此日程时不能修改截止时间")
    }
    repeatEndArrow = (repeatEndRow as ViewGroup).getChildAt(2) as ImageView
    content.addView(repeatEndRow)
    addSectionDivider()
    content.addView(inputRow(android.R.drawable.ic_menu_mylocation, locationInput, context.pageDp(48)))
    addSectionDivider()
    content.addView(inputRow(android.R.drawable.ic_menu_sort_by_size, notesInput, context.pageDp(88)))
    addSectionDivider()
    content.addView(valueRow(android.R.drawable.ic_lock_idle_alarm, "提醒", reminderValue) {
      if (draft.allDay || !draft.hasTime) {
        emitFeedback("设置具体时间后才能添加提醒")
      } else {
        emitDraftAction("openReminder")
      }
    })
    addSectionDivider()
    content.addView(deleteRow)
  }

  private fun bindInputs() {
    titleInput.watch { updateDraft(draft.copy(title = it)) }
    locationInput.watch { updateDraft(draft.copy(location = it)) }
    notesInput.watch { updateDraft(draft.copy(notes = it)) }
  }

  private fun render() {
    applyingSnapshot = true
    titleBar.clearActions()
    // UI-TITLE-COMMON-001: ordinary calendar edit has no center title.
    titleBar.setCenterTitle("")
    titleBar.setDividerVisible(false)
    titleBar.setLeftTextAction("取消", debounce = true) { emit("cancel") }
    val saveType = CalendarTitleSaveContract.resolve(
      loadState = state.loadState,
      saving = state.saving,
      draftValid = CalendarEditValidator.validate(draft).valid,
    )
    titleBar.addRightTextAction("保存", CalendarTitleSaveContract.color(saveType), debounce = true) {
      when (saveType) {
        CalendarTitleSaveType.ENABLE_SAVE,
        CalendarTitleSaveType.DISABLE_SAVE_WITH_FEEDBACK -> requestSave()
        CalendarTitleSaveType.DISABLE_SAVE_TOTALLY -> Unit
      }
    }

    syncText(titleInput, draft.title)
    syncText(locationInput, draft.location)
    syncText(notesInput, draft.notes)
    renderDraftFields()
    deleteRow.visibility = if (state.editing) View.VISIBLE else View.GONE
    applyingSnapshot = false

    val ready = state.loadState == CalendarPageLoadState.READY
    scroll.visibility = if (ready) View.VISIBLE else View.GONE
    stateView.render(state.loadState, state.message)
    busyOverlay.visibility = if (state.saving) View.VISIBLE else View.GONE
    val message = state.message
    if (!message.isNullOrBlank() && message != lastMessage && ready) {
      lastMessage = message
      emitFeedback(message, 5000)
    }
    timePage?.bringToFront()
    repeatEndPage?.bringToFront()
  }

  private fun updateDraft(value: CalendarEditDraft) {
    if (applyingSnapshot) return
    draft = value.normalized()
    renderDraftFields()
    dispatchAction(mapOf("type" to "draftChange", "draft" to draft.toBridge()))
  }

  private fun renderDraftFields() {
    applyingSnapshot = true
    startDateValue.text = formatDate(draft.startDate)
    endDateValue.text = formatDate(draft.endDate)
    val is24Hour = DateFormat.is24HourFormat(context)
    startTimeValue.text = CalendarEditTimeFormatter.timeLabel(parseTime(draft.startTime), is24Hour)
    endTimeValue.text = CalendarEditTimeFormatter.timeLabel(parseTime(draft.endTime), is24Hour)
    val recurrenceMode = state.recurrenceRuleMode
    repeatValue.text = if (recurrenceMode == CalendarRecurrenceControlMode.DISABLED) {
      "不重复"
    } else {
      repeatLabel(draft.repeat)
    }
    repeatEndValue.text = draft.recurrenceUntilDate?.let(::formatDate) ?: "永不截止"
    repeatRow.visibility = if (recurrenceMode == CalendarRecurrenceControlMode.HIDDEN) View.GONE else View.VISIBLE
    repeatEndRow.visibility = if (
      recurrenceMode != CalendarRecurrenceControlMode.HIDDEN && draft.repeat != "once"
    ) View.VISIBLE else View.GONE
    repeatRow.isEnabled = true
    repeatRow.isClickable = true
    repeatEndRow.isEnabled = true
    repeatEndRow.isClickable = true
    val repeatTextColor = if (state.recurrenceRuleEditable) CalendarPagePalette.text else CalendarPagePalette.disabled
    val repeatIconColor = if (state.recurrenceRuleEditable) CalendarPagePalette.placeholder else CalendarPagePalette.disabled
    repeatValue.setTextColor(repeatTextColor)
    repeatEndValue.setTextColor(repeatTextColor)
    repeatIcon.imageTintList = ColorStateList.valueOf(repeatIconColor)
    repeatArrow.imageTintList = ColorStateList.valueOf(repeatIconColor)
    repeatEndArrow.imageTintList = ColorStateList.valueOf(repeatIconColor)
    reminderValue.text = reminderLabel(draft.reminderMinutes)
    val showTime = !draft.allDay && draft.hasTime
    startTimeRow.visibility = if (showTime) View.VISIBLE else View.GONE
    endTimeRow.visibility = if (showTime) View.VISIBLE else View.GONE
    reminderValue.parentView().alpha = if (showTime) 1f else 0.45f
    syncValueRowDescription(startDateRow, "开始日期", startDateValue)
    syncValueRowDescription(endDateRow, "结束日期", endDateValue)
    syncValueRowDescription(startTimeRow, "开始时间", startTimeValue)
    syncValueRowDescription(endTimeRow, "结束时间", endTimeValue)
    syncValueRowDescription(repeatRow, "重复", repeatValue)
    syncValueRowDescription(repeatEndRow, "截止时间", repeatEndValue)
    applyingSnapshot = false
  }

  private fun requestSave() {
    val normalized = draft.normalized()
    val validation = CalendarEditValidator.validate(normalized)
    if (!validation.valid) {
      emitFeedback(validation.message ?: "日程信息不完整")
      return
    }
    draft = normalized
    emitDraftAction("save")
  }

  private fun requestDelete() {
    if (!state.editing || state.saving) return
    emit("delete")
  }

  private fun emitFeedback(message: String, durationMs: Int = 3000) {
    dispatchAction(mapOf(
      "type" to "feedback",
      "message" to message,
      "durationMs" to durationMs,
    ))
  }

  private fun showTimePage(endpoint: CalendarEditEndpoint) {
    if (timePage != null || repeatEndPage != null || state.saving || state.loadState != CalendarPageLoadState.READY) return
    val initial = runCatching { CalendarEditTimeState.fromDraft(draft, endpoint) }.getOrElse {
      emitFeedback("请选择有效的日期")
      return
    }
    showTimePage(initial)
  }

  private fun showTimePage(restoredState: CalendarEditTimeState) {
    if (timePage != null) return
    findFocus()?.clearFocus()
    context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(windowToken, 0)
    val page = CalendarEditTimePageView(
      context = context,
      initialState = restoredState,
      onCancel = ::cancelTimePage,
      onComplete = ::completeTimePage,
    )
    timePage = page
    root.addView(page, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT,
    ))
    page.bringToFront()
    backCallback.isEnabled = true
    page.requestFocus()
  }

  private fun cancelTimePage() {
    val page = timePage ?: return
    val entryDraft = page.currentState().baseDraft
    closeTimePage()
    draft = entryDraft
    renderDraftFields()
  }

  private fun completeTimePage(value: CalendarEditDraft) {
    if (timePage == null) return
    closeTimePage()
    updateDraft(value)
  }

  private fun closeTimePage() {
    val page = timePage ?: return
    page.dispose()
    root.removeView(page)
    timePage = null
    backCallback.isEnabled = repeatEndPage != null
  }

  private fun showRepeatEndPage() {
    if (!state.recurrenceRuleEditable || draft.repeat == "once" || repeatEndPage != null || timePage != null ||
      state.saving || state.loadState != CalendarPageLoadState.READY) return
    val initial = runCatching { CalendarRepeatEndState.fromDraft(draft) }.getOrElse {
      emitFeedback("请选择有效的截止时间")
      return
    }
    showRepeatEndPage(initial)
  }

  private fun showRepeatEndPage(restoredState: CalendarRepeatEndState) {
    if (repeatEndPage != null || timePage != null) return
    findFocus()?.clearFocus()
    context.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(windowToken, 0)
    val page = CalendarRepeatEndPageView(
      context = context,
      initialState = restoredState,
      onCancel = ::cancelRepeatEndPage,
      onComplete = ::completeRepeatEndPage,
    )
    repeatEndPage = page
    root.addView(page, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT,
    ))
    page.bringToFront()
    backCallback.isEnabled = true
    page.requestFocus()
  }

  private fun cancelRepeatEndPage() {
    val page = repeatEndPage ?: return
    val entryDraft = page.currentState().baseDraft
    closeRepeatEndPage()
    draft = entryDraft
    renderDraftFields()
  }

  private fun completeRepeatEndPage(value: CalendarEditDraft) {
    if (repeatEndPage == null) return
    closeRepeatEndPage()
    updateDraft(value)
  }

  private fun closeRepeatEndPage() {
    val page = repeatEndPage ?: return
    page.dispose()
    root.removeView(page)
    repeatEndPage = null
    backCallback.isEnabled = timePage != null
  }

  private fun emitDraftAction(type: String) {
    dispatchAction(mapOf(
      "type" to type,
      "draft" to draft.toBridge(),
    ))
  }

  private fun emit(type: String, extras: Map<String, Any?> = emptyMap()) {
    dispatchAction(mapOf("type" to type) + extras)
  }

  private fun dispatchAction(payload: Map<String, Any?>) {
    if (context !is ComponentActivity) onAction(payload)
  }

  private fun valueRow(iconRes: Int, label: String, value: TextView, onClick: () -> Unit): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = context.pageDp(48)
      addIcon(iconRes)
      addView(context.pageText(label, 16f, CalendarPagePalette.secondary),
        LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
      addView(value.apply {
        gravity = Gravity.CENTER_VERTICAL or Gravity.END
        maxLines = 2
      }, LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply {
        leftMargin = context.pageDp(12)
        rightMargin = context.pageDp(16)
      })
      setOnClickListener { onClick() }
      isClickable = true
      isFocusable = true
      contentDescription = "$label ${value.text}"
    }

  private fun repeatChoiceRow(
    iconRes: Int?,
    accessibilityLabel: String,
    value: TextView,
    onClick: () -> Unit,
  ): LinearLayout = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = context.pageDp(48)
    if (iconRes != null) {
      addIcon(iconRes)
    } else {
      addView(View(context), LinearLayout.LayoutParams(context.pageDp(40), context.pageDp(48)))
    }
    addView(value.apply {
      gravity = Gravity.CENTER_VERTICAL
      maxLines = 1
      setPadding(context.pageDp(6), context.pageDp(6), context.pageDp(6), context.pageDp(6))
    }, LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    addView(ImageView(context).apply {
      setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_chevron_right_bold)
      imageTintList = ColorStateList.valueOf(CalendarPagePalette.placeholder)
    }, LinearLayout.LayoutParams(context.pageDp(12), context.pageDp(12)).apply {
      rightMargin = context.pageDp(16)
    })
    setOnClickListener { onClick() }
    isClickable = true
    isFocusable = true
    contentDescription = "$accessibilityLabel，${value.text}"
  }

  private fun inputRow(iconRes: Int, input: EditText, height: Int): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.TOP
      minimumHeight = height
      addIcon(iconRes)
      addView(input, LinearLayout.LayoutParams(0, LayoutParams.MATCH_PARENT, 1f))
    }

  private fun buildActionRow(iconRes: Int, label: String, color: Int, onClick: () -> Unit): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = context.pageDp(48)
      addView(ImageView(context).apply {
        setImageResource(iconRes)
        imageTintList = ColorStateList.valueOf(color)
        setPadding(context.pageDp(14), context.pageDp(14), context.pageDp(14), context.pageDp(14))
      }, LinearLayout.LayoutParams(context.pageDp(46), context.pageDp(48)))
      addView(context.pageText(label, 16f, color), LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
      setOnClickListener { onClick() }
      isClickable = true
      isFocusable = true
      contentDescription = label
    }

  private fun LinearLayout.addIcon(iconRes: Int) {
    addView(ImageView(context).apply {
      setImageResource(iconRes)
      imageTintList = ColorStateList.valueOf(CalendarPagePalette.placeholder)
      setPadding(context.pageDp(14), context.pageDp(14), context.pageDp(14), context.pageDp(14))
    }, LinearLayout.LayoutParams(context.pageDp(46), context.pageDp(48)))
  }

  private fun addSectionDivider() {
    content.addView(context.pageDivider(16), LinearLayout.LayoutParams(
      LayoutParams.MATCH_PARENT,
      context.pageDp(0.5f).coerceAtLeast(1),
    ).apply {
      topMargin = context.pageDp(14)
      bottomMargin = context.pageDp(14)
    })
  }

  private fun TextView.parentView(): View = parent as? View ?: this

  private fun syncValueRowDescription(row: View, label: String, value: TextView) {
    row.contentDescription = "$label，${value.text}"
  }

  private fun syncText(input: EditText, value: String) {
    if (input.text.toString() == value) return
    val focused = input.hasFocus()
    input.setText(value)
    if (focused) input.setSelection(input.text.length)
  }

  private fun EditText.watch(block: (String) -> Unit) {
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(value: Editable?) {
        if (!applyingSnapshot) block(value.toString())
      }
    })
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    componentActivity()?.onBackPressedDispatcher?.addCallback(backCallback)
    backCallback.isEnabled = timePage != null || repeatEndPage != null
  }

  override fun onDetachedFromWindow() {
    backCallback.remove()
    super.onDetachedFromWindow()
  }

  override fun onSaveInstanceState(): Parcelable {
    val savedState = CalendarEditPageSavedState(super.onSaveInstanceState())
    savedState.timePageState = timePage?.currentState()?.toStateBundle()
    savedState.repeatEndPageState = repeatEndPage?.currentState()?.toStateBundle()
    return savedState
  }

  override fun onRestoreInstanceState(value: Parcelable?) {
    if (value !is CalendarEditPageSavedState) {
      super.onRestoreInstanceState(value)
      return
    }
    super.onRestoreInstanceState(value.superState)
    val restoredTime = value.timePageState?.toTimeState()
    val restoredRepeatEnd = value.repeatEndPageState?.toRepeatEndState()
    post {
      when {
        restoredRepeatEnd != null && repeatEndPage == null -> showRepeatEndPage(restoredRepeatEnd)
        restoredTime != null && timePage == null -> showTimePage(restoredTime)
      }
    }
  }

  private fun componentActivity(): ComponentActivity? =
    (appContext.currentActivity as? ComponentActivity) ?: context.findComponentActivity()

}

private val eventDateFormatter: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE
private val eventTimeFormatter: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
private val eventWeekdays = listOf("一", "二", "三", "四", "五", "六", "日")

private fun parseDate(value: String?): LocalDate? = try {
  value?.let { LocalDate.parse(it, eventDateFormatter) }
} catch (_: DateTimeParseException) {
  null
}

private fun parseTime(value: String?): LocalTime? = try {
  value?.let { LocalTime.parse(it, eventTimeFormatter) }
} catch (_: DateTimeParseException) {
  null
}

private fun formatDate(value: String): String {
  val date = parseDate(value) ?: return value.ifEmpty { "未设置" }
  return "${date.year}年${date.monthValue}月${date.dayOfMonth}日 周${eventWeekdays[date.dayOfWeek.value - 1]}"
}

private fun repeatLabel(value: String): String = when (value) {
  "daily" -> "每天"
  "weekly" -> "每周"
  "monthly" -> "每月"
  "yearly" -> "每年"
  else -> "不重复"
}

private fun reminderLabel(value: Int?): String = when (value) {
  null -> "不提醒"
  0 -> "开始时"
  5 -> "5分钟前"
  15 -> "15分钟前"
  30 -> "30分钟前"
  60 -> "1小时前"
  else -> "${value}分钟前"
}

private class CalendarEditPageSavedState : View.BaseSavedState {
  var timePageState: Bundle? = null
  var repeatEndPageState: Bundle? = null

  constructor(superState: Parcelable?) : super(superState)

  private constructor(source: Parcel) : super(source) {
    timePageState = source.readBundle(CalendarEditPageSavedState::class.java.classLoader)
    repeatEndPageState = source.readBundle(CalendarEditPageSavedState::class.java.classLoader)
  }

  override fun writeToParcel(out: Parcel, flags: Int) {
    super.writeToParcel(out, flags)
    out.writeBundle(timePageState)
    out.writeBundle(repeatEndPageState)
  }

  companion object CREATOR : Parcelable.Creator<CalendarEditPageSavedState> {
    override fun createFromParcel(source: Parcel): CalendarEditPageSavedState =
      CalendarEditPageSavedState(source)

    override fun newArray(size: Int): Array<CalendarEditPageSavedState?> = arrayOfNulls(size)
  }
}

private fun CalendarEditTimeState.toStateBundle(): Bundle = Bundle().apply {
  putBundle("baseDraft", baseDraft.toStateBundle())
  putString("startDate", startDate.toString())
  putString("endDate", endDate.toString())
  putString("startTime", startTime.format(eventTimeFormatter))
  putString("endTime", endTime.format(eventTimeFormatter))
  putBoolean("allDay", allDay)
  putBoolean("timedEnabled", timedEnabled)
  putString("selectedEndpoint", selectedEndpoint.name)
}

private fun CalendarRepeatEndState.toStateBundle(): Bundle = Bundle().apply {
  putBundle("baseDraft", baseDraft.toStateBundle())
  putBoolean("neverEnds", neverEnds)
  putString("selectedDate", selectedDate.toString())
}

private fun CalendarEditDraft.toStateBundle(): Bundle = Bundle().apply {
  putString("title", title)
  putString("startDate", startDate)
  putString("endDate", endDate)
  putString("startTime", startTime)
  putString("endTime", endTime)
  putBoolean("allDay", allDay)
  putString("repeat", repeat)
  putString("recurrenceUntilDate", recurrenceUntilDate)
  putString("reminderMinutes", reminderMinutes?.toString())
  putString("location", location)
  putString("notes", notes)
}

private fun Bundle.toTimeState(): CalendarEditTimeState? = runCatching {
  val baseDraft = requireNotNull(getBundle("baseDraft")).toEditDraft()
  val endpoint = getString("selectedEndpoint")
    ?.let(CalendarEditEndpoint::valueOf)
    ?: CalendarEditEndpoint.START
  val fallback = CalendarEditTimeState.fromDraft(baseDraft, endpoint)
  fallback.copy(
    startDate = requireNotNull(parseDate(getString("startDate"))),
    endDate = requireNotNull(parseDate(getString("endDate"))),
    startTime = requireNotNull(parseTime(getString("startTime"))),
    endTime = requireNotNull(parseTime(getString("endTime"))),
    allDay = getBoolean("allDay"),
    timedEnabled = getBoolean("timedEnabled"),
    selectedEndpoint = endpoint,
  )
}.getOrNull()

private fun Bundle.toRepeatEndState(): CalendarRepeatEndState? = runCatching {
  val selectedDate = requireNotNull(parseDate(getString("selectedDate")))
  require(CalendarEditDateRange.contains(selectedDate))
  CalendarRepeatEndState(
    baseDraft = requireNotNull(getBundle("baseDraft")).toEditDraft(),
    neverEnds = getBoolean("neverEnds"),
    selectedDate = selectedDate,
  )
}.getOrNull()

private fun Bundle.toEditDraft(): CalendarEditDraft = CalendarEditDraft(
  title = getString("title").orEmpty(),
  startDate = getString("startDate").orEmpty(),
  endDate = getString("endDate").orEmpty(),
  startTime = getString("startTime"),
  endTime = getString("endTime"),
  allDay = getBoolean("allDay"),
  repeat = getString("repeat") ?: "once",
  recurrenceUntilDate = getString("recurrenceUntilDate"),
  reminderMinutes = getString("reminderMinutes")?.toIntOrNull(),
  location = getString("location").orEmpty(),
  notes = getString("notes").orEmpty(),
).normalized()

private fun Context.findComponentActivity(): ComponentActivity? {
  var current: Context? = this
  while (current is ContextWrapper) {
    if (current is ComponentActivity) return current
    val next = current.baseContext
    if (next === current) break
    current = next
  }
  return current as? ComponentActivity
}
