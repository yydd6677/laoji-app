package com.laoji.nativeplatform.transfer

// MIN-DELETE-RECOVERY-001: deletion tombstones reject late and recovered uploads.

import android.content.Context
import java.security.MessageDigest

internal class MeetingDeletionStore(context: Context) {
  private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  @Synchronized
  fun markDeleted(scope: String, meetingId: String, nowMs: Long = System.currentTimeMillis()) {
    val normalizedScope = validateScope(scope)
    val normalizedMeetingId = validateMeetingId(meetingId)
    prune(nowMs)
    val entries = preferences.all.entries
      .mapNotNull { (key, value) -> (value as? Long)?.let { key to it } }
      .sortedByDescending { it.second }
    val editor = preferences.edit().putLong(key(normalizedScope, normalizedMeetingId), nowMs.coerceAtLeast(0L))
    entries.drop(MAX_ENTRIES - 1).forEach { (key, _) -> editor.remove(key) }
    check(editor.commit()) { "meeting deletion tombstone could not be persisted" }
  }

  @Synchronized
  fun isDeleted(scope: String, meetingId: String, nowMs: Long = System.currentTimeMillis()): Boolean {
    val normalizedScope = validateScope(scope)
    val normalizedMeetingId = validateMeetingId(meetingId)
    val deletedAt = preferences.getLong(key(normalizedScope, normalizedMeetingId), -1L)
    if (deletedAt < 0L) return false
    if (nowMs - deletedAt <= RETENTION_MS) return true
    preferences.edit().remove(key(normalizedScope, normalizedMeetingId)).commit()
    return false
  }

  @Synchronized
  private fun prune(nowMs: Long) {
    val editor = preferences.edit()
    var changed = false
    preferences.all.forEach { (key, value) ->
      val deletedAt = value as? Long
      if (deletedAt == null || nowMs - deletedAt > RETENTION_MS) {
        editor.remove(key)
        changed = true
      }
    }
    if (changed) editor.commit()
  }

  private fun key(scope: String, meetingId: String): String = MessageDigest.getInstance("SHA-256")
    .digest("$scope\u001f$meetingId".toByteArray(Charsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

  private fun validateScope(value: String): String = value.trim().also {
    require(it == "guest") { "invalid meeting scope" }
  }

  private fun validateMeetingId(value: String): String = value.trim().also {
    require(it.isNotEmpty() && it.length <= 160 && it.none(Char::isISOControl)) { "invalid meeting id" }
  }

  private companion object {
    const val PREFERENCES = "laoji-native-deleted-meetings-v1"
    const val MAX_ENTRIES = 512
    const val RETENTION_MS = 30L * 24L * 60L * 60L * 1000L
  }
}

internal fun meetingUploadTag(scope: String, meetingId: String): String {
  val digest = MessageDigest.getInstance("SHA-256")
    .digest("$scope\u001f$meetingId".toByteArray(Charsets.UTF_8))
    .take(12)
    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
  return "laoji-upload-meeting:$digest"
}
