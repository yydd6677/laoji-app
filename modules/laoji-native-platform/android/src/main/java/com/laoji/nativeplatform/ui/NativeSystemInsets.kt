package com.laoji.nativeplatform.ui

// UI-MOTION-001: top and bottom system insets have separate native owners.

import android.os.Build
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Rect
import android.view.View
import android.view.WindowInsets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsAnimationCompat
import java.util.WeakHashMap

private val insetAttachListeners = WeakHashMap<View, View.OnAttachStateChangeListener>()

internal fun WindowInsets.statusBarInsetTop(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
  getInsets(WindowInsets.Type.statusBars()).top
} else {
  @Suppress("DEPRECATION")
  systemWindowInsetTop
}

internal fun WindowInsets.navigationBarInsetBottom(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
  getInsets(WindowInsets.Type.navigationBars()).bottom
} else {
  @Suppress("DEPRECATION")
  systemWindowInsetBottom
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
  is Activity -> this
  is ContextWrapper -> if (baseContext === this) null else baseContext.findActivity()
  else -> null
}

/**
 * A newly mounted native tab does not have its own [View.getRootWindowInsets]
 * during its first measure. The Activity decor does, because the window is
 * already visible. Reading that stable snapshot prevents a one-frame 0 ->
 * system-inset layout jump while the normal listener remains the source of
 * truth for later window changes.
 */
internal fun View.currentDecorWindowInsets(): WindowInsets? {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
  return context.findActivity()?.window?.decorView?.rootWindowInsets ?: rootWindowInsets
}

internal fun View.currentNavigationBarInsetBottom(): Int =
  currentDecorWindowInsets()?.navigationBarInsetBottom() ?: 0

fun View.installStatusBarInsetPadding(ownsStatusBarInset: () -> Boolean = { true }) {
  fun applyStatusBarInset(statusBarInset: Int) {
    val topInset = if (ownsStatusBarInset()) statusBarInset else 0
    if (paddingTop != topInset) {
      setPadding(paddingLeft, topInset, paddingRight, paddingBottom)
    }
  }

  currentDecorWindowInsets()?.let { applyStatusBarInset(it.statusBarInsetTop()) }
  setOnApplyWindowInsetsListener { view, insets ->
    view.apply { applyStatusBarInset(insets.statusBarInsetTop()) }
    insets
  }
  requestInsetsWhenAttached()
}

fun View.requestInsetsWhenAttached() {
  if (!insetAttachListeners.containsKey(this)) {
    val listener = object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(view: View) {
        view.requestApplyInsets()
      }

      override fun onViewDetachedFromWindow(view: View) = Unit
    }
    insetAttachListeners[this] = listener
    addOnAttachStateChangeListener(listener)
  }
  if (isAttachedToWindow) requestApplyInsets()
}

/**
 * Keeps a full-screen native form's fixed bottom operation above the IME only
 * when the window did not already resize it. The overlap measurement avoids
 * double-applying IME height on devices where adjustResize is effective.
 */
fun View.installImeOverlapBottomPadding() {
  val baselineBottom = paddingBottom
  var pendingApply: Runnable? = null

  fun resetBottomPadding() {
    pendingApply?.let(::removeCallbacks)
    pendingApply = null
    if (paddingBottom != baselineBottom) {
      setPadding(paddingLeft, paddingTop, paddingRight, baselineBottom)
    }
  }

  fun applyImeOverlap(insets: WindowInsetsCompat) {
    pendingApply?.let(::removeCallbacks)
    pendingApply = null
    val visible = insets.isVisible(WindowInsetsCompat.Type.ime())
    if (!visible) {
      resetBottomPadding()
      return
    }
    val task = Runnable {
      val latest = ViewCompat.getRootWindowInsets(this)
      if (!isAttachedToWindow || latest?.isVisible(WindowInsetsCompat.Type.ime()) != true) {
        resetBottomPadding()
        return@Runnable
      }
      val visibleFrame = Rect()
      getWindowVisibleDisplayFrame(visibleFrame)
      val location = IntArray(2)
      getLocationOnScreen(location)
      val naturalBottom = location[1] + height
      val overlap = (naturalBottom - visibleFrame.bottom).coerceAtLeast(0)
      val nextBottom = baselineBottom + overlap
      if (paddingBottom != nextBottom) {
        setPadding(paddingLeft, paddingTop, paddingRight, nextBottom)
      }
    }
    pendingApply = task
    post(task)
  }

  ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
    applyImeOverlap(insets)
    insets
  }
  ViewCompat.setWindowInsetsAnimationCallback(
    this,
    object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
      override fun onProgress(
        insets: WindowInsetsCompat,
        runningAnimations: MutableList<WindowInsetsAnimationCompat>,
      ): WindowInsetsCompat {
        applyImeOverlap(insets)
        return insets
      }
    },
  )
  addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
    override fun onViewAttachedToWindow(view: View) {
      view.requestApplyInsets()
    }

    override fun onViewDetachedFromWindow(view: View) {
      resetBottomPadding()
    }
  })
  requestInsetsWhenAttached()
}
