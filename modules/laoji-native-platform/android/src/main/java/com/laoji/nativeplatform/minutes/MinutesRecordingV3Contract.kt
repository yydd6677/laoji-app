package com.laoji.nativeplatform.minutes

// MIN-REC-LAYOUT-001: dimensions and responsive widths derived from Record V3.

internal object MinutesRecordingV3Contract {
  const val TOP_BAR_HEIGHT_DP = 44
  const val TITLE_MIN_HEIGHT_DP = 136
  const val TAB_HEIGHT_DP = 44
  // mm_layout_record_toolbar_bar_3_new.xml: centered duration, 32dp waveform,
  // then the operation row. The retained two actions are packed in the same
  // bottom hierarchy after omitting Feishu capabilities LaoJi does not provide.
  const val BOTTOM_PANEL_HEIGHT_DP = 144
  const val DURATION_HEIGHT_DP = 32
  const val WAVE_CONTAINER_HEIGHT_DP = 44
  const val WAVE_HEIGHT_DP = 32
  const val ACTION_ROW_HEIGHT_DP = 68
  const val PAUSE_WIDTH_DP = 78
  const val PAUSE_HEIGHT_DP = 56
  const val STOP_WIDTH_DP = 78
  const val STOP_HEIGHT_DP = 56
  const val ACTION_GAP_DP = 12
}
