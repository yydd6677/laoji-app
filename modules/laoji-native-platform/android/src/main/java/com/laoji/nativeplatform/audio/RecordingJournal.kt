package com.laoji.nativeplatform.audio

// MIN-AUDIO-001: crash-safe journal entries precede atomic WAV completion.

import android.content.Context
import android.net.Uri
import android.system.Os
import android.system.OsConstants
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.UUID

private const val RECORDINGS_DIRECTORY = "laoji-recordings"
private const val JOURNAL_SUFFIX = ".journal.json"
private const val PART_SUFFIX = ".wav.part"
private const val CHECKPOINT_BYTES = 1_048_576L
private val recordingIoLock = Any()

enum class JournalState(val wireValue: String) {
  PREPARING("preparing"),
  RECORDING("recording"),
  PAUSED("paused"),
  STOPPING("stopping"),
  LOCAL_SAVED("local_saved"),
  FAILED("failed");

  companion object {
    fun fromWireValue(value: String): JournalState = entries.firstOrNull { it.wireValue == value }
      ?: FAILED
  }
}

enum class JournalAsrState(val wireValue: String) {
  CONNECTING("connecting"),
  CONNECTED("connected"),
  WAITING_READY("waiting_ready"),
  READY("ready"),
  FAILED("failed"),
  NOT_REQUIRED("not_required"),
}

object RecordingPersistencePolicy {
  fun initialUploadState(mode: RecorderMode): String = when (mode) {
    RecorderMode.REALTIME -> "not_ready"
    RecorderMode.LOCAL_ONLY -> "not_applicable"
  }

  fun completedUploadState(mode: RecorderMode): String = when (mode) {
    RecorderMode.REALTIME -> "pending"
    RecorderMode.LOCAL_ONLY -> "not_applicable"
  }

  fun initialAsrState(mode: RecorderMode): JournalAsrState = when (mode) {
    RecorderMode.REALTIME -> JournalAsrState.CONNECTING
    RecorderMode.LOCAL_ONLY -> JournalAsrState.NOT_REQUIRED
  }

  fun recoveredAsrState(mode: RecorderMode): JournalAsrState = when (mode) {
    RecorderMode.REALTIME -> JournalAsrState.FAILED
    RecorderMode.LOCAL_ONLY -> JournalAsrState.NOT_REQUIRED
  }
}

internal object WavFileRepair {
  fun repairInPlace(file: File): Long {
    val randomAccessFile = RandomAccessFile(file, "rw")
    try {
      if (randomAccessFile.length() < AudioRuntimeContract.WAV_HEADER_BYTES) {
        randomAccessFile.setLength(AudioRuntimeContract.WAV_HEADER_BYTES.toLong())
      }
      val pcmBytes = WavRecoveryMath.alignedPcmBytes(randomAccessFile.length())
      val header = ByteArray(AudioRuntimeContract.WAV_HEADER_BYTES)
      randomAccessFile.seek(0L)
      randomAccessFile.readFully(header)
      val repairedLength = AudioRuntimeContract.WAV_HEADER_BYTES + pcmBytes
      if (randomAccessFile.length() != repairedLength || !WavHeader.isPlausible(header, repairedLength)) {
        randomAccessFile.setLength(repairedLength)
        randomAccessFile.seek(0L)
        randomAccessFile.write(WavHeader.create(pcmBytes))
      }
      randomAccessFile.fd.sync()
      return pcmBytes
    } finally {
      randomAccessFile.close()
    }
  }
}

