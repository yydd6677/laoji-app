package com.laoji.nativeplatform.minutes

// MIN-REC-STATE-001 / MIN-DETAIL-001 / MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001:
// normalized source-mapped Minutes state contracts.

const val MINUTES_SNAPSHOT_SCHEMA_VERSION = 15

enum class MinutesSurface(val wireName: String) {
  LIST("list"),
  RECORDING("recording"),
  DETAIL("detail");

  companion object {
    fun fromWireName(value: String?): MinutesSurface =
      entries.firstOrNull { it.wireName == value } ?: LIST
  }
}

enum class MinutesDetailTab(val wireName: String, val label: String) {
  NOTES("notes", "我的笔记"),
  TRANSCRIPT("transcript", "文字记录"),
  SUMMARY("summary", "整理结果"),
  SPEAKERS("speakers", "讲话人"),
  INFO("info", "信息");

  companion object {
    fun fromWireName(value: String?): MinutesDetailTab =
      entries.firstOrNull { it.wireName == value } ?: NOTES
  }
}

enum class MinutesProcessingStage(val wireName: String) {
  CAPTURE("capture"),
  UPLOAD("upload"),
  TRANSCRIPT("transcript"),
  SUMMARY("summary"),
  SPEAKER("speaker");

  companion object {
    fun fromWireName(value: String?): MinutesProcessingStage? =
      entries.firstOrNull { it.wireName == value }
  }
}

enum class MinutesRecordingContent(val wireName: String) {
  NOTES("notes"),
  TRANSCRIPT("transcript");

  companion object {
    fun fromWireName(value: String?): MinutesRecordingContent =
      entries.firstOrNull { it.wireName == value } ?: TRANSCRIPT
  }
}

enum class MinutesRecordingPhase(val wireName: String) {
  IDLE("idle"),
  PREPARING("preparing"),
  RECORDING("recording"),
  PAUSED("paused"),
  STOPPING("stopping"),
  SAVING("saving"),
  FAILED("failed");

  companion object {
    fun fromWireName(value: String?): MinutesRecordingPhase =
      entries.firstOrNull { it.wireName == value } ?: IDLE
  }
}

enum class MinutesContentPhase(val wireName: String) {
  READY("ready"),
  LOADING("loading"),
  EMPTY("empty"),
  ERROR("error");

  companion object {
    fun fromWireName(value: String?): MinutesContentPhase =
      entries.firstOrNull { it.wireName == value } ?: READY
  }
}

data class MinutesDetailPageState(
  val phase: MinutesContentPhase = MinutesContentPhase.READY,
  val message: String = "",
  val generation: Int = 0,
  val cached: Boolean = false,
) {
  fun normalized(): MinutesDetailPageState = copy(generation = generation.coerceAtLeast(0))
}

data class MinutesDetailPageStates(
  val notes: MinutesDetailPageState = MinutesDetailPageState(cached = true),
  val transcript: MinutesDetailPageState = MinutesDetailPageState(),
  val summary: MinutesDetailPageState = MinutesDetailPageState(),
  val speakers: MinutesDetailPageState = MinutesDetailPageState(),
  val info: MinutesDetailPageState = MinutesDetailPageState(),
) {
  operator fun get(tab: MinutesDetailTab): MinutesDetailPageState = when (tab) {
    MinutesDetailTab.NOTES -> notes
    MinutesDetailTab.TRANSCRIPT -> transcript
    MinutesDetailTab.SUMMARY -> summary
    MinutesDetailTab.SPEAKERS -> speakers
    MinutesDetailTab.INFO -> info
  }

  fun normalized(): MinutesDetailPageStates = copy(
    notes = notes.normalized(),
    transcript = transcript.normalized(),
    summary = summary.normalized(),
    speakers = speakers.normalized(),
    info = info.normalized(),
  )

  companion object {
    fun fromLegacy(
      activeTab: MinutesDetailTab,
      contentPhase: MinutesContentPhase,
      contentMessage: String,
      transcriptHasContent: Boolean = false,
      summaryHasContent: Boolean = false,
      speakersHaveContent: Boolean = false,
    ): MinutesDetailPageStates {
      val inferred = MinutesDetailPageStates(
        notes = MinutesDetailPageState(cached = true),
        transcript = contentBackedState(transcriptHasContent, "暂无文字记录"),
        summary = contentBackedState(summaryHasContent, "该会议暂未生成整理结果"),
        speakers = contentBackedState(speakersHaveContent, "暂无讲话人信息"),
        info = MinutesDetailPageState(),
      )
      val activeState = MinutesDetailPageState(contentPhase, contentMessage)
      return when (activeTab) {
        MinutesDetailTab.NOTES -> inferred.copy(notes = activeState.copy(cached = true))
        MinutesDetailTab.TRANSCRIPT -> inferred.copy(transcript = activeState)
        MinutesDetailTab.SUMMARY -> inferred.copy(summary = activeState)
        MinutesDetailTab.SPEAKERS -> inferred.copy(speakers = activeState)
        MinutesDetailTab.INFO -> inferred.copy(info = activeState)
      }
    }

    private fun contentBackedState(hasContent: Boolean, emptyMessage: String): MinutesDetailPageState =
      if (hasContent) MinutesDetailPageState() else MinutesDetailPageState(
        phase = MinutesContentPhase.EMPTY,
        message = emptyMessage,
      )
  }
}

