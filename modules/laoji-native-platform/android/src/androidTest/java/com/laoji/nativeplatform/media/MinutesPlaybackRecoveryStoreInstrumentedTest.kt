package com.laoji.nativeplatform.media

// MIN-PLAYER-RECOVERY-001: real AndroidKeyStore ciphertext and fail-closed storage evidence.

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import java.io.File
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 35)
class MinutesPlaybackRecoveryStoreInstrumentedTest {
  private lateinit var context: Context
  private lateinit var store: EncryptedMinutesPlaybackStore
  private lateinit var localWav: File
  private val now = 2_100_000_000_000L

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    store = EncryptedMinutesPlaybackStore(context) { now }
    store.resetForTest()
    localWav = File(context.filesDir, "recovery-store-${System.nanoTime()}.wav").apply {
      writeBytes(byteArrayOf(0x52, 0x49, 0x46, 0x46))
    }
  }

  @After
  fun tearDown() {
    store.resetForTest()
    localWav.delete()
  }

  @Test
  fun encryptedFileContainsNoPlaintextUriBearerTokenOrHeaderName() {
    val source = cloudSource()
    val record = MinutesPlaybackRecoveryRecord(source, 22_500L, 1.5f, true, now)

    assertTrue(store.save(record))
    val bytes = store.encryptedFileForTest().readBytes()
    for (secret in listOf(source.uri, "Bearer key-store-secret", "Authorization", source.title)) {
      assertFalse("ciphertext leaked $secret", bytes.containsSubsequence(secret.toByteArray()))
    }
    assertArrayEquals(
      MinutesPlaybackRecoveryCodec.encode(record),
      MinutesPlaybackRecoveryCodec.encode(requireNotNull(store.load("user:key-store"))),
    )
  }

  @Test
  fun corruptionAndKeyLossFailClosedAndDeleteTheRecord() {
    assertTrue(store.save(MinutesPlaybackRecoveryRecord(cloudSource(), 1_000L, 1f, false, now)))
    store.encryptedFileForTest().writeBytes(byteArrayOf(1, 2, 3, 4, 5))
    assertNull(store.load("user:key-store"))
    assertFalse(store.encryptedFileForTest().exists())

    assertTrue(store.save(MinutesPlaybackRecoveryRecord(cloudSource(), 2_000L, 1.25f, false, now)))
    store.deleteKeyForTest()
    assertNull(store.load("user:key-store"))
    assertFalse(store.encryptedFileForTest().exists())
  }

  @Test
  fun localAndCloudRestoreButScopeExpiryAndHttpFailClosed() {
    val local = MinutesPlaybackRecoveryRecord(
      MinutesPlayerSource(
        sourceId = "local:meeting-local",
        uri = localWav.toURI().toString(),
        title = "本地录音",
        durationMsHint = 5_000L,
        retainForBackground = true,
        storageScope = "guest",
      ),
      900L,
      0.75f,
      false,
      now,
    )
    assertTrue(store.save(local))
    assertTrue(store.load("guest")?.source?.sourceId == "local:meeting-local")

    val cloud = MinutesPlaybackRecoveryRecord(cloudSource(), 2_400L, 2f, false, now)
    assertTrue(store.save(cloud))
    assertTrue(store.load("user:key-store")?.source?.sourceId == "cloud:meeting-cloud")

    assertTrue(store.save(cloud))
    assertNull(store.load("user:other"))
    assertFalse(store.save(cloud.copy(source = cloud.source.copy(expiresAt = now - 1L))))
    assertFalse(store.save(cloud.copy(source = cloud.source.copy(uri = "http://cdn.example.com/audio.wav"))))
  }

  private fun cloudSource() = MinutesPlayerSource(
    sourceId = "cloud:meeting-cloud",
    uri = "https://cdn.example.com/audio.wav?signature=store-secret",
    headers = mapOf("Authorization" to "Bearer key-store-secret"),
    title = "云端恢复录音",
    durationMsHint = 45_000L,
    retainForBackground = true,
    storageScope = "user:key-store",
    expiresAt = now + 60_000L,
  )
}

private fun ByteArray.containsSubsequence(candidate: ByteArray): Boolean {
  if (candidate.isEmpty() || candidate.size > size) return false
  return (0..size - candidate.size).any { start ->
    candidate.indices.all { offset -> this[start + offset] == candidate[offset] }
  }
}
