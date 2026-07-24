package com.laoji.nativeplatform.mediaimport

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.StatFs
import android.system.Os
import android.system.OsConstants
import expo.modules.kotlin.exception.CodedException
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import kotlin.math.max

private val mediaImportIoLock = Any()

internal class MediaImportException(
  code: String,
  message: String,
  cause: Throwable? = null,
) : CodedException(code, message, cause)

internal data class IngestedMeetingMedia(
  val meetingId: String,
  val assetId: String,
  val origin: String,
  val localUri: String,
  val fileName: String,
  val mimeType: String,
  val byteSize: Long,
  val durationMs: Long,
  val checksumSha256: String,
  val sourceLastModifiedMs: Long?,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "meetingId" to meetingId,
    "assetId" to assetId,
    "origin" to origin,
    "localUri" to localUri,
    "fileName" to fileName,
    "mimeType" to mimeType,
    "byteSize" to byteSize,
    "durationMs" to durationMs,
    "checksumSha256" to checksumSha256,
    "sourceLastModifiedMs" to sourceLastModifiedMs,
  )
}

private data class MediaIngestJournal(
  val meetingId: String,
  val assetId: String,
  val origin: String,
  val sourceUri: String,
  val sourceLastModifiedMs: Long?,
  val fileName: String,
  val mimeType: String,
  val state: String,
  val tempFileName: String,
  val finalFileName: String,
  val byteSize: Long?,
  val durationMs: Long?,
  val checksumSha256: String?,
  val createdAtMs: Long,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("version", 1)
    .put("meetingId", meetingId)
    .put("assetId", assetId)
    .put("origin", origin)
    .put("sourceUri", sourceUri)
    .put("sourceLastModifiedMs", sourceLastModifiedMs)
    .put("fileName", fileName)
    .put("mimeType", mimeType)
    .put("state", state)
    .put("tempFileName", tempFileName)
    .put("finalFileName", finalFileName)
    .put("byteSize", byteSize)
    .put("durationMs", durationMs)
    .put("checksumSha256", checksumSha256)
    .put("createdAtMs", createdAtMs)

  fun readyResult(directory: File): IngestedMeetingMedia? {
    val size = byteSize ?: return null
    val duration = durationMs ?: return null
    val checksum = checksumSha256 ?: return null
    val finalFile = File(directory, finalFileName)
    if (!finalFile.isFile || finalFile.length() != size) return null
    return IngestedMeetingMedia(
      meetingId,
      assetId,
      origin,
      Uri.fromFile(finalFile).toString(),
      fileName,
      mimeType,
      size,
      duration,
      checksum,
      sourceLastModifiedMs,
    )
  }

  companion object {
    fun fromJson(value: JSONObject): MediaIngestJournal? {
      if (value.optInt("version", -1) != 1) return null
      fun required(key: String) = value.optString(key).trim().takeIf(String::isNotBlank)
      fun optionalLong(key: String) = value.optLong(key, -1L).takeIf { it >= 0L }
      return MediaIngestJournal(
        meetingId = required("meetingId") ?: return null,
        assetId = required("assetId") ?: return null,
        origin = required("origin") ?: return null,
        sourceUri = required("sourceUri") ?: return null,
        sourceLastModifiedMs = optionalLong("sourceLastModifiedMs"),
        fileName = required("fileName") ?: return null,
        mimeType = required("mimeType") ?: return null,
        state = required("state") ?: return null,
        tempFileName = required("tempFileName") ?: return null,
        finalFileName = required("finalFileName") ?: return null,
        byteSize = optionalLong("byteSize"),
        durationMs = optionalLong("durationMs"),
        checksumSha256 = required("checksumSha256"),
        createdAtMs = optionalLong("createdAtMs") ?: return null,
      )
    }
  }
}

internal class MediaIngestor(context: Context) {
  private val appContext = context.applicationContext
  private val root = File(appContext.filesDir, "meeting-audio/imports")

