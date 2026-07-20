package com.laoji.nativeplatform.minutes

import android.app.Activity
import android.os.Bundle
import android.widget.FrameLayout

class MinutesSurfaceTestActivity : Activity() {
  lateinit var root: FrameLayout
    private set
  internal var detailSurface: MinutesDetailSurface? = null
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    root = FrameLayout(this)
    setContentView(root)
    if (intent.getBooleanExtra(EXTRA_AUTO_DETAIL, false)) {
      val meetingId = intent.getStringExtra(EXTRA_MEETING_ID).orEmpty().ifBlank { "recreate-meeting" }
      detailSurface = MinutesDetailSurface(this, {}, {}).also { surface ->
        surface.render(recreateDetailState(meetingId))
        root.addView(
          surface,
          FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT),
        )
      }
    }
  }

  private fun recreateDetailState(meetingId: String) = MinutesDetailState(
    meetingId = meetingId,
    title = "重建恢复测试",
    transcript = List(80) { index ->
      MinutesTranscriptLine(
        id = "line-$index",
        text = "第 $index 条重建恢复测试文字记录",
        startMs = index * 1_000L,
      )
    },
    summary = List(60) { index -> MinutesSummaryBlock("summary-$index", "bullet", "第 $index 条纪要") },
    speakers = List(30) { index -> MinutesSpeaker("speaker-$index", "发言人 $index") },
    pageStates = MinutesDetailPageStates(
      transcript = MinutesDetailPageState(generation = 1),
      summary = MinutesDetailPageState(generation = 1),
      speakers = MinutesDetailPageState(generation = 1),
    ),
    audioStatusMessage = "仅有转写，无录音文件",
  )

  companion object {
    const val EXTRA_AUTO_DETAIL = "autoDetail"
    const val EXTRA_MEETING_ID = "meetingId"
  }
}
