package com.laoji.nativeplatform.audio

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class DeviceV2DurableChunk(val sequence: Long, val frame: ByteArray)
internal data class DeviceV2DurableEvent(val sequence: Long, val payload: String)

internal class DeviceV2RealtimeDurableStore(
  context: Context,
  private val sessionId: String,
  requestFingerprint: String,
) {
  private val root = File(
    context.applicationContext.filesDir,
    "laoji-device-v2-realtime/${digestName("$sessionId\u0000$requestFingerprint")}",
  )

  fun writeChunk(sequence: Long, frame: ByteArray) {
    require(sequence >= 0L && frame.isNotEmpty())
    writeEnvelope(file("chunk", sequence), identity("chunk", sequence), frame, MAX_CHUNK_STORE_BYTES)
  }

  fun chunksAfter(sequence: Long): List<DeviceV2DurableChunk> = files("chunk")
    .mapNotNull { file ->
      val itemSequence = sequence(file, "chunk") ?: return@mapNotNull null
      if (itemSequence <= sequence) return@mapNotNull null
      DeviceV2DurableChunk(
        itemSequence,
        openEnvelope(file, identity("chunk", itemSequence), DeviceV2RealtimeFrameCodec.MAX_PCM_BYTES + 2_055),
      )
    }
    .sortedBy { it.sequence }

  fun deleteChunksThrough(sequence: Long) {
    files("chunk").forEach { file ->
      val itemSequence = sequence(file, "chunk") ?: return@forEach
      if (itemSequence <= sequence) file.delete()
    }
    removeRootIfEmpty()
  }

  fun writeEvent(sequence: Long, payload: String) {
    require(sequence >= 1L && payload.isNotBlank())
    writeEnvelope(
      file("event", sequence),
      identity("event", sequence),
      payload.toByteArray(Charsets.UTF_8),
      MAX_EVENT_STORE_BYTES,
    )
  }

  fun eventsAfter(sequence: Long): List<DeviceV2DurableEvent> = files("event")
    .mapNotNull { file ->
      val itemSequence = sequence(file, "event") ?: return@mapNotNull null
      if (itemSequence <= sequence) return@mapNotNull null
      DeviceV2DurableEvent(
        itemSequence,
        String(openEnvelope(file, identity("event", itemSequence), MAX_SINGLE_EVENT_BYTES), Charsets.UTF_8),
      )
    }
    .sortedBy { it.sequence }

  fun deleteEventsThrough(sequence: Long) {
    files("event").forEach { file ->
      val itemSequence = sequence(file, "event") ?: return@forEach
      if (itemSequence <= sequence) file.delete()
    }
    removeRootIfEmpty()
  }

  fun storedBytes(): Long = root.listFiles().orEmpty().filter { it.isFile }.sumOf { it.length() }

  private fun writeEnvelope(file: File, aad: String, plaintext: ByteArray, maximumStoreBytes: Long) {
    require(plaintext.isNotEmpty())
    if (file.isFile) {
      require(openEnvelope(file, aad, maxOf(plaintext.size, MAX_SINGLE_EVENT_BYTES)) contentEquals plaintext) {
        "device-v2 realtime durable replay conflict"
      }
      return
    }
    val currentBytes = storedBytes()
    require(currentBytes + plaintext.size <= maximumStoreBytes) {
      "device-v2 realtime durable store capacity exceeded"
    }
    root.mkdirs()
    require(root.isDirectory)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    val ciphertext = cipher.doFinal(plaintext)
    val envelope = MAGIC + cipher.iv + ciphertext
    val temporary = File(root, ".${file.name}.${System.nanoTime()}.tmp")
    try {
      FileOutputStream(temporary).use { output ->
        output.write(envelope)
        output.flush()
        output.fd.sync()
      }
      require(temporary.renameTo(file)) { "device-v2 realtime durable commit failed" }
    } finally {
      temporary.delete()
    }
  }

  private fun openEnvelope(file: File, aad: String, maximumBytes: Int): ByteArray {
    val envelope = file.readBytes()
    require(envelope.size > MAGIC.size + NONCE_BYTES && envelope.copyOfRange(0, MAGIC.size).contentEquals(MAGIC))
    val nonce = envelope.copyOfRange(MAGIC.size, MAGIC.size + NONCE_BYTES)
    val ciphertext = envelope.copyOfRange(MAGIC.size + NONCE_BYTES, envelope.size)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, nonce))
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    val plaintext = cipher.doFinal(ciphertext)
    require(plaintext.size in 1..maximumBytes)
    return plaintext
  }

  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build(),
    )
    return generator.generateKey()
  }

  private fun files(kind: String): List<File> = root.listFiles { file ->
    file.isFile && file.name.startsWith("$kind-") && file.name.endsWith(".bin")
  }.orEmpty().toList()

  private fun file(kind: String, sequence: Long): File = File(root, "$kind-$sequence.bin")

  private fun sequence(file: File, kind: String): Long? = file.name
    .removePrefix("$kind-")
    .removeSuffix(".bin")
    .toLongOrNull()
    ?.takeIf { it >= 0L }

  private fun identity(kind: String, sequence: Long): String = "$sessionId:$kind:$sequence"

  private fun removeRootIfEmpty() {
    if (root.listFiles().orEmpty().isEmpty()) root.delete()
  }

  internal companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "laoji-device-v2-realtime-v1"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val NONCE_BYTES = 12
    val MAGIC = byteArrayOf('L'.code.toByte(), 'J'.code.toByte(), 'V'.code.toByte(), '2'.code.toByte(), 1)
    const val MAX_CHUNK_STORE_BYTES = 32L * 1024L * 1024L
    const val MAX_EVENT_STORE_BYTES = 32L * 1024L * 1024L
    const val MAX_SINGLE_EVENT_BYTES = 256 * 1024

    fun cleanupExpired(context: Context, nowMs: Long = System.currentTimeMillis()): Int {
      val base = File(context.applicationContext.filesDir, "laoji-device-v2-realtime")
      val cutoff = nowMs - 24L * 60L * 60L * 1_000L
      var removed = 0
      base.listFiles().orEmpty().filter { directory ->
        directory.isDirectory && directory.lastModified() in 1L..cutoff
      }.forEach { directory ->
        if (directory.deleteRecursively()) removed += 1
      }
      if (base.listFiles().orEmpty().isEmpty()) base.delete()
      return removed
    }
  }
}

private fun digestName(value: String): String = java.security.MessageDigest.getInstance("SHA-256")
  .digest(value.toByteArray(Charsets.UTF_8))
  .joinToString("") { "%02x".format(it.toInt() and 0xff) }