data class MinutesMeeting(
  val id: String,
  val targetMeetingId: String = id,
  val title: String,
  val dateTimeLabel: String,
  val durationLabel: String = "",
  val statusLabel: String = "",
  val statusTone: String = "neutral",
  val canResume: Boolean = false,
  val coverType: MinutesListCoverType = MinutesListCoverType.DEFAULT,
  val coverTitle: String = "",
  val coverText: String = "",
  val supportText: String = "",
  val searchSource: String = "",
  val searchSourceId: String = "",
  val searchPositionMs: Long = -1L,
  val action: MinutesMeetingAction = MinutesMeetingAction.OPEN,
  val actionEnabled: Boolean = true,
)

enum class MinutesMeetingAction(val wireName: String) {
  OPEN("open"),
  RESTORE("restore");

  companion object {
    fun fromWireName(value: String?): MinutesMeetingAction = entries.firstOrNull {
      it.wireName == value
    } ?: OPEN
  }
}

enum class MinutesListCoverType(val wireName: String) {
  DEFAULT("default"),
  SUMMARY("summary"),
  SPEAKER_SUMMARY("speakerSummary");

  companion object {
    fun fromWireName(value: String?): MinutesListCoverType = entries.firstOrNull {
      it.wireName == value
    } ?: DEFAULT
  }
}

data class MinutesTranscriptLine(
  val id: String,
  val playerSourceId: String = "",
  val speakerId: String = "",
  val speakerClusterId: String = "",
  val speakerLabel: String = "讲话人",
  val timestampLabel: String = "00:00",
  val startMs: Long = 0L,
  val endMs: Long = startMs,
  val text: String,
  val isFinal: Boolean = true,
  val active: Boolean = false,
  val searchRanges: List<MinutesTextRange> = emptyList(),
  val selectedSearchMatch: Boolean = false,
  val revisionKind: MinutesTranscriptRevisionKind = if (isFinal) {
    MinutesTranscriptRevisionKind.FINAL
  } else {
    MinutesTranscriptRevisionKind.REALTIME_DRAFT
  },
)

data class MinutesMarker(
  val id: String,
  val positionMs: Long,
  val timestampLabel: String,
  val segmentId: String = "",
  val label: String = "",
  val deleting: Boolean = false,
)

enum class MinutesTranscriptRevisionKind(val wireName: String) {
  REALTIME_DRAFT("realtimeDraft"),
  FINAL("final"),
  REPROCESSED("reprocessed");

  companion object {
    fun fromWireName(value: String?, isFinal: Boolean): MinutesTranscriptRevisionKind =
      entries.firstOrNull { it.wireName == value }
        ?: if (isFinal) FINAL else REALTIME_DRAFT
  }
}

data class MinutesSummaryCitation(
  val id: String,
  val segmentId: String,
  val startMs: Long,
  val endMs: Long = startMs,
  val label: String = "",
)

data class MinutesSummarySection(
  val id: String,
  val stableKey: String,
  val kind: String = "paragraph",
  val title: String = "",
  val text: String,
  val citations: List<MinutesSummaryCitation> = emptyList(),
)

data class MinutesActionItem(
  val id: String,
  val content: String,
  val status: String = "pending",
  val assigneeLabel: String = "",
  val dueLabel: String = "",
  val reminderLabel: String = "",
  val followupEventSourceId: String = "",
  val hasSource: Boolean = false,
  val sourceSegmentId: String = "",
  val sourceStartMs: Long = 0L,
  val updatedAtMs: Long = 0L,
  val updating: Boolean = false,
  val syncConflict: Boolean = false,
  val canShare: Boolean = false,
)

data class MinutesSpeaker(
  val id: String,
  val label: String,
  val segmentCount: Int = 0,
  val durationLabel: String = "",
  val canManage: Boolean = false,
)

