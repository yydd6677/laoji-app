package com.laoji.nativeplatform

// CAL-ROOT-001 / MIN-ROOT-001 / MIN-AUDIO-001 / MIN-PLAYER-001: runtime capability truth.

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.net.Uri
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.UUID

class LaojiNativePlatformModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiNativePlatform")

    Constant("evidenceSchemaVersion") { 1 }
    Constant("implementation") { "android-classic-view" }

    Function("createRandomUuid") { UUID.randomUUID().toString() }

    AsyncFunction("sha256File") { fileUri: String ->
      val uri = Uri.parse(fileUri)
      require(uri.scheme == "file") { "file URI is required" }
      val source = File(requireNotNull(uri.path) { "file path is required" }).canonicalFile
      require(source.isFile) { "file is unavailable" }
      val digest = MessageDigest.getInstance("SHA-256")
      var byteSize = 0L
      FileInputStream(source).use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          if (count == 0) continue
          digest.update(buffer, 0, count)
          byteSize = Math.addExact(byteSize, count.toLong())
        }
      }
      mapOf(
        "checksumSha256" to "sha256:${digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }}",
        "byteSize" to byteSize,
      )
    }

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
