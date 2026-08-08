package com.laoji.nativeplatform.audio

// MIN-AUDIO-001 / MIN-REC-STATE-001: AudioRecord, journaled WAV, and ASR share one lifecycle owner.

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.os.Process
import android.os.SystemClock
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.ArrayDeque

private const val MAX_PENDING_ASR_BYTES = 64 * 1024

interface RecorderEngineHost {
  fun onSnapshotChanged(snapshot: RecorderSnapshot)
  fun onUnexpectedStop(result: RecorderStopResult)
}

class RecorderEngine(
  context: Context,
  private val config: RecorderStartConfig,
  private val repository: RecordingRepository,
  private val host: RecorderEngineHost,
) : RealtimeAsrSocketListener {
  val sessionId: String
    get() = config.sessionId

  private val applicationContext = context.applicationContext
  private val stateLock = Any()
  private val recordControlLock = Any()
  private val commandExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "laoji-recorder-command").apply { isDaemon = true }
  }
  private val startFuture = CompletableFuture<RecorderSnapshot>()
  private val emergencyScheduled = AtomicBoolean(false)
  private val asrFailureReported = AtomicBoolean(false)
  private val asrConnectionHandled = AtomicBoolean(false)
  private val asrQueueLock = Any()
  private val pendingAsrFrames = ArrayDeque<ByteArray>()
  private var pendingAsrBytes = 0
  private var flushingPendingAsr = false

  @Volatile
  private var state = RecorderState.IDLE

  @Volatile
  private var paused = false

  @Volatile
  private var stopRequested = false

  @Volatile
  private var asrConnected = false

  @Volatile
  private var readyToStop = false

  @Volatile
  private var transcriptRecoveryRequired = false

  private var startedAtMs = 0L
  private var updatedAtMs = 0L
  private var localUri: String? = null
  private var errorCode: RecorderErrorCode? = null
  private var errorMessage: String? = null
  private var providerErrorCode: String? = null
  private var providerErrorRetryable: Boolean? = null
  private var audioRecord: AudioRecord? = null
  private var recordingThread: Thread? = null
  private var fileSession: RecordingFileSession? = null
  private var asrSocket: RealtimeAsrSocket? = null
  private var stopFuture: CompletableFuture<RecorderStopResult>? = null
  private var capturedAudioBars: List<Float>? = null

  fun start(): CompletableFuture<RecorderSnapshot> {
    commandExecutor.execute(::startInternal)
    return startFuture
  }

  fun pause(): CompletableFuture<RecorderSnapshot> = submitCommand {
    if (state == RecorderState.PAUSED) return@submitCommand snapshot()
    requireState(RecorderState.RECORDING)
    val recorder = audioRecord
      ?: throw RecorderRuntimeException(RecorderErrorCode.AUDIO_UNAVAILABLE, "audio recorder is unavailable")
    synchronized(recordControlLock) {
      paused = true
      try {
        if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
      } catch (_: Exception) {
        paused = false
        throw RecorderRuntimeException(RecorderErrorCode.AUDIO_UNAVAILABLE, "unable to pause recording")
      }
    }
    try {
      fileSession?.updateState(
        JournalState.PAUSED,
        currentJournalAsrState(),
      )
    } catch (_: Exception) {
      synchronized(recordControlLock) {
        try {
          recorder.startRecording()
          paused = false
        } catch (_: Exception) {
          scheduleEmergencyStop(RecorderErrorCode.STORAGE_FAILED, "recording journal could not be updated")
        }
      }
      throw RecorderRuntimeException(RecorderErrorCode.STORAGE_FAILED, "recording journal could not be updated")
    }
    transition(RecorderState.PAUSED)
  }

  fun resume(): CompletableFuture<RecorderSnapshot> = submitCommand {
    if (state == RecorderState.RECORDING) return@submitCommand snapshot()
    requireState(RecorderState.PAUSED)
    val recorder = audioRecord
      ?: throw RecorderRuntimeException(RecorderErrorCode.AUDIO_UNAVAILABLE, "audio recorder is unavailable")
    synchronized(recordControlLock) {
      try {
        recorder.startRecording()
        if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
          throw RecorderRuntimeException(RecorderErrorCode.AUDIO_UNAVAILABLE, "unable to resume recording")
        }
        paused = false
      } catch (error: RecorderRuntimeException) {
        throw error
      } catch (_: Exception) {
        throw RecorderRuntimeException(RecorderErrorCode.AUDIO_UNAVAILABLE, "unable to resume recording")
      }
    }
    try {
      fileSession?.updateState(
        JournalState.RECORDING,
        currentJournalAsrState(),
      )
    } catch (_: Exception) {
      synchronized(recordControlLock) {
        paused = true
        try {
          if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
        } catch (_: Exception) {
          scheduleEmergencyStop(RecorderErrorCode.STORAGE_FAILED, "recording journal could not be updated")
        }
      }
      throw RecorderRuntimeException(RecorderErrorCode.STORAGE_FAILED, "recording journal could not be updated")
    }
    transition(RecorderState.RECORDING)
  }

  fun stop(): CompletableFuture<RecorderStopResult> {
    synchronized(stateLock) {
      stopFuture?.let { return it }
      if (state == RecorderState.LOCAL_SAVED || state == RecorderState.FAILED) {
        val completed = CompletableFuture.completedFuture(terminalStopResult())
        stopFuture = completed
        return completed
      }
      return CompletableFuture<RecorderStopResult>().also { future ->
        stopFuture = future
        try {
          commandExecutor.execute {
            val result = stopInternal(waitForAsr = true, terminalError = null)
            future.complete(result)
            commandExecutor.shutdown()
          }
        } catch (_: Exception) {
          future.completeExceptionally(
            RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "recording session is no longer active"),
          )
        }
      }
    }
  }

  fun snapshot(): RecorderSnapshot = synchronized(stateLock) {
    RecorderSnapshot(
      sessionId = config.sessionId,
      purpose = config.purpose,
      mode = config.mode,
      storageScope = config.storageScope,
      state = state,
      startedAtMs = startedAtMs,
      updatedAtMs = updatedAtMs,
      bytesRecorded = fileSession?.pcmBytes ?: 0L,
      localUri = localUri,
      asrConnected = asrConnected,
      readyToStop = readyToStop,
      transcriptRecoveryRequired = transcriptRecoveryRequired,
      errorCode = errorCode,
      errorMessage = errorMessage,
      providerErrorCode = providerErrorCode,
      providerErrorRetryable = providerErrorRetryable,
    )
  }

  fun shutdownForServiceDestroy(timeoutMs: Long = 3_000L) {
    val active = state == RecorderState.PREPARING ||
      state == RecorderState.RECORDING ||
      state == RecorderState.PAUSED ||
      state == RecorderState.STOPPING
    if (!active) {
      asrSocket?.close()
      commandExecutor.shutdown()
      return
    }
    stopRequested = true
    asrSocket?.cancel()
    stopCapture()
    val future = synchronized(stateLock) {
      stopFuture ?: CompletableFuture<RecorderStopResult>().also { created ->
        stopFuture = created
        try {
          commandExecutor.execute {
            created.complete(
              stopInternal(
                waitForAsr = false,
                terminalError = RecorderFailure(
                  RecorderErrorCode.SERVICE_UNAVAILABLE,
                  if (config.mode == RecorderMode.REALTIME) {
                    "recording service stopped before realtime transcription completed"
                  } else {
                    "recording service stopped before local recording completed"
                  },
                ),
              ),
            )
          }
        } catch (_: Exception) {
          created.completeExceptionally(
            RecorderRuntimeException(
              RecorderErrorCode.SERVICE_UNAVAILABLE,
              "recording session stopped while service cleanup was starting",
            ),
          )
        }
      }
    }
    try {
      future.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: Exception) {
      stopCapture()
    } finally {
      commandExecutor.shutdown()
    }
  }

  override fun onTranscript(transcript: AsrServerEvent.Transcript) {
    if (config.mode != RecorderMode.REALTIME) return
    val currentState = state
    if (currentState == RecorderState.IDLE || currentState == RecorderState.FAILED) return
    RecorderEventBus.emit(
      RecorderEvents.TRANSCRIPT,
      mapOf(
        "sessionId" to config.sessionId,
        "segmentId" to AsrProtocol.transcriptIdentity(config.sessionId, transcript),
        "kind" to if (transcript.isFinal) "final" else "partial",
        "isFinal" to transcript.isFinal,
        "text" to transcript.text,
        "speakerId" to transcript.speakerId,
        "speakerName" to transcript.speakerName,
        "speakerConfidence" to transcript.speakerConfidence,
        "startMs" to transcript.startMs?.toDouble(),
        "endMs" to transcript.endMs?.toDouble(),
        "source" to transcript.source,
        "purpose" to config.purpose.wireValue,
        "receivedAtMs" to System.currentTimeMillis().toDouble(),
      ),
    )
  }

  override fun onServerError(error: AsrServerEvent.Error) {
    if (config.mode != RecorderMode.REALTIME) return
    // The socket can deliver a queued error while stop is finalizing.  Once
    // the local file is terminal, a late server warning must not re-open a
    // failed-looking recorder state.
    if (state == RecorderState.LOCAL_SAVED || state == RecorderState.FAILED) return
    synchronized(stateLock) {
      errorCode = RecorderErrorCode.SERVER_ERROR
      errorMessage = error.detail
      providerErrorCode = error.code
      providerErrorRetryable = error.retryable
      transcriptRecoveryRequired = config.purpose == AudioPurpose.MEETING
      updatedAtMs = System.currentTimeMillis()
    }
    emitError(
      RecorderErrorCode.SERVER_ERROR,
      error.detail,
      recoverable = true,
      providerCode = error.code,
      providerRetryable = error.retryable,
    )
    publishSnapshot()
  }

  override fun onTransportFailure(code: RecorderErrorCode, message: String) {
    if (config.mode != RecorderMode.REALTIME) return
    markAsrUnavailable(code, message)
  }

  private fun startInternal() {
    startedAtMs = System.currentTimeMillis()
    updatedAtMs = startedAtMs
    RecorderLevelHub.reset(config.sessionId)
    try {
      transition(RecorderState.PREPARING)
      ensureRecordPermission()
      fileSession = repository.createSession(config, startedAtMs)

      val recorder = createAudioRecord()
      audioRecord = recorder
      if (stopRequested) {
        throw RecorderRuntimeException(
          RecorderErrorCode.SERVICE_UNAVAILABLE,
          "recording service stopped during startup",
        )
      }
      recorder.startRecording()
      if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        throw RecorderRuntimeException(RecorderErrorCode.AUDIO_UNAVAILABLE, "microphone did not start recording")
      }
      if (stopRequested) {
        throw RecorderRuntimeException(
          RecorderErrorCode.SERVICE_UNAVAILABLE,
          "recording service stopped during startup",
        )
      }
      paused = false
      fileSession?.updateState(JournalState.RECORDING, currentJournalAsrState())
      if (stopRequested) {
        throw RecorderRuntimeException(
          RecorderErrorCode.SERVICE_UNAVAILABLE,
          "recording service stopped during startup",
        )
      }
      transition(RecorderState.RECORDING)
      startRecordingThread(recorder)
      startFuture.complete(snapshot())
      // Local capture is the latency-critical path. Start it as soon as the
      // microphone is ready and establish the realtime ASR socket in parallel;
      // frames are journaled locally and buffered briefly until onOpen. This
      // removes the network round trip from the user's recording start while
      // preserving the same transcript/recovery behavior when the service is
      // slow or temporarily unavailable.
      if (config.mode == RecorderMode.REALTIME) {
        val asrConnection = startRealtimeAsrConnection()
        observeRealtimeAsrConnection(asrConnection)
      }
    } catch (error: RecorderRuntimeException) {
      failStart(error)
    } catch (_: Exception) {
      failStart(
        RecorderRuntimeException(
          RecorderErrorCode.AUDIO_UNAVAILABLE,
          "unable to start native recording",
        ),
      )
    }
  }

  private fun startRealtimeAsrConnection(): CompletableFuture<Unit> {
    val socket = RealtimeAsrSocket(config, this)
    asrSocket = socket
    asrConnectionHandled.set(false)
    return try {
      socket.connect()
    } catch (error: Exception) {
      CompletableFuture<Unit>().also { failed -> failed.completeExceptionally(error) }
    }
  }

  private fun observeRealtimeAsrConnection(connection: CompletableFuture<Unit>) {
    Thread({
      val failure = try {
        connection.get(config.connectionTimeoutMs + 500L, TimeUnit.MILLISECONDS)
        null
      } catch (error: Exception) {
        asrSocket?.cancel()
        error
      }
      try {
        commandExecutor.execute { finishRealtimeAsrConnection(failure) }
      } catch (_: Exception) {
        // The recorder may already be stopping; its terminal path owns cleanup.
      }
    }, "laoji-asr-connect").apply {
      isDaemon = true
      start()
    }
  }

  private fun finishRealtimeAsrConnection(failure: Throwable?) {
    if (!asrConnectionHandled.compareAndSet(false, true)) return
    if (stopRequested || state == RecorderState.LOCAL_SAVED || state == RecorderState.FAILED) {
      asrSocket?.close()
      return
    }
    if (failure != null || asrSocket?.isOpen() != true) {
      markAsrUnavailable(
        RecorderErrorCode.WEBSOCKET_CONNECT_FAILED,
        if (failure != null) "实时语音服务连接失败" else "实时语音服务连接已关闭",
      )
      return
    }
    asrConnected = true
    try {
      fileSession?.updateAsrState(JournalAsrState.CONNECTED)
    } catch (_: Exception) {
      // The audio stream remains usable; the final journal will reconcile it.
    }
    flushPendingAsrFrames()
    publishSnapshot()
  }

  @SuppressLint("MissingPermission")
  private fun createAudioRecord(): AudioRecord {
    val minimum = AudioRecord.getMinBufferSize(
      AudioRuntimeContract.SAMPLE_RATE_HZ,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    if (minimum <= 0) {
      throw RecorderRuntimeException(RecorderErrorCode.AUDIO_UNAVAILABLE, "16 kHz PCM recording is unavailable")
    }
    val internalBufferSize = maxOf(minimum * 2, AudioRuntimeContract.FRAME_BYTES * 2)
    val recorder = try {
      AudioRecord(
        config.purpose.audioSource,
        AudioRuntimeContract.SAMPLE_RATE_HZ,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        internalBufferSize,
      )
    } catch (_: SecurityException) {
      throw RecorderRuntimeException(RecorderErrorCode.PERMISSION_DENIED, "microphone permission is required")
    } catch (_: Exception) {
      throw RecorderRuntimeException(RecorderErrorCode.AUDIO_UNAVAILABLE, "unable to initialize AudioRecord")
    }
    if (recorder.state != AudioRecord.STATE_INITIALIZED) {
      recorder.release()
      throw RecorderRuntimeException(RecorderErrorCode.AUDIO_UNAVAILABLE, "AudioRecord initialization failed")
    }
    return recorder
  }

  private fun startRecordingThread(recorder: AudioRecord) {
    recordingThread = Thread({ recordingLoop(recorder) }, "laoji-recorder-audio").apply {
      isDaemon = true
      start()
    }
  }

  private fun recordingLoop(recorder: AudioRecord) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    val buffer = ByteArray(AudioRuntimeContract.FRAME_BYTES)
    var lastLevelAtMs = Long.MIN_VALUE
    while (!stopRequested) {
      if (paused) {
        SystemClock.sleep(20L)
        continue
      }
      val read = try {
        recorder.read(buffer, 0, buffer.size)
      } catch (_: Exception) {
        if (!stopRequested && !paused) {
          scheduleEmergencyStop(
            RecorderErrorCode.AUDIO_READ_FAILED,
            "microphone read failed",
          )
        }
        break
      }
      if (read <= 0) {
        if (!stopRequested && !paused) {
          scheduleEmergencyStop(
            RecorderErrorCode.AUDIO_READ_FAILED,
            "microphone returned an invalid audio frame",
          )
          break
        }
        continue
      }
      if (stopRequested || paused) continue

      val append = try {
        requireNotNull(fileSession).append(buffer, read)
      } catch (_: Exception) {
        scheduleEmergencyStop(RecorderErrorCode.STORAGE_FAILED, "recording could not be written to storage")
        break
      }
      if (append.bytesWritten > 0 && config.mode == RecorderMode.REALTIME) {
        sendOrQueueAsrFrame(buffer.copyOf(append.bytesWritten))
      }

      val now = SystemClock.elapsedRealtime()
      if (lastLevelAtMs == Long.MIN_VALUE || now - lastLevelAtMs >= config.levelIntervalMs) {
        val level = Pcm16Math.measure(buffer, append.bytesWritten)
        val durationMs = append.totalPcmBytes * 1_000L / AudioRuntimeContract.BYTES_PER_SECOND
        RecorderLevelHub.publish(
          sessionId = config.sessionId,
          normalized = level.normalized.toFloat(),
          peak = level.peak,
          rms = level.rms,
          durationMs = durationMs,
          capturedAtElapsedMs = now,
        )
        if (config.purpose != AudioPurpose.MEETING) {
          RecorderEventBus.emit(
            RecorderEvents.LEVEL,
            mapOf(
              "sessionId" to config.sessionId,
              "peak" to level.peak,
              "rms" to level.rms,
              "normalized" to level.normalized,
              "bytesRecorded" to append.totalPcmBytes.toDouble(),
              "durationMs" to durationMs.toDouble(),
            ),
          )
        }
        lastLevelAtMs = now
      }
      if (append.limitReached) {
        scheduleEmergencyStop(RecorderErrorCode.STORAGE_LIMIT, "recording reached the 1 GB local limit")
        break
      }
    }
  }

  private fun stopInternal(waitForAsr: Boolean, terminalError: RecorderFailure?): RecorderStopResult {
    val currentState = state
    if (currentState == RecorderState.LOCAL_SAVED || currentState == RecorderState.FAILED) {
      return terminalStopResult()
    }

    if (currentState == RecorderState.IDLE) {
      val failure = RecorderFailure(RecorderErrorCode.SESSION_MISMATCH, "recording session has not started")
      return failedStopResult(failure)
    }

    if (state != RecorderState.STOPPING) transition(RecorderState.STOPPING)
    try {
      fileSession?.updateState(
        JournalState.STOPPING,
        if (config.mode == RecorderMode.LOCAL_ONLY) {
          JournalAsrState.NOT_REQUIRED
        } else if (asrConnected) {
          JournalAsrState.WAITING_READY
        } else {
          JournalAsrState.FAILED
        },
      )
    } catch (_: Exception) {
      // Finalization writes a complete journal after the WAV has been synced and renamed.
    }
    stopCapture()

    val finalized = try {
      requireNotNull(fileSession).finalizeRecording(
        if (config.mode == RecorderMode.LOCAL_ONLY) {
          JournalAsrState.NOT_REQUIRED
        } else if (asrConnected && waitForAsr) {
          JournalAsrState.WAITING_READY
        } else {
          JournalAsrState.FAILED
        },
      )
    } catch (_: Exception) {
      asrSocket?.cancel()
      val failure = RecorderFailure(RecorderErrorCode.STORAGE_FAILED, "recording file could not be finalized")
      return failedStopResult(failure)
    }
    localUri = finalized.uri
    transition(RecorderState.LOCAL_SAVED)

    var failure = terminalError
    if (waitForAsr && asrConnected) {
      val socket = asrSocket
      val outcome = if (socket?.sendEndFrame() == true) {
        try {
          socket.awaitReadyToStop(config.stopTimeoutMs)
        } catch (_: InterruptedException) {
          Thread.currentThread().interrupt()
          ReadyToStopOutcome.CLOSED
        }
      } else {
        ReadyToStopOutcome.END_FRAME_REJECTED
      }
      when (outcome) {
        ReadyToStopOutcome.READY -> {
          readyToStop = true
          try {
            // A server-side warning can be emitted while the local recorder
            // keeps capturing.  If the final drain succeeds, that warning is
            // recoverable metadata rather than a terminal recording failure;
            // keep transcriptRecoveryRequired for a later background retry,
            // but do not let SERVER_ERROR poison the stop result.
            val needsTranscriptRecovery = clearRecoverableServerErrorAfterReady()
            fileSession?.updateAsrState(
              if (needsTranscriptRecovery) JournalAsrState.FAILED else JournalAsrState.READY,
            )
          } catch (_: Exception) {
            failure = failure ?: RecorderFailure(
              RecorderErrorCode.STORAGE_FAILED,
              "recording completion journal could not be updated",
            )
          }
        }
        ReadyToStopOutcome.LEGACY_TIMEOUT -> failure = failure ?: RecorderFailure(
          RecorderErrorCode.READY_TO_STOP_TIMEOUT,
          "realtime transcription did not confirm ready_to_stop",
        )
        ReadyToStopOutcome.ACK_TIMEOUT -> failure = failure ?: RecorderFailure(
          RecorderErrorCode.STOP_ACK_TIMEOUT,
          "realtime transcription did not acknowledge the stop request",
        )
        ReadyToStopOutcome.DRAIN_TIMEOUT -> failure = failure ?: RecorderFailure(
          RecorderErrorCode.FINAL_DRAIN_TIMEOUT,
          "realtime transcription did not finish the final drain",
        )
        ReadyToStopOutcome.CLOSED -> failure = failure ?: RecorderFailure(
          RecorderErrorCode.WEBSOCKET_DISCONNECTED,
          "realtime transcription closed before ready_to_stop",
        )
        ReadyToStopOutcome.END_FRAME_REJECTED -> failure = failure ?: RecorderFailure(
          RecorderErrorCode.WEBSOCKET_SEND_FAILED,
          "realtime transcription end frame was not accepted",
        )
      }
    } else if (config.mode == RecorderMode.REALTIME && failure == null) {
      failure = RecorderFailure(
        RecorderErrorCode.WEBSOCKET_DISCONNECTED,
        "realtime transcription was unavailable when recording stopped",
      )
    }

    asrConnected = false
    asrSocket?.close()
    val priorAsrError = if (config.mode == RecorderMode.REALTIME) {
      synchronized(stateLock) {
        errorCode?.let { RecorderFailure(it, errorMessage ?: "realtime transcription failed") }
      }
    } else {
      null
    }
    failure = failure ?: priorAsrError
    if (failure != null) {
      try {
        fileSession?.updateAsrState(
          if (config.mode == RecorderMode.LOCAL_ONLY) JournalAsrState.NOT_REQUIRED else JournalAsrState.FAILED,
        )
      } catch (_: Exception) {
        // The local-saved journal remains uploadable even if its ASR status update fails.
      }
      synchronized(stateLock) {
        errorCode = failure.code
        errorMessage = failure.message
        transcriptRecoveryRequired = config.purpose == AudioPurpose.MEETING
      }
      if (state != RecorderState.FAILED) transition(RecorderState.FAILED)
      emitError(failure.code, failure.message, recoverable = localUri != null)
    } else {
      publishSnapshot()
    }

    val finalSnapshot = snapshot()
    return RecorderStopResult(
      snapshot = finalSnapshot,
      localSaved = finalSnapshot.localUri != null,
      readyToStop = finalSnapshot.readyToStop,
      errorCode = failure?.code,
      errorMessage = failure?.message,
      audioBars = captureAudioBars(),
    )
  }

  private fun stopCapture() {
    stopRequested = true
    synchronized(recordControlLock) {
      try {
        audioRecord?.let { recorder ->
          if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
        }
      } catch (_: Exception) {
        // The recording loop and journal still own the buffered PCM already read.
      }
    }
    recordingThread?.let { thread ->
      try {
        thread.join(2_000L)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
      if (thread.isAlive) thread.interrupt()
    }
    recordingThread = null
    try {
      audioRecord?.release()
    } catch (_: Exception) {
      // Release is best effort after capture has stopped.
    }
    audioRecord = null
  }

  private fun failStart(error: RecorderRuntimeException) {
    stopRequested = true
    stopCapture()
    asrConnected = false
    asrSocket?.cancel()
    try {
      fileSession?.discardIfEmpty()
    } catch (_: Exception) {
      // A remaining journal is repaired on the next recovery scan.
    }
    synchronized(stateLock) {
      errorCode = error.errorCode
      errorMessage = error.message
    }
    if (state != RecorderState.FAILED) transition(RecorderState.FAILED)
    captureAudioBars()
    emitError(error.errorCode, error.message, recoverable = false)
    startFuture.completeExceptionally(error)
    commandExecutor.shutdown()
  }

  private fun scheduleEmergencyStop(code: RecorderErrorCode, message: String) {
    if (stopRequested || !emergencyScheduled.compareAndSet(false, true)) return
    val failure = RecorderFailure(code, message)
    val future = synchronized(stateLock) {
      if (stopFuture != null) return
      CompletableFuture<RecorderStopResult>().also { stopFuture = it }
    }
    commandExecutor.execute {
      val result = stopInternal(waitForAsr = true, terminalError = failure)
      future.complete(result)
      try {
        host.onUnexpectedStop(result)
      } catch (_: Exception) {
        // Service cleanup must not prevent executor shutdown.
      }
      commandExecutor.shutdown()
    }
  }

  private fun markAsrUnavailable(code: RecorderErrorCode, message: String) {
    if (config.mode != RecorderMode.REALTIME) return
    asrConnected = false
    synchronized(asrQueueLock) {
      pendingAsrFrames.clear()
      pendingAsrBytes = 0
      flushingPendingAsr = false
    }
    transcriptRecoveryRequired = config.purpose == AudioPurpose.MEETING
    try {
      fileSession?.updateAsrState(JournalAsrState.FAILED)
    } catch (_: Exception) {
      // Local PCM persistence continues even if a journal status update fails here.
    }
    synchronized(stateLock) {
      if (errorCode == null) {
        errorCode = code
        errorMessage = message
      }
      updatedAtMs = System.currentTimeMillis()
    }
    if (asrFailureReported.compareAndSet(false, true)) {
      emitError(code, message, recoverable = true)
      publishSnapshot()
    }
  }

  private fun currentJournalAsrState(): JournalAsrState = when {
    config.mode == RecorderMode.LOCAL_ONLY -> JournalAsrState.NOT_REQUIRED
    asrConnected -> JournalAsrState.CONNECTED
    asrSocket != null -> JournalAsrState.CONNECTING
    else -> JournalAsrState.FAILED
  }

  private fun sendOrQueueAsrFrame(frame: ByteArray) {
    val sendNow = synchronized(asrQueueLock) {
      if (!asrConnected || flushingPendingAsr) {
        if (pendingAsrBytes + frame.size <= MAX_PENDING_ASR_BYTES) {
          pendingAsrFrames.addLast(frame)
          pendingAsrBytes += frame.size
        }
        false
      } else {
        true
      }
    }
    if (sendNow && asrSocket?.sendPcm(frame, frame.size) != true) {
      markAsrUnavailable(
        RecorderErrorCode.WEBSOCKET_SEND_FAILED,
        "实时语音服务暂时无法接收音频",
      )
    }
  }

  private fun flushPendingAsrFrames() {
    synchronized(asrQueueLock) { flushingPendingAsr = true }
    while (true) {
      val frame = synchronized(asrQueueLock) {
        if (!asrConnected) {
          flushingPendingAsr = false
          return
        }
        pendingAsrFrames.pollFirst()?.also { pendingAsrBytes -= it.size }
          ?: run {
            flushingPendingAsr = false
            return
          }
      }
      if (asrSocket?.sendPcm(frame, frame.size) != true) {
        markAsrUnavailable(
          RecorderErrorCode.WEBSOCKET_SEND_FAILED,
          "实时语音服务暂时无法接收音频",
        )
        return
      }
    }
  }

  private fun clearRecoverableServerErrorAfterReady(): Boolean {
    synchronized(stateLock) {
      val needsTranscriptRecovery =
        errorCode == RecorderErrorCode.SERVER_ERROR && transcriptRecoveryRequired
      if (errorCode == RecorderErrorCode.SERVER_ERROR) {
        errorCode = null
        errorMessage = null
        providerErrorCode = null
        providerErrorRetryable = null
      }
      return needsTranscriptRecovery
    }
  }

  private fun failedStopResult(failure: RecorderFailure): RecorderStopResult {
    synchronized(stateLock) {
      errorCode = failure.code
      errorMessage = failure.message
      updatedAtMs = System.currentTimeMillis()
      if (RecorderStateMachine.canTransition(state, RecorderState.FAILED)) state = RecorderState.FAILED
    }
    emitError(failure.code, failure.message, recoverable = localUri != null)
    publishSnapshot()
    val failedSnapshot = snapshot()
    return RecorderStopResult(
      snapshot = failedSnapshot,
      localSaved = failedSnapshot.localUri != null,
      readyToStop = false,
      errorCode = failure.code,
      errorMessage = failure.message,
      audioBars = captureAudioBars(),
    )
  }

  private fun captureAudioBars(): List<Float> = synchronized(stateLock) {
    capturedAudioBars ?: RecorderLevelHub.captureSummaryAndClear(config.sessionId).also {
      capturedAudioBars = it
    }
  }

  private fun terminalStopResult(): RecorderStopResult {
    val current = snapshot()
    return RecorderStopResult(
      snapshot = current,
      localSaved = current.localUri != null,
      readyToStop = current.readyToStop,
      errorCode = current.errorCode,
      errorMessage = current.errorMessage,
      audioBars = captureAudioBars(),
    )
  }

  private fun ensureRecordPermission() {
    if (applicationContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      throw RecorderRuntimeException(RecorderErrorCode.PERMISSION_DENIED, "microphone permission is required")
    }
  }

  private fun requireState(required: RecorderState) {
    if (state != required) {
      throw RecorderRuntimeException(
        RecorderErrorCode.SESSION_MISMATCH,
        "recording session is ${state.wireValue}, expected ${required.wireValue}",
      )
    }
  }

  private fun transition(next: RecorderState): RecorderSnapshot {
    synchronized(stateLock) {
      if (!RecorderStateMachine.canTransition(state, next)) {
        throw RecorderRuntimeException(
          RecorderErrorCode.SESSION_MISMATCH,
          "invalid recorder transition ${state.wireValue} -> ${next.wireValue}",
        )
      }
      state = next
      updatedAtMs = System.currentTimeMillis()
    }
    return publishSnapshot()
  }

  private fun publishSnapshot(): RecorderSnapshot = snapshot().also { current ->
    try {
      host.onSnapshotChanged(current)
    } catch (_: Exception) {
      // Notification delivery is secondary to recording and persistence.
    }
    RecorderEventBus.emit(RecorderEvents.STATE_CHANGED, current.toMap())
  }

  private fun emitError(
    code: RecorderErrorCode,
    message: String,
    recoverable: Boolean,
    providerCode: String? = null,
    providerRetryable: Boolean? = null,
  ) {
    RecorderEventBus.emit(
      RecorderEvents.ERROR,
      mapOf(
        "sessionId" to config.sessionId,
        "errorCode" to code.wireValue,
        "errorMessage" to message,
        "recoverable" to recoverable,
        "localUri" to localUri,
        "transcriptRecoveryRequired" to transcriptRecoveryRequired,
        "providerCode" to providerCode,
        "providerRetryable" to providerRetryable,
      ),
    )
  }

  private fun <T> submitCommand(block: () -> T): CompletableFuture<T> {
    val future = CompletableFuture<T>()
    try {
      commandExecutor.execute {
        try {
          future.complete(block())
        } catch (error: RecorderRuntimeException) {
          future.completeExceptionally(error)
        } catch (_: Exception) {
          future.completeExceptionally(
            RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "native recorder command failed"),
          )
        }
      }
    } catch (_: Exception) {
      future.completeExceptionally(
        RecorderRuntimeException(RecorderErrorCode.SERVICE_UNAVAILABLE, "native recorder command failed"),
      )
    }
    return future
  }

  private data class RecorderFailure(val code: RecorderErrorCode, val message: String)
}
