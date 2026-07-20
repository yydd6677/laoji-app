package com.laoji.nativeplatform.minutes

// MIN-ROOT-001 / MIN-DETAIL-001 / MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001:
// defensive structured snapshot parsing drives native state.

import com.laoji.nativeplatform.ui.NativeUserMessages

object MinutesSnapshotParser {
  fun parse(raw: Map<String, Any?>, surfaceOverride: String? = null): MinutesUiState {
    val surface = MinutesSurface.fromWireName(surfaceOverride ?: raw.string("surface"))
    val state = MinutesUiState(
      schemaVersion = raw.int("schemaVersion", MINUTES_SNAPSHOT_SCHEMA_VERSION),
      surface = surface,
      list = parseList(raw.map("list")),
      recording = parseRecording(raw.map("recording")),
      detail = parseDetail(raw.map("detail")),
    )
    return MinutesStateReducer.normalize(state)
  }

  private fun parseList(raw: Map<String, Any?>): MinutesListState {
    val phase = MinutesContentPhase.fromWireName(raw.string("phase"))
    return MinutesListState(
    title = raw.string("title").orDefault("会议记录"),
    searching = raw.boolean("searching"),
    query = raw.string("query").orEmpty(),
    phase = phase,
    message = raw.string("message")?.takeIf { it.isNotBlank() }?.let {
      NativeUserMessages.readable(it, listFallback(phase))
    }.orEmpty(),
    showingCachedData = raw.boolean("showingCachedData"),
    meetings = raw.maps("meetings").mapIndexed { index, item ->
      MinutesMeeting(
        id = item.string("id").orDefault("meeting-$index"),
        title = item.string("title").orDefault("未命名会议"),
        dateTimeLabel = item.string("dateTimeLabel").orEmpty(),
        durationLabel = item.string("durationLabel").orEmpty(),
        statusLabel = item.string("statusLabel").orEmpty(),
        statusTone = item.string("statusTone").orDefault("neutral"),
        canResume = item.boolean("canResume"),
        coverType = MinutesListCoverType.fromWireName(item.string("coverType")),
        coverTitle = item.string("coverTitle").orEmpty(),
        coverText = item.string("coverText").orEmpty(),
      )
    },
    )
  }

  private fun parseRecording(raw: Map<String, Any?>): MinutesRecordingState {
    val phase = MinutesRecordingPhase.fromWireName(raw.string("phase"))
    return MinutesRecordingState(
    meetingId = raw.string("meetingId").orEmpty(),
    title = raw.string("title").orDefault("会议记录"),
    startedAtLabel = raw.string("startedAtLabel").orEmpty(),
    phase = phase,
    elapsedMs = raw.long("elapsedMs"),
    statusLabel = raw.string("statusLabel")?.takeIf { it.isNotBlank() }?.let {
      NativeUserMessages.readable(it, recordingFallback(phase))
    }.orEmpty(),
    errorMessage = raw.string("errorMessage")?.takeIf { it.isNotBlank() }?.let {
      NativeUserMessages.readable(it, "录音暂时不可用，请稍后重试。")
    }.orEmpty(),
    canPause = raw.boolean("canPause"),
    canStop = raw.boolean("canStop"),
    canStart = raw.boolean("canStart", true),
    followLatest = raw.boolean("followLatest", true),
    transcript = parseTranscript(raw.maps("transcript")),
    )
  }

