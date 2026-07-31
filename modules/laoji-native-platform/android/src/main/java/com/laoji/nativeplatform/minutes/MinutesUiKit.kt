package com.laoji.nativeplatform.minutes

// UI-TOKENS-001 / MIN-ROOT-001: shared native Minutes tokens and controls.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import com.laoji.nativeplatform.ui.ProfileEntryView
import com.laoji.nativeplatform.ui.NativeUiTokens
import expo.modules.kotlin.AppContext
import kotlin.math.roundToInt

internal object MinutesPalette {
  val page = Color.rgb(248, 249, 250)
  val surface = Color.WHITE
  val filler = Color.rgb(239, 240, 241)
  val text = Color.rgb(31, 35, 41)
  val secondary = Color.rgb(100, 106, 115)
  val faint = Color.rgb(143, 149, 158)
  val disabled = Color.rgb(187, 191, 196)
  val divider = Color.rgb(222, 224, 227)
  val timelineTrack = Color.argb(13, 31, 35, 41)
  val primary = Color.rgb(20, 86, 240)
  val primarySoft = Color.rgb(240, 244, 255)
  val primaryTransparent = Color.argb(38, 51, 109, 244)
  val primaryTransparentStrong = Color.argb(76, 51, 109, 244)
  val coverDefault = Color.rgb(220, 229, 250)
  val coverSummary = Color.rgb(230, 238, 247)
  val coverContent = Color.rgb(240, 241, 242)
  val danger = Color.rgb(226, 46, 40)
  val dangerSoft = Color.rgb(255, 243, 243)
  val warning = Color.rgb(194, 87, 5)
  val success = Color.rgb(37, 136, 50)
}

internal fun Context.dp(value: Int): Int =
  TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

/** Android XML dimension resources round to the nearest device pixel. */
internal fun Context.dpRounded(value: Int): Int =
  TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).roundToInt()

internal fun Context.sp(value: Int): Float =
  TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), resources.displayMetrics)

internal fun View.backgroundShape(
  color: Int,
  radiusDp: Int = 0,
  strokeColor: Int? = null,
  strokeWidthDp: Int = 0,
) {
  background = GradientDrawable().apply {
    setColor(color)
    cornerRadius = context.dp(radiusDp).toFloat()
    if (strokeColor != null && strokeWidthDp > 0) {
      setStroke(context.dp(strokeWidthDp), strokeColor)
    }
  }
}

internal fun View.backgroundHorizontalGradient(
  startColor: Int,
  endColor: Int,
  radiusDp: Int,
) {
  background = GradientDrawable(
    GradientDrawable.Orientation.LEFT_RIGHT,
    intArrayOf(startColor, endColor),
  ).apply {
    cornerRadius = context.dp(radiusDp).toFloat()
  }
}

internal fun Context.roundedStateBackground(
  defaultColor: Int,
  pressedColor: Int,
  disabledColor: Int,
  radiusDp: Int,
): StateListDrawable {
  fun shape(color: Int) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radiusDp).toFloat()
  }
  return StateListDrawable().apply {
    addState(intArrayOf(-android.R.attr.state_enabled), shape(disabledColor))
    addState(intArrayOf(android.R.attr.state_pressed), shape(pressedColor))
    addState(intArrayOf(), shape(defaultColor))
  }
}

internal fun statefulIconTint(defaultColor: Int, pressedColor: Int, disabledColor: Int): ColorStateList =
  ColorStateList(
    arrayOf(
      intArrayOf(-android.R.attr.state_enabled),
      intArrayOf(android.R.attr.state_pressed),
      intArrayOf(),
    ),
    intArrayOf(disabledColor, pressedColor, defaultColor),
  )

internal fun Context.textView(
  text: CharSequence = "",
  textSizeSp: Int = 14,
  color: Int = MinutesPalette.text,
  weight: Int = Typeface.NORMAL,
): TextView = TextView(this).apply {
  this.text = text
  setTextSize(TypedValue.COMPLEX_UNIT_SP, textSizeSp.toFloat())
  setTextColor(color)
  typeface = Typeface.create(Typeface.DEFAULT, weight)
  includeFontPadding = false
}

internal fun Context.iconButton(
  drawableRes: Int,
  description: String,
): ImageButton = ImageButton(this).apply {
  setImageResource(drawableRes)
  imageTintList = ColorStateList.valueOf(MinutesPalette.text)
  background = null
  contentDescription = description
  isFocusable = true
  isClickable = true
  minimumWidth = dp(44)
  minimumHeight = dp(44)
  setPadding(dp(11), dp(11), dp(11), dp(11))
}

