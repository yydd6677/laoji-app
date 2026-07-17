package com.laoji.nativeplatform.speaker

// MIN-SPEAKER-001: normalized speaker snapshots keep credentials and audio files outside the view layer.

data class SpeakerProfileModel(
  val id: String,
  val name: String,
  val sampleCount: Int,
  val quality: Float,
)

data class SpeakerManagerState(
  val guest: Boolean,
  val phase: String,
  val message: String,
  val speakers: List<SpeakerProfileModel>,
)

data class SpeakerEnrollmentState(
  val guest: Boolean,
  val speakerId: String,
  val title: String,
  val phase: String,
  val message: String,
  val name: String,
  val nameEditable: Boolean,
  val nameSaveEnabled: Boolean,
  val enrollmentPhase: String,
  val elapsedMs: Long,
  val maxDurationMs: Long,
  val level: Float,
  val errorMessage: String,
  val canDelete: Boolean,
  val canRecord: Boolean,
  val canSubmit: Boolean,
  val voiceprintText: String,
  val voiceprintConsentAccepted: Boolean = false,
)

internal object SpeakerSnapshotParser {
  fun manager(raw: Map<String, Any?>): SpeakerManagerState = SpeakerManagerState(
    guest = raw.bool("guest"),
    phase = raw.string("phase").ifBlank { "loading" },
    message = raw.string("message"),
    speakers = raw.list("speakers").mapNotNull { value ->
      val item = value as? Map<*, *> ?: return@mapNotNull null
      val id = item.string("id").trim()
      val name = item.string("name").trim()
      if (id.isBlank() || name.isBlank()) return@mapNotNull null
      SpeakerProfileModel(
        id = id,
        name = name,
        sampleCount = item.number("sampleCount").toInt().coerceAtLeast(0),
        quality = item.number("quality").toFloat().coerceIn(0f, 1f),
      )
    },
  )

  fun enrollment(raw: Map<String, Any?>): SpeakerEnrollmentState = SpeakerEnrollmentState(
    guest = raw.bool("guest"),
    speakerId = raw.string("speakerId"),
    title = raw.string("title").ifBlank { "声纹采集" },
    phase = raw.string("phase").ifBlank { "loading" },
    message = raw.string("message"),
    name = raw.string("name"),
    nameEditable = raw.bool("nameEditable", default = true),
    nameSaveEnabled = raw.bool("nameSaveEnabled"),
    enrollmentPhase = raw.string("enrollmentPhase").ifBlank { "idle" },
    elapsedMs = raw.number("elapsedMs").toLong().coerceAtLeast(0L),
    maxDurationMs = raw.number("maxDurationMs").toLong().coerceAtLeast(1L),
    level = raw.number("level").toFloat().coerceIn(0f, 1f),
    errorMessage = raw.string("errorMessage"),
    canDelete = raw.bool("canDelete"),
    canRecord = raw.bool("canRecord", default = true),
    canSubmit = raw.bool("canSubmit"),
    voiceprintText = raw.string("voiceprintText").ifBlank {
      "今天的会议将围绕项目进展展开，请大家依次说明完成情况和下一步安排。"
    },
    voiceprintConsentAccepted = raw.bool("voiceprintConsentAccepted"),
  )

  private fun Map<*, *>.string(key: String): String = this[key] as? String ?: ""
  private fun Map<*, *>.number(key: String): Number = this[key] as? Number ?: 0
  private fun Map<String, Any?>.bool(key: String, default: Boolean = false): Boolean =
    this[key] as? Boolean ?: default
  private fun Map<String, Any?>.list(key: String): List<Any?> = this[key] as? List<Any?> ?: emptyList()
}
