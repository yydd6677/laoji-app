package com.laoji.nativeplatform.audio

// MIN-AUDIO-001: startup recovery repairs journaled PCM files without truncating completed audio.

import android.content.Context
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

object RecorderRecovery {
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "laoji-recorder-recovery").apply { isDaemon = true }
  }

  fun recover(context: Context, excludedSessionId: String? = null): CompletableFuture<RecordingRecoveryReport> {
    val future = CompletableFuture<RecordingRecoveryReport>()
    executor.execute {
      try {
        val report = RecordingRepository(context).recover(excludedSessionId)
        report.recordings.forEach { recording ->
          RecorderEventBus.emit(RecorderEvents.RECOVERED, recording.toMap())
        }
        report.failures.forEach { failure ->
          RecorderEventBus.emit(
            RecorderEvents.ERROR,
            mapOf(
              "sessionId" to null,
              "errorCode" to failure.code.wireValue,
              "errorMessage" to failure.message,
              "fileName" to failure.fileName,
              "recoverable" to true,
              "localUri" to null,
              "transcriptRecoveryRequired" to false,
            ),
          )
        }
        future.complete(report)
      } catch (_: Exception) {
        future.completeExceptionally(
          RecorderRuntimeException(RecorderErrorCode.RECOVERY_FAILED, "recording recovery failed"),
        )
      }
    }
    return future
  }
}