data class MinutesPlayerSource(
  val sourceId: String,
  val uri: String,
  val recordingAssetId: String = "",
  val recordingAssetRemoteId: String = "",
  val label: String = "",
  val localOnly: Boolean = false,
  val headers: Map<String, String> = emptyMap(),
  val title: String = "",
  val durationMsHint: Long = 0L,
  val retainForBackground: Boolean = true,
  val storageScope: String = "",
  val expiresAt: Long? = null,
)

data class MinutesListState(
  val title: String = "会议记录",
  val searching: Boolean = false,
  val query: String = "",
  val mediaImporting: Boolean = false,
  val phase: MinutesContentPhase = MinutesContentPhase.READY,
  val message: String = "",
  val showingCachedData: Boolean = false,
  val mode: MinutesListMode = MinutesListMode.MEETINGS,
  val canOpenRecycleBin: Boolean = false,
  val meetings: List<MinutesMeeting> = emptyList(),
)

enum class MinutesListMode(val wireName: String) {
  MEETINGS("meetings"),
  RECYCLE_BIN("recycleBin");

  companion object {
    fun fromWireName(value: String?): MinutesListMode = entries.firstOrNull {
      it.wireName == value
    } ?: MEETINGS
  }
}

data class MinutesRecordingState(
  val meetingId: String = "",
  val title: String = "会议记录",
  val startedAtLabel: String = "",
  val location: String = "",
  val locationLoading: Boolean = false,
  val canEditLocation: Boolean = true,
  val phase: MinutesRecordingPhase = MinutesRecordingPhase.IDLE,
  val elapsedMs: Long = 0L,
  val statusLabel: String = "",
  val errorMessage: String = "",
  val canPause: Boolean = false,
  val canStop: Boolean = false,
  val canStart: Boolean = true,
  val canCreateMarker: Boolean = false,
  val followLatest: Boolean = true,
  val activeContent: MinutesRecordingContent = MinutesRecordingContent.TRANSCRIPT,
  val manualNote: String = "",
  val manualNoteLoading: Boolean = false,
  val manualNoteSaving: Boolean = false,
  val manualNoteEnabled: Boolean = false,
  val manualNoteError: String = "",
  val manualNoteRetryable: Boolean = true,
  val manualNoteConflict: Boolean = false,
  val transcript: List<MinutesTranscriptLine> = emptyList(),
)

data class MinutesDetailState(
  val meetingId: String = "",
  val available: Boolean = true,
  val title: String = "会议记录",
  val dateTimeLabel: String = "",
  val location: String = "",
  val activeTab: MinutesDetailTab = MinutesDetailTab.NOTES,
  val tabGeneration: Int = 0,
  val activeTabIsExplicit: Boolean = false,
  val contentPhase: MinutesContentPhase = MinutesContentPhase.READY,
  val contentMessage: String = "",
  val canShare: Boolean = false,
  val canManageSpeakers: Boolean = false,
  val canGenerateSummary: Boolean = false,
  val canCreateAction: Boolean = false,
  val canCreateClip: Boolean = false,
  val summaryGenerating: Boolean = false,
  val summaryActionLabel: String = "生成整理结果",
  val titleEditRequestId: Int = 0,
  val focusActionId: String = "",
  val focusActionRequestId: Long = 0L,
  val focusTranscriptSegmentId: String = "",
  val focusTranscriptPositionMs: Long = 0L,
  val focusTranscriptRequestId: Long = 0L,
  val manualNote: String = "",
  val manualNoteLoading: Boolean = false,
  val manualNoteSaving: Boolean = false,
  val manualNoteEnabled: Boolean = false,
  val manualNoteError: String = "",
  val manualNoteRetryable: Boolean = true,
  val manualNoteConflict: Boolean = false,
  val transcript: List<MinutesTranscriptLine> = emptyList(),
  val markers: List<MinutesMarker> = emptyList(),
  val summary: List<MinutesSummarySection> = emptyList(),
  val actions: List<MinutesActionItem> = emptyList(),
  val speakers: List<MinutesSpeaker> = emptyList(),
  val playerSource: MinutesPlayerSource? = null,
  val playerSources: List<MinutesPlayerSource> = emptyList(),
  val audioStatusMessage: String = "",
  val audioErrorMessage: String = "",
  val processingStatusLabel: String = "",
  val processingStatusTone: String = "neutral",
  val rootSyncConflict: Boolean = false,
  val processingRetryStage: MinutesProcessingStage? = null,
  val processingRetrying: Boolean = false,
  val recordingMergeStatusLabel: String = "",
  val recordingMergeActionLabel: String = "",
  val recordingMergeActionEnabled: Boolean = false,
  val pageStates: MinutesDetailPageStates = MinutesDetailPageStates.fromLegacy(
    activeTab = activeTab,
    contentPhase = contentPhase,
    contentMessage = contentMessage,
    transcriptHasContent = transcript.any { it.id.isNotBlank() && it.text.isNotBlank() }
      || markers.any { it.id.isNotBlank() },
    summaryHasContent = summary.any { it.id.isNotBlank() && (it.text.isNotBlank() || it.title.isNotBlank()) }
      || actions.any { it.id.isNotBlank() && it.content.isNotBlank() },
    speakersHaveContent = speakers.any { it.id.isNotBlank() && it.label.isNotBlank() },
  ),
) {
  fun pageState(tab: MinutesDetailTab): MinutesDetailPageState = pageStates[tab]

  fun selectTab(tab: MinutesDetailTab, generation: Int = tabGeneration): MinutesDetailState {
    val selectedPage = pageState(tab)
    return copy(
      activeTab = tab,
      tabGeneration = generation.coerceAtLeast(0),
      contentPhase = selectedPage.phase,
      contentMessage = selectedPage.message,
    )
  }
}