data class RecordingJournalEntry(
  val schemaVersion: Int,
  val sessionId: String,
  val purpose: AudioPurpose,
  val mode: RecorderMode,
  val storageScope: String?,
  val state: JournalState,
  val tempFileName: String,
  val finalFileName: String,
  val pcmBytes: Long,
  val startedAtMs: Long,
  val updatedAtMs: Long,
  val recovered: Boolean,
  val uploadState: String,
  val asrState: JournalAsrState,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("schema_version", schemaVersion)
    .put("session_id", sessionId)
    .put("purpose", purpose.wireValue)
    .put("mode", mode.wireValue)
    .put("storage_scope", storageScope)
    .put("state", state.wireValue)
    .put("temp_file", tempFileName)
    .put("final_file", finalFileName)
    .put("pcm_bytes", pcmBytes)
    .put("started_at_ms", startedAtMs)
    .put("updated_at_ms", updatedAtMs)
    .put("recovered", recovered)
    .put("upload_state", uploadState)
    .put("asr_state", asrState.wireValue)

  companion object {
    fun fromJson(json: JSONObject): RecordingJournalEntry {
      val schemaVersion = json.getInt("schema_version")
      require(schemaVersion == AudioRuntimeContract.JOURNAL_SCHEMA_VERSION) { "unsupported journal schema" }
      val sessionId = RecorderStartConfig.validateSessionId(json.getString("session_id"))
      val purpose = AudioPurpose.fromWireValue(json.getString("purpose"))
      val tempFileName = requireSafeFileName(json.getString("temp_file"))
      val finalFileName = requireSafeFileName(json.getString("final_file"))
      return RecordingJournalEntry(
        schemaVersion = schemaVersion,
        sessionId = sessionId,
        purpose = purpose,
        mode = RecorderMode.fromWireValue(json.optString("mode", RecorderMode.REALTIME.wireValue)),
        storageScope = RecorderStartConfig.normalizeStorageScope(
          json.optString("storage_scope", "").trim().takeIf { it.isNotEmpty() },
        ),
        state = JournalState.fromWireValue(json.optString("state")),
        tempFileName = tempFileName,
        finalFileName = finalFileName,
        pcmBytes = json.optLong("pcm_bytes").coerceAtLeast(0L),
        startedAtMs = json.optLong("started_at_ms").coerceAtLeast(0L),
        updatedAtMs = json.optLong("updated_at_ms").coerceAtLeast(0L),
        recovered = json.optBoolean("recovered", false),
        uploadState = json.optString("upload_state", "not_ready"),
        asrState = JournalAsrState.entries.firstOrNull {
          it.wireValue == json.optString("asr_state")
        } ?: JournalAsrState.FAILED,
      )
    }

    private fun requireSafeFileName(value: String): String {
      require(value.isNotBlank() && File(value).name == value && !value.contains('/') && !value.contains('\\')) {
        "unsafe journal file name"
      }
      return value
    }
  }
}

data class AppendResult(
  val bytesWritten: Int,
  val totalPcmBytes: Long,
  val limitReached: Boolean,
)

data class FinalizedRecording(
  val sessionId: String,
  val purpose: AudioPurpose,
  val mode: RecorderMode,
  val storageScope: String?,
  val uri: String,
  val pcmBytes: Long,
  val durationMs: Long,
  val recovered: Boolean,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "sessionId" to sessionId,
    "purpose" to purpose.wireValue,
    "mode" to mode.wireValue,
    "storageScope" to storageScope,
    "localUri" to uri,
    "bytesRecorded" to pcmBytes.toDouble(),
    "durationMs" to durationMs.toDouble(),
    "recovered" to recovered,
  )
}

data class RecoveryFailure(
  val sessionId: String?,
  val fileName: String,
  val code: RecorderErrorCode,
  val message: String,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "sessionId" to sessionId,
    "fileName" to fileName,
    "errorCode" to code.wireValue,
    "errorMessage" to message,
  )
}

data class RecordingRecoveryReport(
  val recordings: List<FinalizedRecording>,
  val failures: List<RecoveryFailure>,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "recordings" to recordings.map { it.toMap() },
    "failures" to failures.map { it.toMap() },
  )
}

class RecordingRepository(context: Context) {
  private val root = File(context.applicationContext.filesDir, RECORDINGS_DIRECTORY)

  fun createSession(config: RecorderStartConfig, startedAtMs: Long): RecordingFileSession =
    synchronized(recordingIoLock) {
      ensureRoot()
      val stem = RecorderStartConfig.safeFileStem(config.sessionId)
      val nonce = UUID.randomUUID().toString().replace("-", "").take(12)
      val baseName = "$stem-$startedAtMs-$nonce"
      val tempFile = File(root, "$baseName$PART_SUFFIX")
      val finalFile = File(root, "$baseName.wav")
      val journalFile = File(root, "$baseName$JOURNAL_SUFFIX")
      val randomAccessFile = RandomAccessFile(tempFile, "rw")
      try {
        randomAccessFile.setLength(0L)
        randomAccessFile.write(WavHeader.create(0L))
        randomAccessFile.fd.sync()
        val entry = RecordingJournalEntry(
          schemaVersion = AudioRuntimeContract.JOURNAL_SCHEMA_VERSION,
          sessionId = config.sessionId,
          purpose = config.purpose,
          mode = config.mode,
          storageScope = config.storageScope,
          state = JournalState.PREPARING,
          tempFileName = tempFile.name,
          finalFileName = finalFile.name,
          pcmBytes = 0L,
          startedAtMs = startedAtMs,
          updatedAtMs = startedAtMs,
          recovered = false,
          uploadState = RecordingPersistencePolicy.initialUploadState(config.mode),
          asrState = RecordingPersistencePolicy.initialAsrState(config.mode),
        )
        writeJournal(journalFile, entry)
        RecordingFileSession(this, randomAccessFile, journalFile, entry)
      } catch (error: Exception) {
        randomAccessFile.close()
        tempFile.delete()
        journalFile.delete()
        throw RecorderRuntimeException(RecorderErrorCode.STORAGE_FAILED, "unable to initialize recording files")
      }
    }

