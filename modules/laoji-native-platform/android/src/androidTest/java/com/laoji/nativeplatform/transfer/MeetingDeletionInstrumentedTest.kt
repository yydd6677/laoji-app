package com.laoji.nativeplatform.transfer

// MIN-DELETE-RECOVERY-001: durable tombstones and exact journal deletion use production owners.

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.laoji.nativeplatform.audio.JournalAsrState
import com.laoji.nativeplatform.audio.RecorderStartConfig
import com.laoji.nativeplatform.audio.RecordingRepository
import java.io.File
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MeetingDeletionInstrumentedTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private val createdSessionIds = mutableListOf<String>()

  @Before
  fun clearTombstones() {
    context.getSharedPreferences("laoji-native-deleted-meetings-v1", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }

  @After
  fun cleanup() {
    val repository = RecordingRepository(context)
    createdSessionIds.forEach { repository.deleteSession(it) }
    clearTombstones()
  }

  @Test
  fun tombstoneSurvivesStoreRecreationAndExpiresFailClosed() {
    val store = MeetingDeletionStore(context)
    store.markDeleted("user:42", "meeting-42", nowMs = 10_000L)

    assertTrue(MeetingDeletionStore(context).isDeleted("user:42", "meeting-42", nowMs = 20_000L))
    assertFalse(MeetingDeletionStore(context).isDeleted("user:42", "meeting-42", nowMs = Long.MAX_VALUE))
    assertFalse(MeetingDeletionStore(context).isDeleted("user:42", "other", nowMs = 20_000L))
    assertEquals(meetingUploadTag("user:42", "meeting-42"), meetingUploadTag("user:42", "meeting-42"))
    assertNotEquals(meetingUploadTag("user:42", "meeting-42"), meetingUploadTag("guest", "meeting-42"))
  }

  @Test
  fun exactSessionDeletionDoesNotTouchAnotherMeetingAndRejectsActiveSession() {
    val firstId = "delete-${UUID.randomUUID()}"
    val secondId = "keep-${UUID.randomUUID()}"
    createdSessionIds += firstId
    createdSessionIds += secondId
    val repository = RecordingRepository(context)
    val first = repository.createSession(RecorderStartConfig.createLocal(firstId, 100.0), 10_000L).let { session ->
      session.append(ByteArray(640) { 1 }, 640)
      session.finalizeRecording(JournalAsrState.NOT_REQUIRED)
    }
    val second = repository.createSession(RecorderStartConfig.createLocal(secondId, 100.0), 20_000L).let { session ->
      session.append(ByteArray(640) { 2 }, 640)
      session.finalizeRecording(JournalAsrState.NOT_REQUIRED)
    }
    val firstFile = File(requireNotNull(Uri.parse(first.uri).path))
    val secondFile = File(requireNotNull(Uri.parse(second.uri).path))

    val activeFailure = runCatching { repository.deleteSession(firstId, activeSessionId = firstId) }.exceptionOrNull()
    assertTrue(activeFailure is IllegalArgumentException)
    assertTrue(firstFile.isFile)
    assertTrue(secondFile.isFile)

    assertTrue(repository.deleteSession(firstId) >= 2)
    assertFalse(firstFile.exists())
    assertTrue(secondFile.isFile)
    assertEquals(0, repository.deleteSession(firstId))
  }
}
