package com.laoji.nativeplatform

import com.laoji.nativeplatform.mediaimport.MediaImportIntentInbox
import com.laoji.nativeplatform.mediaimport.MediaImportException
import com.laoji.nativeplatform.mediaimport.MediaIngestor
import com.laoji.nativeplatform.mediaimport.MeetingMediaPickerResult
import com.laoji.nativeplatform.mediaimport.createMeetingMediaPickerIntent
import com.laoji.nativeplatform.mediaimport.inspectMeetingMediaSource
import com.laoji.nativeplatform.mediaimport.parseMeetingMediaPickerResult
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class LaojiMediaImportModule : Module() {
  private data class PendingMediaPicker(
    val result: CompletableDeferred<MeetingMediaPickerResult>,
  )

  private val mediaPickerLock = Any()
  private var pendingMediaPicker: PendingMediaPicker? = null

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
      takePendingMediaPicker()?.result?.completeExceptionally(
        MediaImportException("ERR_PICKER_UNAVAILABLE", "文件选择已中止"),
      )
    }

    // Expo's registered activity-result launcher is bound to the Activity that
    // created it. LaoJi recreates that Activity when a theme changes while the
    // React runtime can remain alive, leaving the launcher stale. A stable
    // request code plus the module-level result event always targets the current
    // Activity and therefore remains valid after recreation.
    OnActivityResult { activity, payload ->
      if (payload.requestCode != MEDIA_PICKER_REQUEST_CODE) return@OnActivityResult
      val request = synchronized(mediaPickerLock) { pendingMediaPicker } ?: return@OnActivityResult
      request.result.complete(
        parseMeetingMediaPickerResult(activity, payload.resultCode, payload.data),
      )
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

    AsyncFunction("pickMeetingMedia") Coroutine { includeVideo: Boolean ->
      val request = PendingMediaPicker(CompletableDeferred())
      withContext(Dispatchers.Main.immediate) {
        val activity = appContext.currentActivity
          ?: throw MediaImportException("ERR_PICKER_UNAVAILABLE", "当前无法打开文件")
        synchronized(mediaPickerLock) {
          if (pendingMediaPicker != null) {
            throw MediaImportException("ERR_PICKER_BUSY", "文件选择已打开")
          }
          pendingMediaPicker = request
        }
        try {
          activity.startActivityForResult(
            createMeetingMediaPickerIntent(includeVideo),
            MEDIA_PICKER_REQUEST_CODE,
          )
        } catch (error: Throwable) {
          clearPendingMediaPicker(request)
          throw MediaImportException("ERR_PICKER_UNAVAILABLE", "当前无法打开文件", error)
        }
      }
      try {
        when (val result = request.result.await()) {
          is MeetingMediaPickerResult.Success -> result.uri
          MeetingMediaPickerResult.Cancelled -> throw MediaImportException(
            "ERR_PICKER_CANCELLED",
            "已取消选择",
          )
        }
      } finally {
        clearPendingMediaPicker(request)
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

    AsyncFunction("stageMeetingMediaImport") Coroutine {
        sourceUri: String,
        meetingId: String,
        assetId: String,
        origin: String,
        maximumBytes: Double,
      ->
      withContext(Dispatchers.IO) {
        MediaIngestor(requireContext()).stage(
          sourceUri,
          meetingId,
          assetId,
          origin,
          maximumBytes.toLong(),
        )
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

  private fun takePendingMediaPicker(): PendingMediaPicker? = synchronized(mediaPickerLock) {
    pendingMediaPicker.also { pendingMediaPicker = null }
  }

  private fun clearPendingMediaPicker(request: PendingMediaPicker) {
    synchronized(mediaPickerLock) {
      if (pendingMediaPicker === request) pendingMediaPicker = null
    }
  }

  private companion object {
    const val MEDIA_PICKER_REQUEST_CODE = 0x4C4A
  }
}
