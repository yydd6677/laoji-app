package com.laoji.nativeplatform.calendar

// CAL-RULER-001: derived from DayTimeRulerView.java. The source uses a 56dp
// ruler owner, 12sp centered labels, and font metrics for the baseline.

internal object DayRulerContract {
  const val TEXT_SIZE_SP = 12f
  const val TEXT_COLOR_LIGHT = 0xFF8F959E.toInt()
  const val TEXT_COLOR_DARK = 0xFF757575.toInt()

  fun labelCenterX(rulerWidth: Float): Float = rulerWidth / 2f

  fun centeredBaseline(centerY: Float, ascent: Float, descent: Float): Float =
    centerY - (ascent + descent) / 2f
}
