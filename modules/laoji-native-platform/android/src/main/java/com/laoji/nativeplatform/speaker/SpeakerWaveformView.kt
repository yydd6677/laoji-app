package com.laoji.nativeplatform.speaker

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.View
import kotlin.math.max

// MIN-SPEAKER-001: this is a level visualization only; no PCM bytes cross JS.
internal class SpeakerWaveformView(context: Context) : View(context) {
  private val paletteReady = SpeakerPalette.configure(context)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private var level = 0f

  init {
    setLayerType(View.LAYER_TYPE_SOFTWARE, null)
    contentDescription = "声纹录制音量"
    minimumHeight = context.speakerDp(10)
  }

  fun setLevel(value: Float) {
    val normalized = value.coerceIn(0f, 1f)
    if (normalized == level) return
    level = normalized
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val count = 24
    val gap = context.speakerDp(3).toFloat()
    val barWidth = max(1f, (width - gap * (count - 1)) / count)
    val center = height / 2f
    for (index in 0 until count) {
      val progress = (index + 1).toFloat() / count
      val active = progress <= (level * 1.05f + 0.02f)
      val envelope = 0.25f + 0.75f * (1f - kotlin.math.abs(centerIndex(index, count)))
      val barHeight = max(context.speakerDp(4).toFloat(), height * envelope * (if (active) 0.9f else 0.35f))
      val left = index * (barWidth + gap)
      paint.color = if (active) SpeakerPalette.primary else SpeakerPalette.divider
      canvas.drawRoundRect(left, center - barHeight / 2f, left + barWidth, center + barHeight / 2f, gap, gap, paint)
    }
  }

  private fun centerIndex(index: Int, count: Int): Float =
    1f - kotlin.math.abs((index - (count - 1) / 2f) / ((count - 1) / 2f))
}
