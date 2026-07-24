package com.laoji.nativeplatform.entry

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

private const val PREFS_NAME = "laoji_system_entries"
private const val PROJECTION_KEY = "upcoming_events_projection_v1"
private const val SCHEMA_VERSION = 1
private const val MAX_EVENTS = 5
private const val DAY_MS = 86_400_000L
private const val MAX_PROJECTION_LIFETIME_MS = DAY_MS + 5 * 60_000L
private const val MAX_CLOCK_SKEW_MS = 5 * 60_000L
private val controlCharacterPattern = Regex("[\\u0000-\\u001f\\u007f]")

enum class UpcomingMeetingAction(val wireValue: String, val label: String) {
  START("start", "开始记录"),
  CONTINUE("continue", "继续记录"),
  VIEW("view", "查看记录");

  companion object {
    fun fromWireValue(value: String): UpcomingMeetingAction = entries.firstOrNull {
      it.wireValue == value
    } ?: throw IllegalArgumentException("invalid meeting action")
  }
}

data class UpcomingEventProjectionItem(
  val sourceEventId: String,
  val occurrenceDate: String,
  val title: String,
  val startAtMs: Long,
  val endAtMs: Long,
  val allDay: Boolean,
  val meetingAction: UpcomingMeetingAction,
)

data class UpcomingEventsProjection(
  val schemaVersion: Int,
  val scopeKey: String,
  val updatedAtMs: Long,
  val expiresAtMs: Long,
  val hideTitles: Boolean,
  val events: List<UpcomingEventProjectionItem>,
) {
  fun isFresh(nowMs: Long): Boolean =
    updatedAtMs <= nowMs + MAX_CLOCK_SKEW_MS && nowMs <= expiresAtMs
}

data class SystemEntryProjectionSnapshot(
  val projection: UpcomingEventsProjection?,
  val available: Boolean,
  val fresh: Boolean,
) {
  fun toStateMap(): Map<String, Any?> {
    val value = projection
    return mapOf(
      "available" to available,
      "fresh" to fresh,
      "schemaVersion" to value?.schemaVersion,
      "eventCount" to (value?.events?.size ?: 0),
      "updatedAtMs" to value?.updatedAtMs?.toDouble(),
      "expiresAtMs" to value?.expiresAtMs?.toDouble(),
    )
  }
}

object SystemEntryProjectionStore {
  fun write(context: Context, json: String): SystemEntryProjectionSnapshot {
    require(json.length <= 32_768) { "projection is too large" }
    val projection = parse(json)
    check(
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(PROJECTION_KEY, json)
        .commit(),
    ) { "projection storage failed" }
    notifyWidgetChanged(context)
    return SystemEntryProjectionSnapshot(
      projection = projection,
      available = true,
      fresh = projection.isFresh(System.currentTimeMillis()),
    )
  }

  fun read(context: Context, nowMs: Long = System.currentTimeMillis()): SystemEntryProjectionSnapshot {
    val json = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .getString(PROJECTION_KEY, null)
      ?: return SystemEntryProjectionSnapshot(null, available = false, fresh = false)
    val projection = runCatching { parse(json) }.getOrNull()
      ?: return SystemEntryProjectionSnapshot(null, available = false, fresh = false)
    return SystemEntryProjectionSnapshot(
      projection = projection,
      available = true,
      fresh = projection.isFresh(nowMs),
    )
  }

  fun clear(context: Context) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      .edit()
      .remove(PROJECTION_KEY)
      .commit()
    notifyWidgetChanged(context)
  }

  private fun parse(json: String): UpcomingEventsProjection {
    val root = JSONObject(json)
    root.requireExactKeys(
      setOf("schemaVersion", "scopeKey", "updatedAtMs", "expiresAtMs", "hideTitles", "events"),
    )
    val schemaVersion = root.getInt("schemaVersion")
    require(schemaVersion == SCHEMA_VERSION) { "unsupported projection schema" }
    val scopeKey = root.getString("scopeKey")
    require(
      scopeKey == "guest" ||
        scopeKey.startsWith("user:") && scopeKey.length in 6..256 && !controlCharacterPattern.containsMatchIn(scopeKey),
    ) { "invalid projection scope" }
    val updatedAtMs = root.getLong("updatedAtMs")
    val expiresAtMs = root.getLong("expiresAtMs")
    require(updatedAtMs >= 0L && expiresAtMs >= updatedAtMs) { "invalid projection lifetime" }
    require(expiresAtMs - updatedAtMs <= MAX_PROJECTION_LIFETIME_MS) { "projection lifetime is too long" }
    val eventsJson = root.getJSONArray("events")
    require(eventsJson.length() <= MAX_EVENTS) { "too many projected events" }
    val events = buildList(eventsJson.length()) {
      for (index in 0 until eventsJson.length()) add(parseEvent(eventsJson.getJSONObject(index)))
    }
    require(events.distinctBy { it.sourceEventId to it.occurrenceDate }.size == events.size) {
      "duplicate projected occurrence"
    }
    require(events.zipWithNext().all { (left, right) -> left.startAtMs <= right.startAtMs }) {
      "projected events are not ordered"
    }
    return UpcomingEventsProjection(
      schemaVersion = schemaVersion,
      scopeKey = scopeKey,
      updatedAtMs = updatedAtMs,
      expiresAtMs = expiresAtMs,
      hideTitles = root.getBoolean("hideTitles"),
      events = events,
    )
  }

  private fun parseEvent(json: JSONObject): UpcomingEventProjectionItem {
    json.requireExactKeys(
      setOf(
        "sourceEventId",
        "occurrenceDate",
        "title",
        "startAtMs",
        "endAtMs",
        "allDay",
        "meetingAction",
      ),
    )
    val sourceEventId = json.getString("sourceEventId")
    require(sourceEventId.length in 1..512 && !controlCharacterPattern.containsMatchIn(sourceEventId)) {
      "invalid source event id"
    }
    val occurrenceDate = json.getString("occurrenceDate")
    runCatching { LocalDate.parse(occurrenceDate) }
      .getOrElse { throw IllegalArgumentException("invalid occurrence date") }
    val title = json.getString("title")
    require(title.length in 1..256 && !controlCharacterPattern.containsMatchIn(title)) {
      "invalid event title"
    }
    val startAtMs = json.getLong("startAtMs")
    val endAtMs = json.getLong("endAtMs")
    require(startAtMs >= 0L && endAtMs > startAtMs) { "invalid event time" }
    return UpcomingEventProjectionItem(
      sourceEventId = sourceEventId,
      occurrenceDate = occurrenceDate,
      title = title,
      startAtMs = startAtMs,
      endAtMs = endAtMs,
      allDay = json.getBoolean("allDay"),
      meetingAction = UpcomingMeetingAction.fromWireValue(json.getString("meetingAction")),
    )
  }

  private fun notifyWidgetChanged(context: Context) {
    runCatching {
      val manager = AppWidgetManager.getInstance(context)
      val component = ComponentName(context, LaojiUpcomingEventsWidgetProvider::class.java)
      val ids = manager.getAppWidgetIds(component)
      if (ids.isNotEmpty()) {
        manager.notifyAppWidgetViewDataChanged(ids, com.laoji.nativeplatform.R.id.laoji_widget_event_list)
        LaojiUpcomingEventsWidgetProvider.update(context, manager, ids)
      }
    }
  }
}

private fun JSONObject.requireExactKeys(expected: Set<String>) {
  val actual = keys().asSequence().toSet()
  require(actual == expected) { "projection contains unsupported fields" }
}
