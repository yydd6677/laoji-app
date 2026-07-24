package com.laoji.nativeplatform.calendarpages

// CAL-DETAIL-001 / UI-TITLE-COMMON-001 / UI-MOTION-001: the event detail page
// uses the transparent secondary-left CommonTitleBar source specialization.

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.view.ViewGroup
import com.laoji.nativeplatform.evidence.FeishuEvidence
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

@SuppressLint("ViewConstructor")
@FeishuEvidence("CAL-DETAIL-EDIT-001", "UI-TITLE-COMMON-001")
class CalendarDetailPageView(
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
    scroll.setOnScrollChangeListener { _, _, scrollY, _, _ ->
      titleBar.setTitleAlpha(titleAlphaForScroll(scrollY))
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
    titleBar.setTransparentBackground()
    titleBar.setDividerVisible(false)
    titleBar.setSecondaryLeftTitle(
      state.title,
      CalendarPagePalette.primaryHeader,
      titleAlphaForScroll(scroll.scrollY),
    )
    titleBar.setLeftIconAction(
      com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back,
      "返回",
      Color.BLACK,
      CalendarTitleIconSize.SMALL,
      trailingPaddingDp = 0f,
      debounce = false,
    ) { emit("back") }
    if (state.loadState == CalendarPageLoadState.READY && state.editable) {
      titleBar.addRightIconAction(
        com.laoji.nativeplatform.R.drawable.laoji_ic_edit_outline,
        "编辑日程",
        Color.BLACK,
        CalendarTitleIconSize.SMALL,
        debounce = true,
      ) { emit("edit") }
      titleBar.addRightIconAction(
        com.laoji.nativeplatform.R.drawable.laoji_ic_delete_outline,
        "删除日程",
        Color.BLACK,
        CalendarTitleIconSize.SMALL,
        debounce = true,
      ) {
        if (!state.deleting) requestDelete()
      }
    }

    val ready = state.loadState == CalendarPageLoadState.READY && state.ref != null
    scroll.visibility = if (ready) View.VISIBLE else View.GONE
    stateView.render(state.loadState, state.message)
    busyOverlay.visibility = if (state.deleting) View.VISIBLE else View.GONE
    if (!ready) return

    body.removeAllViews()
    body.addView(buildHeader(), LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    state.meetingAction?.let { action ->
      body.addView(
        buildMeetingAction(action),
        LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, context.pageDp(48)).apply {
          leftMargin = context.pageDp(16)
          rightMargin = context.pageDp(16)
          bottomMargin = context.pageDp(16)
        },
      )
    }
    state.location?.takeIf(String::isNotBlank)?.let {
      body.addView(detailRow(com.laoji.nativeplatform.R.drawable.laoji_ic_location_outline, it, false))
    }
    state.notes?.takeIf(String::isNotBlank)?.let {
      body.addView(detailRow(com.laoji.nativeplatform.R.drawable.laoji_ic_note_outline, it, true))
    }
    state.reminderLabel?.takeIf(String::isNotBlank)?.let {
      body.addView(detailRow(com.laoji.nativeplatform.R.drawable.laoji_ic_time_outline, it, false))
    }
    state.seriesMemory?.let { memory ->
      body.addView(
        buildSeriesMemory(memory),
        LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
          topMargin = context.pageDp(12)
        },
      )
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

  private fun buildMeetingAction(action: CalendarMeetingAction): TextView =
    context.pageText(action.label, 17f, Color.WHITE).apply {
      gravity = Gravity.CENTER
      isEnabled = action.enabled
      isClickable = action.enabled
      isFocusable = action.enabled
      contentDescription = listOf(action.label, action.statusLabel)
        .filter(String::isNotBlank)
        .joinToString("，")
      background = StateListDrawable().apply {
        addState(
          intArrayOf(android.R.attr.state_pressed),
          GradientDrawable().apply {
            setColor(CalendarPagePalette.primaryPressed)
            cornerRadius = context.pageDp(6).toFloat()
          },
        )
        addState(
          intArrayOf(-android.R.attr.state_enabled),
          GradientDrawable().apply {
            setColor(CalendarPagePalette.primarySoft)
            cornerRadius = context.pageDp(6).toFloat()
          },
        )
        addState(
          intArrayOf(),
          GradientDrawable().apply {
            setColor(CalendarPagePalette.primary)
            cornerRadius = context.pageDp(6).toFloat()
          },
        )
      }
      setTextColor(
        android.content.res.ColorStateList(
          arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
          intArrayOf(CalendarPagePalette.disabled, Color.WHITE),
        ),
      )
      setOnClickListener {
        if (action.enabled) emit("meetingAction", mapOf("meetingActionKind" to action.kind))
      }
    }

  private fun buildSeriesMemory(memory: CalendarSeriesMemory): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      addView(context.pageDivider(0))
      when (memory.loadState) {
        CalendarPageLoadState.LOADING -> addView(seriesLoadingRow(memory.message))
        CalendarPageLoadState.ERROR -> addView(seriesErrorRow(memory.message))
        CalendarPageLoadState.READY -> {
          val previous = memory.previousMeeting ?: return@apply
          addView(seriesHeader(previous))
          if (memory.decisions.isNotEmpty()) {
            addView(seriesSectionLabel("决定"))
            memory.decisions.forEach { decision -> addView(seriesDecisionRow(decision)) }
          }
          if (memory.actions.isNotEmpty()) {
            addView(seriesSectionLabel("未完成事项"))
            memory.actions.forEachIndexed { index, action ->
              addView(seriesActionRow(action))
              if (index < memory.actions.lastIndex) addView(context.pageDivider(48))
            }
          }
          if (memory.decisions.isNotEmpty() || memory.actions.isNotEmpty()) {
            addView(context.pageDivider(16))
            addView(seriesCarryForwardAction())
          }
          addView(View(context), LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, context.pageDp(12)))
        }
        CalendarPageLoadState.EMPTY -> Unit
      }
    }

  private fun seriesLoadingRow(message: String?): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(context.pageDp(16), 0, context.pageDp(16), 0)
      minimumHeight = context.pageDp(56)
      addView(
        ProgressBar(context).apply {
          indeterminateTintList = android.content.res.ColorStateList.valueOf(CalendarPagePalette.primary)
        },
        LinearLayout.LayoutParams(context.pageDp(20), context.pageDp(20)).apply {
          rightMargin = context.pageDp(12)
        },
      )
      addView(
        context.pageText(message ?: "正在读取上次会议", 14f, CalendarPagePalette.secondary),
        LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f),
      )
    }

  private fun seriesErrorRow(message: String?): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(context.pageDp(16), 0, context.pageDp(8), 0)
      minimumHeight = context.pageDp(56)
      isClickable = true
      isFocusable = true
      background = seriesRowBackground()
      contentDescription = "${message ?: "上次会议内容暂时无法读取"}，重试"
      addView(
        context.pageText(message ?: "上次会议内容暂时无法读取", 14f, CalendarPagePalette.secondary),
        LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f),
      )
      addView(
        context.pageText("重试", 14f, CalendarPagePalette.primary).apply { gravity = Gravity.CENTER },
        LinearLayout.LayoutParams(context.pageDp(60), context.pageDp(44)),
      )
      setOnClickListener { emit("retrySeriesMemory") }
    }

  private fun seriesHeader(previous: CalendarSeriesMeeting): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(context.pageDp(16), context.pageDp(10), context.pageDp(4), context.pageDp(10))
      minimumHeight = context.pageDp(64)
      isClickable = true
      isFocusable = true
      background = seriesRowBackground()
      contentDescription = listOf("上次会议", previous.title, previous.dateLabel, "查看记录")
        .filter(String::isNotBlank)
        .joinToString("，")
      addView(
        LinearLayout(context).apply {
          orientation = LinearLayout.VERTICAL
          addView(context.pageText("上次会议", 16f, CalendarPagePalette.text))
          addView(
            context.pageText(
              listOf(previous.title, previous.dateLabel).filter(String::isNotBlank).joinToString(" · "),
              13f,
              CalendarPagePalette.secondary,
            ).apply {
              maxLines = 1
              ellipsize = android.text.TextUtils.TruncateAt.END
            },
          )
        },
        LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f),
      )
      addView(
        ImageView(context).apply {
          setImageResource(com.laoji.nativeplatform.R.drawable.laoji_ic_chevron_right_bold)
          imageTintList = android.content.res.ColorStateList.valueOf(CalendarPagePalette.placeholder)
          contentDescription = null
          setPadding(context.pageDp(14), context.pageDp(14), context.pageDp(14), context.pageDp(14))
        },
        LinearLayout.LayoutParams(context.pageDp(44), context.pageDp(44)),
      )
      setOnClickListener { emit("openSeriesMeeting", mapOf("meetingId" to previous.meetingId)) }
    }

  private fun seriesSectionLabel(label: String): View =
    context.pageText(label, 13f, CalendarPagePalette.secondary).apply {
      setPadding(context.pageDp(16), context.pageDp(10), context.pageDp(16), context.pageDp(4))
    }

  private fun seriesDecisionRow(decision: CalendarSeriesDecision): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.TOP
      setPadding(context.pageDp(16), context.pageDp(8), context.pageDp(16), context.pageDp(8))
      minimumHeight = context.pageDp(44)
      isClickable = true
      isFocusable = true
      background = seriesRowBackground()
      contentDescription = if (decision.sourceSegmentId != null || decision.sourceStartMs != null) {
        "决定，${decision.content}，定位来源文字"
      } else {
        "决定，${decision.content}，查看来源会议"
      }
      addView(
        View(context).apply { pageShape(CalendarPagePalette.primary, 2f) },
        LinearLayout.LayoutParams(context.pageDp(4), context.pageDp(4)).apply {
          topMargin = context.pageDp(8)
          rightMargin = context.pageDp(10)
        },
      )
      addView(
        context.pageText(decision.content, 15f, CalendarPagePalette.text).apply { maxLines = 3 },
        LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f),
      )
      setOnClickListener {
        val source = mutableMapOf<String, Any?>("meetingId" to decision.meetingId)
        decision.sourceSegmentId?.takeIf(String::isNotBlank)?.let { source["segmentId"] = it }
        decision.sourceStartMs?.takeIf { it >= 0L }?.let { source["positionMs"] = it }
        emit("openSeriesMeeting", source)
      }
    }

  private fun seriesActionRow(action: CalendarSeriesAction): View =
    LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.TOP
      setPadding(context.pageDp(16), context.pageDp(9), context.pageDp(16), context.pageDp(9))
      minimumHeight = context.pageDp(52)
      isClickable = true
      isFocusable = true
      background = seriesRowBackground()
      contentDescription = listOf("未完成事项", action.content, action.metaLabel, "查看来源")
        .filterNotNull()
        .filter(String::isNotBlank)
        .joinToString("，")
      addView(
        View(context).apply {
          background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.TRANSPARENT)
            setStroke(context.pageDp(1), CalendarPagePalette.placeholder)
          }
        },
        LinearLayout.LayoutParams(context.pageDp(16), context.pageDp(16)).apply {
          topMargin = context.pageDp(2)
          rightMargin = context.pageDp(12)
        },
      )
      addView(
        LinearLayout(context).apply {
          orientation = LinearLayout.VERTICAL
          addView(context.pageText(action.content, 15f, CalendarPagePalette.text).apply { maxLines = 3 })
          action.metaLabel?.takeIf(String::isNotBlank)?.let { meta ->
            addView(context.pageText(meta, 12f, CalendarPagePalette.secondary).apply {
              maxLines = 1
              ellipsize = android.text.TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
              topMargin = context.pageDp(2)
            })
          }
        },
        LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f),
      )
      setOnClickListener {
        emit("openSeriesAction", mapOf("meetingId" to action.meetingId, "actionId" to action.id))
      }
    }

  private fun seriesCarryForwardAction(): TextView =
    context.pageText("带入我的笔记", 15f, CalendarPagePalette.primary).apply {
      gravity = Gravity.CENTER
      minimumHeight = context.pageDp(44)
      isClickable = true
      isFocusable = true
      background = seriesRowBackground()
      contentDescription = "选择内容带入我的笔记"
      setOnClickListener { emit("carrySeriesMemory") }
    }

  private fun seriesRowBackground(): StateListDrawable = StateListDrawable().apply {
    addState(
      intArrayOf(android.R.attr.state_pressed),
      GradientDrawable().apply { setColor(Color.rgb(245, 246, 247)) },
    )
    addState(
      intArrayOf(),
      GradientDrawable().apply { setColor(Color.TRANSPARENT) },
    )
  }

  private fun requestDelete() {
    emit("delete")
  }

  private fun titleAlphaForScroll(scrollY: Int): Float =
    ((scrollY - context.pageDp(40)) / context.pageDp(30).toFloat()).coerceIn(0f, 1f)

  private fun emit(type: String, extras: Map<String, Any?> = emptyMap()) {
    val ref = state.ref?.toBridge().orEmpty()
    onAction(mapOf("type" to type) + ref + extras)
  }

}
