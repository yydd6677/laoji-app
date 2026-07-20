package com.laoji.nativeplatform.calendarpages

// CAL-SEARCH-001 / CAL-DETAIL-001 / UI-MOTION-001: native search owns EditText,
// RecyclerView, grouped 50dp event rows and the source-derived slide-in transition.

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Typeface
import android.text.Editable
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.laoji.nativeplatform.ui.requestInsetsWhenAttached
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

@SuppressLint("ViewConstructor")
class CalendarSearchPageView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  private val onAction by EventDispatcher<Map<String, Any?>>()
  private var bridgeEventsEnabled = true
  private var actionListener: ((Map<String, Any?>) -> Unit)? = null
  private val root = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    setBackgroundColor(CalendarPagePalette.body)
  }
  private val queryInput = EditText(context).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
    setTextColor(CalendarPagePalette.text)
    setHintTextColor(CalendarPagePalette.placeholder)
    hint = "搜索日程"
    background = null
    isSingleLine = true
    maxLines = 1
    setPadding(context.pageDp(4), 0, context.pageDp(4), 0)
  }
  private val clearButton = context.pageIconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_close,
    "清空搜索",
    CalendarPagePalette.placeholder,
  )
  private val recycler = RecyclerView(context).apply {
    layoutManager = LinearLayoutManager(context)
    overScrollMode = View.OVER_SCROLL_NEVER
  }
  private val adapter = CalendarSearchAdapter(::openRow)
  private val stateView = CalendarPageStateView(context) {
    emitAction(mapOf("type" to "retry"))
  }
  private var pendingSnapshot: Map<String, Any?> = emptyMap()
  private var suppressQueryEvent = false
  private var firstAttach = true
  private var dismissing = false
  private val showKeyboard = Runnable {
    if (!isAttachedToWindow || dismissing) return@Runnable
    queryInput.requestFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
      ?.showSoftInput(queryInput, InputMethodManager.SHOW_IMPLICIT)
  }

  init {
    // CAL-SEARCH-001: Keep Android-managed page children visible inside ExpoView.
    setWillNotDraw(false)
    clipToPadding = false
    val searchBar = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setBackgroundColor(CalendarPagePalette.body)
      addView(
        context.pageIconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back, "关闭搜索").apply {
          setOnClickListener { emitAction(mapOf("type" to "close")) }
        },
        LinearLayout.LayoutParams(context.pageDp(44), context.pageDp(56)).apply {
          leftMargin = context.pageDp(4)
        },
      )
      addView(
        context.pageIconButton(
          com.laoji.nativeplatform.R.drawable.laoji_ic_search_outline,
          "搜索",
          CalendarPagePalette.placeholder,
        ).apply { isClickable = false },
        LinearLayout.LayoutParams(context.pageDp(32), context.pageDp(56)),
      )
      addView(queryInput, LinearLayout.LayoutParams(0, context.pageDp(56), 1f))
      addView(clearButton, LinearLayout.LayoutParams(context.pageDp(56), context.pageDp(56)))
    }
    root.addView(searchBar, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, context.pageDp(56)))
    root.addView(context.pageDivider(16))
    val content = FrameLayout(context).apply {
      addView(recycler, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      addView(stateView, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
    root.addView(content, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
    addView(root, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    recycler.adapter = adapter

    queryInput.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(value: Editable?) {
        clearButton.visibility = if (value.isNullOrEmpty()) View.INVISIBLE else View.VISIBLE
        if (!suppressQueryEvent) {
          emitAction(mapOf("type" to "queryChange", "query" to value.toString()))
        }
      }
    })
    clearButton.visibility = View.INVISIBLE
    clearButton.setOnClickListener { queryInput.setText("") }
    ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      root.setPadding(0, systemBars.top, 0, systemBars.bottom)
      insets
    }
    requestInsetsWhenAttached()
  }

  fun setBridgeEventsEnabled(value: Boolean) {
    bridgeEventsEnabled = value
  }

  fun setActionListener(listener: ((Map<String, Any?>) -> Unit)?) {
    actionListener = listener
  }

  fun setSnapshot(value: Map<String, Any?>) {
    pendingSnapshot = value
  }

  fun commitProps() {
    val state = CalendarPageSnapshotParser.search(pendingSnapshot)
    if (queryInput.text.toString() != state.query) {
      suppressQueryEvent = true
      queryInput.setText(state.query)
      queryInput.setSelection(queryInput.text.length)
      suppressQueryEvent = false
    }
    adapter.submit(state.rows)
    recycler.visibility = if (state.loadState == CalendarPageLoadState.READY) View.VISIBLE else View.GONE
    stateView.render(state.loadState, state.message)
  }

  fun dismiss(onClosed: () -> Unit) {
    dismissing = true
    queryInput.removeCallbacks(showKeyboard)
    releaseInputMethodFocus()
    animate().cancel()
    animate()
      .translationX(resources.displayMetrics.widthPixels.toFloat())
      .setDuration(220L)
      .withEndAction(onClosed)
      .start()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    dismissing = false
    if (firstAttach) {
      firstAttach = false
      translationX = resources.displayMetrics.widthPixels.toFloat()
      animate().translationX(0f).setDuration(220L).start()
    }
    queryInput.post(showKeyboard)
  }

  override fun onDetachedFromWindow() {
    dismissing = true
    queryInput.removeCallbacks(showKeyboard)
    releaseInputMethodFocus()
    animate().cancel()
    super.onDetachedFromWindow()
  }

  private fun openRow(row: CalendarSearchRow) {
    emitAction(mapOf("type" to "openEvent") + row.ref.toBridge())
  }

  private fun emitAction(payload: Map<String, Any?>) {
    actionListener?.invoke(payload)
    if (bridgeEventsEnabled) onAction(payload)
  }

  private fun releaseInputMethodFocus() {
    val token = queryInput.windowToken
      ?: (context as? Activity)?.window?.decorView?.windowToken
      ?: windowToken
    queryInput.clearFocus()
    root.isFocusableInTouchMode = true
    root.requestFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
      ?.hideSoftInputFromWindow(token, 0)
  }
}