  private fun parseDetail(raw: Map<String, Any?>): MinutesDetailState {
    val activeTab = MinutesDetailTab.fromWireName(raw.string("activeTab"))
    val contentPhase = MinutesContentPhase.fromWireName(raw.string("contentPhase"))
    val contentMessage = raw.string("contentMessage")?.takeIf { it.isNotBlank() }?.let {
      NativeUserMessages.readable(it, "会议记录暂时无法加载，请稍后重试。")
    }.orEmpty()
    val transcript = parseTranscript(raw.maps("transcript"))
    val summary = raw.maps("summary").mapIndexed { index, item ->
      MinutesSummaryBlock(
        id = item.string("id").orDefault("summary-$index"),
        kind = item.string("kind").orDefault("paragraph"),
        text = item.string("text").orEmpty(),
        checked = item.boolean("checked"),
      )
    }
    val speakers = raw.maps("speakers").mapIndexed { index, item ->
      MinutesSpeaker(
        id = item.string("id").orDefault("speaker-$index"),
        label = item.string("label").orDefault("发言人"),
        segmentCount = item.int("segmentCount"),
        durationLabel = item.string("durationLabel").orEmpty(),
        canManage = item.boolean("canManage"),
      )
    }
    val legacyPageStates = MinutesDetailPageStates.fromLegacy(
      activeTab = activeTab,
      contentPhase = contentPhase,
      contentMessage = contentMessage,
      transcriptHasContent = transcript.any { it.id.isNotBlank() && it.text.isNotBlank() },
      summaryHasContent = summary.any { it.id.isNotBlank() && it.text.isNotBlank() },
      speakersHaveContent = speakers.any { it.id.isNotBlank() && it.label.isNotBlank() },
    )
    return MinutesDetailState(
      meetingId = raw.string("meetingId").orEmpty(),
      available = raw.boolean("available", true),
      title = raw.string("title").orDefault("会议记录"),
      dateTimeLabel = raw.string("dateTimeLabel").orEmpty(),
      activeTab = activeTab,
      tabGeneration = raw["tabGeneration"].pageGeneration(),
      activeTabIsExplicit = raw.boolean("activeTabIsExplicit"),
      contentPhase = contentPhase,
      contentMessage = contentMessage,
      canShare = raw.boolean("canShare"),
      canManageSpeakers = raw.boolean("canManageSpeakers"),
      canGenerateSummary = raw.boolean("canGenerateSummary"),
      summaryGenerating = raw.boolean("summaryGenerating"),
      summaryActionLabel = raw.string("summaryActionLabel").orDefault("生成总结"),
      titleEditRequestId = raw.int("titleEditRequestId"),
      transcript = transcript,
      summary = summary,
      speakers = speakers,
      playerSource = raw.mapOrNull("playerSource")?.let(::parsePlayerSource),
      audioStatusMessage = raw.string("audioStatusMessage")?.takeIf { it.isNotBlank() }?.let {
        NativeUserMessages.readable(it, "录音状态暂时无法获取，请稍后重试。")
      }.orEmpty(),
      audioErrorMessage = raw.string("audioErrorMessage")?.takeIf { it.isNotBlank() }?.let {
        NativeUserMessages.readable(it, "音频暂时无法播放，请稍后重试。")
      }.orEmpty(),
      pageStates = parseDetailPageStates(raw.mapOrNull("pageStates"), legacyPageStates),
    )
  }

  private fun parseDetailPageStates(
    raw: Map<String, Any?>?,
    fallback: MinutesDetailPageStates,
  ): MinutesDetailPageStates = MinutesDetailPageStates(
    transcript = parseDetailPageState(raw?.mapOrNull("transcript"), fallback.transcript),
    summary = parseDetailPageState(raw?.mapOrNull("summary"), fallback.summary),
    speakers = parseDetailPageState(raw?.mapOrNull("speakers"), fallback.speakers),
    info = parseDetailPageState(raw?.mapOrNull("info"), fallback.info),
  )

  private fun parseDetailPageState(
    raw: Map<String, Any?>?,
    fallback: MinutesDetailPageState,
  ): MinutesDetailPageState {
    if (raw == null) return fallback
    return MinutesDetailPageState(
      phase = if (raw.containsKey("phase")) {
        MinutesContentPhase.fromWireName(raw.string("phase"))
      } else {
        fallback.phase
      },
      message = if (raw.containsKey("message")) {
        raw.string("message")?.takeIf { it.isNotBlank() }?.let {
          NativeUserMessages.readable(it, "会议记录暂时无法加载，请稍后重试。")
        }.orEmpty()
      } else fallback.message,
      generation = if (raw.containsKey("generation")) {
        raw["generation"].pageGeneration()
      } else {
        fallback.generation
      },
      cached = if (raw.containsKey("cached")) raw.boolean("cached") else fallback.cached,
    )
  }

