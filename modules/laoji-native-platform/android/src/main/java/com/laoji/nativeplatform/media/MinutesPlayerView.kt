package com.laoji.nativeplatform.media

// MIN-PLAYER-001 / MIN-DETAIL-001: sticky player geometry emits no per-frame JS events.

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.SeekBar
import android.widget.TextView
import androidx.constraintlayout.widget.ConstraintLayout
import com.laoji.nativeplatform.minutes.MinutesPalette
import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import com.laoji.nativeplatform.minutes.backgroundHorizontalGradient
import com.laoji.nativeplatform.minutes.dp
import com.laoji.nativeplatform.minutes.formatClock
import com.laoji.nativeplatform.minutes.iconButton
import com.laoji.nativeplatform.minutes.textView

class MinutesPlayerView(
  context: Context,
  private val onStateChanged: (MinutesPlaybackState) -> Unit,
) : FrameLayout(context) {
  private val controller = MinutesPlaybackRegistry.controller(context)
  private val speedSheet = MinutesPlaybackSpeedSheet(context)
  private val content = ConstraintLayout(context).apply { id = View.generateViewId() }
  private val seekArea = ConstraintLayout(context).apply { id = View.generateViewId() }
  private val position = context.textView(textSizeSp = 12, color = MinutesPalette.faint)
  private val duration = context.textView(textSizeSp = 12, color = MinutesPalette.faint)
  private val seekBar = SeekBar(context)
  private val controls = ConstraintLayout(context).apply { id = View.generateViewId() }
  private val speed = context.textView("1x", 16, MinutesPalette.text)
  private val rewind = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_back_15s,
    "后退 15 秒",
  )
  private val playPause = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_play_filled,
    "播放会议录音",
  )
  private val forward = context.iconButton(
    com.laoji.nativeplatform.R.drawable.laoji_ic_forward_15s,
    "前进 15 秒",
  )
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
    setBackgroundColor(MinutesPalette.surface)
    content.setBackgroundColor(MinutesPalette.surface)
    addView(
      content,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    content.addView(
      seekArea,
      ConstraintLayout.LayoutParams(0, context.dp(45)).apply {
        topToTop = ConstraintLayout.LayoutParams.PARENT_ID
        startToStart = ConstraintLayout.LayoutParams.PARENT_ID
        endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
        topMargin = context.dp(4)
      },
    )
    content.addView(
      controls,
      ConstraintLayout.LayoutParams(0, context.dp(48)).apply {
        topToBottom = seekArea.id
        startToStart = ConstraintLayout.LayoutParams.PARENT_ID
        endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
        bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
        topMargin = context.dp(8)
        bottomMargin = context.dp(32)
      },
    )

    position.id = View.generateViewId()
    position.includeFontPadding = true
    position.gravity = Gravity.START or Gravity.CENTER_VERTICAL
    duration.id = View.generateViewId()
    duration.includeFontPadding = true
    duration.gravity = Gravity.END or Gravity.CENTER_VERTICAL
    seekArea.addView(
      position,
      ConstraintLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
        startToStart = ConstraintLayout.LayoutParams.PARENT_ID
        leftMargin = context.dp(20)
      },
    )
    seekArea.addView(
      duration,
      ConstraintLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
        endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
        rightMargin = context.dp(20)
      },
    )
    seekBar.id = View.generateViewId()
    seekBar.minimumHeight = 0
    // [SOURCE] Feishu's 16dp synchronized thumb is positioned inside the
    // progress host. A plain Android SeekBar needs the equivalent 8dp inset
    // or the endpoint thumbs are clipped by its bounds.
    seekBar.setPadding(context.dp(8), 0, context.dp(8), 0)
    seekBar.max = SEEK_RANGE
    seekBar.progressBackgroundTintList = ColorStateList.valueOf(PLAYER_TRACK_COLOR)
    seekBar.secondaryProgressTintList = ColorStateList.valueOf(PLAYER_BUFFER_COLOR)
    seekBar.progressTintList = ColorStateList.valueOf(PLAYER_GRADIENT_START)
    seekBar.thumbTintList = null
    seekBar.thumbTintMode = null
    seekBar.thumb = MinutesSeekThumbDrawable(context)
    seekBar.thumbTintList = null
    seekBar.thumbTintMode = null
    seekBar.splitTrack = false
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
      ConstraintLayout.LayoutParams(0, context.dp(24)).apply {
        topToTop = ConstraintLayout.LayoutParams.PARENT_ID
        bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
        startToStart = ConstraintLayout.LayoutParams.PARENT_ID
        endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
        leftMargin = context.dp(20)
        rightMargin = context.dp(20)
        topMargin = context.dp(8)
        bottomMargin = context.dp(13)
      },
    )

    speed.id = View.generateViewId()
    rewind.id = View.generateViewId()
    playPause.id = View.generateViewId()
    forward.id = View.generateViewId()
    speed.gravity = Gravity.CENTER
    speed.minimumWidth = 0
    speed.setPadding(context.dp(4), 0, context.dp(4), 0)
    speed.isClickable = true
    speed.isFocusable = true
    speed.contentDescription = "选择播放速度"
    speed.setOnClickListener { showSpeedMenu() }
    controls.addView(
      speed,
      ConstraintLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, context.dp(40)).apply {
        topToTop = ConstraintLayout.LayoutParams.PARENT_ID
        bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
        startToStart = ConstraintLayout.LayoutParams.PARENT_ID
        leftMargin = context.dp(20)
      },
    )
    rewind.minimumWidth = 0
    rewind.minimumHeight = 0
    rewind.setOnClickListener { controller.seekBy(-MINUTES_SKIP_INTERVAL_MS) }
    rewind.setPadding(context.dp(8), context.dp(8), context.dp(8), context.dp(8))
    controls.addView(
      rewind,
      ConstraintLayout.LayoutParams(context.dp(40), context.dp(40)).apply {
        topToTop = ConstraintLayout.LayoutParams.PARENT_ID
        bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
        endToStart = playPause.id
        rightMargin = context.dp(36)
      },
    )
    playPause.backgroundHorizontalGradient(PLAYER_GRADIENT_START, PLAYER_GRADIENT_END, radiusDp = 24)
    playPause.imageTintList = ColorStateList.valueOf(android.graphics.Color.WHITE)
    playPause.setPadding(context.dp(30), context.dp(13), context.dp(28), context.dp(13))
    playPause.setOnClickListener { controller.toggle() }
    controls.addView(
      playPause,
      ConstraintLayout.LayoutParams(context.dp(80), context.dp(48)).apply {
        topToTop = ConstraintLayout.LayoutParams.PARENT_ID
        bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
        startToStart = ConstraintLayout.LayoutParams.PARENT_ID
        endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
      },
    )
    forward.minimumWidth = 0
    forward.minimumHeight = 0
    forward.setOnClickListener { controller.seekBy(MINUTES_SKIP_INTERVAL_MS) }
    forward.setPadding(context.dp(8), context.dp(8), context.dp(8), context.dp(8))
    controls.addView(
      forward,
      ConstraintLayout.LayoutParams(context.dp(40), context.dp(40)).apply {
        topToTop = ConstraintLayout.LayoutParams.PARENT_ID
        bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
        startToEnd = playPause.id
        leftMargin = context.dp(36)
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
    controls.addView(
      error,
      ConstraintLayout.LayoutParams(0, 0).apply {
        topToTop = ConstraintLayout.LayoutParams.PARENT_ID
        bottomToBottom = ConstraintLayout.LayoutParams.PARENT_ID
        startToStart = ConstraintLayout.LayoutParams.PARENT_ID
        endToEnd = ConstraintLayout.LayoutParams.PARENT_ID
      },
    )
    render(controller.state)
  }

  fun setSource(source: MinutesPlayerSource?) {
    controller.setSource(source)
    if (source == null) speedSheet.dismiss()
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
    speedSheet.dismiss()
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
      if (state.isPlaying) com.laoji.nativeplatform.R.drawable.laoji_ic_pause_filled
      else com.laoji.nativeplatform.R.drawable.laoji_ic_play_filled,
    )
    if (state.isPlaying) {
      playPause.setPadding(context.dp(29), context.dp(13), context.dp(29), context.dp(13))
    } else {
      // Feishu offsets the asymmetric play glyph 1dp to the right.
      playPause.setPadding(context.dp(30), context.dp(13), context.dp(28), context.dp(13))
    }
    playPause.contentDescription = if (state.isPlaying) "暂停会议录音" else "播放会议录音"
    val enabled = state.sourceId != null
    listOf(speed, rewind, playPause, forward, seekBar).forEach {
      it.isEnabled = enabled
      it.alpha = if (enabled) 1f else 0.35f
    }
    error.text = state.errorMessage.orEmpty()
    error.visibility = if (state.phase == MinutesPlaybackPhase.FAILED) View.VISIBLE else View.GONE
  }

  private fun showSpeedMenu() {
    speedSheet.show(latestState.rate, controller::setRate)
  }

  private fun rateLabel(rate: Float): String = if (rate % 1f == 0f) rate.toInt().toString() else rate.toString()

  companion object {
    private const val SEEK_RANGE = 1_000
    private val PLAYER_GRADIENT_START = android.graphics.Color.rgb(85, 95, 242)
    private val PLAYER_GRADIENT_END = android.graphics.Color.rgb(139, 118, 245)
    private val PLAYER_BUFFER_COLOR = android.graphics.Color.argb(77, 85, 95, 242)
    private val PLAYER_TRACK_COLOR = android.graphics.Color.argb(26, 31, 35, 41)
  }
}

