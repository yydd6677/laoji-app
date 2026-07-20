package com.laoji.nativeplatform.media

import org.junit.Assert.assertEquals
import org.junit.Test

class MinutesPlaybackContractTest {
  @Test
  fun `MIN-PLAYER-001 exposes the seven Feishu-derived playback rates`() {
    assertEquals(listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f, 3f), MINUTES_PLAYBACK_RATES)
  }

  @Test
  fun `MIN-PLAYER-001 snaps arbitrary requests to a supported rate`() {
    assertEquals(0.5f, resolveMinutesPlaybackRate(0.55f))
    assertEquals(1.25f, resolveMinutesPlaybackRate(1.3f))
    assertEquals(3f, resolveMinutesPlaybackRate(4f))
  }

  @Test
  fun `MIN-PLAYER-001 clamps absolute and fifteen-second seeks`() {
    assertEquals(0L, clampMinutesSeek(-MINUTES_SKIP_INTERVAL_MS, 60_000L))
    assertEquals(45_000L, clampMinutesSeek(30_000L + MINUTES_SKIP_INTERVAL_MS, 60_000L))
    assertEquals(60_000L, clampMinutesSeek(70_000L, 60_000L))
  }

  @Test
  fun `MIN-PLAYER-001 derives stable lifecycle phases`() {
    assertEquals(
      MinutesPlaybackPhase.IDLE,
      resolveMinutesPlaybackPhase(MinutesPlaybackFacts(hasSource = false)),
    )
    assertEquals(
      MinutesPlaybackPhase.PREPARING,
      resolveMinutesPlaybackPhase(MinutesPlaybackFacts(hasSource = true, isBuffering = true)),
    )
    assertEquals(
      MinutesPlaybackPhase.PLAYING,
      resolveMinutesPlaybackPhase(MinutesPlaybackFacts(hasSource = true, isPlaying = true)),
    )
    assertEquals(
      MinutesPlaybackPhase.PAUSED,
      resolveMinutesPlaybackPhase(
        MinutesPlaybackFacts(hasSource = true, isReady = true, positionMs = 1_000L),
      ),
    )
    assertEquals(
      MinutesPlaybackPhase.FAILED,
      resolveMinutesPlaybackPhase(MinutesPlaybackFacts(hasSource = true, hasError = true)),
    )
  }
}