  private fun parseTranscript(items: List<Map<String, Any?>>): List<MinutesTranscriptLine> =
    items.mapIndexed { index, item ->
      MinutesTranscriptLine(
        id = item.string("id").orDefault("line-$index"),
        speakerId = item.string("speakerId").orEmpty(),
        speakerLabel = item.string("speakerLabel").orDefault("发言人"),
        timestampLabel = item.string("timestampLabel").orDefault("00:00"),
        startMs = item.long("startMs"),
        endMs = maxOf(item.long("startMs"), item.long("endMs")),
        text = item.string("text").orEmpty(),
        isFinal = item.boolean("isFinal", true),
      )
    }

  private fun listFallback(phase: MinutesContentPhase): String = when (phase) {
    MinutesContentPhase.LOADING -> "正在加载会议记录"
    MinutesContentPhase.ERROR -> "会议记录暂时无法加载，请稍后重试。"
    else -> "暂无会议记录"
  }

  private fun recordingFallback(phase: MinutesRecordingPhase): String = when (phase) {
    MinutesRecordingPhase.PREPARING -> "正在准备录音"
    MinutesRecordingPhase.RECORDING -> "正在录音"
    MinutesRecordingPhase.PAUSED -> "录音已暂停"
    MinutesRecordingPhase.STOPPING -> "正在停止录音"
    MinutesRecordingPhase.SAVING -> "正在保存会议记录"
    MinutesRecordingPhase.FAILED -> "录音需要重试"
    MinutesRecordingPhase.IDLE -> "准备开始录音"
  }

  private fun parsePlayerSource(raw: Map<String, Any?>): MinutesPlayerSource = MinutesPlayerSource(
    sourceId = raw.string("sourceId").orEmpty(),
    uri = raw.string("uri").orEmpty(),
    headers = raw.map("headers").mapNotNull { (key, value) ->
      (value as? String)?.let { key to it }
    }.toMap(),
    title = raw.string("title").orEmpty(),
    durationMsHint = raw.long("durationMsHint"),
    retainForBackground = raw.boolean("retainForBackground", true),
    storageScope = raw.string("storageScope").orEmpty(),
    expiresAt = raw.nullableLong("expiresAt"),
  )
}

private fun String?.orDefault(fallback: String): String = if (this.isNullOrBlank()) fallback else this

private fun Map<String, Any?>.string(key: String): String? = this[key] as? String

private fun Map<String, Any?>.boolean(key: String, fallback: Boolean = false): Boolean =
  this[key] as? Boolean ?: fallback

private fun Map<String, Any?>.long(key: String, fallback: Long = 0L): Long =
  (this[key] as? Number)?.toLong() ?: fallback

private fun Map<String, Any?>.nullableLong(key: String): Long? =
  (this[key] as? Number)?.toLong()

private fun Map<String, Any?>.int(key: String, fallback: Int = 0): Int =
  (this[key] as? Number)?.toInt() ?: fallback

private fun Any?.pageGeneration(): Int {
  val numeric = (this as? Number)?.toDouble() ?: return 0
  if (!numeric.isFinite()) return 0
  return numeric.coerceIn(0.0, Int.MAX_VALUE.toDouble()).toInt()
}

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.map(key: String): Map<String, Any?> =
  this[key] as? Map<String, Any?> ?: emptyMap()

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.mapOrNull(key: String): Map<String, Any?>? =
  this[key] as? Map<String, Any?>

private fun Map<String, Any?>.maps(key: String): List<Map<String, Any?>> =
  (this[key] as? List<*>)?.mapNotNull { item ->
    @Suppress("UNCHECKED_CAST")
    item as? Map<String, Any?>
  }.orEmpty()
