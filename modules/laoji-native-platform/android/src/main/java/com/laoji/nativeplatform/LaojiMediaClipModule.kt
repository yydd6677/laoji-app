package com.laoji.nativeplatform

import com.laoji.nativeplatform.mediaclip.MediaClipException
import com.laoji.nativeplatform.mediaclip.MediaClipExporter
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class LaojiMediaClipModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiMediaClip")

    AsyncFunction("getCapabilities") Coroutine { ->
      MediaClipExporter(requireContext()).capabilities().toMap()
    }

    AsyncFunction("inspectWavSource") Coroutine { sourceUri: String ->
      withContext(Dispatchers.IO) {
        runNative { MediaClipExporter(requireContext()).inspect(sourceUri).toMap() }
      }
    }

    AsyncFunction("createWavClip") Coroutine {
        sourceUri: String,
        meetingId: String,
        clipId: String,
        startMs: Double,
        endMs: Double,
      ->
      withContext(Dispatchers.IO) {
        runNative {
          MediaClipExporter(requireContext()).export(
            sourceUri,
            meetingId,
            clipId,
            startMs.toLong(),
            endMs.toLong(),
          ).toMap()
        }
      }
    }

    AsyncFunction("deleteClip") Coroutine { meetingId: String, clipId: String ->
      withContext(Dispatchers.IO) {
        runNative { MediaClipExporter(requireContext()).delete(meetingId, clipId) }
      }
    }
  }

  private fun requireContext() = appContext.reactContext?.applicationContext
    ?: throw IllegalStateException("Android application context is unavailable")

  private fun <T> runNative(block: () -> T): T = try {
    block()
  } catch (error: MediaClipException) {
    throw CodedException(error.code, error.message, null)
  }
}
