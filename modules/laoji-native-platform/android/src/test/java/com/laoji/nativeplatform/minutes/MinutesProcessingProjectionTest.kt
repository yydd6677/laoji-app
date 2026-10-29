package com.laoji.nativeplatform.minutes

import com.laoji.nativeplatform.projection.ProjectionEnvelope
import org.junit.Assert.*
import org.junit.Test

class MinutesProcessingProjectionTest {
  private fun state(revision: Long, label: String, detail: MinutesDetailState = MinutesDetailState()) = MinutesUiState(
    surface = MinutesSurface.DETAIL,
    projection = ProjectionEnvelope("epoch", "meeting", revision, revision, "surface", "sha256:" + revision.toString().padStart(64, '0')),
    detail = detail.copy(meetingId = "meeting", processingStatusLabel = label),
  )

  private fun replace(current: MinutesUiState, incoming: MinutesUiState) =
    MinutesStateReducer.reduce(current, MinutesStateMutation.Replace(incoming))

  @Test fun unvisitedTranscriptLoadingDoesNotFreezeCanonicalUploadStatus() {
    val waiting = state(1, "等待上传录音")
    val processing = state(2, "正在生成文字记录", waiting.detail.copy(
      pageStates = waiting.detail.pageStates.copy(transcript = MinutesDetailPageState(MinutesContentPhase.LOADING)),
    ))
    val next = replace(waiting, processing)
    assertEquals("正在生成文字记录", next.detail.processingStatusLabel)
    // Page-local stale loading protection is still independent and intact.
    assertEquals(waiting.detail.pageStates.transcript, next.detail.pageStates.transcript)
    assertEquals(MinutesDetailTab.NOTES, next.detail.activeTab)
  }

  @Test fun staleInactiveSummaryPageCannotBlockCurrentTranscriptStatusOrCompletion() {
    val waiting = state(1, "等待上传录音", MinutesDetailState(
      pageStates = MinutesDetailPageStates(summary = MinutesDetailPageState(MinutesContentPhase.ERROR, generation = 8)),
    ))
    val processing = state(2, "正在生成文字记录", MinutesDetailState(
      processingStatusTone = "processing",
      pageStates = MinutesDetailPageStates(summary = MinutesDetailPageState(MinutesContentPhase.LOADING, generation = 7)),
    ))
    val next = replace(waiting, processing)
    assertEquals("正在生成文字记录", next.detail.processingStatusLabel)
    assertEquals("processing", next.detail.processingStatusTone)
    assertEquals(8, next.detail.pageStates.summary.generation)
    assertEquals("", replace(next, state(3, "")).detail.processingStatusLabel)
  }

  @Test fun newerTaskRetryStateDoesNotDependOnPageContentGeneration() {
    val current = state(2, "正在生成文字记录", MinutesDetailState(
      pageStates = MinutesDetailPageStates(transcript = MinutesDetailPageState(generation = 9)),
      transcript = listOf(MinutesTranscriptLine("saved", text = "已有可用文字")),
    ))
    val incoming = state(3, "转写失败，可重试", MinutesDetailState(
      processingRetryStage = MinutesProcessingStage.TRANSCRIPT,
      processingStatusTone = "error",
      processingRetrying = true,
    ))
    val next = replace(current, incoming)
    assertEquals(incoming.detail.processingStatusLabel, next.detail.processingStatusLabel)
    assertEquals(MinutesProcessingStage.TRANSCRIPT, next.detail.processingRetryStage)
    assertTrue(next.detail.processingRetrying)
    assertEquals(current.detail.transcript, next.detail.transcript)
  }

  @Test fun staleWholeProjectionCannotResurrectAnObsoleteTaskStatus() {
    val complete = state(5, "")
    for (stale in listOf(state(4, "等待上传录音"), state(4, "正在整理会议记录"))) {
      assertSame(complete, replace(complete, stale))
    }
    assertSame(complete, replace(complete, state(6, "等待上传录音").copy(projectionInvalid = true)))
  }
}
