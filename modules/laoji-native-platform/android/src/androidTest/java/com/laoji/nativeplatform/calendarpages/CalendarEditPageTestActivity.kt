package com.laoji.nativeplatform.calendarpages

// CAL-EDIT-TIME-001: isolated Activity that mounts the production Expo-root CalendarEditPageView.

import android.os.Bundle
import android.content.Context
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import expo.modules.core.ModuleRegistry
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import java.lang.ref.WeakReference

class CalendarEditPageTestActivity : ComponentActivity() {
  lateinit var page: CalendarEditPageView
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    page = CalendarEditPageView(this, testAppContext(applicationContext)).apply {
      id = PAGE_VIEW_ID
      setSnapshot(defaultSnapshot())
      commitProps()
    }
    setContentView(
      page,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  companion object {
    private const val PAGE_VIEW_ID = 0x01020ABC
    private var sharedAppContext: AppContext? = null

    private fun testAppContext(context: Context): AppContext = sharedAppContext ?: synchronized(this) {
      sharedAppContext ?: createAppContext(context).also { sharedAppContext = it }
    }

    private fun createAppContext(context: Context): AppContext {
      val modulesProvider = object : ModulesProvider {
        override fun getModulesList(): List<Class<out Module>> = emptyList()
      }
      val legacyRegistry = ModuleRegistry(emptyList(), emptyList())
      val reactContextClass = Class.forName("com.facebook.react.bridge.BridgeReactContext")
      val reactContext = reactContextClass.getConstructor(Context::class.java).newInstance(context)
      val constructor = AppContext::class.java.declaredConstructors.single { it.parameterTypes.size == 3 }
      constructor.isAccessible = true
      return constructor.newInstance(modulesProvider, legacyRegistry, WeakReference(reactContext)) as AppContext
    }

    private fun defaultSnapshot(): Map<String, Any?> = mapOf(
      "schemaVersion" to 1,
      "state" to "ready",
      "editing" to false,
      "saving" to false,
      "draft" to mapOf(
        "title" to "CAL-EDIT-TIME-001 测试日程",
        "startDate" to "2026-07-17",
        "endDate" to "2026-07-17",
        "startTime" to "10:00",
        "endTime" to "11:00",
        "isAllDay" to false,
        "repeat" to "once",
        "reminderMinutes" to null,
        "location" to "",
        "notes" to "",
      ),
    )
  }
}
