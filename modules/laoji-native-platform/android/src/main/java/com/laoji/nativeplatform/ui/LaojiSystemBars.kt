package com.laoji.nativeplatform.ui

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Keeps Android-owned status/navigation surfaces aligned with the LaoJi skin. */
object LaojiSystemBars {
  @JvmStatic
  fun apply(activity: Activity) {
    val palette = NativeUiTokens.palette(activity)
    val window = activity.window
    val darkStatusSurface = isDark(palette.body)
    val darkNavigationSurface = isDark(palette.surface)

    // Android 15 may render these colors as the background behind transparent
    // system bars. Older releases and three-button navigation use them
    // directly, so keep both paths explicitly themed.
    @Suppress("DEPRECATION")
    window.statusBarColor = palette.body
    @Suppress("DEPRECATION")
    window.navigationBarColor = palette.surface
    window.decorView.setBackgroundColor(palette.body)
    installSystemBarBackdrops(activity, palette.body, palette.surface)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !darkStatusSurface
      isAppearanceLightNavigationBars = !darkNavigationSurface
    }
  }

  private fun installSystemBarBackdrops(
    activity: Activity,
    statusColor: Int,
    navigationColor: Int,
  ) {
    val decor = activity.window.decorView as? ViewGroup ?: return
    installBackdrop(
      activity = activity,
      decor = decor,
      tag = STATUS_BACKDROP_TAG,
      color = statusColor,
      gravity = Gravity.TOP,
      insetType = WindowInsetsCompat.Type.statusBars(),
      insetSize = { insets -> insets.top },
    )
    installBackdrop(
      activity = activity,
      decor = decor,
      tag = NAVIGATION_BACKDROP_TAG,
      color = navigationColor,
      gravity = Gravity.BOTTOM,
      insetType = WindowInsetsCompat.Type.navigationBars(),
      insetSize = { insets -> insets.bottom },
    )
  }

  private fun installBackdrop(
    activity: Activity,
    decor: ViewGroup,
    tag: String,
    color: Int,
    gravity: Int,
    insetType: Int,
    insetSize: (androidx.core.graphics.Insets) -> Int,
  ) {
    val backdrop = decor.findViewWithTag<View>(tag) ?: View(activity).apply {
      this.tag = tag
      isClickable = false
      isFocusable = false
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      decor.addView(
        this,
        FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          0,
          gravity,
        ),
      )
    }
    backdrop.setBackgroundColor(color)

    fun updateHeight(size: Int) {
      val params = backdrop.layoutParams as? FrameLayout.LayoutParams ?: return
      if (params.height == size && params.gravity == gravity) return
      params.height = size
      params.gravity = gravity
      backdrop.layoutParams = params
    }

    ViewCompat.setOnApplyWindowInsetsListener(backdrop) { _, insets ->
      updateHeight(insetSize(insets.getInsets(insetType)))
      insets
    }
    ViewCompat.getRootWindowInsets(decor)?.let { insets ->
      updateHeight(insetSize(insets.getInsets(insetType)))
    }
    ViewCompat.requestApplyInsets(backdrop)
  }

  private fun isDark(color: Int): Boolean {
    val luminance = (
      Color.red(color) * 299 +
        Color.green(color) * 587 +
        Color.blue(color) * 114
      ) / 1000
    return luminance < 150
  }

  private const val STATUS_BACKDROP_TAG = "laoji:system-bar:status"
  private const val NAVIGATION_BACKDROP_TAG = "laoji:system-bar:navigation"
}