  fun recover(
    excludedSessionId: String? = null,
    includeFinalized: Boolean = false,
  ): RecordingRecoveryReport = synchronized(recordingIoLock) {
    ensureRoot()
    recoverJournalWriteTemps()
    val recovered = mutableListOf<FinalizedRecording>()
    val failures = mutableListOf<RecoveryFailure>()
    val referencedParts = mutableSetOf<String>()
    val referencedFinals = mutableSetOf<String>()

    root.listFiles { file -> file.isFile && file.name.endsWith(JOURNAL_SUFFIX) }
      .orEmpty()
      .sortedBy { it.name }
      .forEach { journalFile ->
        val entry = try {
          readJournal(journalFile)
        } catch (_: Exception) {
          failures += RecoveryFailure(
            null,
            journalFile.name,
            RecorderErrorCode.RECOVERY_FAILED,
            "recording journal is invalid",
          )
          return@forEach
        }
        referencedParts += entry.tempFileName
        referencedFinals += entry.finalFileName
        if (entry.sessionId == excludedSessionId) return@forEach

        try {
          val finalFile = File(root, entry.finalFileName)
          val tempFile = File(root, entry.tempFileName)
          when {
            finalFile.isFile -> {
              val pcmBytes = WavFileRepair.repairInPlace(finalFile)
              val localPolicyMismatch = entry.mode == RecorderMode.LOCAL_ONLY && (
                entry.uploadState != RecordingPersistencePolicy.completedUploadState(entry.mode) ||
                  entry.asrState != JournalAsrState.NOT_REQUIRED
                )
              val failedMeetingAsrNeedsRecovery =
                entry.purpose == AudioPurpose.MEETING &&
                  entry.mode == RecorderMode.REALTIME &&
                  entry.asrState == JournalAsrState.FAILED
              val needsRecovery =
                entry.state != JournalState.LOCAL_SAVED ||
                entry.pcmBytes != pcmBytes ||
                localPolicyMismatch ||
                failedMeetingAsrNeedsRecovery
              val finalizedEntry = if (needsRecovery) {
                entry.copy(
                  state = JournalState.LOCAL_SAVED,
                  pcmBytes = pcmBytes,
                  updatedAtMs = System.currentTimeMillis(),
                  recovered = true,
                  uploadState = RecordingPersistencePolicy.completedUploadState(entry.mode),
                  asrState = RecordingPersistencePolicy.recoveredAsrState(entry.mode),
                ).also { writeJournal(journalFile, it) }
              } else {
                entry
              }
              if (needsRecovery || includeFinalized) {
                recovered += finalizedRecording(finalizedEntry, finalFile)
              }
            }
            tempFile.isFile -> {
              val finalized = finalizeDetachedFile(tempFile, finalFile)
              val updated = entry.copy(
                state = JournalState.LOCAL_SAVED,
                finalFileName = finalized.file.name,
                pcmBytes = finalized.pcmBytes,
                updatedAtMs = System.currentTimeMillis(),
                recovered = true,
                uploadState = RecordingPersistencePolicy.completedUploadState(entry.mode),
                asrState = RecordingPersistencePolicy.recoveredAsrState(entry.mode),
              )
              writeJournal(journalFile, updated)
              referencedFinals += finalized.file.name
              recovered += finalizedRecording(updated, finalized.file)
            }
            else -> failures += RecoveryFailure(
              entry.sessionId,
              journalFile.name,
              RecorderErrorCode.RECOVERY_FAILED,
              "recording journal has no local audio file",
            )
          }
        } catch (_: Exception) {
          failures += RecoveryFailure(
            entry.sessionId,
            journalFile.name,
            RecorderErrorCode.RECOVERY_FAILED,
            "recording file could not be repaired",
          )
        }
      }

    root.listFiles { file -> file.isFile && file.name.endsWith(PART_SUFFIX) }
      .orEmpty()
      .filterNot { referencedParts.contains(it.name) }
      .sortedBy { it.name }
      .forEach { tempFile ->
        try {
          val baseName = tempFile.name.removeSuffix(PART_SUFFIX)
          val finalized = finalizeDetachedFile(tempFile, File(root, "$baseName.wav"))
          val now = System.currentTimeMillis()
          val entry = RecordingJournalEntry(
            schemaVersion = AudioRuntimeContract.JOURNAL_SCHEMA_VERSION,
            sessionId = recoverySessionId(baseName),
            purpose = AudioPurpose.SPEAKER,
            mode = RecorderMode.LOCAL_ONLY,
            storageScope = null,
            state = JournalState.LOCAL_SAVED,
            tempFileName = tempFile.name,
            finalFileName = finalized.file.name,
            pcmBytes = finalized.pcmBytes,
            startedAtMs = tempFile.lastModified().takeIf { it > 0L } ?: now,
            updatedAtMs = now,
            recovered = true,
            uploadState = RecordingPersistencePolicy.completedUploadState(RecorderMode.LOCAL_ONLY),
            asrState = RecordingPersistencePolicy.recoveredAsrState(RecorderMode.LOCAL_ONLY),
          )
          writeJournal(uniqueJournalFile(baseName), entry)
          referencedFinals += finalized.file.name
          recovered += finalizedRecording(entry, finalized.file)
        } catch (_: Exception) {
          failures += RecoveryFailure(
            null,
            tempFile.name,
            RecorderErrorCode.RECOVERY_FAILED,
            "orphan recording file could not be repaired",
          )
        }
      }

    root.listFiles { file -> file.isFile && file.name.endsWith(".wav") }
      .orEmpty()
      .filterNot { referencedFinals.contains(it.name) }
      .sortedBy { it.name }
      .forEach { wavFile ->
        try {
          val pcmBytes = WavFileRepair.repairInPlace(wavFile)
          val now = System.currentTimeMillis()
          val baseName = wavFile.name.removeSuffix(".wav")
          val entry = RecordingJournalEntry(
            schemaVersion = AudioRuntimeContract.JOURNAL_SCHEMA_VERSION,
            sessionId = recoverySessionId(baseName),
            purpose = AudioPurpose.SPEAKER,
            mode = RecorderMode.LOCAL_ONLY,
            storageScope = null,
            state = JournalState.LOCAL_SAVED,
            tempFileName = "$baseName$PART_SUFFIX",
            finalFileName = wavFile.name,
            pcmBytes = pcmBytes,
            startedAtMs = wavFile.lastModified().takeIf { it > 0L } ?: now,
            updatedAtMs = now,
            recovered = true,
            uploadState = RecordingPersistencePolicy.completedUploadState(RecorderMode.LOCAL_ONLY),
            asrState = RecordingPersistencePolicy.recoveredAsrState(RecorderMode.LOCAL_ONLY),
          )
          writeJournal(uniqueJournalFile(baseName), entry)
          recovered += finalizedRecording(entry, wavFile)
        } catch (_: Exception) {
          failures += RecoveryFailure(
            null,
            wavFile.name,
            RecorderErrorCode.RECOVERY_FAILED,
            "unregistered WAV file could not be repaired",
          )
        }
      }

    RecordingRecoveryReport(recovered, failures)
  }

