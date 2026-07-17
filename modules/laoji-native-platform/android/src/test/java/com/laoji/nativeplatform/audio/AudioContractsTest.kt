package com.laoji.nativeplatform.audio

// MIN-AUDIO-001 / MIN-REC-STATE-001: executable recorder and WAV evidence.

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

class AudioContractsTest {
  @Test
  fun secureTransportIsAcceptedByDefault() {
    assertEquals(
      "wss://realtime.example/ws/meeting/meeting-1/qwen",
      RecorderStartConfig.validateWebSocketUrl(
        "wss://realtime.example/ws/meeting/meeting-1/qwen",
      ),
    )
  }

  @Test
  fun insecureTransportRequiresExplicitDevelopmentOptIn() {
    assertInvalid("ws://dev.example:18020/ws/meeting/meeting-1/qwen", false)
    assertEquals(
      "ws://dev.example:18020/ws/meeting/meeting-1/qwen",
      RecorderStartConfig.validateWebSocketUrl(
        "ws://dev.example:18020/ws/meeting/meeting-1/qwen",
        allowInsecureDevelopment = true,
      ),
    )
  }

  @Test
  fun developmentOptInStillRejectsUserInfoQueryAndFragment() {
    listOf(
      "ws://user:password@dev.example/ws/meeting/1/qwen",
      "ws://dev.example/ws/meeting/1/qwen?token=secret",
      "ws://dev.example/ws/meeting/1/qwen#fragment",
      "ws://dev.example/ws/meeting/1/qwen?",
      "ws://dev.example/ws/meeting/1/qwen#",
    ).forEach { url -> assertInvalid(url, true) }
  }

  @Test
  fun authenticationHeadersMatchTheServerContractAndRedactSecrets() {
    val bearer = RecorderCredentials.create("account-secret", null)
    val guest = RecorderCredentials.create(null, "guest-secret")

    assertEquals("Authorization", bearer.headerName)
    assertEquals("Bearer account-secret", bearer.headerValue)
    assertEquals("X-Guest-Session-Token", guest.headerName)
    assertEquals("guest-secret", guest.headerValue)
    assertFalse(bearer.toString().contains("account-secret"))
    assertFalse(guest.toString().contains("guest-secret"))
  }

  @Test
  fun recorderStateTransitionsRemainExplicit() {
    assertTrue(RecorderStateMachine.canTransition(RecorderState.RECORDING, RecorderState.PAUSED))
    assertTrue(RecorderStateMachine.canTransition(RecorderState.STOPPING, RecorderState.LOCAL_SAVED))
    assertFalse(RecorderStateMachine.canTransition(RecorderState.LOCAL_SAVED, RecorderState.RECORDING))
  }

  @Test
  fun wavHeaderCarriesTheActualPcmLength() {
    val header = WavHeader.create(3_200L)
    assertEquals(AudioRuntimeContract.WAV_HEADER_BYTES, header.size)
    assertEquals(
      3_200,
      ByteBuffer.wrap(header, 40, 4).order(ByteOrder.LITTLE_ENDIAN).int,
    )
  }

  @Test
  fun localOnlyContractHasNoTransportOrCredentials() {
    val config = RecorderStartConfig.createLocal(" speaker-enrollment-1 ", 250.0)

    assertEquals("speaker-enrollment-1", config.sessionId)
    assertEquals(AudioPurpose.SPEAKER, config.purpose)
    assertEquals(RecorderMode.LOCAL_ONLY, config.mode)
    assertEquals(250L, config.levelIntervalMs)
    assertFalse(config.allowInsecureDevelopment)
    assertNull(config.websocketUrl)
    assertNull(config.credentials)
  }

  @Test
  fun realtimeContractRejectsSpeakerPurpose() {
    try {
      RecorderStartConfig.create(
        sessionId = "speaker-enrollment-1",
        purpose = "speaker",
        websocketUrl = "wss://realtime.example/ws/speaker/1",
        accessToken = "token",
        guestToken = null,
        connectionTimeoutMs = null,
        stopTimeoutMs = null,
        levelIntervalMs = null,
      )
      fail("expected realtime speaker mode to be rejected")
    } catch (error: RecorderRuntimeException) {
      assertEquals(RecorderErrorCode.INVALID_OPTIONS, error.errorCode)
    }
  }

  @Test
  fun localStopCompletesWithoutReadyToStop() {
    val snapshot = RecorderSnapshot(
      sessionId = "speaker-enrollment-1",
      purpose = AudioPurpose.SPEAKER,
      mode = RecorderMode.LOCAL_ONLY,
      state = RecorderState.LOCAL_SAVED,
      startedAtMs = 1L,
      updatedAtMs = 2L,
      bytesRecorded = 3_200L,
      localUri = "file:///speaker.wav",
      asrConnected = false,
      readyToStop = false,
      transcriptRecoveryRequired = false,
      errorCode = null,
      errorMessage = null,
    )
    val result = RecorderStopResult(
      snapshot = snapshot,
      localSaved = true,
      readyToStop = false,
      errorCode = null,
      errorMessage = null,
      audioBars = listOf(0.25f, 1f),
    )

    assertFalse(snapshot.asrRequired)
    assertEquals("completed", result.toMap()["status"])
    assertEquals(listOf(0.25, 1.0), result.toMap()["audioBars"])
  }

  @Test
  fun localRecoveryRemainsLocalAndAlignsPcm16() {
    assertEquals("not_applicable", RecordingPersistencePolicy.initialUploadState(RecorderMode.LOCAL_ONLY))
    assertEquals("not_applicable", RecordingPersistencePolicy.completedUploadState(RecorderMode.LOCAL_ONLY))
    assertEquals(JournalAsrState.NOT_REQUIRED, RecordingPersistencePolicy.recoveredAsrState(RecorderMode.LOCAL_ONLY))
    assertEquals(0L, WavRecoveryMath.alignedPcmBytes(12L))
    assertEquals(3_200L, WavRecoveryMath.alignedPcmBytes(3_245L))
    try {
      RecorderMode.fromWireValue("unexpected")
      fail("expected an unknown journal mode to be rejected")
    } catch (error: RecorderRuntimeException) {
      assertEquals(RecorderErrorCode.INVALID_OPTIONS, error.errorCode)
    }
  }

  @Test
  fun wavRecoveryRepairsAnOddLengthTemporaryFileInPlace() {
    val file = File.createTempFile("laoji-audio-recovery-", ".wav.part")
    try {
      RandomAccessFile(file, "rw").use { recording ->
        recording.setLength(AudioRuntimeContract.WAV_HEADER_BYTES + 3_201L)
      }

      val pcmBytes = WavFileRepair.repairInPlace(file)
      val header = ByteArray(AudioRuntimeContract.WAV_HEADER_BYTES)
      RandomAccessFile(file, "r").use { recording -> recording.readFully(header) }

      assertEquals(3_200L, pcmBytes)
      assertEquals(AudioRuntimeContract.WAV_HEADER_BYTES + 3_200L, file.length())
      assertTrue(WavHeader.isPlausible(header, file.length()))
    } finally {
      file.delete()
    }
  }

  private fun assertInvalid(url: String, allowInsecureDevelopment: Boolean) {
    try {
      RecorderStartConfig.validateWebSocketUrl(url, allowInsecureDevelopment)
      fail("expected URL to be rejected")
    } catch (error: RecorderRuntimeException) {
      assertEquals(RecorderErrorCode.INVALID_OPTIONS, error.errorCode)
    }
  }
}
