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
    mediaImporting = raw.boolean("mediaImporting"),
    phase = phase,
    message = raw.string("message")?.takeIf { it.isNotBlank() }?.let {
      NativeUserMessages.readable(it, listFallback(phase))
    }.orEmpty(),
    showingCachedData = raw.boolean("showingCachedData"),
    mode = MinutesListMode.fromWireName(raw.string("mode")),
    canOpenRecycleBin = raw.boolean("canOpenRecycleBin"),
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
        action = MinutesMeetingAction.fromWireName(item.string("action")),
        actionEnabled = item.boolean("actionEnabled", true),
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
    location = raw.string("location").orEmpty(),
    locationLoading = raw.boolean("locationLoading"),
    canEditLocation = raw.boolean("canEditLocation", true),
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
    canCreateMarker = raw.boolean("canCreateMarker"),
    followLatest = raw.boolean("followLatest", true),
    activeContent = MinutesRecordingContent.fromWireName(raw.string("activeContent")),
    manualNote = raw.string("manualNote").orEmpty(),
    manualNoteLoading = raw.boolean("manualNoteLoading"),
    manualNoteSaving = raw.boolean("manualNoteSaving"),
    manualNoteEnabled = raw.boolean("manualNoteEnabled"),
    manualNoteError = raw.string("manualNoteError")?.takeIf { it.isNotBlank() }?.let {
      NativeUserMessages.readable(it, "笔记暂时未保存，请稍后重试。")
    }.orEmpty(),
    manualNoteRetryable = raw.boolean("manualNoteRetryable", true),
    manualNoteConflict = raw.boolean("manualNoteConflict"),
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
    val markers = raw.maps("markers")
      .asSequence()
      .mapNotNull { item ->
        val id = item.string("id").orEmpty()
        val positionMs = item.long("positionMs")
        if (id.isBlank() || positionMs < 0L) null else MinutesMarker(
          id = id,
          positionMs = positionMs,
          timestampLabel = item.string("timestampLabel").orDefault(formatClock(positionMs)),
          segmentId = item.string("segmentId").orEmpty(),
          label = item.string("label").orEmpty(),
          deleting = item.boolean("deleting"),
        )
      }
      .take(MAX_MARKERS)
      .sortedWith(compareBy<MinutesMarker> { it.positionMs }.thenBy { it.id })
      .toList()
    val summary = raw.maps("summary").mapIndexed { index, item ->
      MinutesSummarySection(
        id = item.string("id").orDefault("summary-$index"),
        stableKey = item.string("stableKey").orDefault("section_$index"),
        kind = item.string("kind").orDefault("paragraph"),
        title = item.string("title").orEmpty(),
        text = item.string("text").orEmpty(),
        citations = item.maps("citations")
          .asSequence()
          .mapIndexedNotNull { citationIndex, citation ->
            val segmentId = citation.string("segmentId").orEmpty()
            val startMs = citation.long("startMs").coerceAtLeast(0L)
            val endMs = citation.long("endMs", startMs).coerceAtLeast(startMs)
            if (segmentId.isBlank()) null else MinutesSummaryCitation(
              id = citation.string("id").orDefault("summary-$index-citation-$citationIndex"),
              segmentId = segmentId,
              startMs = startMs,
              endMs = endMs,
              label = citation.string("label").orEmpty(),
            )
          }
          .take(MAX_SUMMARY_CITATIONS)
          .toList(),
      )
    }
    val actions = raw.maps("actions")
      .asSequence()
      .mapIndexedNotNull { index, item ->
        val id = item.string("id").orDefault("action-$index")
        val content = item.string("content").orEmpty().trim()
        if (content.isBlank()) return@mapIndexedNotNull null
        val status = item.string("status").orDefault("pending")
          .takeIf { it == "pending" || it == "completed" || it == "dismissed" }
          ?: "pending"
        MinutesActionItem(
          id = id,
          content = content,
          status = status,
          assigneeLabel = item.string("assigneeLabel").orEmpty(),
          dueLabel = item.string("dueLabel").orEmpty(),
          reminderLabel = item.string("reminderLabel").orEmpty(),
          followupEventSourceId = item.string("followupEventSourceId").orEmpty(),
          hasSource = item.boolean("hasSource") || item.containsKey("sourceStartMs"),
          sourceSegmentId = item.string("sourceSegmentId").orEmpty(),
          sourceStartMs = item.long("sourceStartMs").coerceAtLeast(0L),
          updatedAtMs = item.long("updatedAtMs").coerceAtLeast(0L),
          updating = item.boolean("updating"),
          syncConflict = item.boolean("syncConflict"),
        )
      }
      .take(MAX_SUMMARY_ACTIONS)
      .toList()
    val speakers = raw.maps("speakers").mapIndexed { index, item ->
      MinutesSpeaker(
        id = item.string("id").orDefault("speaker-$index"),
        label = item.string("label").orDefault("讲话人"),
        segmentCount = item.int("segmentCount"),
        durationLabel = item.string("durationLabel").orEmpty(),
        canManage = item.boolean("canManage"),
      )
    }
    val legacyPageStates = MinutesDetailPageStates.fromLegacy(
      activeTab = activeTab,
      contentPhase = contentPhase,
      contentMessage = contentMessage,
      transcriptHasContent = transcript.any { it.id.isNotBlank() && it.text.isNotBlank() }
        || markers.isNotEmpty(),
      summaryHasContent = summary.any { it.id.isNotBlank() && (it.text.isNotBlank() || it.title.isNotBlank()) }
        || actions.any { it.id.isNotBlank() && it.content.isNotBlank() },
      speakersHaveContent = speakers.any { it.id.isNotBlank() && it.label.isNotBlank() },
    )
    return MinutesDetailState(
      meetingId = raw.string("meetingId").orEmpty(),
      available = raw.boolean("available", true),
      title = raw.string("title").orDefault("会议记录"),
      dateTimeLabel = raw.string("dateTimeLabel").orEmpty(),
      location = raw.string("location").orEmpty(),
      activeTab = activeTab,
      tabGeneration = raw["tabGeneration"].pageGeneration(),
      activeTabIsExplicit = raw.boolean("activeTabIsExplicit"),
      contentPhase = contentPhase,
      contentMessage = contentMessage,
      canShare = raw.boolean("canShare"),
      canManageSpeakers = raw.boolean("canManageSpeakers"),
      canGenerateSummary = raw.boolean("canGenerateSummary"),
      canCreateAction = raw.boolean("canCreateAction"),
      summaryGenerating = raw.boolean("summaryGenerating"),
      summaryActionLabel = raw.string("summaryActionLabel").orDefault("生成整理结果"),
      titleEditRequestId = raw.int("titleEditRequestId"),
      focusActionId = raw.string("focusActionId").orEmpty(),
      focusActionRequestId = raw.long("focusActionRequestId").coerceAtLeast(0L),
      focusTranscriptSegmentId = raw.string("focusTranscriptSegmentId").orEmpty(),
      focusTranscriptPositionMs = raw.long("focusTranscriptPositionMs").coerceAtLeast(0L),
      focusTranscriptRequestId = raw.long("focusTranscriptRequestId").coerceAtLeast(0L),
      manualNote = raw.string("manualNote").orEmpty(),
      manualNoteLoading = raw.boolean("manualNoteLoading"),
      manualNoteSaving = raw.boolean("manualNoteSaving"),
      manualNoteEnabled = raw.boolean("manualNoteEnabled"),
      manualNoteError = raw.string("manualNoteError")?.takeIf { it.isNotBlank() }?.let {
        NativeUserMessages.readable(it, "笔记暂时未保存，请稍后重试。")
      }.orEmpty(),
      manualNoteRetryable = raw.boolean("manualNoteRetryable", true),
      manualNoteConflict = raw.boolean("manualNoteConflict"),
      transcript = transcript,
      markers = markers,
      summary = summary,
      actions = actions,
      speakers = speakers,
      playerSource = raw.mapOrNull("playerSource")?.let(::parsePlayerSource),
      audioStatusMessage = raw.string("audioStatusMessage")?.takeIf { it.isNotBlank() }?.let {
        NativeUserMessages.readable(it, "录音状态暂时无法获取，请稍后重试。")
      }.orEmpty(),
      audioErrorMessage = raw.string("audioErrorMessage")?.takeIf { it.isNotBlank() }?.let {
        NativeUserMessages.readable(it, "音频暂时无法播放，请稍后重试。")
      }.orEmpty(),
      processingStatusLabel = raw.string("processingStatusLabel")?.takeIf { it.isNotBlank() }?.let {
        NativeUserMessages.readable(it, "会议处理状态暂时无法获取，请稍后重试。")
      }.orEmpty(),
      processingStatusTone = raw.string("processingStatusTone")
        ?.takeIf { it == "neutral" || it == "primary" || it == "success" || it == "warning" || it == "danger" }
        ?: "neutral",
      rootSyncConflict = raw.boolean("rootSyncConflict"),
      processingRetryStage = MinutesProcessingStage.fromWireName(raw.string("processingRetryStage")),
      processingRetrying = raw.boolean("processingRetrying"),
      pageStates = parseDetailPageStates(raw.mapOrNull("pageStates"), legacyPageStates),
    )
  }

  private fun parseDetailPageStates(
    raw: Map<String, Any?>?,
    fallback: MinutesDetailPageStates,
  ): MinutesDetailPageStates = MinutesDetailPageStates(
    notes = parseDetailPageState(raw?.mapOrNull("notes"), fallback.notes),
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
      val text = item.string("text").orEmpty()
      val isFinal = item.boolean("isFinal", true)
      MinutesTranscriptLine(
        id = item.string("id").orDefault("line-$index"),
        speakerId = item.string("speakerId").orEmpty(),
        speakerClusterId = item.string("speakerClusterId").orEmpty(),
        speakerLabel = item.string("speakerLabel").orDefault("讲话人"),
        timestampLabel = item.string("timestampLabel").orDefault("00:00"),
        startMs = item.long("startMs"),
        endMs = maxOf(item.long("startMs"), item.long("endMs")),
        text = text,
        isFinal = isFinal,
        active = item.boolean("active"),
        searchRanges = item.maps("searchRanges")
          .asSequence()
          .mapNotNull { range ->
            MinutesTextRange(range.int("start"), range.int("end"))
              .takeIf { it.validFor(text) }
          }
          .take(MAX_TRANSCRIPT_SEARCH_RANGES)
          .toList(),
        selectedSearchMatch = item.boolean("selectedSearchMatch"),
        revisionKind = MinutesTranscriptRevisionKind.fromWireName(
          item.string("revisionKind"),
          isFinal,
        ),
      )
    }

  private const val MAX_TRANSCRIPT_SEARCH_RANGES = 1_000
  private const val MAX_MARKERS = 2_000
  private const val MAX_SUMMARY_CITATIONS = 5_000
  private const val MAX_SUMMARY_ACTIONS = 500

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
