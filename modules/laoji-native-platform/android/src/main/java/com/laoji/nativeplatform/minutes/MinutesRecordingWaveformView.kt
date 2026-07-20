package com.laoji.nativeplatform.minutes

// MIN-REC-BRIDGE-001 / MIN-REC-WAVE-001: native level interpolation and Record V3 geometry.

import android.app.ActivityManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

internal class WaveformSignalProcessor(
  private val maxPending: Int = 10,
  private val targetPeriodMs: Long = 100L,
  private val attack: Float = 0.2f,
  private val decay: Float = 0.08f,
) {
  private val pending = ArrayDeque<Float>(maxPending)
  private var cycleStartedAtMs = Long.MIN_VALUE
  private var cycleStartTarget = 0f
  private var cycleEndTarget = 0f

  var displayedValue = 0f
    private set

  val pendingCount: Int
    get() = pending.size

  fun offer(value: Float) {
    val normalized = value.takeIf(Float::isFinite)?.coerceIn(0f, 1f) ?: return
    if (pending.size == maxPending) pending.removeFirst()
    pending.addLast(normalized)
  }

  fun advance(nowMs: Long): Float {
    if (cycleStartedAtMs == Long.MIN_VALUE) beginCycle(nowMs)
    if (nowMs - cycleStartedAtMs >= targetPeriodMs) beginCycle(nowMs)

    val progress = if (targetPeriodMs <= 0L) {
      1f
    } else {
      ((nowMs - cycleStartedAtMs).toFloat() / targetPeriodMs).coerceIn(0f, 1f)
    }
    val desired = cosineInterpolate(cycleStartTarget, cycleEndTarget, progress)
    displayedValue = smooth(displayedValue, desired, attack, decay)
    return displayedValue
  }

  fun reset() {
    pending.clear()
    cycleStartedAtMs = Long.MIN_VALUE
    cycleStartTarget = 0f
    cycleEndTarget = 0f
    displayedValue = 0f
  }

  private fun beginCycle(nowMs: Long) {
    cycleStartTarget = if (cycleStartedAtMs == Long.MIN_VALUE) displayedValue else cycleEndTarget
    cycleEndTarget = pending.maxOrNull() ?: 0f
    pending.clear()
    cycleStartedAtMs = nowMs
  }

  companion object {
    internal fun smooth(current: Float, target: Float, attack: Float = 0.2f, decay: Float = 0.08f): Float {
      val coefficient = if (target >= current) attack else decay
      return (current + ((target - current) * coefficient)).coerceIn(0f, 1f)
    }

    internal fun cosineInterpolate(start: Float, end: Float, progress: Float): Float {
      val bounded = progress.coerceIn(0f, 1f)
      val eased = ((1.0 - cos(PI * bounded)) / 2.0).toFloat()
      return start + ((end - start) * eased)
    }
  }
}

