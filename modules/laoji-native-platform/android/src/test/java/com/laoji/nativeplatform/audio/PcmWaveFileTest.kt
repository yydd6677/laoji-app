package com.laoji.nativeplatform.audio

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.security.MessageDigest

class PcmWaveFileTest {
  private val pcm = byteArrayOf(1, 0, 2, 0, -1, 127)
  private fun hash(bytes: ByteArray) = "sha256:" + MessageDigest.getInstance("SHA-256").digest(bytes)
    .joinToString("") { b -> "%02x".format(b.toInt() and 255) }
  private fun format(channels: Int = 1): ByteArray = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN)
    .putShort(1).putShort(channels.toShort()).putInt(16000).putInt(32000).putShort(2).putShort(16).array()
  private fun wave(vararg chunks: Pair<String, ByteArray>): ByteArray {
    val body = ByteArrayOutputStream(); body.write("WAVE".toByteArray())
    for ((name, data) in chunks) {
      body.write(name.toByteArray()); body.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(data.size).array())
      body.write(data); if (data.size % 2 != 0) body.write(0)
    }
    return "RIFF".toByteArray() + ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(body.size()).array() + body.toByteArray()
  }
  private fun <T> file(bytes: ByteArray, test: (File) -> T): T {
    val root = Files.createTempDirectory("hardware-wave").toFile(); val file = File(root, "recording.wav")
    try { file.writeBytes(bytes); return test(file) } finally { root.deleteRecursively() }
  }
  private fun inspect(bytes: ByteArray) = file(bytes) { PcmWaveFile.inspect(it, bytes.size.toLong(), pcm.size.toLong()) }

  @Test fun canonicalLayoutIsUnchanged() {
    val result = inspect(wave("fmt " to format(), "data" to pcm))
    assertEquals(PcmWaveLayout(44, 6), result)
  }
  @Test fun oddMetadataBeforeAndMetadataAfterDataDoNotContaminateAudioHash() {
    val bytes = wave("JUNK" to byteArrayOf(7), "fmt " to format(), "data" to pcm, "LIST" to byteArrayOf(8, 9))
    file(bytes) {
      val layout = PcmWaveFile.inspect(it, bytes.size.toLong(), 6)
      assertEquals(54L, layout.audioOffset)
      assertEquals(PcmWaveDigests(hash(bytes), hash(pcm)), PcmWaveFile.digests(it, layout))
    }
  }
  @Test fun pcmFormatExtensionsAreAllowed() {
    assertEquals(46L, inspect(wave("fmt " to (format() + byteArrayOf(0, 0)), "data" to pcm)).audioOffset)
  }
  @Test(expected = IOException::class) fun duplicateDataIsRejected() { inspect(wave("fmt " to format(), "data" to pcm, "data" to pcm)) }
  @Test(expected = IOException::class) fun duplicateFormatIsRejected() { inspect(wave("fmt " to format(), "fmt " to format(), "data" to pcm)) }
  @Test(expected = IOException::class) fun missingDataIsRejected() { inspect(wave("fmt " to format())) }
  @Test(expected = IOException::class) fun missingFormatIsRejected() { inspect(wave("data" to pcm)) }
  @Test(expected = IOException::class) fun wrongChannelCountIsRejected() { inspect(wave("fmt " to format(2), "data" to pcm)) }
  @Test(expected = IOException::class) fun mismatchedPayloadLengthIsRejected() { inspect(wave("fmt " to format(), "data" to (pcm + pcm))) }
  @Test(expected = IOException::class) fun falseRiffLengthIsRejected() {
    val bytes = wave("fmt " to format(), "data" to pcm); bytes[4] = 0; inspect(bytes)
  }
  @Test fun everyTruncatedPrefixIsRejected() {
    val bytes = wave("fmt " to format(), "data" to pcm)
    for (length in 0 until bytes.size) {
      try { inspect(bytes.copyOf(length)); fail("accepted truncation $length") } catch (_: IOException) { }
    }
  }
  @Test(expected = IOException::class) fun rangeCannotReadOutsideFile() {
    file(pcm) { PcmWaveFile.digests(it, PcmWaveLayout(4, 4)) }
  }
  @Test fun dualDigestHandlesEveryBufferBoundaryAndTrailingMetadata() {
    for (size in listOf(2, 65534, 65536, 65538, 131074)) {
      val audio = ByteArray(size) { (it * 17).toByte() }
      val bytes = wave("JUNK" to ByteArray(65513) { 23 }, "fmt " to format(), "data" to audio,
        "LIST" to ByteArray(65537) { 42 })
      file(bytes) {
        val layout = PcmWaveFile.inspect(it, bytes.size.toLong(), size.toLong())
        assertEquals(PcmWaveDigests(hash(bytes), hash(audio)), PcmWaveFile.digests(it, layout))
      }
    }
  }
  @Test fun pcmWrapComputesBothDigestsWhileCopyingAndPreservesSource() {
    for (size in listOf(2, 65534, 65536, 65538, 131074)) {
      val audio = ByteArray(size) { (it * 31).toByte() }
      file(audio) { source ->
        val wav = File(source.parentFile, "pending.part")
        val result = PcmWaveFile.fromPcm(source, wav, size.toLong(), hash(audio))
        val expected = wave("fmt " to format(), "data" to audio)
        assertArrayEquals(audio, source.readBytes())
        assertArrayEquals(expected, wav.readBytes())
        assertEquals(PcmWaveDigests(hash(expected), hash(audio)), result)
        assertEquals(PcmWaveLayout(44, size.toLong()), PcmWaveFile.inspect(wav, expected.size.toLong(), size.toLong()))
      }
    }
  }
  @Test fun pcmChecksumFailureDeletesOnlyTentativeWave() {
    file(pcm) { source ->
      val wav = File(source.parentFile, "pending.part")
      try {
        PcmWaveFile.fromPcm(source, wav, pcm.size.toLong(), hash(pcm + pcm))
        fail("accepted wrong audio hash")
      } catch (_: PcmWaveIntegrityException) { }
      assertFalse(wav.exists())
      assertArrayEquals(pcm, source.readBytes())
    }
  }
  @Test fun pcmDimensionsAreRejectedBeforeOutputIsCreated() {
    file(pcm) { source ->
      for (size in listOf(0L, 3L, 8L, 0xffffffffL)) {
        val wav = File(source.parentFile, "pending.part")
        try {
          PcmWaveFile.fromPcm(source, wav, size, hash(pcm))
          fail("accepted invalid dimensions $size")
        } catch (_: PcmWaveIntegrityException) { }
        assertFalse(wav.exists())
        assertArrayEquals(pcm, source.readBytes())
      }
    }
  }
  @Test(expected = IllegalArgumentException::class) fun pcmCannotOverwriteItsOwnSource() {
    file(pcm) { PcmWaveFile.fromPcm(it, it, pcm.size.toLong(), hash(pcm)) }
  }
}
