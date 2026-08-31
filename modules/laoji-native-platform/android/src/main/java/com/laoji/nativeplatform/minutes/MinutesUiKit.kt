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
import com.laoji.nativeplatform.ui.LaojiThemeTypography
import com.laoji.nativeplatform.NativeThemePreference
import expo.modules.kotlin.AppContext
import kotlin.math.roundToInt

internal object MinutesPalette {
  var vivid = false
  var paper = false
  var midnight = false
  var cardRadiusDp = 10
  var coverRadiusDp = 0
  var gridSidePaddingDp = 8
  var page = Color.rgb(248, 249, 250)
  var surface = Color.WHITE
  var filler = Color.rgb(239, 240, 241)
  var text = Color.rgb(31, 35, 41)
  var secondary = Color.rgb(100, 106, 115)
  var faint = Color.rgb(143, 149, 158)
  var disabled = Color.rgb(187, 191, 196)
  var divider = Color.rgb(222, 224, 227)
  var timelineTrack = Color.argb(13, 31, 35, 41)
  var primary = Color.rgb(20, 86, 240)
  var primarySoft = Color.rgb(240, 244, 255)
  var primaryTransparent = Color.argb(38, 51, 109, 244)
  var primaryTransparentStrong = Color.argb(76, 51, 109, 244)
  var coverDefault = Color.rgb(220, 229, 250)
  var coverSummary = Color.rgb(230, 238, 247)
  var coverContent = Color.rgb(240, 241, 242)
  var danger = Color.rgb(226, 46, 40)
  var dangerSoft = Color.rgb(255, 243, 243)
  var warning = Color.rgb(194, 87, 5)
  var success = Color.rgb(37, 136, 50)
  var recordGradientStart = Color.rgb(85, 95, 242)
  var recordGradientEnd = Color.rgb(139, 118, 245)

  fun configure(context: Context) {
    val theme = NativeThemePreference.read(context)
    vivid = theme == "vivid"
    paper = theme == "paper"
    midnight = theme == "midnight"
    when (theme) {
      "vivid" -> configureVivid()
      "paper" -> configurePaper()
      "midnight" -> configureMidnight()
      else -> configureNeutral()
    }
  }

  private fun configureNeutral() {
    cardRadiusDp = 10
    coverRadiusDp = 0
    gridSidePaddingDp = 8
    page = Color.rgb(243, 246, 250)
    surface = Color.WHITE
    filler = Color.rgb(238, 243, 250)
    text = Color.rgb(23, 32, 51)
    secondary = Color.rgb(91, 101, 119)
    faint = Color.rgb(135, 146, 165)
    disabled = Color.rgb(180, 188, 200)
    divider = Color.rgb(220, 227, 236)
    timelineTrack = Color.argb(13, 23, 32, 51)
    primary = Color.rgb(39, 104, 232)
    primarySoft = Color.rgb(234, 241, 255)
    primaryTransparent = Color.argb(38, 39, 104, 232)
    primaryTransparentStrong = Color.argb(76, 39, 104, 232)
    coverDefault = Color.rgb(220, 230, 248)
    coverSummary = Color.rgb(230, 238, 248)
    coverContent = Color.rgb(239, 243, 248)
    danger = Color.rgb(226, 46, 40)
    dangerSoft = Color.rgb(255, 243, 243)
    warning = Color.rgb(194, 87, 5)
    success = Color.rgb(37, 136, 50)
    recordGradientStart = Color.rgb(77, 127, 234)
    recordGradientEnd = Color.rgb(39, 104, 232)
  }

  private fun configureVivid() {
    cardRadiusDp = 16
    coverRadiusDp = 12
    gridSidePaddingDp = 12
    page = Color.rgb(248, 246, 252)
    surface = Color.WHITE
    filler = Color.rgb(242, 238, 252)
    text = Color.rgb(33, 29, 45)
    secondary = Color.rgb(110, 104, 123)
    faint = Color.rgb(153, 146, 167)
    disabled = Color.rgb(201, 196, 209)
    divider = Color.rgb(228, 221, 236)
    timelineTrack = Color.argb(16, 114, 85, 201)
    primary = Color.rgb(114, 85, 201)
    primarySoft = Color.rgb(238, 233, 252)
    primaryTransparent = Color.argb(38, 130, 101, 212)
    primaryTransparentStrong = Color.argb(76, 130, 101, 212)
    coverDefault = Color.rgb(235, 226, 250)
    coverSummary = Color.rgb(250, 228, 238)
    coverContent = Color.rgb(243, 239, 249)
    danger = Color.rgb(255, 77, 79)
    dangerSoft = Color.rgb(255, 240, 248)
    warning = Color.rgb(224, 139, 51)
    success = Color.rgb(75, 157, 73)
    recordGradientStart = Color.rgb(130, 101, 212)
    recordGradientEnd = Color.rgb(216, 111, 153)
  }

