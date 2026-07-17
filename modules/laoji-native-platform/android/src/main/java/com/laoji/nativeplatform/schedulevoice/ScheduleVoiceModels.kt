package com.laoji.nativeplatform.schedulevoice

// UI-OVERLAY-001: one immutable snapshot owns every conditional state without changing control slots.
internal enum class ScheduleVoicePhase(val wireName: String) {
  INPUT("input"),
  PREPARING("preparing"),
  RECORDING("recording"),
  PARSING("parsing"),
  CONFIRM("confirm"),
  SAVING("saving");

  companion object {
    fun fromWireName(value: String?): ScheduleVoicePhase = entries.firstOrNull { it.wireName == value } ?: INPUT
  }
}

internal data class ScheduleVoiceField(
  val key: String,
  val label: String,
  val value: String,
)

internal data class ScheduleVoiceSnapshot(
  val schemaVersion: Int = 1,
  val phase: ScheduleVoicePhase = ScheduleVoicePhase.INPUT,
  val text: String = "",
  val errorMessage: String = "",
  val statusLabel: String = "",
  val title: String = "",
  val fields: List<ScheduleVoiceField> = emptyList(),
  val canParse: Boolean = false,
  val canSave: Boolean = false,
  val canEditDetails: Boolean = false,
) {
  companion object {
    fun parse(raw: Map<String, Any?>?): ScheduleVoiceSnapshot? {
      if ((raw?.get("schemaVersion") as? Number)?.toInt() != 1) return null
      val fields = (raw["fields"] as? List<*>)?.mapNotNull { value ->
        val item = value as? Map<*, *> ?: return@mapNotNull null
        ScheduleVoiceField(
          key = item.string("key").take(64),
          label = item.string("label").take(40),
          value = item.string("value").take(240),
        )
      }.orEmpty()
      return ScheduleVoiceSnapshot(
        schemaVersion = 1,
        phase = ScheduleVoicePhase.fromWireName(raw.string("phase")),
        text = raw.string("text").take(2000),
        errorMessage = raw.string("errorMessage").take(240),
        statusLabel = raw.string("statusLabel").take(80),
        title = raw.string("title").take(200),
        fields = fields,
        canParse = raw.boolean("canParse"),
        canSave = raw.boolean("canSave"),
        canEditDetails = raw.boolean("canEditDetails"),
      )
    }

    private fun Map<*, *>.string(key: String): String = this[key] as? String ?: ""
    private fun Map<*, *>.boolean(key: String): Boolean = this[key] as? Boolean ?: false
  }
}

internal object ScheduleVoiceGesture {
  const val HOLD_TO_TALK_MS = 320L

  fun shouldStopOnRelease(startedFromInput: Boolean, heldForMs: Long): Boolean =
    !startedFromInput || heldForMs >= HOLD_TO_TALK_MS
}