  fun deleteSession(sessionId: String, activeSessionId: String? = null): Int = synchronized(recordingIoLock) {
    val normalizedSessionId = RecorderStartConfig.validateSessionId(sessionId)
    require(activeSessionId != normalizedSessionId) { "active recording cannot be deleted" }
    ensureRoot()
    recoverJournalWriteTemps()
    var deleted = 0
    root.listFiles { file -> file.isFile && file.name.endsWith(JOURNAL_SUFFIX) }
      .orEmpty()
      .sortedBy { it.name }
      .forEach { journalFile ->
        val entry = runCatching { readJournal(journalFile) }.getOrNull() ?: return@forEach
        if (entry.sessionId != normalizedSessionId) return@forEach
        val files = listOf(
          File(root, entry.tempFileName),
          File(root, entry.finalFileName),
          journalFile,
          File(root, "${journalFile.name}.tmp"),
        )
        files.forEach { file ->
          if (file.exists() && file.delete()) deleted += 1
        }
      }
    syncDirectory()
    deleted
  }

  internal fun writeJournal(journalFile: File, entry: RecordingJournalEntry) {
    ensureRoot()
    val temp = File(root, "${journalFile.name}.tmp")
    FileOutputStream(temp, false).use { output ->
      output.write(entry.toJson().toString().toByteArray(Charsets.UTF_8))
      output.flush()
      output.fd.sync()
    }
    atomicRenameReplacing(temp, journalFile)
    syncDirectory()
  }