/** Keeps the source asset's three colors even when the platform theme tints SeekBar thumbs. */
private class MinutesSeekThumbDrawable(context: Context) : Drawable() {
  private val sizePx = context.dp(16)
  private val ringInsetPx = context.dp(1).toFloat()
  private val coreInsetPx = context.dp(3).toFloat()
  private val outerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = android.graphics.Color.rgb(204, 216, 251)
  }
  private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = android.graphics.Color.WHITE
  }
  private val corePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = android.graphics.Color.rgb(73, 83, 230)
  }

  override fun draw(canvas: Canvas) {
    val centerX = bounds.exactCenterX()
    val centerY = bounds.exactCenterY()
    val radius = minOf(bounds.width(), bounds.height()) / 2f
    canvas.drawCircle(centerX, centerY, radius, outerPaint)
    canvas.drawCircle(centerX, centerY, (radius - ringInsetPx).coerceAtLeast(0f), ringPaint)
    canvas.drawCircle(centerX, centerY, (radius - coreInsetPx).coerceAtLeast(0f), corePaint)
  }

  override fun setAlpha(alpha: Int) {
    outerPaint.alpha = alpha
    ringPaint.alpha = alpha
    corePaint.alpha = alpha
    invalidateSelf()
  }

  override fun setColorFilter(colorFilter: ColorFilter?) = Unit

  @Suppress("DEPRECATION")
  override fun getOpacity(): Int = PixelFormat.TRANSLUCENT

  override fun getIntrinsicWidth(): Int = sizePx

  override fun getIntrinsicHeight(): Int = sizePx
}
