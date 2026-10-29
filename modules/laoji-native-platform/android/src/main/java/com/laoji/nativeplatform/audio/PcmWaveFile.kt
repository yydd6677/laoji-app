package com.laoji.nativeplatform.audio

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

internal data class PcmWaveLayout(val audioOffset: Long, val audioBytes: Long)
internal data class PcmWaveDigests(val fileSha256: String, val audioSha256: String)
internal class PcmWaveIntegrityException : IOException("PCM dimensions or digest differ")

/** Same RIFF/PCM contract as the recorder, not a fixed 44-byte-header assumption.
 * Unknown metadata chunks are skipped with checked bounds; only the declared
 * data chunk participates in audio_payload SHA. Never loads a whole recording. */
internal object PcmWaveFile {
  fun inspect(file: File, expectedFileBytes: Long = file.length(), expectedAudioBytes: Long? = null): PcmWaveLayout {
    if (expectedFileBytes !in 44..0xffffffffL || (expectedAudioBytes != null && (expectedAudioBytes <= 0 || expectedAudioBytes % 2L != 0L)) ||
      file.length() != expectedFileBytes) throw IOException("WAV dimensions differ")
    RandomAccessFile(file, "r").use { input ->
      fun fourcc(): String = ByteArray(4).also(input::readFully).toString(Charsets.US_ASCII)
      fun u16(): Int = input.readUnsignedByte() or (input.readUnsignedByte() shl 8)
      fun u32(): Long = (u16().toLong() or (u16().toLong() shl 16))
      if (fourcc() != "RIFF" || u32() + 8 != expectedFileBytes || fourcc() != "WAVE") throw IOException("Invalid RIFF container")
      var at = 12L
      var hasFormat = false
      var layout: PcmWaveLayout? = null
      while (at < expectedFileBytes) {
        if (expectedFileBytes - at < 8) throw IOException("Truncated RIFF chunk header")
        input.seek(at)
        val kind = fourcc(); val size = u32(); val payload = at + 8
        val end = payload + size
        if (end > expectedFileBytes || end + (size and 1L) > expectedFileBytes) throw IOException("RIFF chunk exceeds source")
        when (kind) {
          "fmt " -> {
            if (hasFormat || size < 16 || u16() != 1 || u16() != 1 || u32() != 16000L ||
              u32() != 32000L || u16() != 2 || u16() != 16) throw IOException("Unsupported or ambiguous PCM format")
            hasFormat = true
          }
          "data" -> {
            if (layout != null || size <= 0 || size % 2L != 0L || (expectedAudioBytes != null && size != expectedAudioBytes)) throw IOException("Ambiguous or mismatched audio data")
            layout = PcmWaveLayout(payload, size)
          }
        }
        at = end + (size and 1L)
      }
      if (!hasFormat) throw IOException("Missing PCM format")
      return layout ?: throw IOException("Missing PCM data")
    }
  }

  /** Compute source-audio and import-file identities in one bounded disk pass.
   * RIFF metadata/padding belongs only to the complete-file identity. */
  fun digests(file: File, layout: PcmWaveLayout): PcmWaveDigests {
    val size = file.length()
    val offset = layout.audioOffset; val length = layout.audioBytes
    if (offset < 0 || length < 0 || offset > size || length > size - offset)
      throw IOException("Audio range exceeds source")
    val whole = MessageDigest.getInstance("SHA-256")
    val audio = MessageDigest.getInstance("SHA-256")
    RandomAccessFile(file, "r").use { input ->
      val bytes = ByteArray(64 * 1024); var at = 0L
      while (at < size) {
        val count = minOf(size - at, bytes.size.toLong()).toInt()
        input.readFully(bytes, 0, count)
        whole.update(bytes, 0, count)
        val begin = maxOf(at, offset)
        val end = minOf(at + count, offset + length)
        if (end > begin) audio.update(bytes, (begin - at).toInt(), (end - begin).toInt())
        at += count
      }
      if (input.length() != size) throw IOException("WAV changed while verifying")
    }
    return PcmWaveDigests(hex(whole), hex(audio))
  }

  /** Wrap a complete PCM source and verify exactly the bytes being saved.
   * The uncommitted WAV is removed on every failure; the resumable source is
   * left to its owner. No second full-file read is needed after the copy. */
  fun fromPcm(source: File, wav: File, audioBytes: Long, expectedAudioSha256: String): PcmWaveDigests {
    require(source.canonicalFile != wav.canonicalFile)
    if (audioBytes <= 0 || audioBytes % 2 != 0L || audioBytes > 0xffffffffL - 36L || source.length() != audioBytes)
      throw PcmWaveIntegrityException()
    val whole = MessageDigest.getInstance("SHA-256")
    val audio = MessageDigest.getInstance("SHA-256")
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      .put("RIFF".toByteArray(Charsets.US_ASCII)).putInt((audioBytes + 36).toInt())
      .put("WAVEfmt ".toByteArray(Charsets.US_ASCII)).putInt(16).putShort(1).putShort(1)
      .putInt(16000).putInt(32000).putShort(2).putShort(16)
      .put("data".toByteArray(Charsets.US_ASCII)).putInt(audioBytes.toInt()).array()
    var committed = false
    try {
      val hashes = FileInputStream(source).use { input ->
        FileOutputStream(wav).use { output ->
          output.write(header); whole.update(header)
          val bytes = ByteArray(64 * 1024); var left = audioBytes
          while (left > 0) {
            val count = input.read(bytes, 0, minOf(left, bytes.size.toLong()).toInt())
            if (count <= 0) throw PcmWaveIntegrityException()
            audio.update(bytes, 0, count); whole.update(bytes, 0, count)
            output.write(bytes, 0, count); left -= count
          }
          if (input.read() != -1 || source.length() != audioBytes) throw PcmWaveIntegrityException()
          val hashes = PcmWaveDigests(hex(whole), hex(audio))
          if (hashes.audioSha256 != expectedAudioSha256.lowercase()) throw PcmWaveIntegrityException()
          output.fd.sync()
          hashes
        }
      }
      committed = true
      return hashes
    } finally {
      if (!committed) wav.delete()
    }
  }

  private fun hex(digest: MessageDigest): String = "sha256:" + digest.digest()
    .joinToString("") { "%02x".format(it.toInt() and 255) }
}