  private fun configurePaper() {
    cardRadiusDp = 10
    coverRadiusDp = 4
    gridSidePaddingDp = 10
    page = Color.rgb(243, 240, 231)
    surface = Color.rgb(252, 251, 246)
    filler = Color.rgb(239, 238, 230)
    text = Color.rgb(37, 38, 33)
    secondary = Color.rgb(98, 99, 93)
    faint = Color.rgb(133, 134, 126)
    disabled = Color.rgb(180, 181, 173)
    divider = Color.rgb(216, 215, 205)
    timelineTrack = Color.argb(15, 37, 38, 33)
    primary = Color.rgb(99, 120, 36)
    primarySoft = Color.rgb(233, 237, 217)
    primaryTransparent = Color.argb(38, 99, 120, 36)
    primaryTransparentStrong = Color.argb(76, 99, 120, 36)
    coverDefault = Color.rgb(228, 231, 207)
    coverSummary = Color.rgb(235, 229, 213)
    coverContent = Color.rgb(239, 238, 230)
    danger = Color.rgb(201, 80, 69)
    dangerSoft = Color.rgb(249, 232, 228)
    warning = Color.rgb(181, 106, 34)
    success = Color.rgb(95, 125, 40)
    recordGradientStart = Color.rgb(130, 148, 61)
    recordGradientEnd = Color.rgb(96, 118, 36)
  }

  private fun configureMidnight() {
    cardRadiusDp = 12
    coverRadiusDp = 8
    gridSidePaddingDp = 10
    page = Color.rgb(16, 20, 27)
    surface = Color.rgb(27, 34, 45)
    filler = Color.rgb(32, 40, 52)
    text = Color.rgb(238, 243, 250)
    secondary = Color.rgb(176, 186, 200)
    faint = Color.rgb(127, 138, 154)
    disabled = Color.rgb(86, 97, 112)
    divider = Color.rgb(44, 55, 69)
    timelineTrack = Color.argb(22, 222, 231, 242)
    primary = Color.rgb(116, 167, 255)
    primarySoft = Color.rgb(30, 50, 80)
    primaryTransparent = Color.argb(46, 116, 167, 255)
    primaryTransparentStrong = Color.argb(82, 116, 167, 255)
    coverDefault = Color.rgb(31, 55, 84)
    coverSummary = Color.rgb(36, 51, 69)
    coverContent = Color.rgb(32, 40, 52)
    danger = Color.rgb(255, 119, 112)
    dangerSoft = Color.rgb(74, 41, 43)
    warning = Color.rgb(224, 164, 92)
    success = Color.rgb(103, 197, 135)
    recordGradientStart = Color.rgb(116, 167, 255)
    recordGradientEnd = Color.rgb(89, 185, 183)
  }
}

