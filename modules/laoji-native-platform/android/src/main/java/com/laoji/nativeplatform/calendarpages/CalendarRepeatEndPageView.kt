package com.laoji.nativeplatform.calendarpages

// UI-TITLE-COMMON-001 / CAL-REPEAT-RRULE-001: retained repeat-end page derived
// from ChooseRepeatEndFragment and fragment_event_repeat_end.xml.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeParseException

internal data class CalendarRepeatEndState(
  val baseDraft: CalendarEditDraft,
  val neverEnds: Boolean,
  val selectedDate: LocalDate,
) {
  val startDate: LocalDate
    get() = parseRepeatEndDate(baseDraft.startDate) ?: selectedDate

  val valid: Boolean
    get() = neverEnds || !selectedDate.isBefore(startDate)

  fun setNeverEnds(value: Boolean): CalendarRepeatEndState = copy(neverEnds = value)

  fun setYear(value: Int): CalendarRepeatEndState = copy(
    selectedDate = selectedDate.withClampedYear(value),
  )

  fun setMonth(value: Int): CalendarRepeatEndState = copy(
    selectedDate = selectedDate.withClampedMonth(value),
  )

  fun setDay(value: Int): CalendarRepeatEndState = copy(
    selectedDate = selectedDate.withDayOfMonth(value.coerceAtMost(selectedDate.lengthOfMonth())),
  )

  fun completedDraft(): CalendarEditDraft = baseDraft.copy(
    recurrenceUntilDate = if (neverEnds) null else selectedDate.toString(),
  ).normalized()

  companion object {
    fun fromDraft(value: CalendarEditDraft): CalendarRepeatEndState {
      val draft = value.normalized()
      val start = requireNotNull(
        parseRepeatEndDate(draft.startDate)?.takeIf(CalendarEditDateRange::contains),
      ) { "start date is outside the visible wheel range" }
      val explicit = draft.recurrenceUntilDate?.let { raw ->
        requireNotNull(parseRepeatEndDate(raw)?.takeIf(CalendarEditDateRange::contains)) {
          "repeat end is outside the visible wheel range"
        }
      }
      val sourceDefault = when (draft.repeat) {
        "daily" -> start.plusMonths(1)
        "weekly" -> start.plusMonths(3)
        "monthly" -> start.plusYears(1)
        "yearly" -> start.plusYears(5)
        else -> start.plusMonths(3)
      }.let(CalendarEditDateRange::clamp)
      return CalendarRepeatEndState(
        baseDraft = draft,
        neverEnds = explicit == null,
        selectedDate = explicit ?: sourceDefault,
      )
    }
  }
}

