package com.laoji.nativeplatform.media

// MIN-PLAYER-RECOVERY-001: every persisted source byte is protected by AndroidKeyStore AES/GCM.

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class EncryptedMinutesPlaybackStore(
  context: Context,
  private val nowEpochMs: () -> Long = System::currentTimeMillis,
) : MinutesPlaybackRecoveryStore {
  private val applicationContext = context.applicationContext
  private val atomicFile = AtomicFile(
    File(applicationContext.noBackupFilesDir, RECOVERY_FILE_NAME),
  )
  private val policy = MinutesPlaybackRecoveryPolicy(
    localSourceAccess = AndroidMinutesLocalSourceAccess(applicationContext),
  )

  @Synchronized
  override fun load(activeStorageScope: String): MinutesPlaybackRecoveryRecord? {
    if (!atomicFile.baseFile.isFile) return null
    return try {
      val encrypted = atomicFile.readFully()
      val record = MinutesPlaybackRecoveryCodec.decode(decrypt(encrypted))
      if (!policy.canRestore(record, activeStorageScope, nowEpochMs())) {
        clear()
        null
      } else {
        record
      }
    } catch (error: Exception) {
      Log.w(LOG_TAG, "Unable to read encrypted playback recovery", error)
      clear()
      null
    }
  }

  @Synchronized
  override fun save(record: MinutesPlaybackRecoveryRecord): Boolean {
    if (!policy.canPersist(record.source, record.source.storageScope, nowEpochMs())) {
      clear()
      return false
    }
    val encrypted = try {
      encrypt(MinutesPlaybackRecoveryCodec.encode(record))
    } catch (error: Exception) {
      Log.w(LOG_TAG, "Unable to encrypt playback recovery", error)
      clear()
      return false
    }
    var stream: FileOutputStream? = null
    return try {
      val output = atomicFile.startWrite()
      stream = output
      output.write(encrypted)
      atomicFile.finishWrite(output)
      stream = null
      true
    } catch (error: Exception) {
      Log.w(LOG_TAG, "Unable to atomically write playback recovery", error)
      stream?.let(atomicFile::failWrite)
      false
    }
  }

  @Synchronized
  override fun clear() {
    atomicFile.delete()
  }

  internal fun encryptedFileForTest(): File = atomicFile.baseFile

  internal fun resetForTest() {
    clear()
    deleteKeyForTest()
  }

  internal fun deleteKeyForTest() {
    runCatching {
      keyStore().deleteEntry(KEY_ALIAS)
    }
  }

  private fun encrypt(plaintext: ByteArray): ByteArray {
    val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
    // AndroidKeyStore owns IV generation when randomized encryption is required.
    cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
    val iv = requireNotNull(cipher.iv).also {
      require(it.size == GCM_IV_BYTES) { "invalid generated recovery IV" }
    }
    cipher.updateAAD(ENVELOPE_AAD)
    val ciphertext = cipher.doFinal(plaintext)
    return ByteArrayOutputStream().also { output ->
      DataOutputStream(output).use { data ->
        data.writeInt(ENVELOPE_MAGIC)
        data.writeInt(ENVELOPE_VERSION)
        data.writeInt(iv.size)
        data.write(iv)
        data.writeInt(ciphertext.size)
        data.write(ciphertext)
      }
    }.toByteArray()
  }

  private fun decrypt(envelope: ByteArray): ByteArray =
    DataInputStream(ByteArrayInputStream(envelope)).use { data ->
      if (data.readInt() != ENVELOPE_MAGIC || data.readInt() != ENVELOPE_VERSION) {
        throw IOException("invalid encrypted recovery envelope")
      }
      val ivSize = data.readInt()
      if (ivSize != GCM_IV_BYTES) throw IOException("invalid recovery IV")
      val iv = ByteArray(ivSize).also(data::readFully)
      val ciphertextSize = data.readInt()
      if (ciphertextSize !in 1..MAX_CIPHERTEXT_BYTES) throw IOException("invalid recovery ciphertext")
      val ciphertext = ByteArray(ciphertextSize).also(data::readFully)
      if (data.available() != 0) throw IOException("trailing encrypted recovery envelope")
      val cipher = Cipher.getInstance(CIPHER_TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
      cipher.updateAAD(ENVELOPE_AAD)
      try {
        cipher.doFinal(ciphertext)
      } catch (error: AEADBadTagException) {
        throw IOException("recovery authentication failed", error)
      }
    }

  private fun encryptionKey(): SecretKey {
    val keyStore = keyStore()
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
      .apply {
        init(
          KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
          )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build(),
        )
      }
      .generateKey()
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

  companion object {
    private const val LOG_TAG = "LaojiMinutesRecovery"
    private const val ANDROID_KEY_STORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "laoji.minutes.playback.recovery.aes.v1"
    private const val CIPHER_TRANSFORMATION = "AES/GCM/NoPadding"
    private const val RECOVERY_FILE_NAME = "minutes-playback-recovery.bin"
    private const val ENVELOPE_MAGIC = 0x4c4a4d52
    private const val ENVELOPE_VERSION = 1
    private const val GCM_IV_BYTES = 12
    private const val GCM_TAG_BITS = 128
    private const val MAX_CIPHERTEXT_BYTES = 2 * 1_048_576
    private val ENVELOPE_AAD = "MIN-PLAYER-RECOVERY-001:v1".toByteArray(Charsets.US_ASCII)
  }
}

internal class AndroidMinutesLocalSourceAccess(context: Context) : MinutesLocalSourceAccess {
  private val applicationContext = context.applicationContext

  override fun isReadable(uri: String, scheme: String): Boolean = try {
    val parsed = Uri.parse(uri)
    when (scheme) {
      "file" -> parsed.path?.let(::File)?.let { it.isFile && it.canRead() } == true
      "content" -> applicationContext.contentResolver.openAssetFileDescriptor(parsed, "r")?.use { true } == true
      else -> false
    }
  } catch (_: Exception) {
    false
  }
}