private class CalendarSearchAdapter(
  private val onClick: (CalendarSearchRow) -> Unit,
) : RecyclerView.Adapter<CalendarSearchRowHolder>() {
  private var rows: List<CalendarSearchRow> = emptyList()

  fun submit(value: List<CalendarSearchRow>) {
    rows = value
    notifyDataSetChanged()
  }

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): CalendarSearchRowHolder =
    CalendarSearchRowHolder(parent.context, onClick)

  override fun getItemCount(): Int = rows.size

  override fun onBindViewHolder(holder: CalendarSearchRowHolder, position: Int) {
    val previousMonth = rows.getOrNull(position - 1)?.monthLabel
    holder.bind(rows[position], rows[position].monthLabel != previousMonth)
  }
}

private class CalendarSearchRowHolder(
  context: Context,
  private val onClick: (CalendarSearchRow) -> Unit,
) : RecyclerView.ViewHolder(LinearLayout(context)) {
  private val root = itemView as LinearLayout
  private val month = context.pageText(sizeSp = 20f, weight = Typeface.BOLD).apply {
    setPadding(context.pageDp(16), 0, context.pageDp(16), 0)
    gravity = Gravity.CENTER_VERTICAL
  }
  private val eventRow = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private val dateLane = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.CENTER
  }
  private val weekday = context.pageText(sizeSp = 12f, weight = Typeface.BOLD).apply {
    gravity = Gravity.CENTER
  }
  private val day = context.pageText(sizeSp = 20f, weight = Typeface.BOLD).apply {
    gravity = Gravity.CENTER
  }
  private val marker = View(context).apply {
    pageShape(CalendarPagePalette.primary, 2f)
  }
  private val title = context.pageText(sizeSp = 16f).apply {
    maxLines = 1
  }
  private val time = context.pageText(sizeSp = 12f, color = CalendarPagePalette.secondary).apply {
    maxLines = 1
  }

  init {
    root.orientation = LinearLayout.VERTICAL
    root.setBackgroundColor(CalendarPagePalette.body)
    root.addView(month, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.pageDp(44)))
    dateLane.addView(weekday, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    dateLane.addView(day, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    eventRow.addView(dateLane, LinearLayout.LayoutParams(context.pageDp(57), context.pageDp(50)))
    eventRow.addView(marker, LinearLayout.LayoutParams(context.pageDp(4), context.pageDp(34)).apply {
      rightMargin = context.pageDp(10)
    })
    val content = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_VERTICAL
      addView(title, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      addView(time, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = context.pageDp(2)
      })
    }
    eventRow.addView(content, LinearLayout.LayoutParams(0, context.pageDp(50), 1f).apply {
      rightMargin = context.pageDp(16)
    })
    root.addView(eventRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.pageDp(50)))
  }

  fun bind(row: CalendarSearchRow, showMonth: Boolean) {
    month.visibility = if (showMonth) View.VISIBLE else View.GONE
    month.text = row.monthLabel
    dateLane.visibility = if (row.showDate) View.VISIBLE else View.INVISIBLE
    weekday.text = row.weekdayLabel
    day.text = row.dayLabel
    title.text = row.title
    time.text = row.timeLabel.ifEmpty { row.dateLabel }
    root.contentDescription = listOf(row.title, row.dateLabel, row.timeLabel)
      .filter(String::isNotBlank)
      .joinToString("，")
    root.setOnClickListener { onClick(row) }
    root.isClickable = true
    root.isFocusable = true
  }
}