data class MinutesUiState(
  val schemaVersion: Int = MINUTES_SNAPSHOT_SCHEMA_VERSION,
  val surface: MinutesSurface = MinutesSurface.LIST,
  val list: MinutesListState = MinutesListState(),
  val recording: MinutesRecordingState = MinutesRecordingState(),
  val detail: MinutesDetailState = MinutesDetailState(),
)

sealed interface MinutesStateMutation {
  data class Replace(val state: MinutesUiState) : MinutesStateMutation
  data class SelectSurface(val surface: MinutesSurface) : MinutesStateMutation
  data class SelectDetailTab(val tab: MinutesDetailTab, val generation: Int) : MinutesStateMutation
  data class SetFollowLatest(val followLatest: Boolean) : MinutesStateMutation
}

object MinutesStateReducer {
  fun reduce(current: MinutesUiState, mutation: MinutesStateMutation): MinutesUiState {
    val next = when (mutation) {
      is MinutesStateMutation.Replace -> mergeReplace(current, mutation.state)
      is MinutesStateMutation.SelectSurface -> current.copy(surface = mutation.surface)
      is MinutesStateMutation.SelectDetailTab -> if (
        mutation.generation < current.detail.tabGeneration ||
        (mutation.generation == current.detail.tabGeneration && mutation.tab != current.detail.activeTab)
      ) {
        current
      } else {
        current.copy(detail = current.detail.selectTab(mutation.tab, mutation.generation))
      }
      is MinutesStateMutation.SetFollowLatest -> current.copy(
        recording = current.recording.copy(followLatest = mutation.followLatest),
      )
    }
    return normalize(next)
  }

  fun normalize(state: MinutesUiState): MinutesUiState {
    val pageStates = state.detail.pageStates.normalized()
    val activePage = pageStates[state.detail.activeTab]
    val selectedPlayerSource = state.detail.playerSource?.takeIf {
      it.sourceId.isNotBlank() && it.uri.isNotBlank() && it.storageScope.isNotBlank()
    }
    val playerSources = (state.detail.playerSources + listOfNotNull(selectedPlayerSource))
      .filter { it.sourceId.isNotBlank() && it.uri.isNotBlank() && it.storageScope.isNotBlank() }
      .distinctBy { it.sourceId }
      .take(20)
    return state.copy(
      schemaVersion = MINUTES_SNAPSHOT_SCHEMA_VERSION,
      list = state.list.copy(
        query = state.list.query.take(100),
        meetings = state.list.meetings.filter { it.id.isNotBlank() },
      ),
      recording = state.recording.copy(
        elapsedMs = state.recording.elapsedMs.coerceAtLeast(0L),
        transcript = state.recording.transcript.filter { it.id.isNotBlank() && it.text.isNotBlank() },
      ),
      detail = state.detail.copy(
        tabGeneration = state.detail.tabGeneration.coerceAtLeast(0),
        contentPhase = activePage.phase,
        contentMessage = activePage.message,
        transcript = state.detail.transcript.filter { it.id.isNotBlank() && it.text.isNotBlank() },
        markers = state.detail.markers
          .filter { it.id.isNotBlank() && it.positionMs >= 0L }
          .sortedWith(compareBy<MinutesMarker> { it.positionMs }.thenBy { it.id }),
        summary = state.detail.summary.filter {
          it.id.isNotBlank() && it.stableKey.isNotBlank() && (it.text.isNotBlank() || it.title.isNotBlank())
        },
        speakers = state.detail.speakers.filter { it.id.isNotBlank() && it.label.isNotBlank() },
        playerSource = selectedPlayerSource,
        playerSources = playerSources,
        pageStates = pageStates,
      ),
    )
  }

