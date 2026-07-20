package com.laoji.nativeplatform.media

// MIN-PLAYER-RECOVERY-001: portable recovery policy, codec, and throttle regressions.

import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MinutesPlaybackRecoveryTest {
  private val readableLocal = MinutesLocalSourceAccess { _, _ -> true }
  private val policy = MinutesPlaybackRecoveryPolicy(readableLocal)
  private val now = 2_000_000_000_000L

  @Test
  fun `MIN-PLAYER-RECOVERY-001 codec retains the complete local recovery contract`() {
    val record = record(
      source = source(
        sourceId = "local:meeting-17",
        uri = "file:///data/user/0/com.laoji/files/meeting-17.wav",
        storageScope = "guest",
      ),
      positionMs = 34_567L,
      rate = 1.5f,
      wasPlaying = true,
    )

    assertEquals(record, MinutesPlaybackRecoveryCodec.decode(MinutesPlaybackRecoveryCodec.encode(record)))
  }

  @Test
  fun `MIN-PLAYER-RECOVERY-001 codec retains encrypted cloud headers and expiry metadata`() {
    val cloud = record(
      source = source(
        sourceId = "cloud:meeting-42",
        uri = "https://cdn.example.com/audio.wav?signature=secret",
        storageScope = "user:42",
        expiresAt = now + 60_000L,
        headers = mapOf("Authorization" to "Bearer token-secret"),
      ),
    )

    assertEquals(cloud, MinutesPlaybackRecoveryCodec.decode(MinutesPlaybackRecoveryCodec.encode(cloud)))
  }

  @Test
  fun `MIN-PLAYER-RECOVERY-001 rejects corruption expiry HTTP unreadable local and unstable ids`() {
    assertFalse(policy.canRestore(record(source = source(uri = "http://example.com/a.wav")), "user:42", now))
    assertFalse(policy.canRestore(record(source = source(expiresAt = now - 1L)), "user:42", now))
    assertFalse(
      MinutesPlaybackRecoveryPolicy(MinutesLocalSourceAccess { _, _ -> false }).canRestore(
        record(source = source(
          sourceId = "local:meeting-42",
          uri = "file:///missing.wav",
        )),
        "user:42",
        now,
      ),
    )
    assertFalse(policy.canRestore(record(source = source(sourceId = "cloud:https://signed.example/a")), "user:42", now))
    assertFailsWithIOException {
      MinutesPlaybackRecoveryCodec.decode(MinutesPlaybackRecoveryCodec.encode(record()).copyOf(9))
    }
  }

  @Test
  fun `MIN-PLAYER-RECOVERY-001 isolates scope and applies conservative undated HTTPS age`() {
    val fresh = record(source = source(expiresAt = null), savedAtEpochMs = now - 10_000L)
    val old = fresh.copy(savedAtEpochMs = now - MINUTES_RECOVERY_MAX_UNDATED_HTTPS_AGE_MS - 1L)

    assertTrue(policy.canRestore(fresh, "user:42", now))
    assertFalse(policy.canRestore(fresh, "user:7", now))
    assertFalse(policy.canRestore(fresh, MINUTES_SIGNED_OUT_SCOPE, now))
    assertFalse(policy.canRestore(old, "user:42", now))
    assertNull(normalizeMinutesSourceStorageScope("signed_out"))
  }

  @Test
  fun `MIN-PLAYER-RECOVERY-001 throttles progress while forced lifecycle saves remain independent`() {
    val throttle = MinutesPlaybackProgressThrottle(intervalMs = 5_000L, minimumPositionDeltaMs = 1_000L)
    assertTrue(throttle.shouldPersist(1_000L, 10_000L))
    throttle.markPersisted(1_000L, 10_000L)
    assertFalse(throttle.shouldPersist(5_999L, 14_000L))
    assertFalse(throttle.shouldPersist(6_000L, 10_999L))
    assertTrue(throttle.shouldPersist(6_000L, 11_000L))
    throttle.reset()
    assertTrue(throttle.shouldPersist(6_001L, 11_001L))
  }

  private fun source(
    sourceId: String = "cloud:meeting-42",
    uri: String = "https://cdn.example.com/audio.wav",
    storageScope: String = "user:42",
    expiresAt: Long? = now + 60_000L,
    headers: Map<String, String> = emptyMap(),
  ) = MinutesPlayerSource(
    sourceId = sourceId,
    uri = uri,
    headers = headers,
    title = "恢复测试会议",
    durationMsHint = 90_000L,
    retainForBackground = true,
    storageScope = storageScope,
    expiresAt = expiresAt,
  )

  private fun record(
    source: MinutesPlayerSource = source(),
    positionMs: Long = 12_345L,
    rate: Float = 1.25f,
    wasPlaying: Boolean = false,
    savedAtEpochMs: Long = now,
  ) = MinutesPlaybackRecoveryRecord(source, positionMs, rate, wasPlaying, savedAtEpochMs)

  private fun assertFailsWithIOException(block: () -> Unit) {
    try {
      block()
      throw AssertionError("expected IOException")
    } catch (_: IOException) {
      // Expected fail-closed parse.
    }
  }
}
