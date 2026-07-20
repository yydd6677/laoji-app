package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001: process-durable, meeting-scoped view state.

import android.content.Context
import android.util.Base64

internal data class MinutesDetailPageScrollPosition(
  val anchorIndex: Int = 0,
  val offsetPx: Int = 0,
)

internal data class MinutesDetailPersistedViewState(
  val activeTab: MinutesDetailTab = MinutesDetailTab.TRANSCRIPT,
  val tabGeneration: Int = 0,
  val headerCollapseOffsetPx: Int = 0,
  val transcript: MinutesDetailPageScrollPosition = MinutesDetailPageScrollPosition(),
  val summary: MinutesDetailPageScrollPosition = MinutesDetailPageScrollPosition(),
  val speakers: MinutesDetailPageScrollPosition = MinutesDetailPageScrollPosition(),
  val info: MinutesDetailPageScrollPosition = MinutesDetailPageScrollPosition(),
)

internal class MinutesDetailViewStateStore(context: Context) {
  private val preferences = context.applicationContext.getSharedPreferences(
    PREFERENCES_NAME,
    Context.MODE_PRIVATE,
  )

  fun read(meetingId: String): MinutesDetailPersistedViewState? {
    if (meetingId.isBlank()) return null
    val prefix = prefix(meetingId)
    if (!preferences.getBoolean("$prefix.exists", false)) return null
    return MinutesDetailPersistedViewState(
      activeTab = MinutesDetailTab.fromWireName(preferences.getString("$prefix.tab", null)),
      tabGeneration = preferences.getInt("$prefix.tabGeneration", 0).coerceAtLeast(0),
      headerCollapseOffsetPx = preferences.getInt("$prefix.header", 0).coerceAtLeast(0),
      transcript = readPage(prefix, "transcript"),
      summary = readPage(prefix, "summary"),
      speakers = readPage(prefix, "speakers"),
      info = readPage(prefix, "info"),
    )
  }

  fun write(meetingId: String, state: MinutesDetailPersistedViewState, synchronous: Boolean = false) {
    if (meetingId.isBlank()) return
    val prefix = prefix(meetingId)
    val editor = preferences.edit()
      .putBoolean("$prefix.exists", true)
      .putString("$prefix.tab", state.activeTab.wireName)
      .putInt("$prefix.tabGeneration", state.tabGeneration.coerceAtLeast(0))
      .putInt("$prefix.header", state.headerCollapseOffsetPx.coerceAtLeast(0))
      .putPage(prefix, "transcript", state.transcript)
      .putPage(prefix, "summary", state.summary)
      .putPage(prefix, "speakers", state.speakers)
      .putPage(prefix, "info", state.info)
    if (synchronous) editor.commit() else editor.apply()
  }

  fun clear(meetingId: String) {
    if (meetingId.isBlank()) return
    val prefix = prefix(meetingId)
    val editor = preferences.edit()
    preferences.all.keys.filter { it.startsWith(prefix) }.forEach(editor::remove)
    editor.commit()
  }

  private fun readPage(prefix: String, tab: String): MinutesDetailPageScrollPosition =
    MinutesDetailPageScrollPosition(
      anchorIndex = preferences.getInt("$prefix.$tab.index", 0).coerceAtLeast(0),
      offsetPx = preferences.getInt("$prefix.$tab.offset", 0),
    )

  private fun android.content.SharedPreferences.Editor.putPage(
    prefix: String,
    tab: String,
    state: MinutesDetailPageScrollPosition,
  ) = apply {
    putInt("$prefix.$tab.index", state.anchorIndex.coerceAtLeast(0))
    putInt("$prefix.$tab.offset", state.offsetPx)
  }

  private fun prefix(meetingId: String): String {
    val encoded = Base64.encodeToString(
      meetingId.toByteArray(Charsets.UTF_8),
      Base64.NO_WRAP or Base64.URL_SAFE,
    )
    return "meeting.$encoded"
  }

  private companion object {
    const val PREFERENCES_NAME = "laoji_minutes_detail_view_state_v1"
  }
}
