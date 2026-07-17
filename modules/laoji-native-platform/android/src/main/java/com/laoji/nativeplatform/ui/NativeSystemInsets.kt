package com.laoji.nativeplatform.ui

// UI-MOTION-001: top and bottom system insets have separate native owners.

import android.os.Build
import android.view.View
import android.view.WindowInsets
import java.util.WeakHashMap

private val insetAttachListeners = WeakHashMap<View, View.OnAttachStateChangeListener>()

fun View.installStatusBarInsetPadding(ownsStatusBarInset: () -> Boolean = { true }) {
  setOnApplyWindowInsetsListener { view, insets ->
    val statusBarInset = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      insets.getInsets(WindowInsets.Type.statusBars()).top
    } else {
      @Suppress("DEPRECATION")
      insets.systemWindowInsetTop
    }
    val topInset = if (ownsStatusBarInset()) statusBarInset else 0
    if (view.paddingTop != topInset) {
      view.setPadding(view.paddingLeft, topInset, view.paddingRight, view.paddingBottom)
    }
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
