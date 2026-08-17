package com.laoji.nativeplatform.calendarpages

// CAL-EDIT-TIME-001 / UI-TITLE-COMMON-001: the time page keeps the source
// Cancel / Time / Done CommonTitleBar configuration and native wheel ownership.

// CAL-EDIT-TIME-001: in-root full-screen editor derived from EditMultiTimeView's two-wheel layout.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.laoji.nativeplatform.evidence.FeishuEvidence
import java.time.LocalDate
import java.time.YearMonth

@SuppressLint("ViewConstructor")
@FeishuEvidence("CAL-PICKER-WHEEL-TAP-001", "CAL-TIMEFORMAT-001", "UI-TITLE-COMMON-001")
internal class CalendarEditTimePageView(
  context: Context,
  initialState: CalendarEditTimeState,
  private val onCancel: () -> Unit,
  private val onComplete: (CalendarEditDraft) -> Unit,
) : LinearLayout(context) {
  private val paletteReady = CalendarPagePalette.configure(context)
  private var state = initialState
  private val is24Hour = true
  private var applyingState = false
  private val titleBar = CalendarCommonTitleBar(context)
  private val allDaySwitch = CalendarSourceSwitch(context).apply {
    contentDescription = "全天"
  }
  private val timeSwitch = CalendarSourceSwitch(context).apply {
    contentDescription = "具体时间"
  }
  private val timeSwitchRow = toggleRow("具体时间", timeSwitch)
  private val endTimeSwitch = CalendarSourceSwitch(context).apply {
    contentDescription = "结束时间"
  }
  private val endTimeSwitchRow = toggleRow("结束时间", endTimeSwitch)
  private val startDateText = endpointText(15f, Typeface.BOLD)
  private val startTimeText = endpointText(14f, Typeface.NORMAL, CalendarPagePalette.secondary)
  private val endDateText = endpointText(15f, Typeface.BOLD)
  private val endTimeText = endpointText(14f, Typeface.NORMAL, CalendarPagePalette.secondary)
  private val startRegion = endpointRegion(
    label = "开始",
    dateText = startDateText,
    timeText = startTimeText,
    endpoint = CalendarEditEndpoint.START,
  )
  private val endRegion = endpointRegion(
    label = "结束",
    dateText = endDateText,
    timeText = endTimeText,
    endpoint = CalendarEditEndpoint.END,
  )
  private val allDayPanel = LinearLayout(context).apply {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private val timedPanel = LinearLayout(context).apply {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private val allDayYearWheel = CalendarEditWheelView(context)
  private val allDayMonthWheel = CalendarEditWheelView(context)
  private val allDayDateWheel = CalendarEditWheelView(context)
  private val timedDateWheel = CalendarEditWheelView(context)
  private val periodWheel = CalendarEditWheelView(context)
  private val hourWheel = CalendarEditWheelView(context)
  private val minuteWheel = CalendarEditWheelView(context)

  init {
    orientation = VERTICAL
    setBackgroundColor(CalendarPagePalette.body)
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES

    titleBar.setCenterTitle("时间")
    titleBar.setDividerVisible(false)
    titleBar.setLeftTextAction("取消", debounce = false) { onCancel() }
    titleBar.addRightTextAction("完成", CalendarPagePalette.primary, debounce = true) {
      onComplete(state.completedDraft())
    }
    addView(titleBar, LayoutParams(
      LayoutParams.MATCH_PARENT,
      CalendarCommonTitleBarContract.fullScreenHeightPx(context),
    ))

    val scroll = ScrollView(context).apply {
      isFillViewport = true
      overScrollMode = OVER_SCROLL_NEVER
      isVerticalScrollBarEnabled = false
    }
    val body = LinearLayout(context).apply {
      orientation = VERTICAL
      addView(toggleRow("全天", allDaySwitch))
      addView(context.pageDivider(16))
      addView(timeSwitchRow)
      addView(endTimeSwitchRow)
      addView(endpointRow())
      addView(wheelContainer())
      addView(context.pageDivider(16), LayoutParams(LayoutParams.MATCH_PARENT, context.pageDp(0.5f).coerceAtLeast(1)).apply {
        topMargin = context.pageDp(14)
        bottomMargin = context.pageDp(14)
      })
    }
    scroll.addView(body, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))

    configureWheels()
    allDaySwitch.setOnCheckedChangeListener { _, checked ->
      if (!applyingState) applyState(state.setAllDay(checked))
    }
    timeSwitch.setOnCheckedChangeListener { _, checked ->
      if (!applyingState) applyState(state.setTimedEnabled(checked))
    }
    endTimeSwitch.setOnCheckedChangeListener { _, checked ->
      if (!applyingState) applyState(state.setEndTimedEnabled(checked))
    }
    syncUi()
  }

  fun currentState(): CalendarEditTimeState = state

  fun dispose() {
    allDayYearWheel.dispose()
    allDayMonthWheel.dispose()
    allDayDateWheel.dispose()
    timedDateWheel.dispose()
    periodWheel.dispose()
    hourWheel.dispose()
    minuteWheel.dispose()
  }

  private fun endpointRow(): View = LinearLayout(context).apply {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = context.pageDp(88)
    addView(startRegion, LayoutParams(0, LayoutParams.MATCH_PARENT, 1f))
    addView(View(context).apply { setBackgroundColor(CalendarPagePalette.divider) }, LayoutParams(
      context.pageDp(0.5f).coerceAtLeast(1),
      context.pageDp(56),
    ))
    addView(endRegion, LayoutParams(0, LayoutParams.MATCH_PARENT, 1f))
  }

  private fun endpointRegion(
    label: String,
    dateText: TextView,
    timeText: TextView,
    endpoint: CalendarEditEndpoint,
  ): LinearLayout = LinearLayout(context).apply {
    orientation = VERTICAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.pageDp(16), context.pageDp(10), context.pageDp(12), context.pageDp(10))
    addView(context.pageText(label, 13f, CalendarPagePalette.secondary), LayoutParams(
      LayoutParams.WRAP_CONTENT,
      LayoutParams.WRAP_CONTENT,
    ))
    addView(dateText, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = context.pageDp(5)
    })
    addView(timeText, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = context.pageDp(3)
    })
    setOnClickListener { applyState(state.select(endpoint)) }
    isClickable = true
    isFocusable = true
  }

  private fun wheelContainer(): View = FrameLayout(context).apply {
    setPadding(0, context.pageDp(20), 0, context.pageDp(20))

    allDayPanel.addView(allDayYearWheel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    allDayPanel.addView(allDayMonthWheel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    allDayPanel.addView(allDayDateWheel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

    timedPanel.addView(timedDateWheel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 2f))
    if (!is24Hour) {
      timedPanel.addView(periodWheel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 0.8f))
    }
    timedPanel.addView(hourWheel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 0.9f))
    timedPanel.addView(minuteWheel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 0.9f))

    addView(allDayPanel, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      gravity = Gravity.CENTER_VERTICAL
    })
    addView(timedPanel, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      gravity = Gravity.CENTER_VERTICAL
    })
  }

  private fun configureWheels() {
    allDayYearWheel.configure(
      CalendarEditTimeState.MIN_YEAR,
      CalendarEditTimeState.MAX_YEAR,
      looping = false,
      role = "年份滚轮",
      labelProvider = CalendarEditTimeFormatter::yearWheelLabel,
    ) { applyState(state.setYear(it)) }
    allDayMonthWheel.configure(
      1,
      12,
      looping = true,
      role = "月份滚轮",
      labelProvider = CalendarEditTimeFormatter::monthWheelLabel,
    ) { applyState(state.setMonth(it)) }
    configureAllDayDateWheel()

    timedDateWheel.configure(
      LocalDate.of(CalendarEditTimeState.MIN_YEAR, 1, 1).toEpochDay().toInt(),
      LocalDate.of(CalendarEditTimeState.MAX_YEAR, 12, 31).toEpochDay().toInt(),
      looping = true,
      role = "日期滚轮",
      labelProvider = { CalendarEditTimeFormatter.dateWheelLabel(LocalDate.ofEpochDay(it.toLong())) },
    ) { applyState(state.setDate(state.selectedEndpoint, LocalDate.ofEpochDay(it.toLong()))) }

    periodWheel.configure(
      0,
      1,
      looping = false,
      role = "上下午滚轮",
      labelProvider = CalendarEditTimeFormatter::periodWheelLabel,
    ) { applyState(state.setPeriod(it)) }
    hourWheel.configure(
      if (is24Hour) 0 else 1,
      if (is24Hour) 23 else 12,
      looping = true,
      role = "小时滚轮",
      labelProvider = { CalendarEditTimeFormatter.hourWheelLabel(it, is24Hour) },
    ) { value ->
      applyState(if (is24Hour) state.setHour24(value) else state.setHour12(value))
    }
    minuteWheel.configure(
      0,
      CalendarEditTimeState.MINUTE_ITEM_COUNT - 1,
      looping = true,
      role = "分钟滚轮",
      labelProvider = CalendarEditTimeFormatter::minuteWheelLabel,
    ) { applyState(state.setMinuteIndex(it)) }
  }

  private fun configureAllDayDateWheel() {
    val date = state.selectedDate()
    allDayDateWheel.configure(
      1,
      YearMonth.from(date).lengthOfMonth(),
      looping = true,
      role = "日期滚轮",
      labelProvider = CalendarEditTimeFormatter::dayWheelLabel,
    ) { applyState(state.setDayOfMonth(it)) }
  }

  private fun applyState(value: CalendarEditTimeState) {
    state = value
    syncUi()
  }

  private fun syncUi() {
    applyingState = true
    allDaySwitch.isChecked = state.allDay
    timeSwitch.isChecked = state.timedEnabled
    endTimeSwitch.isChecked = state.endTimedEnabled
    timeSwitchRow.visibility = if (state.allDay) GONE else VISIBLE
    endTimeSwitchRow.visibility = if (!state.allDay && state.timedEnabled) VISIBLE else GONE

    startDateText.text = CalendarEditTimeFormatter.dateLabel(state.startDate)
    endDateText.text = CalendarEditTimeFormatter.dateLabel(state.endDate)
    startTimeText.text = endpointTimeLabel(CalendarEditEndpoint.START)
    endTimeText.text = endpointTimeLabel(CalendarEditEndpoint.END)
    syncEndpointRegion(startRegion, CalendarEditEndpoint.START, startDateText, startTimeText)
    syncEndpointRegion(endRegion, CalendarEditEndpoint.END, endDateText, endTimeText)

    allDayPanel.visibility = if (state.allDay) VISIBLE else INVISIBLE
    timedPanel.visibility = if (state.allDay) INVISIBLE else VISIBLE
    val selectedTimeEnabled = state.timeEnabled(state.selectedEndpoint)
    periodWheel.visibility = if (selectedTimeEnabled && !is24Hour) VISIBLE else GONE
    hourWheel.visibility = if (selectedTimeEnabled) VISIBLE else GONE
    minuteWheel.visibility = if (selectedTimeEnabled) VISIBLE else GONE

    configureAllDayDateWheel()
    val date = state.selectedDate()
    allDayYearWheel.setValue(date.year)
    allDayMonthWheel.setValue(date.monthValue)
    allDayDateWheel.setValue(date.dayOfMonth)
    timedDateWheel.setValue(date.toEpochDay().toInt())
    val time = state.selectedTime()
    periodWheel.setValue(if (time.hour < 12) 0 else 1)
    hourWheel.setValue(if (is24Hour) time.hour else (time.hour % 12).let { if (it == 0) 12 else it })
    minuteWheel.setValue(time.minute / CalendarEditTimeState.MINUTE_STEP)
    applyingState = false
  }

  private fun syncEndpointRegion(
    region: LinearLayout,
    endpoint: CalendarEditEndpoint,
    dateText: TextView,
    timeText: TextView,
  ) {
    val selected = state.selectedEndpoint == endpoint
    region.isSelected = selected
    region.setBackgroundColor(if (selected) CalendarPagePalette.primarySoft else Color.TRANSPARENT)
    val label = if (endpoint == CalendarEditEndpoint.START) "开始" else "结束"
    region.contentDescription = "$label 区域，${dateText.text}，${timeText.text}"
  }

  private fun endpointTimeLabel(endpoint: CalendarEditEndpoint): String = when {
    state.allDay -> "全天"
    !state.timeEnabled(endpoint) -> "未设置"
    else -> CalendarEditTimeFormatter.timeLabel(state.timeFor(endpoint), is24Hour)
  }

  private fun toggleRow(label: String, toggle: CalendarSourceSwitch): LinearLayout = LinearLayout(context).apply {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = context.pageDp(52)
    setPadding(context.pageDp(16), 0, context.pageDp(12), 0)
    addView(context.pageText(label, 16f), LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    addView(toggle, LayoutParams(context.pageDp(52), context.pageDp(48)))
  }

  private fun endpointText(
    sizeSp: Float,
    weight: Int,
    color: Int = CalendarPagePalette.text,
  ): TextView = context.pageText(sizeSp = sizeSp, color = color, weight = weight).apply {
    maxLines = 1
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
  }
}
