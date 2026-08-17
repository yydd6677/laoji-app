package com.laoji.nativeplatform.mediaimport

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.providers.AppContextProvider
import java.io.Serializable

internal data class MeetingMediaPickerOptions(
  val includeVideo: Boolean,
) : Serializable

internal sealed class MeetingMediaPickerResult {
  data class Success(val uri: String) : MeetingMediaPickerResult()
  data object Cancelled : MeetingMediaPickerResult()
}

// Keep the chooser filter in sync with MediaImportSupport and the server
// capability contract.  A broad `audio/*`/`*/*` filter can make DocumentsUI
// show providers and files that the ingest/ffmpeg path will reject later.
private val supportedAudioPickerMimeTypes = arrayOf(
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
)

private val supportedMeetingPickerMimeTypes = arrayOf(
  *supportedAudioPickerMimeTypes,
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
)

internal class MeetingMediaPickerContract(
  private val appContextProvider: AppContextProvider,
) : AppContextActivityResultContract<MeetingMediaPickerOptions, MeetingMediaPickerResult> {
  override fun createIntent(context: Context, input: MeetingMediaPickerOptions): Intent =
    Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = if (input.includeVideo) "*/*" else "audio/*"
      putExtra(
        Intent.EXTRA_MIME_TYPES,
        if (input.includeVideo) supportedMeetingPickerMimeTypes else supportedAudioPickerMimeTypes,
      )
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    }

  override fun parseResult(
    input: MeetingMediaPickerOptions,
    resultCode: Int,
    intent: Intent?,
  ): MeetingMediaPickerResult {
    if (resultCode != Activity.RESULT_OK || intent?.data == null) {
      return MeetingMediaPickerResult.Cancelled
    }
    val uri = intent.data ?: return MeetingMediaPickerResult.Cancelled
    val resolver = appContextProvider.appContext.reactContext?.contentResolver
    val takeFlags = intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION
    if (takeFlags != 0) {
      runCatching { resolver?.takePersistableUriPermission(uri, takeFlags) }
    }
    return MeetingMediaPickerResult.Success(uri.toString())
  }
}