/** Keep translucent media tokens tied to the active skin instead of a source-blue literal. */
internal fun withAlpha(color: Int, alpha: Int): Int = Color.argb(
  alpha.coerceIn(0, 255),
  Color.red(color),
  Color.green(color),
  Color.blue(color),
)

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
  typeface = LaojiThemeTypography.typeface(this@textView, weight)
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
  private data class Configuration(
    val title: String,
    val showBack: Boolean,
    val showSearch: Boolean,
    val showShare: Boolean,
    val showMore: Boolean,
    val shareEnabled: Boolean,
    val showDone: Boolean,
  )

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
  private var actionHandler: ((String) -> Unit)? = null
  private var renderedConfiguration: Configuration? = null
  private val backButton = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back,
    "返回",
  ).apply {
    setOnClickListener { actionHandler?.invoke("back") }
  }
  private val moreButton = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_more_outline,
    "更多会议记录操作",
  ).apply {
    setOnClickListener { actionHandler?.invoke("more") }
  }
  private val searchButton = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_search_outline,
    "搜索文字记录",
  ).apply {
    setOnClickListener { actionHandler?.invoke("search") }
  }
  private val shareButton = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_share_outline,
    "分享会议资料",
  ).apply {
    setOnClickListener { actionHandler?.invoke("share") }
  }
  private val doneButton = context.textView("完成", 17, MinutesPalette.primary).apply {
    gravity = Gravity.CENTER
    isClickable = true
    isFocusable = true
    contentDescription = "完成编辑会议记录标题"
    visibility = View.GONE
    setOnClickListener { actionHandler?.invoke("done") }
  }

  val activeDoneAction: View?
    get() = doneButton.takeIf { it.visibility == View.VISIBLE }

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
    leftActions.addView(
      backButton,
      LinearLayout.LayoutParams(context.dp(44), context.dp(44)).apply { leftMargin = context.dp(6) },
    )
    rightActions.addView(searchButton, LinearLayout.LayoutParams(context.dp(44), context.dp(44)))
    rightActions.addView(moreButton, LinearLayout.LayoutParams(context.dp(44), context.dp(44)))
    rightActions.addView(shareButton, LinearLayout.LayoutParams(context.dp(44), context.dp(44)))
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
      LayoutParams(context.dp(132), context.dp(44)).apply {
        gravity = Gravity.END
        rightMargin = context.dp(6)
      },
    )
    addView(
      doneButton,
      LayoutParams(LayoutParams.WRAP_CONTENT, context.dp(44)).apply {
        gravity = Gravity.END
        rightMargin = context.dp(20)
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
    val next = Configuration(
      title = title,
      showBack = showBack,
      showSearch = showSearch,
      showShare = showShare,
      showMore = showMore,
      shareEnabled = shareEnabled,
      showDone = showDone,
    )
    actionHandler = onAction
    if (renderedConfiguration == next) return
    renderedConfiguration = next
    if (titleView.text.toString() != title) titleView.text = title
    if (editTitle.text.toString() != title) editTitle.text = title
    titleView.visibility = if (showDone) View.GONE else View.VISIBLE
    editTitleContainer.visibility = if (showDone) View.VISIBLE else View.GONE
    // Keep every action in one permanent slot. Tab changes only alter
    // visibility, so the shared title bar never destroys/recreates buttons or
    // shifts the remaining actions by one frame.
    backButton.visibility = if (showBack && !showDone) View.VISIBLE else View.INVISIBLE
    rightActions.visibility = if (showDone) View.INVISIBLE else View.VISIBLE
    moreButton.visibility = if (showMore) View.VISIBLE else View.INVISIBLE
    searchButton.visibility = if (showSearch) View.VISIBLE else View.INVISIBLE
    shareButton.visibility = if (showShare) View.VISIBLE else View.INVISIBLE
    shareButton.isEnabled = shareEnabled
    shareButton.alpha = if (shareEnabled) 1f else 0.35f
    doneButton.visibility = if (showDone) View.VISIBLE else View.GONE
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
  // [PRODUCT] Global app settings entry; the surrounding Minutes title bar
  // remains source-shaped and keeps its own palette/inset ownership.
  private val profileEntry = ProfileEntryView(context, appContext).apply {
    setOnClickListener { actionHandler?.invoke("openSettings") }
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
    canEmptyRecycleBin: Boolean,
    recycleBinEmptying: Boolean,
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
    val nextConfiguration = listOf(
      if (recycleBin) "recycle" else "meetings",
      canEmptyRecycleBin,
      recycleBinEmptying,
    ).joinToString("|")
    if (actionConfiguration == nextConfiguration) return
    actionConfiguration = nextConfiguration
    leading.removeAllViews()
    actions.removeAllViews()
    (titleView.layoutParams as LayoutParams).apply {
      leftMargin = context.dp(if (recycleBin) 70 else 98)
      rightMargin = context.dp(if (recycleBin) 70 else 98)
    }.also(titleView::setLayoutParams)
    if (recycleBin) {
      leading.addView(
        context.iconButton(
          com.laoji.nativeplatform.R.drawable.laoji_ic_arrow_back,
          "返回会议记录",
        ).apply { setOnClickListener { actionHandler?.invoke("closeRecycleBin") } },
        LinearLayout.LayoutParams(context.dp(44), context.dp(44)),
      )
      actions.addView(
        context.textView(
          if (recycleBinEmptying) "清理中" else "清空",
          textSizeSp = 15,
          color = if (canEmptyRecycleBin) MinutesPalette.danger else MinutesPalette.faint,
          weight = Typeface.BOLD,
        ).apply {
          gravity = Gravity.CENTER
          isClickable = canEmptyRecycleBin && !recycleBinEmptying
          isFocusable = canEmptyRecycleBin && !recycleBinEmptying
          isEnabled = canEmptyRecycleBin && !recycleBinEmptying
          visibility = if (canEmptyRecycleBin || recycleBinEmptying) View.VISIBLE else View.INVISIBLE
          contentDescription = if (recycleBinEmptying) "正在清空回收站" else "清空回收站"
          setOnClickListener { actionHandler?.invoke("emptyRecycleBin") }
        },
        LinearLayout.LayoutParams(context.dp(64), context.dp(44)),
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
  else -> MinutesPalette.secondary
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