  internal fun deleteSessionFiles(journalFile: File, entry: RecordingJournalEntry) {
    synchronized(recordingIoLock) {
      File(root, entry.tempFileName).delete()
      journalFile.delete()
      File(root, "${journalFile.name}.tmp").delete()
      syncDirectory()
    }
  }

  internal fun rootFile(fileName: String): File = File(root, fileName)

  internal fun availableFinalFile(preferred: File): File {
    if (!preferred.exists()) return preferred
    val base = preferred.name.removeSuffix(".wav")
    var index = 1
    while (true) {
      val candidate = File(root, "$base-recovered-$index.wav")
      if (!candidate.exists()) return candidate
      index += 1
    }
  }

  internal fun atomicRename(source: File, destination: File) {
    require(!destination.exists()) { "destination already exists" }
    Os.rename(source.absolutePath, destination.absolutePath)
    syncDirectory()
  }

  private fun finalizeDetachedFile(tempFile: File, preferredFinal: File): DetachedFinalizedFile {
    val pcmBytes = WavFileRepair.repairInPlace(tempFile)
    val finalFile = availableFinalFile(preferredFinal)
    atomicRename(tempFile, finalFile)
    return DetachedFinalizedFile(finalFile, pcmBytes)
  }

  private fun recoverJournalWriteTemps() {
    root.listFiles { file -> file.isFile && file.name.endsWith("$JOURNAL_SUFFIX.tmp") }
      .orEmpty()
      .forEach { temp ->
        val target = File(root, temp.name.removeSuffix(".tmp"))
        if (target.exists()) {
          temp.delete()
          return@forEach
        }
        try {
          readJournal(temp)
          atomicRenameReplacing(temp, target)
        } catch (_: Exception) {
          // Keep an invalid write-temp for diagnosis; it contains no credentials.
        }
      }
  }

  private fun readJournal(file: File): RecordingJournalEntry =
    RecordingJournalEntry.fromJson(JSONObject(file.readText(Charsets.UTF_8)))

  private fun finalizedRecording(entry: RecordingJournalEntry, file: File): FinalizedRecording =
    FinalizedRecording(
      sessionId = entry.sessionId,
      purpose = entry.purpose,
      mode = entry.mode,
      storageScope = entry.storageScope,
      uri = Uri.fromFile(file).toString(),
      pcmBytes = entry.pcmBytes,
      durationMs = entry.pcmBytes * 1_000L / AudioRuntimeContract.BYTES_PER_SECOND,
      recovered = entry.recovered,
    )

  private fun recoverySessionId(baseName: String): String =
    "recovered:${baseName.take(140)}"

  private fun uniqueJournalFile(baseName: String): File {
    var candidate = File(root, "$baseName$JOURNAL_SUFFIX")
    var index = 1
    while (candidate.exists()) {
      candidate = File(root, "$baseName-recovered-$index$JOURNAL_SUFFIX")
      index += 1
    }
    return candidate
  }

  private fun atomicRenameReplacing(source: File, destination: File) {
    Os.rename(source.absolutePath, destination.absolutePath)
    syncDirectory()
  }

  private fun ensureRoot() {
    if (!root.exists() && !root.mkdirs()) {
      throw RecorderRuntimeException(RecorderErrorCode.STORAGE_FAILED, "unable to create recording directory")
    }
    if (!root.isDirectory) {
      throw RecorderRuntimeException(RecorderErrorCode.STORAGE_FAILED, "recording path is not a directory")
    }
  }

  private fun syncDirectory() {
    try {
      val descriptor = Os.open(root.absolutePath, OsConstants.O_RDONLY, 0)
      try {
        Os.fsync(descriptor)
      } finally {
        Os.close(descriptor)
      }
    } catch (_: Exception) {
      // The WAV and journal file descriptors were already synced.
    }
  }