internal class MinutesTitleBar(context: Context) : FrameLayout(context) {
  private val titleView = context.textView(textSizeSp = 20, weight = Typeface.BOLD).apply {
    gravity = Gravity.CENTER
    maxLines = 1
  }
  private val editTitleContainer = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.CENTER_VERTICAL
    visibility = View.GONE
  }
  private val editTitle = context.textView(textSizeSp = 17, weight = Typeface.BOLD).apply { maxLines = 1 }
  private val editStatus = context.textView("已保存", textSizeSp = 12, color = MinutesPalette.faint).apply { maxLines = 1 }
  private val leftActions = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private val rightActions = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private var actionConfiguration = ""
  private var actionHandler: ((String) -> Unit)? = null
  private var doneAction: View? = null

  val activeDoneAction: View?
    get() = doneAction

  fun setEditDirty(value: Boolean) {
    editStatus.text = if (value) "未保存" else "已保存"
    editStatus.setTextColor(if (value) MinutesPalette.warning else MinutesPalette.faint)
    editStatus.contentDescription = editStatus.text
  }

  init {
    setBackgroundColor(MinutesPalette.surface)
    minimumHeight = context.dp(44)
    addView(
      titleView,
      LayoutParams(LayoutParams.MATCH_PARENT, context.dp(44)).apply {
        leftMargin = context.dp(98)
        rightMargin = context.dp(98)
        gravity = Gravity.CENTER
      },
    )
    editTitleContainer.addView(
      editTitle,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    editTitleContainer.addView(
      editStatus,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    addView(
      editTitleContainer,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        leftMargin = context.dp(16)
        rightMargin = context.dp(82)
      },
    )
    addView(
      leftActions,
      LayoutParams(LayoutParams.WRAP_CONTENT, context.dp(44)).apply { gravity = Gravity.START },
    )
    addView(
      rightActions,
      LayoutParams(LayoutParams.WRAP_CONTENT, context.dp(44)).apply {
        gravity = Gravity.END
        rightMargin = context.dp(6)
      },
    )
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
  }

  fun configure(
    title: String,
    showBack: Boolean,
    showSearch: Boolean = false,
    showShare: Boolean = false,
    showMore: Boolean = false,
    shareEnabled: Boolean = true,
    showDone: Boolean = false,
    onAction: (String) -> Unit,
  ) {
    if (titleView.text.toString() != title) titleView.text = title
    if (editTitle.text.toString() != title) editTitle.text = title
    titleView.visibility = if (showDone) View.GONE else View.VISIBLE
    editTitleContainer.visibility = if (showDone) View.VISIBLE else View.GONE
    actionHandler = onAction
    val nextConfiguration = listOf(showBack, showSearch, showShare, showMore, shareEnabled, showDone).joinToString("|")
    if (nextConfiguration == actionConfiguration) return
    actionConfiguration = nextConfiguration
    leftActions.removeAllViews()
    rightActions.removeAllViews()
    doneAction = null
    if (showBack && !showDone) {
      leftActions.addView(
        context.iconButton(com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back, "返回").apply {
          setOnClickListener { actionHandler?.invoke("back") }
        },
        LinearLayout.LayoutParams(context.dp(44), context.dp(44)).apply { leftMargin = context.dp(6) },
      )
    }
    if (showDone) {
      doneAction = context.textView("完成", 17, MinutesPalette.primary).apply {
        gravity = Gravity.CENTER
        isClickable = true
        isFocusable = true
        contentDescription = "完成编辑会议记录标题"
        setOnClickListener { actionHandler?.invoke("done") }
      }
      (rightActions.layoutParams as? LayoutParams)?.rightMargin = context.dp(20)
      rightActions.requestLayout()
      rightActions.addView(doneAction, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(44)))
    } else {
      (rightActions.layoutParams as? LayoutParams)?.rightMargin = context.dp(6)
      rightActions.requestLayout()
      if (showMore) {
        addRightAction(com.laoji.nativeplatform.R.drawable.laoji_ic_more_outline, "更多会议记录操作", action = "more")
      }
      if (showSearch) {
        addRightAction(com.laoji.nativeplatform.R.drawable.laoji_ic_search_outline, "搜索会议记录", action = "search")
      }
      if (showShare) {
        addRightAction(com.laoji.nativeplatform.R.drawable.laoji_ic_share_outline, "分享会议资料", shareEnabled, "share")
      }
    }
  }

  private fun addRightAction(
    drawableRes: Int,
    description: String,
    enabled: Boolean = true,
    action: String,
  ) {
    rightActions.addView(
      context.iconButton(drawableRes, description).apply {
        isEnabled = enabled
        alpha = if (enabled) 1f else 0.35f
        setOnClickListener { actionHandler?.invoke(action) }
      },
      LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
    )
  }
}

