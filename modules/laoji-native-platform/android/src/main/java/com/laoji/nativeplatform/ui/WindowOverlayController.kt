package com.laoji.nativeplatform.ui

// UI-OVERLAY-WINDOW-001 / UI-ANDROID-COMPOSITION-001: one Activity-owned root
// contains every temporary page, sheet and dialog above the Fabric surface.

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.lifecycle.Lifecycle
import com.laoji.nativeplatform.calendarpages.CalendarSearchPageView
import com.laoji.nativeplatform.schedulevoice.ScheduleVoiceHostView
import expo.modules.kotlin.AppContext
import java.util.concurrent.CountDownLatch

internal enum class WindowOverlayKind(val wireName: String) {
  CALENDAR_SEARCH("calendar-search"),
  SCHEDULE_VOICE("schedule-voice"),
  ACTION_SHEET("action-sheet"),
  DIALOG("dialog"),
  TOAST("toast");

  companion object {
    fun fromWireName(value: String): WindowOverlayKind = entries.firstOrNull {
      it.wireName == value
    } ?: error("Unsupported window overlay kind: $value")
  }
}

internal class WindowOverlayEntryRegistry<T : Any>(
  private val kindOf: (T) -> WindowOverlayKind,
  private val ownerOf: (T) -> String,
) {
  private val entries = mutableMapOf<WindowOverlayKind, T>()

  operator fun get(kind: WindowOverlayKind): T? = entries[kind]

  fun put(value: T): T? = entries.put(kindOf(value), value)

  fun currentForOwner(kind: WindowOverlayKind, ownerId: String): T? =
    entries[kind]?.takeIf { ownerOf(it) == ownerId }

  fun removeIfCurrent(value: T): Boolean {
    val kind = kindOf(value)
    if (entries[kind] !== value) return false
    entries.remove(kind)
    return true
  }

  fun values(): Collection<T> = entries.values

  fun isNotEmpty(): Boolean = entries.isNotEmpty()

  fun contains(kind: WindowOverlayKind): Boolean = entries.containsKey(kind)
}

