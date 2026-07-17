package com.laoji.nativeplatform.calendarpages

// CAL-DETAIL-001 / UI-SHELL-001 / UI-MOTION-001: the event detail page is a
// native title/header/body hierarchy with native scroll-driven title reveal.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

@SuppressLint("ViewConstructor")
class CalendarDetailPageView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  private val onAction by EventDispatcher<Map<String, Any?>>()
  private val root = FrameLayout(context)
  private val titleBar = CalendarPageTitleBar(context)
  private val scroll = ScrollView(context).apply {
    isFillViewport = true
    overScrollMode = View.OVER_SCROLL_NEVER
    isVerticalScrollBarEnabled = false
  }
  private val body = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(0, 0, 0, context.pageDp(80))
  }
  private val stateView = CalendarPageStateView(context) {
    onAction(mapOf("type" to "retry"))
  }
  private val busyOverlay = FrameLayout(context).apply {
    setBackgroundColor(CalendarPagePalette.scrim)
    isClickable = true
    isFocusable = true
    contentDescription = "正在删除日程"
    addView(
      ProgressBar(context),
      FrameLayout.LayoutParams(context.pageDp(40), context.pageDp(40)).apply {
        gravity = Gravity.CENTER
      },
    )
  }
  private var pendingSnapshot: Map<String, Any?> = emptyMap()
  private var state = CalendarDetailPageState()

  init {
    // CAL-DETAIL-001: Keep Android-managed page children visible inside ExpoView.
    setWillNotDraw(false)
    clipToPadding = false
    setBackgroundColor(CalendarPagePalette.body)
    scroll.addView(body, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    val page = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      addView(titleBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.pageDp(44)))
      addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }
    root.addView(page, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    root.addView(stateView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
      topMargin = context.pageDp(44)
    })
    root.addView(busyOverlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    scroll.setOnScrollChangeListener { _, _, scrollY, _, _ ->
      titleBar.setTitleAlpha(((scrollY - context.pageDp(40)) / context.pageDp(30).toFloat()).coerceIn(0f, 1f))
    }
  }

  fun setSnapshot(value: Map<String, Any?>) {
    pendingSnapshot = value
  }

  fun commitProps() {
    state = CalendarPageSnapshotParser.detail(pendingSnapshot)
    render()
  }

  private fun render() {
    titleBar.clearActions()
    titleBar.setTitle(state.title, CalendarPagePalette.primaryHeader, 0f)
    titleBar.addBack { emit("back") }
    if (state.loadState == CalendarPageLoadState.READY && state.editable) {
      titleBar.addRightIcon(android.R.drawable.ic_menu_edit, "编辑日程") { emit("edit") }
      titleBar.addRightIcon(
        android.R.drawable.ic_menu_delete,
        "删除日程",
        CalendarPagePalette.danger,
        enabled = !state.deleting,
      ) { requestDelete() }
    }

    val ready = state.loadState == CalendarPageLoadState.READY && state.ref != null
    scroll.visibility = if (ready) View.VISIBLE else View.GONE
    stateView.render(state.loadState, state.message)
    busyOverlay.visibility = if (state.deleting) View.VISIBLE else View.GONE
    if (!ready) return

    body.removeAllViews()
    body.addView(buildHeader(), LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    state.location?.takeIf(String::isNotBlank)?.let {
      body.addView(detailRow(android.R.drawable.ic_menu_mylocation, it, false))
    }
    state.notes?.takeIf(String::isNotBlank)?.let {
      body.addView(detailRow(android.R.drawable.ic_menu_sort_by_size, it, true))
    }
    state.reminderLabel?.takeIf(String::isNotBlank)?.let {
      body.addView(detailRow(android.R.drawable.ic_lock_idle_alarm, it, false))
    }
  }

  private fun buildHeader(): View = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    setPadding(context.pageDp(16), 0, context.pageDp(16), context.pageDp(30))
    background = GradientDrawable(
      GradientDrawable.Orientation.TOP_BOTTOM,
      intArrayOf(Color.rgb(240, 244, 255), CalendarPagePalette.body),
    )
    val summaryRow = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.TOP
      val marker = View(context).apply { pageShape(CalendarPagePalette.primaryHeader, 4f) }
      addView(marker, LinearLayout.LayoutParams(context.pageDp(14), context.pageDp(14)).apply {
        topMargin = context.pageDp(17)
        rightMargin = context.pageDp(18)
      })
      addView(
        context.pageText(
          state.title,
          20f,
          CalendarPagePalette.primaryHeader,
          Typeface.BOLD,
        ).apply { maxLines = 2 },
        LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply {
          topMargin = context.pageDp(10)
        },
      )
    }
    addView(summaryRow, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    addView(
      context.pageText(state.timeLabel, 14f, CalendarPagePalette.primaryHeader).apply {
        maxLines = 3
      },
      LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
        leftMargin = context.pageDp(32)
        topMargin = context.pageDp(4)
      },
    )
    state.repeatLabel?.takeIf(String::isNotBlank)?.let { label ->
      addView(
        context.pageText(label, 14f, Color.rgb(148, 180, 255)).apply { maxLines = 2 },
        LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
          leftMargin = context.pageDp(32)
        },
      )
    }
  }

  private fun detailRow(iconRes: Int, value: String, multiline: Boolean): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.TOP
      setPadding(0, context.pageDp(10), context.pageDp(16), context.pageDp(10))
      minimumHeight = context.pageDp(44)
      addView(ImageView(context).apply {
        setImageResource(iconRes)
        imageTintList = android.content.res.ColorStateList.valueOf(CalendarPagePalette.placeholder)
        contentDescription = null
        setPadding(context.pageDp(16), context.pageDp(3), context.pageDp(16), context.pageDp(3))
      }, LinearLayout.LayoutParams(context.pageDp(48), context.pageDp(22)))
      addView(context.pageText(value, 16f).apply {
        maxLines = if (multiline) Int.MAX_VALUE else 2
      }, LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
    }

  private fun requestDelete() {
    emit("delete")
  }

  private fun emit(type: String, extras: Map<String, Any?> = emptyMap()) {
    val ref = state.ref?.toBridge().orEmpty()
    onAction(mapOf("type" to type) + ref + extras)
  }

}
