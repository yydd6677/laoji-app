package com.laoji.nativeplatform

import com.laoji.nativeplatform.entry.SystemEntryProjectionStore
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LaojiSystemEntriesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiSystemEntries")

    AsyncFunction("writeUpcomingEventsProjection") { json: String ->
      val context = requireNotNull(appContext.reactContext?.applicationContext) {
        "Android application context is unavailable"
      }
      SystemEntryProjectionStore.write(context, json).toStateMap()
    }

    AsyncFunction("clearUpcomingEventsProjection") {
      val context = requireNotNull(appContext.reactContext?.applicationContext) {
        "Android application context is unavailable"
      }
      SystemEntryProjectionStore.clear(context)
    }
  }
}
