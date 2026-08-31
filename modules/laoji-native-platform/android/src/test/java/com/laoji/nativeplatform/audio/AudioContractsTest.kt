package com.laoji.nativeplatform.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioContractsTest {
  @Test
  fun localMeetingCaptureUsesMeetingAudioWithoutRealtimeDependency() {
    val config = RecorderStartConfig.createLocalMeeting(
      sessionId = "meeting-local-fallback",
      storageScope = "guest",
      levelIntervalMs = 120.0,
    )

    assertEquals(AudioPurpose.MEETING, config.purpose)
    assertEquals(RecorderMode.LOCAL_ONLY, config.mode)
    assertEquals("guest", config.storageScope)
    assertEquals(120L, config.levelIntervalMs)
    assertNull(config.websocketUrl)
    assertNull(config.credentials)
    assertNull(config.deviceV2)
    assertFalse(config.realtimeAttachPending)
  }

  @Test
  fun deferredRealtimeMeetingCanCaptureBeforeRemoteConfigurationExists() {
    val config = RecorderStartConfig.createDeferredRealtimeMeeting(
      sessionId = "meeting-local-first",
      storageScope = "guest",
      levelIntervalMs = 100.0,
    )

    assertEquals(AudioPurpose.MEETING, config.purpose)
    assertEquals(RecorderMode.REALTIME, config.mode)
    assertEquals("guest", config.storageScope)
    assertEquals(100L, config.levelIntervalMs)
    assertNull(config.websocketUrl)
    assertNull(config.credentials)
    assertNull(config.deviceV2)
    assertTrue(config.realtimeAttachPending)
  }
}
