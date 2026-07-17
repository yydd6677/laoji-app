package com.laoji.nativeplatform.ui

// UI-SHELL-001 / UI-OVERLAY-WINDOW-001: temporary UI is attached once at Activity level.

import android.util.Log
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
