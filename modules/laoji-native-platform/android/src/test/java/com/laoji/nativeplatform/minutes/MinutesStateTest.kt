package com.laoji.nativeplatform.minutes

// MIN-DETAIL-PAGER-001 / MIN-DETAIL-STICKY-001: per-page detail state contract regressions.

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MinutesStateTest {
  @Test
  fun `MIN-REC-STATE-001 normalizes elapsed time and transcript snapshots`() {
    val state = MinutesStateReducer.normalize(
      MinutesUiState(
        recording = MinutesRecordingState(
          elapsedMs = -1,
          transcript = listOf(
            MinutesTranscriptLine("valid", text = "内容"),
            MinutesTranscriptLine("", text = "丢弃"),
          ),
        ),
      ),
    )
    assertEquals(0L, state.recording.elapsedMs)
    assertEquals(listOf("valid"), state.recording.transcript.map { it.id })
  }

  @Test
  fun `MIN-PLAYER-001 rejects an empty player source`() {
    val state = MinutesStateReducer.normalize(
      MinutesUiState(
        detail = MinutesDetailState(
          playerSource = MinutesPlayerSource(sourceId = "", uri = "https://example.com/audio.wav"),
        ),
      ),
    )
    assertNull(state.detail.playerSource)
  }

  @Test
  fun `MIN-SEARCH-001 bounds the native search query`() {
    val state = MinutesStateReducer.normalize(
      MinutesUiState(list = MinutesListState(searching = true, query = "会".repeat(120))),
    )
    assertEquals(100, state.list.query.length)
  }

  @Test
  fun `MIN-SUMMARY-001 preserves guest summary capability in the detail state`() {
    val state = MinutesStateReducer.normalize(
      MinutesUiState(detail = MinutesDetailState(canGenerateSummary = true, summaryActionLabel = "生成总结")),
    )
    assertEquals(true, state.detail.canGenerateSummary)
    assertEquals("生成总结", state.detail.summaryActionLabel)
  }

  @Test
  fun `MIN-DETAIL-STATE-001 parses unavailable detail records without enabling actions`() {
    val state = MinutesSnapshotParser.parse(
      mapOf(
        "surface" to "detail",
        "detail" to mapOf(
          "meetingId" to "missing",
          "available" to false,
          "title" to "会议记录不存在",
          "canShare" to true,
        ),
      ),
    )
    assertEquals(false, state.detail.available)
    assertEquals(true, state.detail.canShare)
  }

  @Test
  fun `MIN-DETAIL-PAGER-001 parses three independent page states`() {
    val state = MinutesSnapshotParser.parse(
      mapOf(
        "surface" to "detail",
        "detail" to mapOf(
          "activeTab" to "summary",
          "tabGeneration" to 7,
          "activeTabIsExplicit" to true,
          "audioStatusMessage" to "仅有转写，无录音文件",
          "audioErrorMessage" to "录音同步失败",
          "contentPhase" to "error",
          "contentMessage" to "legacy value",
          "pageStates" to mapOf(
            "transcript" to mapOf(
              "phase" to "error",
              "message" to "文字记录失败",
              "generation" to 11,
              "cached" to true,
            ),
            "summary" to mapOf(
              "phase" to "loading",
              "message" to "正在生成纪要",
              "generation" to 12,
            ),
            "speakers" to mapOf(
              "phase" to "empty",
              "message" to "暂无发言人",
              "generation" to 13,
            ),
          ),
        ),
      ),
    )

    assertEquals(MinutesDetailPageState(MinutesContentPhase.ERROR, "文字记录失败", 11, true), state.detail.pageStates.transcript)
    assertEquals(MinutesDetailPageState(MinutesContentPhase.LOADING, "正在生成纪要", 12), state.detail.pageStates.summary)
    assertEquals(MinutesDetailPageState(MinutesContentPhase.EMPTY, "暂无发言人", 13), state.detail.pageStates.speakers)
    assertEquals(MinutesContentPhase.LOADING, state.detail.contentPhase)
    assertEquals("正在生成纪要", state.detail.contentMessage)
    assertEquals(7, state.detail.tabGeneration)
    assertEquals(true, state.detail.activeTabIsExplicit)
    assertEquals("仅有转写，无录音文件", state.detail.audioStatusMessage)
    assertEquals("录音同步失败", state.detail.audioErrorMessage)
  }

  @Test
  fun `MIN-DETAIL-PAGER-001 migrates a legacy active-page snapshot deterministically`() {
    val state = MinutesSnapshotParser.parse(
      mapOf(
        "surface" to "detail",
        "detail" to mapOf(
          "activeTab" to "summary",
          "contentPhase" to "error",
          "contentMessage" to "纪要同步失败",
          "transcript" to listOf(mapOf("id" to "line-1", "text" to "保留的文字记录")),
          "summary" to emptyList<Map<String, Any?>>(),
          "speakers" to emptyList<Map<String, Any?>>(),
        ),
      ),
    )

    assertEquals(MinutesDetailPageState(), state.detail.pageStates.transcript)
    assertEquals(
      MinutesDetailPageState(MinutesContentPhase.ERROR, "纪要同步失败", 0),
      state.detail.pageStates.summary,
    )
    assertEquals(
      MinutesDetailPageState(MinutesContentPhase.EMPTY, "暂无发言人信息", 0),
      state.detail.pageStates.speakers,
    )
  }

  @Test
  fun `MIN-DETAIL-STICKY-001 selecting a tab preserves every page state`() {
    val pageStates = MinutesDetailPageStates(
      transcript = MinutesDetailPageState(MinutesContentPhase.ERROR, "文字记录失败", 21),
      summary = MinutesDetailPageState(MinutesContentPhase.LOADING, "正在生成纪要", 22),
      speakers = MinutesDetailPageState(MinutesContentPhase.EMPTY, "暂无发言人", 23),
    )
    val initial = MinutesUiState(
      surface = MinutesSurface.DETAIL,
      detail = MinutesDetailState(
        activeTab = MinutesDetailTab.TRANSCRIPT,
        contentPhase = MinutesContentPhase.ERROR,
        contentMessage = "文字记录失败",
        pageStates = pageStates,
      ),
    )

    val summary = MinutesStateReducer.reduce(initial, MinutesStateMutation.SelectDetailTab(MinutesDetailTab.SUMMARY, 1))
    val speakers = MinutesStateReducer.reduce(summary, MinutesStateMutation.SelectDetailTab(MinutesDetailTab.SPEAKERS, 2))

    assertEquals(pageStates, summary.detail.pageStates)
    assertEquals(MinutesContentPhase.LOADING, summary.detail.contentPhase)
    assertEquals("正在生成纪要", summary.detail.contentMessage)
    assertEquals(pageStates, speakers.detail.pageStates)
    assertEquals(MinutesContentPhase.EMPTY, speakers.detail.contentPhase)
    assertEquals("暂无发言人", speakers.detail.contentMessage)
  }

  @Test
  fun `MIN-DETAIL-PAGER-001 degrades unknown page values safely`() {
    val state = MinutesSnapshotParser.parse(
      mapOf(
        "surface" to "detail",
        "detail" to mapOf(
          "activeTab" to "chapters",
          "pageStates" to mapOf(
            "transcript" to mapOf(
              "phase" to "stale",
              "message" to 7,
              "generation" to -4,
            ),
            "summary" to mapOf(
              "phase" to "error",
              "message" to "纪要失败",
              "generation" to Double.NaN,
            ),
            "speakers" to mapOf(
              "phase" to "loading",
              "message" to "正在同步发言人",
              "generation" to Long.MAX_VALUE,
            ),
          ),
        ),
      ),
    )

    assertEquals(MinutesDetailTab.TRANSCRIPT, state.detail.activeTab)
    assertEquals(MinutesDetailPageState(), state.detail.pageStates.transcript)
    assertEquals(
      MinutesDetailPageState(MinutesContentPhase.ERROR, "纪要失败", 0),
      state.detail.pageStates.summary,
    )
    assertEquals(
      MinutesDetailPageState(MinutesContentPhase.LOADING, "正在同步发言人", Int.MAX_VALUE),
      state.detail.pageStates.speakers,
    )
    assertEquals(MinutesContentPhase.READY, state.detail.contentPhase)
    assertEquals("", state.detail.contentMessage)
  }

  @Test
  fun `MIN-DETAIL-PAGER-001 rejects stale page generations without discarding fresh siblings`() {
    val current = MinutesUiState(
      surface = MinutesSurface.DETAIL,
      detail = MinutesDetailState(
        meetingId = "meeting-1",
        activeTab = MinutesDetailTab.SUMMARY,
        tabGeneration = 8,
        transcript = listOf(MinutesTranscriptLine("new-transcript", text = "新转写")),
        summary = listOf(MinutesSummaryBlock("old-summary", text = "旧纪要")),
        speakers = listOf(MinutesSpeaker("old-speaker", "旧发言人")),
        pageStates = MinutesDetailPageStates(
          transcript = MinutesDetailPageState(MinutesContentPhase.READY, generation = 12),
          summary = MinutesDetailPageState(MinutesContentPhase.ERROR, "旧纪要失败", 4, cached = true),
          speakers = MinutesDetailPageState(MinutesContentPhase.READY, generation = 5),
        ),
      ),
    )
    val incoming = current.copy(
      detail = current.detail.copy(
        activeTab = MinutesDetailTab.TRANSCRIPT,
        tabGeneration = 7,
        transcript = listOf(MinutesTranscriptLine("stale-transcript", text = "过期转写")),
        summary = listOf(MinutesSummaryBlock("new-summary", text = "新纪要")),
        speakers = listOf(MinutesSpeaker("new-speaker", "新发言人")),
        pageStates = MinutesDetailPageStates(
          transcript = MinutesDetailPageState(MinutesContentPhase.ERROR, "过期失败", 11),
          summary = MinutesDetailPageState(MinutesContentPhase.READY, generation = 6),
          speakers = MinutesDetailPageState(MinutesContentPhase.READY, generation = 6),
        ),
      ),
    )

    val reduced = MinutesStateReducer.reduce(current, MinutesStateMutation.Replace(incoming))

    assertEquals(listOf("new-transcript"), reduced.detail.transcript.map { it.id })
    assertEquals(12, reduced.detail.pageStates.transcript.generation)
    assertEquals(listOf("new-summary"), reduced.detail.summary.map { it.id })
    assertEquals(listOf("new-speaker"), reduced.detail.speakers.map { it.id })
    assertEquals(MinutesDetailTab.SUMMARY, reduced.detail.activeTab)
    assertEquals(8, reduced.detail.tabGeneration)
    assertEquals(MinutesContentPhase.READY, reduced.detail.contentPhase)
  }

  @Test
  fun `MIN-DETAIL-PAGER-001 accepts lower generations for a different meeting`() {
    val current = MinutesUiState(
      detail = MinutesDetailState(
        meetingId = "meeting-1",
        transcript = listOf(MinutesTranscriptLine("old", text = "旧会议")),
        pageStates = MinutesDetailPageStates(
          transcript = MinutesDetailPageState(generation = 99),
        ),
      ),
    )
    val incoming = MinutesUiState(
      detail = MinutesDetailState(
        meetingId = "meeting-2",
        transcript = listOf(MinutesTranscriptLine("new", text = "新会议")),
        pageStates = MinutesDetailPageStates(
          transcript = MinutesDetailPageState(generation = 1),
        ),
      ),
    )

    val reduced = MinutesStateReducer.reduce(current, MinutesStateMutation.Replace(incoming))

    assertEquals("meeting-2", reduced.detail.meetingId)
    assertEquals(listOf("new"), reduced.detail.transcript.map { it.id })
  }

  @Test
  fun `MIN-DETAIL-PAGER-001 rejects a different tab target at the same generation`() {
    val current = MinutesUiState(
      detail = MinutesDetailState(
        meetingId = "meeting-1",
        activeTab = MinutesDetailTab.SUMMARY,
        tabGeneration = 5,
      ),
    )

    val replaced = MinutesStateReducer.reduce(
      current,
      MinutesStateMutation.Replace(
        current.copy(detail = current.detail.copy(activeTab = MinutesDetailTab.TRANSCRIPT)),
      ),
    )
    val selected = MinutesStateReducer.reduce(
      current,
      MinutesStateMutation.SelectDetailTab(MinutesDetailTab.SPEAKERS, 5),
    )

    assertEquals(MinutesDetailTab.SUMMARY, replaced.detail.activeTab)
    assertEquals(MinutesDetailTab.SUMMARY, selected.detail.activeTab)
  }

  @Test
  fun `MIN-DETAIL-PAGER-001 only forwards reducer-accepted tab actions`() {
    val store = MinutesStateStore(
      MinutesUiState(
        detail = MinutesDetailState(
          meetingId = "meeting-1",
          activeTab = MinutesDetailTab.SUMMARY,
          tabGeneration = 9,
        ),
      ),
    )

    assertEquals(
      false,
      store.dispatchIfAccepted(MinutesStateMutation.SelectDetailTab(MinutesDetailTab.TRANSCRIPT, 8)),
    )
    assertEquals(
      false,
      store.dispatchIfAccepted(MinutesStateMutation.SelectDetailTab(MinutesDetailTab.SPEAKERS, 9)),
    )
    assertEquals(
      true,
      store.dispatchIfAccepted(MinutesStateMutation.SelectDetailTab(MinutesDetailTab.SPEAKERS, 10)),
    )
    assertEquals(MinutesDetailTab.SPEAKERS, store.state.detail.activeTab)
    assertEquals(10, store.state.detail.tabGeneration)
  }
}
