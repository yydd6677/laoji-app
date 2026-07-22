package com.laoji.nativeplatform

// CAL-ROOT-001 / MIN-ROOT-001 / MIN-AUDIO-001 / MIN-PLAYER-001: runtime capability truth.

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class LaojiNativePlatformModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiNativePlatform")

    Constant("evidenceSchemaVersion") { 1 }
    Constant("implementation") { "android-classic-view" }

    Function("createRandomUuid") { UUID.randomUUID().toString() }

    AsyncFunction("getCapabilities") {
      mapOf(
        "calendarSurface" to true,
        "minutesSurface" to true,
        "nativeAudioRuntime" to true,
        "mediaPlayer" to true
      )
    }
  }
}
