package com.laoji.nativeplatform.minutes

// [SOURCE] MmListMoreMenu + mm_tab_more_dialog.xml: the home-title overflow
// is an anchor-positioned menu with 48dp rows, 140dp minimum width, 16sp text,
// 20dp horizontal padding, and a 12dp icon/text gap.

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.ColorStateList
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
import kotlin.math.max

internal class MinutesMainMenu(
  private val sourceContext: Context,
  private val onAction: (Map<String, Any?>) -> Unit,
) {
  private var overlay: FrameLayout? = null
  private var overlayHost: ViewGroup? = null
  private var backCallback: OnBackPressedCallback? = null
  private var contentRoot: View? = null
  private var previousContentAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO

  fun show(anchor: View, canOpenRecycleBin: Boolean) {
    dismiss()
    val activity = sourceContext.findMenuActivity() ?: return
    val host = activity.window.decorView as? ViewGroup ?: return
    if (!anchor.isShown || anchor.width <= 0 || anchor.height <= 0) return
    val anchorRect = Rect().also(anchor::getGlobalVisibleRect)
    if (anchorRect.isEmpty) return

    val hostLocation = IntArray(2).also(host::getLocationOnScreen)
    val anchorLocation = IntArray(2).also(anchor::getLocationOnScreen)
    val anchorLeft = anchorLocation[0] - hostLocation[0]
    val anchorTop = anchorLocation[1] - hostLocation[1]
    val hostWidth = host.width.takeIf { it > 0 } ?: activity.resources.displayMetrics.widthPixels
    val hostHeight = host.height.takeIf { it > 0 } ?: activity.resources.displayMetrics.heightPixels

    val scrim = FrameLayout(activity).apply {
      setBackgroundColor(Color.TRANSPARENT)
      isClickable = true
      isFocusable = true
      isFocusableInTouchMode = true
      contentDescription = "会议记录更多操作"
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    val menu = createMenu(activity, canOpenRecycleBin)
    menu.measure(
      View.MeasureSpec.makeMeasureSpec(hostWidth, View.MeasureSpec.AT_MOST),
      View.MeasureSpec.makeMeasureSpec(hostHeight, View.MeasureSpec.AT_MOST),
    )
    val menuWidth = menu.measuredWidth.coerceAtLeast(activity.dp(140))
    val menuHeight = menu.measuredHeight
    val screenMargin = activity.dp(8)
    // [SOURCE] MmListMoreMenu passes {12f, 49f} to the anchored dialog helper.
    val menuLeft = (anchorLeft + anchor.width - menuWidth - activity.dp(12))
      .coerceIn(screenMargin, max(screenMargin, hostWidth - menuWidth - screenMargin))
    val menuTop = (anchorTop + activity.dp(49))
      .coerceIn(screenMargin, max(screenMargin, hostHeight - menuHeight - screenMargin))
    scrim.addView(
      menu,
      FrameLayout.LayoutParams(menuWidth, menuHeight).apply {
        leftMargin = menuLeft
        topMargin = menuTop
      },
    )
    scrim.setOnClickListener { dismiss() }
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
    (activity as? ComponentActivity)?.onBackPressedDispatcher?.addCallback(nextBackCallback)

    val appContent = activity.findViewById<View>(android.R.id.content)
    previousContentAccessibility = appContent?.importantForAccessibility
      ?: View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    appContent?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    contentRoot = appContent
    overlay = scrim
    overlayHost = host
    backCallback = nextBackCallback
    host.addView(
      scrim,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
    scrim.bringToFront()
    scrim.requestFocus()
  }

  fun dismiss() {
    backCallback?.remove()
    backCallback = null
    overlay?.let { overlayHost?.removeView(it) }
    overlay = null
    overlayHost = null
    contentRoot?.importantForAccessibility = previousContentAccessibility
    contentRoot = null
  }

  private fun createMenu(context: Context, canOpenRecycleBin: Boolean): LinearLayout = LinearLayout(context).apply {
    orientation = LinearLayout.VERTICAL
    minimumWidth = context.dp(140)
    backgroundShape(MinutesPalette.surface, radiusDp = 8)
    clipToOutline = true
    elevation = context.dp(8).toFloat()
    val actions = mutableListOf(
      MenuAction(
        label = "管理标签",
        type = "openMeetingTags",
        icon = com.laoji.nativeplatform.R.drawable.laoji_ic_note_outline,
      ),
      MenuAction(
        label = "管理讲话人",
        type = "openSpeakers",
        icon = com.laoji.nativeplatform.R.drawable.laoji_ic_member_outline,
      ),
      MenuAction(
        label = "个人资料",
        type = "openProfile",
        icon = com.laoji.nativeplatform.R.drawable.laoji_ic_personal_info_outline,
      ),
    )
    if (canOpenRecycleBin) {
      actions += MenuAction(
        label = "回收站",
        type = "openRecycleBin",
        icon = com.laoji.nativeplatform.R.drawable.laoji_ic_delete_outline,
      )
    }
    actions.forEach { action ->
      val row = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumWidth = context.dp(140)
        setPadding(context.dp(20), 0, context.dp(20), 0)
        isClickable = true
        isFocusable = true
        contentDescription = action.label
        background = mainMenuRowBackground()
        val icon = ImageView(context).apply {
          setImageResource(action.icon)
          imageTintList = ColorStateList.valueOf(MinutesPalette.text)
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        addView(icon, LinearLayout.LayoutParams(context.dp(24), context.dp(24)))
        addView(
          context.textView(action.label, textSizeSp = 16),
          LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = context.dp(12)
          },
        )
        setOnClickListener {
          dismiss()
          onAction(mapOf("type" to action.type))
        }
      }
      addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(48)))
    }
  }

  private data class MenuAction(val label: String, val type: String, val icon: Int)
}

private fun mainMenuRowBackground(): StateListDrawable = StateListDrawable().apply {
  addState(
    intArrayOf(android.R.attr.state_pressed),
    GradientDrawable().apply { setColor(Color.rgb(242, 243, 245)) },
  )
  addState(
    intArrayOf(),
    GradientDrawable().apply { setColor(MinutesPalette.surface) },
  )
}

private fun Context.findMenuActivity(): Activity? {
  var current: Context? = this
  while (current is ContextWrapper) {
    if (current is Activity) return current
    current = current.baseContext
  }
  return current as? Activity
}
