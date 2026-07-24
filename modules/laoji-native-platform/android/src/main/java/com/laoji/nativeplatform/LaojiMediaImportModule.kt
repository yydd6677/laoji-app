package com.laoji.nativeplatform

import com.laoji.nativeplatform.mediaimport.MediaImportIntentInbox
import com.laoji.nativeplatform.mediaimport.MediaIngestor
import com.laoji.nativeplatform.mediaimport.inspectMeetingMediaSource
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class LaojiMediaImportModule : Module() {
  private val intentListener: (Map<String, Any?>) -> Unit = { value ->
    sendEvent("onMediaImportIntent", value)
  }

  override fun definition() = ModuleDefinition {
    Name("LaojiMediaImport")
    Events("onMediaImportIntent")

    OnCreate {
      MediaImportIntentInbox.addListener(intentListener)
    }

    OnDestroy {
      MediaImportIntentInbox.removeListener(intentListener)
    }

    AsyncFunction("getPendingMediaImportIntent") Coroutine { ->
      MediaImportIntentInbox.peek(requireContext())?.toMap()
    }

    AsyncFunction("acknowledgeMediaImportIntent") Coroutine { token: String ->
      MediaImportIntentInbox.acknowledge(requireContext(), token)
    }

    AsyncFunction("inspectMeetingMediaSource") Coroutine { sourceUri: String ->
      withContext(Dispatchers.IO) {
        inspectMeetingMediaSource(requireContext(), sourceUri).toMap()
      }
    }

    AsyncFunction("ingestMeetingMedia") Coroutine {
        sourceUri: String,
        meetingId: String,
        assetId: String,
        origin: String,
        maximumBytes: Double,
      ->
      withContext(Dispatchers.IO) {
        MediaIngestor(requireContext()).ingest(
          sourceUri,
          meetingId,
          assetId,
          origin,
          maximumBytes.toLong(),
        ).toMap()
      }
    }

    AsyncFunction("recoverPendingMediaImports") Coroutine { ->
      withContext(Dispatchers.IO) {
        MediaIngestor(requireContext()).recoverPending().map { it.toMap() }
      }
    }

    AsyncFunction("acknowledgeIngestedMeetingMedia") Coroutine { meetingId: String, assetId: String ->
      withContext(Dispatchers.IO) {
        MediaIngestor(requireContext()).acknowledge(meetingId, assetId)
      }
    }

    AsyncFunction("discardIngestedMeetingMedia") Coroutine { meetingId: String, assetId: String ->
      withContext(Dispatchers.IO) {
        MediaIngestor(requireContext()).discard(meetingId, assetId)
      }
    }
  }

  private fun requireContext() = appContext.reactContext?.applicationContext
    ?: throw IllegalStateException("Android application context is unavailable")
}