@SuppressLint("ViewConstructor", "UseSwitchCompatOrMaterialCode")
internal class CalendarRepeatEndPageView(
  context: Context,
  initialState: CalendarRepeatEndState,
  private val onCancel: () -> Unit,
  private val onComplete: (CalendarEditDraft) -> Unit,
) : LinearLayout(context) {
  private val paletteReady = CalendarPagePalette.configure(context)
  private var state = initialState
  private var applyingState = false
  private val titleBar = CalendarCommonTitleBar(context)
  private val neverEndsSwitch = CalendarSourceSwitch(context).apply {
    contentDescription = "永不截止"
  }
  private val wheelContainer = LinearLayout(context).apply {
    orientation = VERTICAL
    setBackgroundColor(CalendarPagePalette.body)
  }
  private val wheelPanel = LinearLayout(context).apply {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private val yearWheel = CalendarEditWheelView(context)
  private val monthWheel = CalendarEditWheelView(context)
  private val dayWheel = CalendarEditWheelView(context)
  private val errorText = context.pageText(
    "截止日期需晚于开始日期",
    14f,
    CalendarPagePalette.danger,
  ).apply {
    visibility = GONE
  }

  init {
    orientation = VERTICAL
    setBackgroundColor(CalendarPagePalette.body)
    isClickable = true
    isFocusable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES


    addView(titleBar, LayoutParams(
      LayoutParams.MATCH_PARENT,
      CalendarCommonTitleBarContract.fullScreenHeightPx(context),
    ))
    addView(neverEndsRow(), LayoutParams(LayoutParams.MATCH_PARENT, context.pageDp(48)).apply {
      topMargin = context.pageDp(14)
    })
    addView(wheelContainer, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(errorText, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
      topMargin = context.pageDp(4)
      marginStart = context.pageDp(16)
      marginEnd = context.pageDp(16)
    })

    wheelContainer.addView(View(context).apply {
      setBackgroundColor(CalendarPagePalette.divider)
    }, LayoutParams(LayoutParams.MATCH_PARENT, context.pageDp(0.5f).coerceAtLeast(1)).apply {
      topMargin = context.pageDp(14)
      bottomMargin = context.pageDp(14)
      marginStart = context.pageDp(16)
    })
    wheelContainer.addView(context.pageText("截止时间", 16f, CalendarPagePalette.text), LayoutParams(
      LayoutParams.MATCH_PARENT,
      context.pageDp(34),
    ).apply {
      marginStart = context.pageDp(16)
      marginEnd = context.pageDp(15)
    })
    val frame = FrameLayout(context).apply {
      setPadding(0, context.pageDp(20), 0, context.pageDp(20))
      addView(wheelPanel, FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
      ).apply { gravity = Gravity.CENTER_VERTICAL })
    }
    wheelContainer.addView(frame, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    wheelPanel.addView(yearWheel, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    wheelPanel.addView(monthWheel, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    wheelPanel.addView(dayWheel, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))

    configureWheels()
    neverEndsSwitch.setOnCheckedChangeListener { _, checked ->
      if (!applyingState) applyState(state.setNeverEnds(checked))
    }
    syncUi()
  }

  fun currentState(): CalendarRepeatEndState = state

  fun dispose() {
    yearWheel.dispose()
    monthWheel.dispose()
    dayWheel.dispose()
  }

  private fun neverEndsRow(): View = LinearLayout(context).apply {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(context.pageDp(16), 0, context.pageDp(16), 0)
    addView(context.pageText("永不截止", 16f, CalendarPagePalette.text, Typeface.NORMAL), LayoutParams(
      0,
      LayoutParams.WRAP_CONTENT,
      1f,
    ))
    addView(neverEndsSwitch, LayoutParams(
      context.pageDp(CalendarSourceSwitch.TRACK_WIDTH_DP),
      context.pageDp(CalendarSourceSwitch.HOST_HEIGHT_DP),
    ).apply {
      rightMargin = context.pageDp(16)
    })
  }

  private fun configureWheels() {
    yearWheel.configure(
      CalendarEditTimeState.MIN_YEAR,
      CalendarEditTimeState.MAX_YEAR,
      looping = true,
      role = "截止年份滚轮",
      labelProvider = CalendarEditTimeFormatter::yearWheelLabel,
    ) { applyState(state.setYear(it)) }
    monthWheel.configure(
      1,
      12,
      looping = true,
      role = "截止月份滚轮",
      labelProvider = CalendarEditTimeFormatter::monthWheelLabel,
    ) { applyState(state.setMonth(it)) }
    configureDayWheel()
  }

  private fun configureDayWheel() {
    dayWheel.configure(
      1,
      YearMonth.from(state.selectedDate).lengthOfMonth(),
      looping = true,
      role = "截止日期滚轮",
      labelProvider = { day ->
        CalendarEditTimeFormatter.dayWithWeekdayWheelLabel(
          LocalDate.of(state.selectedDate.year, state.selectedDate.monthValue, day),
        )
      },
    ) { applyState(state.setDay(it)) }
  }

  private fun applyState(value: CalendarRepeatEndState) {
    val monthChanged = value.selectedDate.year != state.selectedDate.year ||
      value.selectedDate.monthValue != state.selectedDate.monthValue
    state = value
    if (monthChanged) configureDayWheel()
    syncUi()
  }

  private fun syncUi() {
    applyingState = true
    neverEndsSwitch.setCheckedIgnoreEvent(state.neverEnds)
    wheelContainer.visibility = if (state.neverEnds) GONE else VISIBLE
    errorText.visibility = if (state.valid) GONE else VISIBLE
    yearWheel.setValue(state.selectedDate.year)
    monthWheel.setValue(state.selectedDate.monthValue)
    dayWheel.setValue(state.selectedDate.dayOfMonth)
    titleBar.clearActions()
    titleBar.setCenterTitle("选择截止时间")
    titleBar.setDividerVisible(false)
    titleBar.setLeftTextAction("取消", debounce = true) { onCancel() }
    titleBar.addRightTextAction(
      "完成",
      if (state.valid) CalendarPagePalette.primary else CalendarPagePalette.disabled,
      debounce = true,
    ) {
      if (state.valid) onComplete(state.completedDraft())
    }
    applyingState = false
  }
}

private fun parseRepeatEndDate(value: String?): LocalDate? = try {
  value?.let(LocalDate::parse)
} catch (_: DateTimeParseException) {
  null
}

private fun LocalDate.withClampedYear(value: Int): LocalDate = LocalDate.of(
  value,
  monthValue,
  dayOfMonth.coerceAtMost(YearMonth.of(value, monthValue).lengthOfMonth()),
)

private fun LocalDate.withClampedMonth(value: Int): LocalDate = LocalDate.of(
  year,
  value,
  dayOfMonth.coerceAtMost(YearMonth.of(year, value).lengthOfMonth()),
)
