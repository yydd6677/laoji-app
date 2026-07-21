package com.laoji.nativeplatform.minutes

// MIN-REC-STATE-001 / MIN-DETAIL-001 / MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001:
// normalized source-mapped Minutes state contracts.

const val MINUTES_SNAPSHOT_SCHEMA_VERSION = 1

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
  TRANSCRIPT("transcript", "文字记录"),
  SUMMARY("summary", "纪要"),
  SPEAKERS("speakers", "发言人"),
  INFO("info", "录音信息");

  companion object {
    fun fromWireName(value: String?): MinutesDetailTab =
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
  val transcript: MinutesDetailPageState = MinutesDetailPageState(),
  val summary: MinutesDetailPageState = MinutesDetailPageState(),
  val speakers: MinutesDetailPageState = MinutesDetailPageState(),
  val info: MinutesDetailPageState = MinutesDetailPageState(),
) {
  operator fun get(tab: MinutesDetailTab): MinutesDetailPageState = when (tab) {
    MinutesDetailTab.TRANSCRIPT -> transcript
    MinutesDetailTab.SUMMARY -> summary
    MinutesDetailTab.SPEAKERS -> speakers
    MinutesDetailTab.INFO -> info
  }

  fun normalized(): MinutesDetailPageStates = copy(
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
        transcript = contentBackedState(transcriptHasContent, "暂无文字记录"),
        summary = contentBackedState(summaryHasContent, "该会议暂未生成纪要"),
        speakers = contentBackedState(speakersHaveContent, "暂无发言人信息"),
        info = MinutesDetailPageState(),
      )
      val activeState = MinutesDetailPageState(contentPhase, contentMessage)
      return when (activeTab) {
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
  val title: String,
  val dateTimeLabel: String,
  val durationLabel: String = "",
  val statusLabel: String = "",
  val statusTone: String = "neutral",
  val canResume: Boolean = false,
  val coverType: MinutesListCoverType = MinutesListCoverType.DEFAULT,
  val coverTitle: String = "",
  val coverText: String = "",
)

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
  val speakerId: String = "",
  val speakerLabel: String = "发言人",
  val timestampLabel: String = "00:00",
  val startMs: Long = 0L,
  val endMs: Long = startMs,
  val text: String,
  val isFinal: Boolean = true,
)

data class MinutesSummaryBlock(
  val id: String,
  val kind: String = "paragraph",
  val text: String,
  val checked: Boolean = false,
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
  val phase: MinutesContentPhase = MinutesContentPhase.READY,
  val message: String = "",
  val showingCachedData: Boolean = false,
  val meetings: List<MinutesMeeting> = emptyList(),
)

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
  val followLatest: Boolean = true,
  val transcript: List<MinutesTranscriptLine> = emptyList(),
)

data class MinutesDetailState(
  val meetingId: String = "",
  val available: Boolean = true,
  val title: String = "会议记录",
  val dateTimeLabel: String = "",
  val location: String = "",
  val activeTab: MinutesDetailTab = MinutesDetailTab.TRANSCRIPT,
  val tabGeneration: Int = 0,
  val activeTabIsExplicit: Boolean = false,
  val contentPhase: MinutesContentPhase = MinutesContentPhase.READY,
  val contentMessage: String = "",
  val canShare: Boolean = false,
  val canManageSpeakers: Boolean = false,
  val canGenerateSummary: Boolean = false,
  val summaryGenerating: Boolean = false,
  val summaryActionLabel: String = "生成总结",
  val titleEditRequestId: Int = 0,
  val transcript: List<MinutesTranscriptLine> = emptyList(),
  val summary: List<MinutesSummaryBlock> = emptyList(),
  val speakers: List<MinutesSpeaker> = emptyList(),
  val playerSource: MinutesPlayerSource? = null,
  val audioStatusMessage: String = "",
  val audioErrorMessage: String = "",
  val pageStates: MinutesDetailPageStates = MinutesDetailPageStates.fromLegacy(
    activeTab = activeTab,
    contentPhase = contentPhase,
    contentMessage = contentMessage,
    transcriptHasContent = transcript.any { it.id.isNotBlank() && it.text.isNotBlank() },
    summaryHasContent = summary.any { it.id.isNotBlank() && it.text.isNotBlank() },
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
        summary = state.detail.summary.filter { it.id.isNotBlank() && it.text.isNotBlank() },
        speakers = state.detail.speakers.filter { it.id.isNotBlank() && it.label.isNotBlank() },
        playerSource = state.detail.playerSource?.takeIf {
          it.sourceId.isNotBlank() && it.uri.isNotBlank() && it.storageScope.isNotBlank()
        },
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
    val summaryFresh = fresh(MinutesDetailTab.SUMMARY)
    val speakersFresh = fresh(MinutesDetailTab.SPEAKERS)
    val infoFresh = fresh(MinutesDetailTab.INFO)
    val tabFresh = nextDetail.tabGeneration > currentDetail.tabGeneration ||
      (nextDetail.tabGeneration == currentDetail.tabGeneration && nextDetail.activeTab == currentDetail.activeTab)
    val pageStates = MinutesDetailPageStates(
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
        transcript = if (transcriptFresh) nextDetail.transcript else currentDetail.transcript,
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
