package com.laoji.nativeplatform.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioContractsTest {
  @Test
  fun transportDiagnosticsClassifyNestedCausesWithoutLeakingMessages() {
    val privateMessage = "https://private.invalid/token?secret=do-not-log"
    assertEquals("dns", asrTransportFailureKind(java.io.IOException(privateMessage,
      java.net.UnknownHostException(privateMessage))))
    assertEquals("tls", asrTransportFailureKind(javax.net.ssl.SSLHandshakeException(privateMessage)))
    assertEquals("connect", asrTransportFailureKind(java.net.ConnectException(privateMessage)))
    assertEquals("timeout", asrTransportFailureKind(java.net.SocketTimeoutException(privateMessage)))
    assertEquals("protocol", asrTransportFailureKind(java.net.ProtocolException(privateMessage)))
    assertEquals("io", asrTransportFailureKind(java.io.EOFException(privateMessage)))
    assertEquals("unknown", asrTransportFailureKind(IllegalArgumentException(privateMessage)))
    val cycle = object : RuntimeException(privateMessage) {
      override val cause: Throwable get() = this
    }
    assertEquals("unknown", asrTransportFailureKind(cycle))
  }

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
