package com.laoji.nativeplatform.audio

import android.content.Context
import android.net.Uri
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** File producer for the existing schedule transport. No microphone, Meeting,
 * speaker job, base64 copy or second ASR protocol. Source survives failure. */
internal object AudioFileTranscriber {
  private val executor = Executors.newSingleThreadExecutor { Thread(it, "laoji-file-asr").apply { isDaemon = true } }
  fun transcribe(context: Context, uri: String, config: RecorderStartConfig): CompletableFuture<String> =
    CompletableFuture.supplyAsync({
      require(config.purpose == AudioPurpose.SCHEDULE)
      val file = File(requireNotNull(Uri.parse(uri).path)).canonicalFile
      require(file.toPath().startsWith(context.filesDir.canonicalFile.toPath()) ||
        file.toPath().startsWith(context.cacheDir.canonicalFile.toPath())) { "audio source is not app owned" }
      val layout = PcmWaveFile.inspect(file)
      val failure = AtomicReference<Throwable?>(null)
      val parts = linkedMapOf<String, String>()
      val socket = RealtimeAsrSocket(config, object : RealtimeAsrSocketListener {
        override fun onTranscript(transcript: AsrServerEvent.Transcript) {
          if (transcript.isFinal) synchronized(parts) { parts[AsrProtocol.transcriptIdentity(config.sessionId, transcript)] = transcript.text }
        }
        override fun onServerError(error: AsrServerEvent.Error) { failure.set(IllegalStateException("语音转写暂时不可用")) }
        override fun onTransportFailure(code: RecorderErrorCode, message: String) { failure.set(IllegalStateException("语音转写暂时不可用")) }
      })
      try {
        socket.connect().get(20, TimeUnit.SECONDS)
        RandomAccessFile(file, "r").use { input ->
          input.seek(layout.audioOffset)
          val bytes = ByteArray(6400); var left = layout.audioBytes
          while (left > 0) {
            failure.get()?.let { throw it }
            val count = minOf(left, bytes.size.toLong()).toInt()
            input.readFully(bytes, 0, count)
            check(socket.sendPcm(bytes, count)) { "语音转写连接已中断" }
            left -= count
            Thread.sleep(20)
          }
        }
        failure.get()?.let { throw it }
        check(socket.sendEndFrame()) { "语音转写未完成" }
        check(socket.awaitReadyToStop(maxOf(60_000L, layout.audioBytes / 32L * 2L)) == ReadyToStopOutcome.READY) { "语音转写未完成" }
        failure.get()?.let { throw it }
        synchronized(parts) { parts.values.joinToString("").trim() }.also {
          check(it.isNotBlank()) { "未识别到语音内容，请重新录音。" }
        }
      } finally { socket.cancel() }
    }, executor)
}