  /** MIN-DETAIL-PAGER-001: stale page responses cannot replace newer page data. */
  private fun mergeReplace(current: MinutesUiState, incoming: MinutesUiState): MinutesUiState {
    val next = normalize(incoming)
    val currentDetail = current.detail
    val nextDetail = next.detail
    if (
      currentDetail.meetingId.isBlank() ||
      nextDetail.meetingId.isBlank() ||
      currentDetail.meetingId != nextDetail.meetingId
    ) {
      return next
    }

    fun fresh(tab: MinutesDetailTab): Boolean =
      nextDetail.pageState(tab).generation >= currentDetail.pageState(tab).generation

    val transcriptFresh = fresh(MinutesDetailTab.TRANSCRIPT)
    val notesFresh = fresh(MinutesDetailTab.NOTES)
    val summaryFresh = fresh(MinutesDetailTab.SUMMARY)
    val speakersFresh = fresh(MinutesDetailTab.SPEAKERS)
    val infoFresh = fresh(MinutesDetailTab.INFO)
    val tabFresh = nextDetail.tabGeneration > currentDetail.tabGeneration ||
      (nextDetail.tabGeneration == currentDetail.tabGeneration && nextDetail.activeTab == currentDetail.activeTab)
    val pageStates = MinutesDetailPageStates(
      notes = if (notesFresh) nextDetail.pageStates.notes else currentDetail.pageStates.notes,
      transcript = if (transcriptFresh) nextDetail.pageStates.transcript else currentDetail.pageStates.transcript,
      summary = if (summaryFresh) nextDetail.pageStates.summary else currentDetail.pageStates.summary,
      speakers = if (speakersFresh) nextDetail.pageStates.speakers else currentDetail.pageStates.speakers,
      info = if (infoFresh) nextDetail.pageStates.info else currentDetail.pageStates.info,
    )
    val activeTab = if (tabFresh) nextDetail.activeTab else currentDetail.activeTab

    return next.copy(
      detail = nextDetail.copy(
        activeTab = activeTab,
        tabGeneration = if (tabFresh) nextDetail.tabGeneration else currentDetail.tabGeneration,
        manualNote = if (notesFresh) nextDetail.manualNote else currentDetail.manualNote,
        manualNoteLoading = if (notesFresh) nextDetail.manualNoteLoading else currentDetail.manualNoteLoading,
        manualNoteSaving = if (notesFresh) nextDetail.manualNoteSaving else currentDetail.manualNoteSaving,
        manualNoteEnabled = if (notesFresh) nextDetail.manualNoteEnabled else currentDetail.manualNoteEnabled,
        manualNoteError = if (notesFresh) nextDetail.manualNoteError else currentDetail.manualNoteError,
        manualNoteRetryable = if (notesFresh) nextDetail.manualNoteRetryable else currentDetail.manualNoteRetryable,
        manualNoteConflict = if (notesFresh) nextDetail.manualNoteConflict else currentDetail.manualNoteConflict,
        transcript = if (transcriptFresh) nextDetail.transcript else currentDetail.transcript,
        markers = if (transcriptFresh) nextDetail.markers else currentDetail.markers,
        summary = if (summaryFresh) nextDetail.summary else currentDetail.summary,
        speakers = if (speakersFresh) nextDetail.speakers else currentDetail.speakers,
        pageStates = pageStates,
        contentPhase = pageStates[activeTab].phase,
        contentMessage = pageStates[activeTab].message,
      ),
    )
  }
}

class MinutesStateStore(initial: MinutesUiState = MinutesUiState()) {
  var state: MinutesUiState = MinutesStateReducer.normalize(initial)
    private set

  fun dispatch(mutation: MinutesStateMutation): MinutesUiState {
    state = MinutesStateReducer.reduce(state, mutation)
    return state
  }

  fun dispatchIfAccepted(mutation: MinutesStateMutation): Boolean {
    if (mutation is MinutesStateMutation.SelectDetailTab) {
      val current = state.detail
      if (
        mutation.generation < current.tabGeneration ||
        (mutation.generation == current.tabGeneration && mutation.tab != current.activeTab)
      ) return false
    }
    dispatch(mutation)
    return true
  }
}
