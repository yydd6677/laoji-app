package com.laoji.nativeplatform.media

// MIN-PLAYER-001 / MIN-DETAIL-001: sticky player geometry emits no per-frame JS events.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.SeekBar
import android.widget.TextView
import com.laoji.nativeplatform.minutes.MinutesPalette
import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import com.laoji.nativeplatform.minutes.backgroundShape
import com.laoji.nativeplatform.minutes.dp
import com.laoji.nativeplatform.minutes.formatClock
import com.laoji.nativeplatform.minutes.iconButton
import com.laoji.nativeplatform.minutes.textView

class MinutesPlayerView(
  context: Context,
  private val onStateChanged: (MinutesPlaybackState) -> Unit,
) : LinearLayout(context) {
  private val controller = MinutesPlaybackRegistry.controller(context)
  private val seekArea = FrameLayout(context)
  private val position = context.textView(textSizeSp = 12, color = MinutesPalette.secondary)
  private val duration = context.textView(textSizeSp = 12, color = MinutesPalette.secondary)
  private val seekBar = SeekBar(context)
  private val controls = FrameLayout(context)
  private val speed = context.textView("1x", 14, MinutesPalette.text, Typeface.BOLD)
  private val rewind = context.iconButton(android.R.drawable.ic_media_rew, "后退 15 秒")
  private val playPause = context.iconButton(android.R.drawable.ic_media_play, "播放会议录音")
  private val forward = context.iconButton(android.R.drawable.ic_media_ff, "前进 15 秒")
  private val error = context.textView(textSizeSp = 13, color = MinutesPalette.danger)
  private var latestState = MinutesPlaybackState()
  private var trackingSeek = false
  private var attached = false

  private val listener = MinutesPlaybackListener { state ->
    post {
      latestState = state
      render(state)
      onStateChanged(state)
    }
  }

  init {
    orientation = VERTICAL
    setBackgroundColor(MinutesPalette.surface)
    elevation = context.dp(3).toFloat()
    addView(seekArea, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(44)))
    addView(controls, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(56)))

    position.gravity = Gravity.START or Gravity.CENTER_VERTICAL
    duration.gravity = Gravity.END or Gravity.CENTER_VERTICAL
    seekArea.addView(
      position,
      FrameLayout.LayoutParams(context.dp(58), context.dp(20), Gravity.START or Gravity.TOP).apply {
        leftMargin = context.dp(20)
        topMargin = context.dp(3)
      },
    )
    seekArea.addView(
      duration,
      FrameLayout.LayoutParams(context.dp(58), context.dp(20), Gravity.END or Gravity.TOP).apply {
        rightMargin = context.dp(20)
        topMargin = context.dp(3)
      },
    )
    seekBar.max = SEEK_RANGE
    seekBar.progressTintList = ColorStateList.valueOf(MinutesPalette.primary)
    seekBar.thumbTintList = ColorStateList.valueOf(MinutesPalette.primary)
    seekBar.contentDescription = "录音播放进度"
    seekBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
      override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) {
        if (fromUser && latestState.durationMs > 0L) {
          position.text = formatClock(latestState.durationMs * progress / SEEK_RANGE)
        }
      }

      override fun onStartTrackingTouch(seekBar: SeekBar) {
        trackingSeek = true
      }

      override fun onStopTrackingTouch(seekBar: SeekBar) {
        trackingSeek = false
        if (latestState.durationMs > 0L) {
          controller.seekTo(latestState.durationMs * seekBar.progress / SEEK_RANGE)
        }
      }
    })
    seekArea.addView(
      seekBar,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(32), Gravity.BOTTOM).apply {
        leftMargin = context.dp(12)
        rightMargin = context.dp(12)
      },
    )

    speed.gravity = Gravity.CENTER
    speed.isClickable = true
    speed.isFocusable = true
    speed.contentDescription = "选择播放速度"
    speed.setOnClickListener { showSpeedMenu() }
    controls.addView(
      speed,
      FrameLayout.LayoutParams(context.dp(48), context.dp(44), Gravity.START or Gravity.CENTER_VERTICAL).apply {
        leftMargin = context.dp(8)
      },
    )
    rewind.setOnClickListener { controller.seekBy(-MINUTES_SKIP_INTERVAL_MS) }
    controls.addView(
      rewind,
      FrameLayout.LayoutParams(context.dp(44), context.dp(44), Gravity.CENTER_VERTICAL).apply {
        leftMargin = context.dp(64)
      },
    )
    playPause.backgroundShape(MinutesPalette.primary, radiusDp = 24)
    playPause.imageTintList = ColorStateList.valueOf(android.graphics.Color.WHITE)
    playPause.setOnClickListener { controller.toggle() }
    controls.addView(
      playPause,
      FrameLayout.LayoutParams(context.dp(80), context.dp(48), Gravity.CENTER),
    )
    forward.setOnClickListener { controller.seekBy(MINUTES_SKIP_INTERVAL_MS) }
    controls.addView(
      forward,
      FrameLayout.LayoutParams(context.dp(44), context.dp(44), Gravity.END or Gravity.CENTER_VERTICAL).apply {
        rightMargin = context.dp(64)
      },
    )
    error.maxLines = 2
    error.setBackgroundColor(MinutesPalette.surface)
    error.setPadding(context.dp(16), 0, context.dp(16), 0)
    error.gravity = Gravity.CENTER
    error.isClickable = true
    error.isFocusable = true
    error.contentDescription = "录音播放失败，点击重试"
    error.setOnClickListener { controller.play() }
    controls.addView(error, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(56)))
    render(controller.state)
  }

  fun setSource(source: MinutesPlayerSource?) {
    controller.setSource(source)
    visibility = if (source == null) View.GONE else View.VISIBLE
  }

  fun seekTo(positionMs: Long) {
    controller.seekTo(positionMs)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (attached) return
    attached = true
    MinutesPlaybackRegistry.attachSurface()
    controller.addListener(listener)
  }

  override fun onDetachedFromWindow() {
    if (attached) {
      attached = false
      controller.removeListener(listener)
      MinutesPlaybackRegistry.detachSurface()
    }
    super.onDetachedFromWindow()
  }

  private fun render(state: MinutesPlaybackState) {
    position.text = formatClock(state.positionMs)
    duration.text = formatClock(state.durationMs)
    if (!trackingSeek) {
      seekBar.progress = if (state.durationMs > 0L) {
        ((state.positionMs.coerceIn(0L, state.durationMs) * SEEK_RANGE) / state.durationMs).toInt()
      } else {
        0
      }
    }
    seekBar.secondaryProgress = if (state.durationMs > 0L) {
      ((state.bufferedPositionMs.coerceIn(0L, state.durationMs) * SEEK_RANGE) / state.durationMs).toInt()
    } else {
      0
    }
    speed.text = "${rateLabel(state.rate)}x"
    playPause.setImageResource(
      if (state.isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
    )
    playPause.contentDescription = if (state.isPlaying) "暂停会议录音" else "播放会议录音"
    val enabled = state.sourceId != null && state.phase != MinutesPlaybackPhase.PREPARING
    listOf(speed, rewind, playPause, forward, seekBar).forEach {
      it.isEnabled = enabled
      it.alpha = if (enabled) 1f else 0.35f
    }
    error.text = state.errorMessage.orEmpty()
    error.visibility = if (state.phase == MinutesPlaybackPhase.FAILED) View.VISIBLE else View.GONE
  }

  private fun showSpeedMenu() {
    PopupMenu(context, speed).apply {
      MINUTES_PLAYBACK_RATES.forEachIndexed { index, rate ->
        menu.add(0, index, index, "${rateLabel(rate)}x").isCheckable = true
      }
      menu.findItem(MINUTES_PLAYBACK_RATES.indexOfFirst { it == latestState.rate }.coerceAtLeast(0))?.isChecked = true
      setOnMenuItemClickListener { item ->
        MINUTES_PLAYBACK_RATES.getOrNull(item.itemId)?.let(controller::setRate)
        true
      }
      show()
    }
  }

  private fun rateLabel(rate: Float): String = if (rate % 1f == 0f) rate.toInt().toString() else rate.toString()

  companion object {
    private const val SEEK_RANGE = 1_000
  }
}
