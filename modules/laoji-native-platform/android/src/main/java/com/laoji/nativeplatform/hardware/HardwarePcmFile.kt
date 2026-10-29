package com.laoji.nativeplatform.hardware
import com.laoji.nativeplatform.audio.PcmWaveFile
import com.laoji.nativeplatform.audio.PcmWaveIntegrityException

import android.util.Log
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile

/** Stores only a contiguous trustworthy PCM prefix. A gap never becomes fabricated silence. */
internal class HardwarePcmFile(val file: File) : Closeable {
  private val output: RandomAccessFile
  private var lastSync = 0L
  init {
    file.parentFile?.mkdirs()
    output = RandomAccessFile(file, "rw")
    if (output.length() % 2L != 0L) output.setLength(output.length() - 1)
    output.seek(output.length())
  }
  @Synchronized fun size(): Long = output.length()
  @Synchronized fun append(offset: Long, bytes: ByteArray): Boolean {
    if (offset != output.length() || bytes.size % 2 != 0 || offset + bytes.size > 0xffffffffL - 36L) return false
    output.seek(offset)
    output.write(bytes)
    if (output.length() - lastSync >= 65536) sync()
    return true
  }
  @Synchronized fun sync() { output.fd.sync(); lastSync = output.length() }
  @Synchronized override fun close() { output.fd.sync(); output.close() }

  companion object {
    fun verifyAndCommit(file: File, store: HardwareRecordingStore, deviceId: String, recording: HardwareDeviceRecording): PendingHardwareRecording {
      val (id, wav) = store.deviceDownloadPart(deviceId, recording.recordingId, recording.generation)
      val hashes = try {
        HardwareDownloadOutput.storage { PcmWaveFile.fromPcm(file, wav, recording.audioBytes, recording.checksumSha256) }
      } catch (error: HardwareRuntimeException) {
        if (error.cause !is PcmWaveIntegrityException) throw error
        Log.w("LaojiHardware", "pcm_integrity_failed received_bytes=${file.length()} expected_bytes=${recording.audioBytes}")
        file.delete()
        throw HardwareRuntimeException("checksum_mismatch", "录音校验未通过，请重新接收。", error)
      }
      val result = store.commitDeviceDownload(id, wav, deviceId, recording.recordingId, recording.generation,
        recording.title, recording.createdEpochMs ?: System.currentTimeMillis(), recording.durationMs, wav.length(), hashes.fileSha256,
        recording.purpose, recording.captureId, recording.timeZone, recording.checksumSha256)
      file.delete()
      return result
    }
  }
}
