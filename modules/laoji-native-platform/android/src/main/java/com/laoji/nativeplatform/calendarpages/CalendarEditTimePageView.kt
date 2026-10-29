package com.laoji.nativeplatform.calendarpages

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.time.LocalDate
import java.time.YearMonth

@SuppressLint("ViewConstructor")
internal class CalendarEditTimePageView(
  context: Context,
  initialState: CalendarEditTimeState,
  private val onCancel: () -> Unit,
  private val onComplete: (CalendarEditDraft) -> Unit,
) : LinearLayout(context) {
  private val paletteReady = CalendarPagePalette.configure(context)
  private var state = initialState
  private var configuredDayCount = 0
  private val titleBar = CalendarCommonTitleBar(context)
  private val precisionButtons = linkedMapOf<CalendarTimePrecision, TextView>()
  private val periodButtons = linkedMapOf<CalendarTimePeriod, TextView>()
  private val precisionRow = LinearLayout(context).apply { orientation = HORIZONTAL }
  private val periods = LinearLayout(context).apply { orientation = VERTICAL }
  private val endpoints = LinearLayout(context).apply { orientation = HORIZONTAL }
  private val startRegion = endpoint(CalendarEditEndpoint.START)
  private val endRegion = endpoint(CalendarEditEndpoint.END)
  private val endAction = context.pageText(sizeSp = 15f, color = { CalendarPagePalette.primary }).apply {
    gravity = Gravity.CENTER_VERTICAL
    minHeight = context.pageDp(48)
    setPadding(context.pageDp(16), 0, context.pageDp(16), 0)
    isClickable = true; isFocusable = true
    setOnClickListener { applyState(state.setEndEnabled(!state.endTimedEnabled)) }
  }
  private val datePanel = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
  private val timedPanel = LinearLayout(context).apply { orientation = HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
  private val yearWheel = CalendarEditWheelView(context)
  private val monthWheel = CalendarEditWheelView(context)
  private val dayWheel = CalendarEditWheelView(context)
  private val timedDateWheel = CalendarEditWheelView(context)
  private val hourWheel = CalendarEditWheelView(context)
  private val minuteWheel = CalendarEditWheelView(context)
  private val errorText = context.pageText(sizeSp = 14f, color = { CalendarPagePalette.danger }).apply {
    visibility = GONE
    setPadding(context.pageDp(16), context.pageDp(12), context.pageDp(16), context.pageDp(12))
  }

  init {
    orientation = VERTICAL
    pageBackgroundColor { CalendarPagePalette.body }
    isClickable = true; isFocusable = true
    titleBar.setCenterTitle(if (state.dateOnly) "日期" else "时间")
    titleBar.setDividerVisible(false)
    titleBar.setLeftTextAction("取消", debounce = false) { onCancel() }
    titleBar.addRightTextAction("完成", { CalendarPagePalette.primary }, debounce = true) {
      val completed = state.completedDraft()
      val validation = CalendarEditValidator.validate(completed, requireDate = state.dateOnly)
      if (validation.valid) onComplete(completed) else {
        errorText.text = validation.message; errorText.visibility = VISIBLE
      }
    }
    addView(titleBar, LayoutParams(LayoutParams.MATCH_PARENT, CalendarCommonTitleBarContract.fullScreenHeightPx(context)))
    for (precision in CalendarTimePrecision.entries) {
      val button = context.pageText(precision.label, 15f, weight = Typeface.BOLD).apply {
        gravity = Gravity.CENTER; minHeight = context.pageDp(48)
        isClickable = true; isFocusable = true
        setOnClickListener { applyState(state.setPrecision(precision)) }
        pageBackgroundColor { if (state.precision == precision) CalendarPagePalette.primarySoft else CalendarPagePalette.body }
        pageTextColor { if (state.precision == precision) CalendarPagePalette.primary else CalendarPagePalette.secondary }
      }
      precisionButtons[precision] = button
      precisionRow.addView(button, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    }
    CalendarTimePeriod.entries.toList().chunked(3).forEach { row ->
      val group = LinearLayout(context).apply { orientation = HORIZONTAL }
      row.forEach { period ->
        val button = context.pageText(period.label, 16f).apply {
          gravity = Gravity.CENTER; minHeight = context.pageDp(56)
          isClickable = true; isFocusable = true
          setOnClickListener { applyState(state.setPeriod(period)) }
          pageBackgroundColor { if (state.period == period) CalendarPagePalette.primarySoft else CalendarPagePalette.body }
          pageTextColor { if (state.period == period) CalendarPagePalette.primary else CalendarPagePalette.text }
        }
        periodButtons[period] = button
        group.addView(button, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
      }
      periods.addView(group)
    }
    endpoints.addView(startRegion, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    endpoints.addView(endRegion, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    for (wheel in listOf(yearWheel, monthWheel, dayWheel))
      datePanel.addView(wheel, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    timedPanel.addView(timedDateWheel, LayoutParams(0, LayoutParams.WRAP_CONTENT, 2f))
    timedPanel.addView(hourWheel, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    timedPanel.addView(minuteWheel, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    val body = LinearLayout(context).apply {
      orientation = VERTICAL
      addView(precisionRow); addView(periods); addView(endpoints); addView(datePanel)
      addView(timedPanel); addView(endAction); addView(errorText)
    }
    val scroll = ScrollView(context).apply {
      isVerticalScrollBarEnabled = false; overScrollMode = OVER_SCROLL_NEVER
      addView(body, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
    yearWheel.configure(CalendarEditTimeState.MIN_YEAR, CalendarEditTimeState.MAX_YEAR, false,
      "年份滚轮", CalendarEditTimeFormatter::yearWheelLabel) { applyState(state.setYear(it), forceWheels = false) }
    monthWheel.configure(1, 12, true, "月份滚轮", CalendarEditTimeFormatter::monthWheelLabel) { applyState(state.setMonth(it), forceWheels = false) }
    timedDateWheel.configure(LocalDate.of(CalendarEditTimeState.MIN_YEAR, 1, 1).toEpochDay().toInt(),
      LocalDate.of(CalendarEditTimeState.MAX_YEAR, 12, 31).toEpochDay().toInt(), false, "日期滚轮",
      { CalendarEditTimeFormatter.dateWheelLabel(LocalDate.ofEpochDay(it.toLong())) }) {
        applyState(state.setDate(state.selectedEndpoint, LocalDate.ofEpochDay(it.toLong())), forceWheels = false)
      }
    hourWheel.configure(0, 23, true, "小时滚轮", { CalendarEditTimeFormatter.hourWheelLabel(it, true) }) { applyState(state.setHour24(it), forceWheels = false) }
    minuteWheel.configure(0, 59, true, "分钟滚轮", CalendarEditTimeFormatter::minuteWheelLabel) { applyState(state.setMinuteIndex(it), forceWheels = false) }
    syncUi(forceWheels = true)
  }

  fun currentState(): CalendarEditTimeState = state
  fun dispose() { listOf(yearWheel, monthWheel, dayWheel, timedDateWheel, hourWheel, minuteWheel).forEach { it.dispose() } }
  private fun applyState(value: CalendarEditTimeState, forceWheels: Boolean = true) {
    state = value; errorText.visibility = GONE; syncUi(forceWheels)
  }
  private fun endpoint(value: CalendarEditEndpoint): TextView = context.pageText(sizeSp = 15f).apply {
    minHeight = context.pageDp(72); gravity = Gravity.CENTER_VERTICAL
    setPadding(context.pageDp(16), context.pageDp(12), context.pageDp(16), context.pageDp(12))
    isClickable = true; isFocusable = true
    setOnClickListener { applyState(state.select(value)) }
    pageBackgroundColor { if (state.selectedEndpoint == value) CalendarPagePalette.primarySoft else CalendarPagePalette.body }
  }
  private fun syncUi(forceWheels: Boolean) {
    precisionRow.visibility = if (state.dateOnly) GONE else VISIBLE
    periods.visibility = if (!state.dateOnly && state.precision == CalendarTimePrecision.PERIOD) VISIBLE else GONE
    val exact = !state.dateOnly && state.hasTime
    // Neither a hidden endpoint nor its separator keeps occupying a row.
    endpoints.visibility = if (exact && state.endTimedEnabled) VISIBLE else GONE
    datePanel.visibility = if (state.dateOnly) VISIBLE else GONE
    timedPanel.visibility = if (exact) VISIBLE else GONE
    endAction.visibility = if (exact) VISIBLE else GONE
    endAction.text = if (state.endTimedEnabled) "移除结束时间" else "添加结束时间"
    startRegion.text = "开始\n${CalendarEditTimeFormatter.dateLabel(state.startDate)} ${CalendarEditTimeFormatter.timeLabel(state.startTime, true)}"
    endRegion.text = "结束\n${CalendarEditTimeFormatter.dateLabel(state.endDate)} ${CalendarEditTimeFormatter.timeLabel(state.endTime, true)}"
    startRegion.isSelected = state.selectedEndpoint == CalendarEditEndpoint.START
    endRegion.isSelected = state.selectedEndpoint == CalendarEditEndpoint.END
    for ((value, button) in precisionButtons) {
      button.isSelected = state.precision == value
      button.pageBackgroundColor { if (state.precision == value) CalendarPagePalette.primarySoft else CalendarPagePalette.body }
      button.pageTextColor { if (state.precision == value) CalendarPagePalette.primary else CalendarPagePalette.secondary }
    }
    for ((value, button) in periodButtons) {
      button.isSelected = state.period == value
      button.pageBackgroundColor { if (state.period == value) CalendarPagePalette.primarySoft else CalendarPagePalette.body }
      button.pageTextColor { if (state.period == value) CalendarPagePalette.primary else CalendarPagePalette.text }
    }
    for ((endpoint, region) in listOf(CalendarEditEndpoint.START to startRegion, CalendarEditEndpoint.END to endRegion)) {
      region.pageBackgroundColor { if (state.selectedEndpoint == endpoint) CalendarPagePalette.primarySoft else CalendarPagePalette.body }
    }
    val date = state.selectedDate()
    val days = YearMonth.from(date).lengthOfMonth()
    if (configuredDayCount != days) {
      configuredDayCount = days
      dayWheel.configure(1, days, true, "日期滚轮", CalendarEditTimeFormatter::dayWheelLabel) {
        applyState(state.setDayOfMonth(it), forceWheels = false)
      }
      dayWheel.setValue(date.dayOfMonth)
    }
    for ((wheel, value) in listOf(yearWheel to date.year, monthWheel to date.monthValue,
      dayWheel to date.dayOfMonth, timedDateWheel to date.toEpochDay().toInt(),
      hourWheel to state.selectedTime().hour, minuteWheel to state.selectedTime().minute)) {
      if (forceWheels) wheel.setValue(value) else wheel.synchronizeValueIfIdle(value)
    }
    // Selection changes redraw through the existing token owner, not a rebuilt tree.
    precisionButtons.values.forEach { it.refreshDrawableState() }
    periodButtons.values.forEach { it.refreshDrawableState() }
  }
}
