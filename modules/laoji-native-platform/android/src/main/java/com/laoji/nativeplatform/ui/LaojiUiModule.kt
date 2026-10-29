package com.laoji.nativeplatform.ui

// UI-SHELL-001 / UI-OVERLAY-WINDOW-001: temporary UI is attached once at Activity level.

import android.util.Log
import android.graphics.Rect
import android.os.Build
import android.view.WindowInsets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LaojiUiModule : Module() {
  private val overlayController by lazy {
    WindowOverlayController(
      appContext = appContext,
      onAction = { sendEvent("onOverlayAction", it) },
      onDismiss = { sendEvent("onOverlayDismiss", it) },
    )
  }

  override fun definition() = ModuleDefinition {
    Name("LaojiUi")
    Constant("evidenceSchemaVersion") { 1 }
    Constant("implementation") { "android-window-overlay-owner" }
    Events("onOverlayAction", "onOverlayDismiss")

    // RN keyboard events are derived from its Activity root's visible frame.
    // A translucent Dialog can temporarily make that frame look like a
    // screen-height keyboard. Read actual system IME insets instead.
    AsyncFunction("readKeyboardFrame") {
      val activity = appContext.currentActivity ?: return@AsyncFunction null
      val density = activity.resources.displayMetrics.density
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val metrics = activity.windowManager.currentWindowMetrics
        val insets = metrics.windowInsets
        val visible = insets.isVisible(WindowInsets.Type.ime())
        mapOf("visible" to visible,
          "top" to if (visible) (metrics.bounds.bottom - insets.getInsets(WindowInsets.Type.ime()).bottom) / density else 0f)
      } else {
        val decor = activity.window.decorView
        val insets = ViewCompat.getRootWindowInsets(decor) ?: return@AsyncFunction null
        val visible = insets.isVisible(WindowInsetsCompat.Type.ime())
        val frame = Rect()
        decor.getWindowVisibleDisplayFrame(frame)
        mapOf("visible" to visible, "top" to if (visible) frame.bottom / density else 0f)
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground {
      overlayController.ensureAttached()
    }

    OnActivityEntersBackground {
      overlayController.clearKind(WindowOverlayKind.TOAST, "background")
    }

    OnActivityDestroys {
      overlayController.destroy()
    }

    OnDestroy {
      overlayController.destroy()
    }

    AsyncFunction("presentOverlay") { ownerId: String, kind: String, snapshot: Map<String, Any?> ->
      try {
        overlayController.present(ownerId, kind, snapshot)
        Log.i(LOG_TAG, "present kind=$kind owner=$ownerId")
      } catch (error: Throwable) {
        Log.e(LOG_TAG, "present failed kind=$kind owner=$ownerId", error)
        throw error
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("dismissOverlay") { ownerId: String, kind: String, reason: String ->
      overlayController.dismiss(ownerId, kind, reason)
    }.runOnQueue(Queues.MAIN)
  }

  private companion object {
    const val LOG_TAG = "LaojiWindowOverlay"
  }
}