internal class MinutesRecordingWaveformView @JvmOverloads constructor(
  context: Context,
  attrs: AttributeSet? = null,
) : View(context, attrs) {
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.argb(128, 31, 35, 41)
    strokeCap = Paint.Cap.ROUND
    strokeWidth = context.dp(BAR_WIDTH_DP).toFloat()
  }
  private val processor = WaveformSignalProcessor()
  private val samples = ArrayDeque<Float>(MAX_VISUAL_SAMPLES)
  private val frameIntervalMs = if (isLowMemoryDevice(context)) LOW_MEMORY_FRAME_MS else NORMAL_FRAME_MS
  private var active = false
  private var aggregatedVisible = false
  private var frameScheduled = false
  private var lastSignalAtMs = Long.MIN_VALUE

  private val frameCallback = object : Runnable {
    override fun run() {
      frameScheduled = false
      if (!shouldAnimate()) return
      val nowMs = SystemClock.uptimeMillis()
      val processorValue = processor.advance(nowMs)
      // Keep the visualizer alive during the short gaps that can occur while
      // AudioRecord/ASR frames are crossing the service boundary. Real RMS
      // samples take precedence as soon as they arrive.
      val value = if (lastSignalAtMs == Long.MIN_VALUE || nowMs - lastSignalAtMs > 1_200L) {
        ambientFallback(nowMs)
      } else {
        processorValue
      }
      if (samples.size == MAX_VISUAL_SAMPLES) samples.removeFirst()
      samples.addLast(value)
      invalidate()
      scheduleFrame()
    }
  }

  fun offerLevel(value: Float) {
    lastSignalAtMs = SystemClock.uptimeMillis()
    processor.offer(perceptualLevel(value))
  }

  fun setActive(value: Boolean, clear: Boolean = false) {
    active = value
    if (!value) {
      removeCallbacks(frameCallback)
      frameScheduled = false
      if (clear) {
        processor.reset()
        samples.clear()
        lastSignalAtMs = Long.MIN_VALUE
        invalidate()
      }
      return
    }
    scheduleFrame()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    aggregatedVisible = isShown && windowVisibility == VISIBLE
    scheduleFrame()
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(frameCallback)
    frameScheduled = false
    aggregatedVisible = false
    super.onDetachedFromWindow()
  }

  override fun onVisibilityAggregated(isVisible: Boolean) {
    super.onVisibilityAggregated(isVisible)
    aggregatedVisible = isVisible && windowVisibility == VISIBLE
    if (aggregatedVisible) scheduleFrame() else stopFrameCallback()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    aggregatedVisible = visibility == VISIBLE && isShown
    if (aggregatedVisible) scheduleFrame() else stopFrameCallback()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (width <= 0 || height <= 0) return

    val barWidth = context.dp(BAR_WIDTH_DP).toFloat()
    val gapWidth = context.dp(BAR_GAP_DP).toFloat()
    val sideMargin = context.dp(SIDE_MARGIN_DP).toFloat()
    val usableWidth = max(0f, width - (sideMargin * 2f))
    var barCount = max(3, ((usableWidth + gapWidth) / (barWidth + gapWidth)).toInt())
    barCount -= barCount % GROUP_SIZE
    if (barCount < GROUP_SIZE) barCount = GROUP_SIZE

    val visualizerWidth = (barCount * barWidth) + ((barCount - 1) * gapWidth)
    var x = ((width - visualizerWidth) / 2f) + (barWidth / 2f)
    val centerY = height / 2f
    val minHeight = context.dp(MIN_BAR_HEIGHT_DP).toFloat()
    val maxHeight = min(context.dp(MAX_BAR_HEIGHT_DP).toFloat(), height - barWidth)
    val fadeWidth = context.dp(EDGE_FADE_DP).toFloat()

    repeat(barCount) { index ->
      val normalized = normalizedHeight(index, barCount)
      val barHeight = minHeight + ((maxHeight - minHeight) * normalized)
      val distanceFromEdge = min(x, width - x)
      val edgeAlpha = (distanceFromEdge / fadeWidth).coerceIn(MIN_EDGE_ALPHA, 1f)
      paint.alpha = (BASE_ALPHA * edgeAlpha).toInt()
      canvas.drawLine(x, centerY - (barHeight / 2f), x, centerY + (barHeight / 2f), paint)
      x += barWidth + gapWidth
    }
    paint.alpha = BASE_ALPHA
  }

  private fun normalizedHeight(index: Int, barCount: Int): Float {
    if (samples.isEmpty()) {
      val idle = ((index * 17 + 5) % 11) / 10f
      return (IDLE_BASE + (idle * IDLE_RANGE)) * if (active) 1f else 0.72f
    }
    val sourceIndex = ((index.toFloat() / max(1, barCount - 1)) * (samples.size - 1)).toInt()
    val center = samples.elementAt(sourceIndex)
    val envelope = when (index % GROUP_SIZE) {
      0, 4 -> 0.58f
      1, 3 -> 0.78f
      else -> 1f
    }
    return max(0.04f, center * envelope) * if (active) 1f else 0.62f
  }

  private fun shouldAnimate(): Boolean = active && isAttachedToWindow && aggregatedVisible

  private fun ambientFallback(nowMs: Long): Float {
    val cycle = ((sin(nowMs.toDouble() / 180.0) + 1.0) / 2.0).toFloat()
    return 0.08f + (cycle * 0.14f)
  }

  private fun perceptualLevel(linearPeak: Float): Float {
    val bounded = linearPeak.takeIf(Float::isFinite)?.coerceIn(0f, 1f) ?: return 0f
    if (bounded <= 0f) return 0f
    // RecorderEngine publishes linear PCM peak / 32768. Mapping that value
    // directly makes ordinary speech (-45 to -25 dBFS on a phone microphone)
    // collapse into the minimum 3dp bar. A dB window preserves silence while
    // giving conversational changes enough visual range to be legible.
    val dbFs = 20f * log10(bounded)
    return ((dbFs - VISUAL_FLOOR_DB) / (VISUAL_CEILING_DB - VISUAL_FLOOR_DB)).coerceIn(0f, 1f)
  }

  private fun scheduleFrame() {
    if (!shouldAnimate() || frameScheduled) return
    frameScheduled = true
    postDelayed(frameCallback, frameIntervalMs)
  }

  private fun stopFrameCallback() {
    removeCallbacks(frameCallback)
    frameScheduled = false
  }

  companion object {
    private const val BAR_WIDTH_DP = 3
    private const val BAR_GAP_DP = 3
    private const val SIDE_MARGIN_DP = 4
    private const val MIN_BAR_HEIGHT_DP = 3
    private const val MAX_BAR_HEIGHT_DP = 29
    private const val EDGE_FADE_DP = 50
    private const val GROUP_SIZE = 5
    private const val MAX_VISUAL_SAMPLES = 256
    private const val BASE_ALPHA = 128
    private const val MIN_EDGE_ALPHA = 0.08f
    private const val IDLE_BASE = 0.08f
    private const val IDLE_RANGE = 0.22f
    private const val VISUAL_FLOOR_DB = -60f
    private const val VISUAL_CEILING_DB = -12f
    private const val NORMAL_FRAME_MS = 1_000L / 30L
    private const val LOW_MEMORY_FRAME_MS = 1_000L / 15L

    private fun isLowMemoryDevice(context: Context): Boolean {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      return manager?.isLowRamDevice == true
    }
  }
}