  fun ingest(
    sourceUri: String,
    meetingId: String,
    assetId: String,
    origin: String,
    maximumBytes: Long,
  ): IngestedMeetingMedia = synchronized(mediaImportIoLock) {
    val normalizedMeetingId = validateIdentity(meetingId, "meeting")
    val normalizedAssetId = validateIdentity(assetId, "asset")
    if (origin !in setOf("file_import", "share_intent")) {
      throw MediaImportException("ERR_MEDIA_IMPORT_INVALID_INPUT", "invalid media import origin")
    }
    if (maximumBytes <= 0L || maximumBytes > MAXIMUM_SUPPORTED_BYTES) {
      throw MediaImportException("ERR_MEDIA_IMPORT_INVALID_INPUT", "invalid media import size limit")
    }
    val uri = runCatching { Uri.parse(sourceUri.trim()) }.getOrNull()
      ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "invalid media import URI")
    if (uri.scheme !in setOf("content", "file")) {
      throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "unsupported media import URI scheme")
    }
    val metadata = resolveMediaSourceMetadata(appContext, uri)
    val mimeType = resolvedSupportedMimeType(metadata.fileName, metadata.mimeType)
      ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "unsupported media type")
    metadata.byteSize?.let { size ->
      if (size <= 0L) throw MediaImportException("ERR_MEDIA_IMPORT_EMPTY", "media file is empty")
      if (size > maximumBytes) throw MediaImportException("ERR_MEDIA_IMPORT_TOO_LARGE", "media file exceeds size limit")
    }
    ensureRoot()
    ensureSpace(metadata.byteSize, maximumBytes)
    val directory = File(root, normalizedMeetingId)
    if (!directory.exists() && !directory.mkdirs()) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "unable to create media import directory")
    }
    if (!directory.isDirectory) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "media import path is not a directory")
    }
    val extension = preferredMediaExtension(metadata.fileName, mimeType)
    val finalFile = File(directory, "$normalizedAssetId.$extension")
    val tempFile = File(directory, "$normalizedAssetId.$extension.part")
    val journalFile = File(directory, JOURNAL_FILE)
    val current = readJournal(journalFile)
    if (current != null && (
        current.meetingId != normalizedMeetingId ||
          current.assetId != normalizedAssetId ||
          current.origin != origin ||
          current.sourceUri != uri.toString()
      )) {
      throw MediaImportException("ERR_MEDIA_IMPORT_IDENTITY_CONFLICT", "media import identity already exists")
    }
    current?.readyResult(directory)?.takeIf {
      it.meetingId == normalizedMeetingId && it.assetId == normalizedAssetId
    }?.let { return@synchronized it }
    if (finalFile.exists() || tempFile.exists()) {
      throw MediaImportException("ERR_MEDIA_IMPORT_IDENTITY_CONFLICT", "media import identity already exists")
    }
    val createdAtMs = System.currentTimeMillis().coerceAtLeast(0L)
    var journal = MediaIngestJournal(
      normalizedMeetingId,
      normalizedAssetId,
      origin,
      uri.toString(),
      metadata.lastModifiedMs,
      metadata.fileName,
      mimeType,
      "copying",
      tempFile.name,
      finalFile.name,
      null,
      null,
      null,
      createdAtMs,
    )
    writeJournal(directory, journalFile, journal)
    try {
      val digest = MessageDigest.getInstance("SHA-256")
      var copied = 0L
      openSource(uri).use { input ->
        FileOutputStream(tempFile, false).use { output ->
          val buffer = ByteArray(COPY_BUFFER_BYTES)
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            copied += count
            if (copied > maximumBytes) {
              throw MediaImportException("ERR_MEDIA_IMPORT_TOO_LARGE", "media file exceeds size limit")
            }
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
          }
          output.flush()
          output.fd.sync()
        }
      }
      if (copied <= 0L) throw MediaImportException("ERR_MEDIA_IMPORT_EMPTY", "media file is empty")
      metadata.byteSize?.let { expected ->
        if (expected != copied) {
          throw MediaImportException("ERR_MEDIA_IMPORT_CHANGED", "media source changed while importing")
        }
      }
      val durationMs = inspectAudio(tempFile)
      val checksum = digest.digest().joinToString("") { byte ->
        "%02x".format(byte.toInt() and 0xff)
      }
      journal = journal.copy(
        state = "prepared",
        byteSize = copied,
        durationMs = durationMs,
        checksumSha256 = checksum,
      )
      writeJournal(directory, journalFile, journal)
      Os.rename(tempFile.absolutePath, finalFile.absolutePath)
      syncDirectory(directory)
      journal = journal.copy(state = "ready")
      writeJournal(directory, journalFile, journal)
      journal.readyResult(directory)
        ?: throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "media import result is incomplete")
    } catch (error: Throwable) {
      tempFile.delete()
      if (!finalFile.exists()) journalFile.delete()
      syncDirectory(directory)
      if (error is MediaImportException) throw error
      throw MediaImportException("ERR_MEDIA_IMPORT_FAILED", "media import failed", error)
    }
  }

  fun recoverPending(): List<IngestedMeetingMedia> = synchronized(mediaImportIoLock) {
    if (!root.exists()) return@synchronized emptyList()
    root.listFiles { file -> file.isDirectory }.orEmpty().sortedBy { it.name }.mapNotNull { directory ->
      val journalFile = File(directory, JOURNAL_FILE)
      val journal = readJournal(journalFile) ?: run {
        directory.listFiles { file -> file.name.endsWith(".part") }.orEmpty().forEach(File::delete)
        return@mapNotNull null
      }
      when (journal.state) {
        "ready" -> journal.readyResult(directory)
        "prepared" -> {
          val temp = File(directory, journal.tempFileName)
          val final = File(directory, journal.finalFileName)
          if (!final.exists() && temp.isFile) {
            runCatching {
              Os.rename(temp.absolutePath, final.absolutePath)
              syncDirectory(directory)
            }.getOrElse { return@mapNotNull null }
          }
          val ready = journal.copy(state = "ready")
          val result = ready.readyResult(directory) ?: return@mapNotNull null
          writeJournal(directory, journalFile, ready)
          result
        }
        else -> {
          File(directory, journal.tempFileName).delete()
          journalFile.delete()
          syncDirectory(directory)
          null
        }
      }
    }
  }

  fun acknowledge(meetingId: String, assetId: String): Boolean = synchronized(mediaImportIoLock) {
    val directory = File(root, validateIdentity(meetingId, "meeting"))
    val journalFile = File(directory, JOURNAL_FILE)
    val journal = readJournal(journalFile) ?: return@synchronized false
    if (journal.assetId != validateIdentity(assetId, "asset")) return@synchronized false
    val deleted = journalFile.delete()
    File(directory, "$JOURNAL_FILE.tmp").delete()
    syncDirectory(directory)
    deleted
  }

  fun discard(meetingId: String, assetId: String): Boolean = synchronized(mediaImportIoLock) {
    val directory = File(root, validateIdentity(meetingId, "meeting"))
    val journalFile = File(directory, JOURNAL_FILE)
    val journal = readJournal(journalFile) ?: return@synchronized false
    if (journal.assetId != validateIdentity(assetId, "asset")) return@synchronized false
    var changed = false
    listOf(
      File(directory, journal.tempFileName),
      File(directory, journal.finalFileName),
      journalFile,
      File(directory, "$JOURNAL_FILE.tmp"),
    ).forEach { file -> if (file.exists() && file.delete()) changed = true }
    syncDirectory(directory)
    directory.delete()
    changed
  }

  private fun ensureRoot() {
    if (!root.exists() && !root.mkdirs()) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "unable to create media import root")
    }
    if (!root.isDirectory) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "media import root is not a directory")
    }
  }

  private fun ensureSpace(byteSize: Long?, maximumBytes: Long) {
    val required = byteSize?.let { size -> max(size + size / 10L, size + MINIMUM_SPACE_HEADROOM) }
      ?: max(maximumBytes / 10L, MINIMUM_SPACE_HEADROOM)
    val available = runCatching { StatFs(root.absolutePath).availableBytes }.getOrDefault(0L)
    if (available <= 0L || available < required) {
      throw MediaImportException("ERR_MEDIA_IMPORT_NO_SPACE", "insufficient storage for media import")
    }
  }

  private fun openSource(uri: Uri): InputStream = when (uri.scheme) {
    "content" -> appContext.contentResolver.openInputStream(uri)
    "file" -> uri.path?.let(::File)?.let(::FileInputStream)
    else -> null
  } ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "media source cannot be opened")

  private fun inspectAudio(file: File): Long {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(file.absolutePath)
      val hasAudio = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO)
      if (hasAudio != null && !hasAudio.equals("yes", ignoreCase = true)) {
        throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "selected media has no audio track")
      }
      val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "media duration is unavailable")
      if (duration < 0L) {
        throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "media duration is invalid")
      }
      return duration
    } catch (error: MediaImportException) {
      throw error
    } catch (error: Throwable) {
      throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "media metadata is unreadable", error)
    } finally {
      runCatching { retriever.release() }
    }
  }

  private fun writeJournal(directory: File, journalFile: File, journal: MediaIngestJournal) {
    val temp = File(directory, "$JOURNAL_FILE.tmp")
    FileOutputStream(temp, false).use { output ->
      output.write(journal.toJson().toString().toByteArray(Charsets.UTF_8))
      output.flush()
      output.fd.sync()
    }
    Os.rename(temp.absolutePath, journalFile.absolutePath)
    syncDirectory(directory)
  }

  private fun readJournal(file: File): MediaIngestJournal? = runCatching {
    if (!file.isFile || file.length() !in 1..MAXIMUM_JOURNAL_BYTES) return@runCatching null
    MediaIngestJournal.fromJson(JSONObject(file.readText(Charsets.UTF_8)))
  }.getOrNull()

  private fun syncDirectory(directory: File) {
    runCatching {
      val descriptor = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
      try {
        Os.fsync(descriptor)
      } finally {
        Os.close(descriptor)
      }
    }
  }

  private fun validateIdentity(value: String, label: String): String = value.trim().also {
    if (!IDENTITY_PATTERN.matches(it)) {
      throw MediaImportException("ERR_MEDIA_IMPORT_INVALID_INPUT", "invalid media import $label identity")
    }
  }

  private companion object {
    const val JOURNAL_FILE = ".media-ingest-v1.json"
    const val COPY_BUFFER_BYTES = 128 * 1024
    const val MINIMUM_SPACE_HEADROOM = 16L * 1024L * 1024L
    const val MAXIMUM_SUPPORTED_BYTES = 2L * 1024L * 1024L * 1024L
    const val MAXIMUM_JOURNAL_BYTES = 32L * 1024L
    val IDENTITY_PATTERN = Regex("^[A-Za-z0-9._:-]{1,160}$")
  }
}
