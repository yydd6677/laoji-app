package com.laoji.nativeplatform.mediaimport

import android.app.Activity
import android.content.Context
import android.content.Intent

internal sealed class MeetingMediaPickerResult {
  data class Success(val uri: String) : MeetingMediaPickerResult()
  data object Cancelled : MeetingMediaPickerResult()
}

internal fun createMeetingMediaPickerIntent(includeVideo: Boolean): Intent =
  Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = if (includeVideo) "*/*" else "audio/*"
    putExtra(
      Intent.EXTRA_MIME_TYPES,
      (if (includeVideo) supportedMeetingMediaMimeTypes else supportedAudioMeetingMediaMimeTypes)
        .toTypedArray(),
    )
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
  }

internal fun parseMeetingMediaPickerResult(
  context: Context,
  resultCode: Int,
  intent: Intent?,
): MeetingMediaPickerResult {
  if (resultCode != Activity.RESULT_OK || intent?.data == null) {
    return MeetingMediaPickerResult.Cancelled
  }
  val uri = intent.data ?: return MeetingMediaPickerResult.Cancelled
  val takeFlags = intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION
  if (takeFlags != 0) {
    runCatching { context.contentResolver.takePersistableUriPermission(uri, takeFlags) }
  }
  return MeetingMediaPickerResult.Success(uri.toString())
}
