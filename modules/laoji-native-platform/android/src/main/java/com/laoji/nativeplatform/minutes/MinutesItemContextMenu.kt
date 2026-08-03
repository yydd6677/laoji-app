package com.laoji.nativeplatform.minutes

// [SOURCE] MmHomeItemLongClickBuilder keeps a bright screenshot of the pressed
// card over a full-screen scrim and places mm_home_item_menu beside that card.

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowInsetsControllerCompat
import kotlin.math.max
import kotlin.math.roundToInt

internal class MinutesItemContextMenu(
  private val sourceContext: Context,
  private val onAction: (Map<String, Any?>) -> Unit,
) {
  private var overlay: FrameLayout? = null
  private var overlayHost: ViewGroup? = null
  private var cardBitmap: Bitmap? = null
  private var backCallback: OnBackPressedCallback? = null
  private var contentRoot: View? = null
  private var previousContentAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
  private var activity: Activity? = null
  private var previousLightStatusBars = true
  private var previousLightNavigationBars = true

  fun dismiss() {
    backCallback?.remove()
    backCallback = null
    overlay?.let { overlayHost?.removeView(it) }
    overlay = null
    overlayHost = null
    cardBitmap?.recycle()
    cardBitmap = null
    contentRoot?.importantForAccessibility = previousContentAccessibility
    contentRoot = null
    activity?.let { currentActivity ->
      WindowInsetsControllerCompat(currentActivity.window, currentActivity.window.decorView).apply {
        isAppearanceLightStatusBars = previousLightStatusBars
        isAppearanceLightNavigationBars = previousLightNavigationBars
      }
    }
    activity = null
  }

  fun show(anchor: View, meeting: MinutesMeeting) {
    dismiss()
    val nextActivity = sourceContext.findActivity() ?: return
    val host = nextActivity.window.decorView as? ViewGroup ?: return
    if (!anchor.isShown || anchor.width <= 0 || anchor.height <= 0) return
    val anchorRect = Rect().also { anchor.getGlobalVisibleRect(it) }
    if (anchorRect.isEmpty) return
    val bitmap = anchor.captureBitmap() ?: return

    val hostLocation = IntArray(2).also(host::getLocationOnScreen)
    // [SOURCE] MmHomeItemLongClickBuilder positions its flow from
    // UIUtils.calcViewScreenLocation(itemView), which uses getLocationOnScreen.
    // The visible rect is clipped by RecyclerView and would shift a partial card.
    val anchorLocation = IntArray(2).also(anchor::getLocationOnScreen)
    val anchorLeft = anchorLocation[0] - hostLocation[0]
    val anchorTop = anchorLocation[1] - hostLocation[1]
    val anchorRight = anchorLeft + anchor.width
    val anchorBottom = anchorTop + anchor.height
    val hostWidth = host.width.takeIf { it > 0 } ?: nextActivity.resources.displayMetrics.widthPixels
    val hostHeight = host.height.takeIf { it > 0 } ?: nextActivity.resources.displayMetrics.heightPixels
    val scrim = FrameLayout(nextActivity).apply {
      setBackgroundColor(Color.argb((255 * 0.56f).roundToInt(), 0, 0, 0))
      isClickable = true
      isFocusable = true
      isFocusableInTouchMode = true
      contentDescription = "会议记录操作"
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    val card = ImageView(nextActivity).apply {
      setImageBitmap(bitmap)
      scaleType = ImageView.ScaleType.FIT_XY
      backgroundShape(MinutesPalette.surface, radiusDp = 12)
      clipToOutline = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    val actions = if (meeting.action == MinutesMeetingAction.RESTORE) {
      listOf(MenuAction(label = "恢复", type = "restoreMeeting"))
    } else {
      listOf(
        MenuAction(
          label = if (meeting.canResume) "继续录音" else "查看会议记录",
          type = if (meeting.canResume) "openRecording" else "openMeeting",
        ),
        MenuAction(label = "设置标签", type = "setMeetingTags"),
        MenuAction(label = "删除", type = "deleteMeeting"),
      )
    }
    val menu = createMenu(nextActivity, actions, meeting.targetMeetingId)
    val horizontalPadding = nextActivity.dp(2)
    val verticalPadding = nextActivity.dp(3)
    val cardLeft = anchorLeft - horizontalPadding
    val cardTop = anchorTop - verticalPadding
    scrim.addView(
      card,
      FrameLayout.LayoutParams(
        anchor.width + horizontalPadding * 2,
        anchor.height + verticalPadding * 2,
      ).apply {
        leftMargin = cardLeft
        topMargin = cardTop
      },
    )

    menu.measure(
      View.MeasureSpec.makeMeasureSpec(nextActivity.dp(252), View.MeasureSpec.AT_MOST),
      View.MeasureSpec.makeMeasureSpec(hostHeight, View.MeasureSpec.AT_MOST),
    )
    val menuWidth = menu.measuredWidth.coerceIn(nextActivity.dp(128), nextActivity.dp(252))
    val menuHeight = menu.measuredHeight
    val safeGap = nextActivity.dp(8)
    val screenMargin = nextActivity.dp(8)
    val placeBelow = hostHeight - anchorBottom - screenMargin >= menuHeight + safeGap
    val proposedTop = if (placeBelow) anchorBottom + safeGap else anchorTop - safeGap - menuHeight
    val menuTop = proposedTop.coerceIn(screenMargin, max(screenMargin, hostHeight - menuHeight - screenMargin))
    val anchorCenterX = (anchorLeft + anchorRight) / 2
    val proposedLeft = if (anchorCenterX <= hostWidth / 2) {
      anchorLeft - horizontalPadding
    } else {
      anchorRight + horizontalPadding - menuWidth
    }
    val menuLeft = proposedLeft.coerceIn(screenMargin, max(screenMargin, hostWidth - menuWidth - screenMargin))
    scrim.addView(
      menu,
      FrameLayout.LayoutParams(menuWidth, menuHeight).apply {
        leftMargin = menuLeft
        topMargin = menuTop
      },
    )

    scrim.setOnClickListener { dismiss() }
    card.setOnClickListener { dismiss() }
    scrim.setOnKeyListener { _, keyCode, event ->
      if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
        dismiss()
        true
      } else {
        false
      }
    }
    val nextBackCallback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = dismiss()
    }
    (nextActivity as? ComponentActivity)?.onBackPressedDispatcher?.addCallback(nextBackCallback)

    val appContent = nextActivity.findViewById<View>(android.R.id.content)
    previousContentAccessibility = appContent?.importantForAccessibility
      ?: View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    appContent?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    val systemBarController = WindowInsetsControllerCompat(nextActivity.window, nextActivity.window.decorView)
    previousLightStatusBars = systemBarController.isAppearanceLightStatusBars
    previousLightNavigationBars = systemBarController.isAppearanceLightNavigationBars
    systemBarController.isAppearanceLightStatusBars = false
    systemBarController.isAppearanceLightNavigationBars = false

    activity = nextActivity
    overlay = scrim
    overlayHost = host
    cardBitmap = bitmap
    backCallback = nextBackCallback
    contentRoot = appContent
    host.addView(
      scrim,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
    scrim.bringToFront()
    scrim.requestFocus()
  }

  private fun createMenu(
    context: Context,
    actions: List<MenuAction>,
    meetingId: String,
  ): LinearLayout = LinearLayout(context).apply {
    // [SOURCE] mm_home_item_menu.xml: 48dp rows, 128-252dp width,
    // 16sp regular text, 16dp horizontal padding and a 0.5dp divider.
    orientation = LinearLayout.VERTICAL
    minimumWidth = context.dp(128)
    backgroundShape(MinutesPalette.surface, radiusDp = 12)
    clipToOutline = true
    elevation = context.dp(8).toFloat()
    actions.forEachIndexed { index, action ->
      val row = context.textView(action.label, textSizeSp = 16).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(context.dp(16), 0, context.dp(16), 0)
        minWidth = context.dp(128)
        maxWidth = context.dp(252)
        isClickable = true
        isFocusable = true
        contentDescription = action.label
        background = menuRowBackground(context)
        setOnClickListener {
          dismiss()
          onAction(mapOf("type" to action.type, "meetingId" to meetingId))
        }
      }
      addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(48)))
      if (index != actions.lastIndex) {
        addView(
          View(context).apply { setBackgroundColor(MinutesPalette.divider) },
          LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            max(1, (context.resources.displayMetrics.density * 0.5f).roundToInt()),
          ),
        )
      }
    }
  }

  private data class MenuAction(val label: String, val type: String)
}

private fun View.captureBitmap(): Bitmap? = try {
  Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bitmap ->
    draw(Canvas(bitmap))
  }
} catch (_: RuntimeException) {
  null
}

private fun menuRowBackground(context: Context): StateListDrawable = StateListDrawable().apply {
  addState(
    intArrayOf(android.R.attr.state_pressed),
    GradientDrawable().apply { setColor(MinutesPalette.filler) },
  )
  addState(
    intArrayOf(),
    GradientDrawable().apply { setColor(MinutesPalette.surface) },
  )
}

private fun Context.findActivity(): Activity? {
  var current: Context? = this
  while (current is ContextWrapper) {
    if (current is Activity) return current
    current = current.baseContext
  }
  return current as? Activity
}