  private data class DetachedFinalizedFile(val file: File, val pcmBytes: Long)
}

class RecordingFileSession internal constructor(
  private val repository: RecordingRepository,
  private val randomAccessFile: RandomAccessFile,
  private val journalFile: File,
  initialEntry: RecordingJournalEntry,
) {
  private var entry = initialEntry
  private var closed = false
  private var lastSyncedPcmBytes = 0L
  private var finalizedRecording: FinalizedRecording? = null

  val pcmBytes: Long
    get() = synchronized(recordingIoLock) { entry.pcmBytes }

  fun append(buffer: ByteArray, count: Int): AppendResult = synchronized(recordingIoLock) {
    check(!closed) { "recording file is closed" }
    val requested = count.coerceIn(0, buffer.size) and -2
    val remaining = (AudioRuntimeContract.MAX_PCM_BYTES - entry.pcmBytes).coerceAtLeast(0L)
    val writable = minOf(requested.toLong(), remaining).toInt() and -2
    if (writable > 0) {
      randomAccessFile.write(buffer, 0, writable)
      entry = entry.copy(
        pcmBytes = entry.pcmBytes + writable,
        updatedAtMs = System.currentTimeMillis(),
      )
    }
    if (entry.pcmBytes - lastSyncedPcmBytes >= CHECKPOINT_BYTES) {
      randomAccessFile.fd.sync()
      repository.writeJournal(journalFile, entry)
      lastSyncedPcmBytes = entry.pcmBytes
    }
    AppendResult(
      bytesWritten = writable,
      totalPcmBytes = entry.pcmBytes,
      limitReached = writable < requested || entry.pcmBytes >= AudioRuntimeContract.MAX_PCM_BYTES,
    )
  }

  fun updateState(state: JournalState, asrState: JournalAsrState = entry.asrState) =
    synchronized(recordingIoLock) {
      if (closed && finalizedRecording == null) return@synchronized
      entry = entry.copy(
        state = state,
        updatedAtMs = System.currentTimeMillis(),
        asrState = asrState,
      )
      repository.writeJournal(journalFile, entry)
    }

  fun updateAsrState(asrState: JournalAsrState) = synchronized(recordingIoLock) {
    entry = entry.copy(updatedAtMs = System.currentTimeMillis(), asrState = asrState)
    repository.writeJournal(journalFile, entry)
  }

  fun finalizeRecording(asrState: JournalAsrState): FinalizedRecording = synchronized(recordingIoLock) {
    finalizedRecording?.let { return@synchronized it }
    check(!closed) { "recording file is closed" }
    val actualPcmBytes = WavRecoveryMath.alignedPcmBytes(randomAccessFile.length())
    randomAccessFile.setLength(AudioRuntimeContract.WAV_HEADER_BYTES + actualPcmBytes)
    randomAccessFile.seek(0L)
    randomAccessFile.write(WavHeader.create(actualPcmBytes))
    randomAccessFile.fd.sync()
    randomAccessFile.close()
    closed = true

    val tempFile = repository.rootFile(entry.tempFileName)
    val finalFile = repository.availableFinalFile(repository.rootFile(entry.finalFileName))
    repository.atomicRename(tempFile, finalFile)
    entry = entry.copy(
      state = JournalState.LOCAL_SAVED,
      finalFileName = finalFile.name,
      pcmBytes = actualPcmBytes,
      updatedAtMs = System.currentTimeMillis(),
      uploadState = RecordingPersistencePolicy.completedUploadState(entry.mode),
      asrState = asrState,
    )
    repository.writeJournal(journalFile, entry)
    FinalizedRecording(
      sessionId = entry.sessionId,
      purpose = entry.purpose,
      mode = entry.mode,
      storageScope = entry.storageScope,
      uri = Uri.fromFile(finalFile).toString(),
      pcmBytes = actualPcmBytes,
      durationMs = actualPcmBytes * 1_000L / AudioRuntimeContract.BYTES_PER_SECOND,
      recovered = false,
    ).also { finalizedRecording = it }
  }

  fun discardIfEmpty() = synchronized(recordingIoLock) {
    if (closed) return@synchronized
    if (entry.pcmBytes > 0L) return@synchronized
    randomAccessFile.close()
    closed = true
    repository.deleteSessionFiles(journalFile, entry)
  }
}
