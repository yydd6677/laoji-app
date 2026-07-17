package com.laoji.nativeplatform.ui

// UI-OVERLAY-WINDOW-001: transient feedback is a non-exported Activity child.

import android.content.Context
import android.os.SystemClock
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.annotation.Keep
import expo.modules.kotlin.AppContext
import kotlin.math.max
import kotlin.math.min

@Keep
internal class NativeToastHostView(
  context: Context,
  @Suppress("UNUSED_PARAMETER") appContext: AppContext,
) : FrameLayout(context) {
  private val palette = NativeUiTokens.palette(context)
  private val toastRoot = FrameLayout(context)
  private var snapshot: Map<String, Any?> = emptyMap()
  private var navigationInsetPx = 0
  private var imeInsetPx = 0
  private var panel: LinearLayout? = null
  private var messageText: TextView? = null
  private var showing = false
  private var closing = false
  private var presentationSequence = 0L
  private var activeSequence = 0L
  private var shownAtElapsedMs = 0L
  private var dismissListener: ((Map<String, Any?>) -> Unit)? = null
  private val timeout = Runnable { dismiss("timeout") }

  init {
    setWillNotDraw(false)
    clipChildren = false
    clipToPadding = false
    isClickable = false
    isFocusable = false
    visibility = GONE
    addView(toastRoot, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
      updateBottomInsets(insets)
      insets
    }
    ViewCompat.setWindowInsetsAnimationCallback(
      this,
      object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        override fun onProgress(
          insets: WindowInsetsCompat,
          runningAnimations: MutableList<WindowInsetsAnimationCompat>,
        ): WindowInsetsCompat {
          updateBottomInsets(insets)
          return insets
        }
      },
    )
    requestInsetsWhenAttached()
  }

  fun setDismissListener(listener: ((Map<String, Any?>) -> Unit)?) {
    dismissListener = listener
  }

  fun setSnapshot(value: Map<String, Any?>) {
    snapshot = value
    val visible = value["visible"] as? Boolean ?: false
    val message = value["message"] as? String ?: ""
    if (!visible || message.isBlank()) {
      dismiss("closed")
      return
    }

    removeCallbacks(timeout)
    animate().cancel()
    closing = false
    render(message)
    presentationSequence += 1
    activeSequence = presentationSequence
    shownAtElapsedMs = SystemClock.elapsedRealtime()
    if (!showing) {
      showing = true
      visibility = VISIBLE
      alpha = 0f
      animate()
        .alpha(1f)
        .setDuration(NativeUiTokens.TOAST_DURATION_MS)
        .start()
    } else {
      alpha = 1f
    }
    val durationMs = scheduleTimeout()
    Log.i(
      TAG,
      "show sequence=$activeSequence atElapsedMs=$shownAtElapsedMs durationMs=${durationMs ?: "none"}",
    )
  }

  fun dismiss(reason: String) {
    if (!showing || closing) return
    closing = true
    val dismissSequence = activeSequence
    val dismissStartedAtMs = SystemClock.elapsedRealtime()
    Log.i(
      TAG,
      "dismiss-start sequence=$dismissSequence reason=$reason atElapsedMs=$dismissStartedAtMs " +
        "visibleForMs=${dismissStartedAtMs - shownAtElapsedMs}",
    )
    removeCallbacks(timeout)
    animate().cancel()
    animate()
      .alpha(0f)
      .setDuration(NativeUiTokens.TOAST_DURATION_MS)
      .withEndAction {
        if (!closing || dismissSequence != activeSequence) return@withEndAction
        val dismissedAtMs = SystemClock.elapsedRealtime()
        closing = false
        showing = false
        visibility = GONE
        toastRoot.removeAllViews()
        panel = null
        messageText = null
        alpha = 1f
        Log.i(
          TAG,
          "dismiss-end sequence=$dismissSequence reason=$reason atElapsedMs=$dismissedAtMs " +
            "animationMs=${dismissedAtMs - dismissStartedAtMs}",
        )
        dismissListener?.invoke(mapOf("reason" to reason))
      }
      .start()
  }

  private fun render(message: String) {
    toastRoot.removeAllViews()
    messageText = null
    val card = TouchConsumingLinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      minimumHeight = NativeUiTokens.dp(context, NativeUiTokens.TOAST_MIN_HEIGHT_DP).toInt()
      background = NativeUiTokens.roundedBackground(context, palette.backgroundTips, 20f)
      elevation = NativeUiTokens.dp(context, 4f)
      setPadding(
        NativeUiTokens.dp(context, 20f).toInt(),
        NativeUiTokens.dp(context, 10f).toInt(),
        NativeUiTokens.dp(context, 20f).toInt(),
        NativeUiTokens.dp(context, 10f).toInt(),
      )
      isClickable = false
      isFocusable = false
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    val messageView = TextView(context).apply {
      text = message
      textSize = 14f
      setTextColor(palette.onTips)
      maxLines = 12
      ellipsize = TextUtils.TruncateAt.END
      gravity = Gravity.START or Gravity.CENTER_VERTICAL
      setLineSpacing(0f, 1.0f)
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
      accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE
    }
    messageText = messageView
    card.addView(messageView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))

    panel = card
    toastRoot.addView(card, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
    positionPanel()
    card.post {
      if (panel !== card) return@post
      val radius = if (messageView.lineCount > 1) 8f else 20f
      card.background = NativeUiTokens.roundedBackground(context, palette.backgroundTips, radius)
    }
  }

  private fun positionPanel() {
    val card = panel ?: return
    val available = if (width > 0) width else resources.displayMetrics.widthPixels
    val sideMargin = NativeUiTokens.dp(context, 16f).toInt()
    val maxWidth = NativeUiTokens.dp(context, NativeUiTokens.TOAST_MAX_WIDTH_DP).toInt()
    val targetWidth = min(maxWidth, (available - sideMargin * 2).coerceAtLeast(1))
    val horizontalPadding = NativeUiTokens.dp(context, 40f).toInt()
    messageText?.maxWidth = (targetWidth - horizontalPadding).coerceAtLeast(1)
    val bottomDp = (snapshot["bottom"] as? Number)?.toFloat() ?: 80f
    card.layoutParams = (card.layoutParams as? LayoutParams ?: LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)).apply {
      width = ViewGroup.LayoutParams.WRAP_CONTENT
      height = ViewGroup.LayoutParams.WRAP_CONTENT
      gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
      bottomMargin = max(navigationInsetPx, imeInsetPx) +
        NativeUiTokens.dp(context, bottomDp.coerceAtLeast(0f)).toInt()
    }
    card.requestLayout()
  }

  private fun scheduleTimeout(): Long? {
    if (snapshot.containsKey("durationMs") && snapshot["durationMs"] == null) return null
    val duration = ((snapshot["durationMs"] as? Number)?.toLong() ?: 4000L).coerceAtLeast(0L)
    postDelayed(timeout, duration)
    return duration
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    positionPanel()
  }

  private fun updateBottomInsets(insets: WindowInsetsCompat) {
    val nextNavigationInset = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
    val nextImeInset = if (insets.isVisible(WindowInsetsCompat.Type.ime())) {
      insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
    } else {
      0
    }
    if (nextNavigationInset == navigationInsetPx && nextImeInset == imeInsetPx) return
    navigationInsetPx = nextNavigationInset
    imeInsetPx = nextImeInset
    positionPanel()
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(timeout)
    animate().cancel()
    super.onDetachedFromWindow()
  }

  private companion object {
    const val TAG = "LaojiWindowToast"
  }

}

private class TouchConsumingLinearLayout(context: Context) : LinearLayout(context) {
  override fun onTouchEvent(event: MotionEvent): Boolean = true
}
