package com.laoji.nativeplatform.audio

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class RecordingJournalAsrRecoveryTest {
  @Test
  fun failedRealtimeMeetingAsrIsRecoveredAfterLocalFileWasFinalized() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val sessionId = "svc03-recovery-${UUID.randomUUID()}"
    val repository = RecordingRepository(context)
    val config = RecorderStartConfig.create(
      sessionId = sessionId,
      purpose = "meeting",
      storageScope = "guest",
      websocketUrl = "ws://127.0.0.1",
      accessToken = null,
      guestToken = "test-token",
      allowInsecureDevelopment = true,
      connectionTimeoutMs = 5_000.0,
      stopTimeoutMs = 5_000.0,
      levelIntervalMs = 100.0,
    )

    try {
      val fileSession = repository.createSession(config, System.currentTimeMillis())
      val pcm = ByteArray(AudioRuntimeContract.FRAME_BYTES) { if (it % 2 == 0) 8 else 0 }
      assertEquals(pcm.size, fileSession.append(pcm, pcm.size).bytesWritten)
      fileSession.finalizeRecording(JournalAsrState.FAILED)

      val report = repository.recover()
      val recovered = report.recordings.singleOrNull { it.sessionId == sessionId }
      assertTrue("failed meeting ASR journal was not emitted for recovery", recovered != null)
      assertTrue(requireNotNull(recovered).recovered)
      assertTrue(requireNotNull(recovered).uri.startsWith("file:"))
    } finally {
      repository.deleteSession(sessionId)
    }
  }
}
