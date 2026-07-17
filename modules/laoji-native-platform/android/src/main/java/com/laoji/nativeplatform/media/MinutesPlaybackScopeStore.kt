package com.laoji.nativeplatform.media

// MIN-PLAYER-RECOVERY-001: non-secret active scope is durable before the playback service starts.

import android.content.Context

internal class MinutesPlaybackScopeStore(context: Context) {
  private val preferences = context.applicationContext.getSharedPreferences(
    PREFERENCES_NAME,
    Context.MODE_PRIVATE,
  )

  @Synchronized
  fun activeScope(): String = normalizeMinutesActiveStorageScope(
    preferences.getString(KEY_ACTIVE_SCOPE, null),
  ) ?: MINUTES_SIGNED_OUT_SCOPE

  @Synchronized
  fun activate(scope: String): Boolean {
    val normalized = requireNotNull(normalizeMinutesActiveStorageScope(scope)) {
      "Invalid Minutes playback storage scope"
    }
    val changed = activeScope() != normalized
    check(preferences.edit().putString(KEY_ACTIVE_SCOPE, normalized).commit()) {
      "Unable to persist Minutes playback storage scope"
    }
    return changed
  }

  companion object {
    private const val PREFERENCES_NAME = "laoji_minutes_active_playback_scope"
    private const val KEY_ACTIVE_SCOPE = "active_scope"
  }
}