internal class WindowOverlayController(
  private val appContext: AppContext,
  private val onAction: (Map<String, Any?>) -> Unit,
  private val onDismiss: (Map<String, Any?>) -> Unit,
) {
  private val mainHandler = Handler(Looper.getMainLooper())

  private data class Entry(
    val kind: WindowOverlayKind,
    val ownerId: String,
    val view: View,
    var snapshot: Map<String, Any?> = emptyMap(),
  )

  private var activity: Activity? = null
  private var host: FrameLayout? = null
  private var pageSlot: FrameLayout? = null
  private var sheetSlot: FrameLayout? = null
  private var dialogSlot: FrameLayout? = null
  private var toastSlot: FrameLayout? = null
  private var backCallback: OnBackPressedCallback? = null
  private val entries = WindowOverlayEntryRegistry<Entry>({ it.kind }, { it.ownerId })
  private val closing = mutableSetOf<WindowOverlayKind>()
  private val obscuredActivityChildren = mutableMapOf<View, Int>()

  fun present(ownerId: String, rawKind: String, snapshot: Map<String, Any?>) {
    require(ownerId.isNotBlank()) { "Window overlay ownerId must not be blank" }
    val kind = WindowOverlayKind.fromWireName(rawKind)
    val currentActivity = appContext.currentActivity
    if (!canPresent(currentActivity)) {
      onDismiss(mapOf("reason" to "host-not-resumed") + metadata(kind, ownerId))
      return
    }
    ensureHost()

    if (kind == WindowOverlayKind.ACTION_SHEET || kind == WindowOverlayKind.SCHEDULE_VOICE) {
      val conflictingKind = if (kind == WindowOverlayKind.ACTION_SHEET) {
        WindowOverlayKind.SCHEDULE_VOICE
      } else {
        WindowOverlayKind.ACTION_SHEET
      }
      entries[conflictingKind]?.let { removeEntry(it, "replaced", notify = true) }
    }

    var entry = entries[kind]
    if (entry != null && (entry.ownerId != ownerId || closing.contains(kind))) {
      removeEntry(entry, "replaced", notify = true)
      entry = null
    }
    if (entry == null) {
      entry = createEntry(kind, ownerId)
      check(entries.put(entry) == null) { "Window overlay slot must be empty before mounting" }
      slotFor(kind).addView(
        entry.view,
        FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
      )
    }

    updateEntry(entry, snapshot)
    updateHostVisibility()
    ViewCompat.requestApplyInsets(entry.view)
  }

  fun dismiss(ownerId: String, rawKind: String, reason: String = "programmatic") {
    val kind = WindowOverlayKind.fromWireName(rawKind)
    val entry = entries.currentForOwner(kind, ownerId) ?: return
    when (val view = entry.view) {
      is LaojiNativeDialogHostView -> view.setSnapshot(mapOf("visible" to false))
      is LaojiNativeActionSheetHostView -> view.setSnapshot(mapOf("visible" to false))
      is ScheduleVoiceHostView -> animateDismiss(entry, reason) { callback -> view.dismiss(callback) }
      is CalendarSearchPageView -> animateDismiss(entry, reason) { callback -> view.dismiss(callback) }
      is NativeToastHostView -> view.dismiss(reason)
      else -> removeEntry(entry, reason, notify = true)
    }
  }

  fun ensureAttached() {
    if (entries.isNotEmpty()) {
      ensureHost()
      entries.values().forEach { entry ->
        updateEntry(entry, entry.snapshot)
        entry.view.requestInsetsWhenAttached()
      }
      host?.requestInsetsWhenAttached()
      updateHostVisibility()
    }
  }

  fun clearKind(kind: WindowOverlayKind, reason: String) {
    entries[kind]?.let { removeEntry(it, reason, notify = true) }
  }

  /**
   * Expo may invalidate a module from its executor thread during a ReactHost
   * reload. Android View ownership is stricter than the module lifecycle, so
   * the complete teardown must run on the main thread before invalidation
   * returns. Waiting here also prevents a newly-created React surface from
   * racing the old overlay root's removeView calls.
   */
  fun destroy() {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      destroyOnMain()
      return
    }

    val completed = CountDownLatch(1)
    var failure: Throwable? = null
    mainHandler.post {
      try {
        destroyOnMain()
      } catch (error: Throwable) {
        failure = error
      } finally {
        completed.countDown()
      }
    }
    completed.await()
    failure?.let { error ->
      Log.e(LOG_TAG, "overlay teardown failed on main thread", error)
    }
  }

  private fun destroyOnMain() {
    entries.values().toList().forEach { removeEntry(it, "activity-destroyed", notify = false) }
    restoreActivityAccessibility()
    closing.clear()
    (host?.parent as? ViewGroup)?.removeView(host)
    backCallback?.remove()
    backCallback = null
    host = null
    pageSlot = null
    sheetSlot = null
    dialogSlot = null
    toastSlot = null
    activity = null
  }

  private fun ensureHost() {
    val currentActivity = requireNotNull(appContext.currentActivity) {
      "No foreground Activity is available for the window overlay"
    }
    if (activity !== currentActivity || host?.parent == null) {
      destroy()
      activity = currentActivity
      val root = FrameLayout(currentActivity).apply {
        visibility = View.GONE
        clipChildren = false
        clipToPadding = false
        isSaveEnabled = false
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      }
      pageSlot = FrameLayout(currentActivity)
      sheetSlot = FrameLayout(currentActivity)
      dialogSlot = FrameLayout(currentActivity)
      toastSlot = FrameLayout(currentActivity).apply {
        isClickable = false
        isFocusable = false
      }
      root.addView(pageSlot, matchParentParams())
      root.addView(sheetSlot, matchParentParams())
      root.addView(dialogSlot, matchParentParams())
      root.addView(toastSlot, matchParentParams())
      currentActivity.findViewById<ViewGroup>(android.R.id.content).addView(root, matchParentParams())
      backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
          val top = topModalEntry() ?: return
          if (
            top.kind == WindowOverlayKind.SCHEDULE_VOICE &&
            (top.view as? ScheduleVoiceHostView)?.hideImeIfVisible() == true
          ) {
            return
          }
          if (
            top.kind == WindowOverlayKind.SCHEDULE_VOICE ||
            top.kind == WindowOverlayKind.CALENDAR_SEARCH
          ) {
            emitAction(top.kind, top.ownerId, mapOf("type" to "close"))
          }
          dismiss(top.ownerId, top.kind.wireName, "system-back")
        }
      }.also { callback ->
        (currentActivity as? ComponentActivity)?.onBackPressedDispatcher?.addCallback(callback)
      }
      host = root
      ViewCompat.requestApplyInsets(root)
    }
    host?.bringToFront()
  }

  private fun canPresent(candidate: Activity?): Boolean {
    if (candidate == null || candidate.isFinishing || candidate.isDestroyed) return false
    val componentActivity = candidate as? ComponentActivity ?: return false
    return componentActivity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
  }

  private fun createEntry(kind: WindowOverlayKind, ownerId: String): Entry {
    val currentActivity = requireNotNull(activity)
    val view = when (kind) {
      WindowOverlayKind.DIALOG -> LaojiNativeDialogHostView(currentActivity, appContext).apply {
        setBridgeEventsEnabled(false)
        setActionListener { emitAction(kind, ownerId, it) }
        setDismissListener { finishNativeDismiss(kind, ownerId, it) }
      }
      WindowOverlayKind.ACTION_SHEET -> LaojiNativeActionSheetHostView(currentActivity, appContext).apply {
        setBridgeEventsEnabled(false)
        setItemListener { emitAction(kind, ownerId, it) }
        setDismissListener { finishNativeDismiss(kind, ownerId, it) }
      }
      WindowOverlayKind.SCHEDULE_VOICE -> ScheduleVoiceHostView(currentActivity, appContext).apply {
        setBridgeEventsEnabled(false)
        setActionListener { emitAction(kind, ownerId, it) }
      }
      WindowOverlayKind.CALENDAR_SEARCH -> CalendarSearchPageView(currentActivity, appContext).apply {
        setBridgeEventsEnabled(false)
        setActionListener { emitAction(kind, ownerId, it) }
      }
      WindowOverlayKind.TOAST -> NativeToastHostView(currentActivity, appContext).apply {
        setDismissListener { finishNativeDismiss(kind, ownerId, it) }
      }
    }
    return Entry(kind, ownerId, view)
  }

  private fun updateEntry(entry: Entry, snapshot: Map<String, Any?>) {
    entry.snapshot = snapshot
    when (val view = entry.view) {
      is LaojiNativeDialogHostView -> view.setSnapshot(snapshot)
      is LaojiNativeActionSheetHostView -> view.setSnapshot(snapshot)
      is ScheduleVoiceHostView -> view.setSnapshot(snapshot)
      is CalendarSearchPageView -> {
        view.setSnapshot(snapshot)
        view.commitProps()
      }
      is NativeToastHostView -> view.setSnapshot(snapshot)
    }
  }

  private fun animateDismiss(
    entry: Entry,
    reason: String,
    start: ((() -> Unit)) -> Unit,
  ) {
    if (!closing.add(entry.kind)) return
    start {
      closing.remove(entry.kind)
      val current = entries[entry.kind]
      if (current === entry) removeEntry(entry, reason, notify = true)
    }
  }

  private fun finishNativeDismiss(kind: WindowOverlayKind, ownerId: String, payload: Map<String, Any?>) {
    val entry = entries.currentForOwner(kind, ownerId) ?: return
    removeEntry(entry, payload["reason"] as? String ?: "closed", notify = false)
    onDismiss(payload + metadata(kind, ownerId))
  }

  private fun emitAction(kind: WindowOverlayKind, ownerId: String, payload: Map<String, Any?>) {
    val current = entries.currentForOwner(kind, ownerId) ?: return
    onAction(payload + metadata(kind, ownerId))
  }

  private fun removeEntry(entry: Entry, reason: String, notify: Boolean) {
    if (!entries.removeIfCurrent(entry)) return
    closing.remove(entry.kind)
    entry.view.animate().cancel()
    (entry.view.parent as? ViewGroup)?.removeView(entry.view)
    if (notify) onDismiss(mapOf("reason" to reason) + metadata(entry.kind, entry.ownerId))
    updateHostVisibility()
  }

  private fun metadata(kind: WindowOverlayKind, ownerId: String): Map<String, Any?> = mapOf(
    "kind" to kind.wireName,
    "ownerId" to ownerId,
  )

  private fun slotFor(kind: WindowOverlayKind): FrameLayout = when (kind) {
    WindowOverlayKind.CALENDAR_SEARCH -> requireNotNull(pageSlot)
    WindowOverlayKind.SCHEDULE_VOICE,
    WindowOverlayKind.ACTION_SHEET -> requireNotNull(sheetSlot)
    WindowOverlayKind.DIALOG -> requireNotNull(dialogSlot)
    WindowOverlayKind.TOAST -> requireNotNull(toastSlot)
  }

  private fun updateHostVisibility() {
    host?.visibility = if (entries.isNotEmpty()) View.VISIBLE else View.GONE
    val modalEntry = topModalEntry()
    backCallback?.let { callback ->
      callback.isEnabled = false
      if (modalEntry != null) {
        // [INFERENCE] Activity-owned overlays must be the last registered
        // callback so an underlying native page cannot consume the same Back
        // press and leave a sheet visible over a hidden exit confirmation.
        callback.remove()
        (activity as? ComponentActivity)?.onBackPressedDispatcher?.addCallback(callback)
        callback.isEnabled = true
      }
    }
    updateAccessibilityIsolation()
    host?.bringToFront()
  }

  private fun updateAccessibilityIsolation() {
    val topModal = topModalEntry()
    val content = activity?.findViewById<ViewGroup>(android.R.id.content)
    if (topModal == null || content == null) {
      restoreActivityAccessibility()
    } else {
      repeat(content.childCount) { index ->
        val child = content.getChildAt(index)
        if (child !== host && !obscuredActivityChildren.containsKey(child)) {
          obscuredActivityChildren[child] = child.importantForAccessibility
          child.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
      }
    }

    entries.values().forEach { entry ->
      if (entry.kind != WindowOverlayKind.TOAST) {
        entry.view.importantForAccessibility = if (entry === topModal) {
          View.IMPORTANT_FOR_ACCESSIBILITY_YES
        } else {
          View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
      }
    }
  }

  private fun topModalEntry(): Entry? =
    entries[WindowOverlayKind.DIALOG]
      ?: entries[WindowOverlayKind.ACTION_SHEET]
      ?: entries[WindowOverlayKind.SCHEDULE_VOICE]
      ?: entries[WindowOverlayKind.CALENDAR_SEARCH]

  private fun restoreActivityAccessibility() {
    obscuredActivityChildren.forEach { (view, importance) ->
      view.importantForAccessibility = importance
    }
    obscuredActivityChildren.clear()
  }

  private fun matchParentParams() = FrameLayout.LayoutParams(
    ViewGroup.LayoutParams.MATCH_PARENT,
    ViewGroup.LayoutParams.MATCH_PARENT,
  )

  private companion object {
    const val LOG_TAG = "LaojiWindowOverlay"
  }
}
