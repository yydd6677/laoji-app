package com.laoji.nativeplatform.legacy

import android.content.Context
import java.io.File

/** Deletes files left by the retired media-clip feature during meeting deletion. */
internal object LegacyMediaClipCleanup {
  private val safeMeetingId = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,159}")

  fun deleteMeeting(context: Context, meetingId: String): Int = synchronized(this) {
    val normalized = meetingId.trim()
    require(safeMeetingId.matches(normalized)) { "meeting identity is invalid" }
    val root = File(context.applicationContext.filesDir, "meeting-clips").canonicalFile
    val directory = File(root, normalized).canonicalFile
    require(directory.parentFile == root) { "meeting clip path is invalid" }
    if (!directory.exists()) return@synchronized 0
    val count = directory.walkBottomUp().count { it.isFile }
    check(directory.deleteRecursively()) { "legacy meeting clip files could not be deleted" }
    count
  }
}