/** Main-tab title mirrors MmInviteTitleBar in the in-main-tab, left-title branch. */
internal class MinutesMainTitleBar(context: Context, appContext: AppContext) : FrameLayout(context) {
  private val titleView = context.textView(textSizeSp = 20, weight = Typeface.BOLD).apply {
    gravity = Gravity.CENTER
    maxLines = 1
  }
  private val actions = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private val leading = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }
  private var actionHandler: ((String) -> Unit)? = null
  private var actionConfiguration = ""
  private val viewModeButton = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_list_outline,
    "切换到列表视图",
  )
  private val moreButton = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_more_outline,
    "更多会议记录操作",
  )
  // [PRODUCT] Global app profile entry; the surrounding Minutes title bar
  // remains source-shaped and keeps its own palette/inset ownership.
  private val profileEntry = ProfileEntryView(context, appContext).apply {
    setOnClickListener { actionHandler?.invoke("openProfile") }
  }

  fun moreAnchor(): View = moreButton

  fun setProfileEntrySnapshot(snapshot: Map<String, Any?>) {
    profileEntry.setSnapshot(snapshot)
  }

  init {
    setBackgroundColor(MinutesPalette.page)
    minimumHeight = context.dp(44)
    addView(
      titleView,
      LayoutParams(LayoutParams.MATCH_PARENT, context.dp(44)).apply {
        gravity = Gravity.CENTER
        // mm_view_invite_titlebar.xml gives the title a centered lane between
        // the 44dp leading slot and the two trailing actions.
        leftMargin = context.dp(98)
        rightMargin = context.dp(98)
      },
    )
    addView(
      leading,
      LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT).apply {
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        leftMargin = context.dp(6)
      },
    )
    addView(
      actions,
      LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT).apply {
        gravity = Gravity.END or Gravity.CENTER_VERTICAL
        rightMargin = context.dp(6)
      },
    )
  }

  fun configure(
    title: String,
    viewMode: MinutesHomeViewMode,
    recycleBin: Boolean,
    onAction: (String) -> Unit,
  ) {
    titleView.text = title
    actionHandler = onAction
    viewModeButton.setImageResource(
      if (viewMode == MinutesHomeViewMode.GRID) {
        com.laoji.nativeplatform.R.drawable.laoji_ic_list_outline
      } else {
        com.laoji.nativeplatform.R.drawable.laoji_ic_grid_outline
      },
    )
    viewModeButton.contentDescription = if (viewMode == MinutesHomeViewMode.GRID) {
      "切换到列表视图"
    } else {
      "切换到网格视图"
    }
    val nextConfiguration = if (recycleBin) "recycle" else "meetings"
    if (actionConfiguration == nextConfiguration) return
    actionConfiguration = nextConfiguration
    leading.removeAllViews()
    actions.removeAllViews()
    (titleView.layoutParams as LayoutParams).apply {
      leftMargin = context.dp(if (recycleBin) 54 else 98)
      rightMargin = context.dp(if (recycleBin) 54 else 98)
    }.also(titleView::setLayoutParams)
    if (recycleBin) {
      leading.addView(
        context.iconButton(
          com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back,
          "返回会议记录",
        ).apply { setOnClickListener { actionHandler?.invoke("closeRecycleBin") } },
        LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
      )
      return
    }
    leading.addView(
      profileEntry,
      LinearLayout.LayoutParams(
        context.dp(NativeUiTokens.PROFILE_ENTRY_HIT_SIZE_DP.toInt()),
        context.dp(NativeUiTokens.PROFILE_ENTRY_HIT_SIZE_DP.toInt()),
      ),
    )
    actions.addView(
      context.iconButton(
        com.laoji.nativeplatform.R.drawable.laoji_ic_search_outline,
        "搜索会议记录",
      ).apply { setOnClickListener { actionHandler?.invoke("search") } },
      LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
    )
    actions.addView(
      viewModeButton.apply { setOnClickListener { actionHandler?.invoke("toggleViewMode") } },
      LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
    )
    actions.addView(
      moreButton.apply { setOnClickListener { actionHandler?.invoke("more") } },
      LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
    )
  }
}

internal fun statusToneColor(tone: String): Int = when (tone) {
  "danger" -> MinutesPalette.danger
  "warning" -> MinutesPalette.warning
  "success" -> MinutesPalette.success
  "primary" -> MinutesPalette.primary
  else -> MinutesPalette.faint
}

internal fun formatClock(durationMs: Long): String {
  val totalSeconds = (durationMs.coerceAtLeast(0L) / 1_000L).toInt()
  val hours = totalSeconds / 3_600
  val minutes = (totalSeconds % 3_600) / 60
  val seconds = totalSeconds % 60
  return if (hours > 0) {
    "%02d:%02d:%02d".format(hours, minutes, seconds)
  } else {
    "%02d:%02d".format(minutes, seconds)
  }
}
