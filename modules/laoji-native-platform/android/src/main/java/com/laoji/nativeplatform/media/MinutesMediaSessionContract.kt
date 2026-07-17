package com.laoji.nativeplatform.media

// MIN-PLAYER-001: source metadata and custom skip commands form the MediaSession contract.

import android.os.Bundle
import androidx.media3.session.SessionCommand
import com.laoji.nativeplatform.minutes.MinutesPlayerSource

internal const val MINUTES_MEDIA_SESSION_ID = "laoji-minutes-playback"
internal const val MINUTES_SET_SOURCE_ACTION = "com.laoji.minutes.SET_SOURCE"
internal const val MINUTES_CLEAR_SOURCE_ACTION = "com.laoji.minutes.CLEAR_SOURCE"
internal const val MINUTES_ACTIVATE_STORAGE_SCOPE_ACTION = "com.laoji.minutes.ACTIVATE_STORAGE_SCOPE"

internal val MINUTES_SET_SOURCE_COMMAND = SessionCommand(MINUTES_SET_SOURCE_ACTION, Bundle.EMPTY)
internal val MINUTES_CLEAR_SOURCE_COMMAND = SessionCommand(MINUTES_CLEAR_SOURCE_ACTION, Bundle.EMPTY)
internal val MINUTES_ACTIVATE_STORAGE_SCOPE_COMMAND =
  SessionCommand(MINUTES_ACTIVATE_STORAGE_SCOPE_ACTION, Bundle.EMPTY)

private const val KEY_SOURCE_ID = "sourceId"
private const val KEY_URI = "uri"
private const val KEY_HEADERS = "headers"
private const val KEY_TITLE = "title"
private const val KEY_DURATION_MS_HINT = "durationMsHint"
private const val KEY_RETAIN_FOR_BACKGROUND = "retainForBackground"
private const val KEY_STORAGE_SCOPE = "storageScope"
private const val KEY_EXPIRES_AT = "expiresAt"
private const val MAX_HEADER_COUNT = 32

internal fun MinutesPlayerSource.toSessionArguments(): Bundle = Bundle().apply {
  putString(KEY_SOURCE_ID, sourceId)
  putString(KEY_URI, uri)
  putString(KEY_TITLE, title)
  putLong(KEY_DURATION_MS_HINT, durationMsHint.coerceAtLeast(0L))
  putBoolean(KEY_RETAIN_FOR_BACKGROUND, retainForBackground)
  putString(KEY_STORAGE_SCOPE, storageScope)
  expiresAt?.let { putLong(KEY_EXPIRES_AT, it) }
  putBundle(
    KEY_HEADERS,
    Bundle().apply {
      headers.entries.take(MAX_HEADER_COUNT).forEach { (name, value) ->
        if (name.isNotBlank() && value.isNotBlank()) putString(name, value)
      }
    },
  )
}

internal fun Bundle.toMinutesPlayerSource(): MinutesPlayerSource? {
  val sourceId = getString(KEY_SOURCE_ID)?.takeIf(String::isNotBlank) ?: return null
  val uri = getString(KEY_URI)?.takeIf(String::isNotBlank) ?: return null
  val headerBundle = getBundle(KEY_HEADERS)
  val headers = headerBundle?.keySet()
    ?.take(MAX_HEADER_COUNT)
    ?.mapNotNull { name -> headerBundle.getString(name)?.let { name to it } }
    ?.toMap()
    .orEmpty()
  return MinutesPlayerSource(
    sourceId = sourceId,
    uri = uri,
    headers = headers,
    title = getString(KEY_TITLE).orEmpty(),
    durationMsHint = getLong(KEY_DURATION_MS_HINT).coerceAtLeast(0L),
    retainForBackground = getBoolean(KEY_RETAIN_FOR_BACKGROUND, true),
    storageScope = getString(KEY_STORAGE_SCOPE).orEmpty(),
    expiresAt = if (containsKey(KEY_EXPIRES_AT)) getLong(KEY_EXPIRES_AT) else null,
  )
}

internal fun minutesStorageScopeArguments(storageScope: String): Bundle = Bundle().apply {
  putString(KEY_STORAGE_SCOPE, storageScope)
}

internal fun Bundle.toMinutesStorageScope(): String? =
  normalizeMinutesActiveStorageScope(getString(KEY_STORAGE_SCOPE))

internal fun MinutesPlayerSource.toPlaybackMetadataExtras(): Bundle = Bundle().apply {
  putLong(KEY_DURATION_MS_HINT, durationMsHint.coerceAtLeast(0L))
  putBoolean(KEY_RETAIN_FOR_BACKGROUND, retainForBackground)
  putString(KEY_STORAGE_SCOPE, storageScope)
}

internal fun Bundle?.durationMsHint(): Long = this?.getLong(KEY_DURATION_MS_HINT)?.coerceAtLeast(0L) ?: 0L

internal fun Bundle?.retainForBackground(): Boolean =
  this?.getBoolean(KEY_RETAIN_FOR_BACKGROUND, true) ?: true
