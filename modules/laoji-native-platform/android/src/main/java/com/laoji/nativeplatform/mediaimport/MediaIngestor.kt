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
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max

private val mediaImportRootLock = Any()
private val mediaImportIoLocks = ConcurrentHashMap<String, Any>()

private fun mediaImportLockFor(meetingId: String): Any =
  mediaImportIoLocks.computeIfAbsent(meetingId) { Any() }

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

  fun stage(
    sourceUri: String,
    meetingId: String,
    assetId: String,
    origin: String,
    maximumBytes: Long,
  ): Boolean = synchronized(mediaImportLockFor(meetingId.trim())) {
    val normalizedMeetingId = validateIdentity(meetingId, "meeting")
    val normalizedAssetId = validateIdentity(assetId, "asset")
    if (origin !in setOf("file_import", "share_intent", "recording_merge")) {
      throw MediaImportException("ERR_MEDIA_IMPORT_INVALID_INPUT", "会议录音来源无效")
    }
    if (maximumBytes <= 0L || maximumBytes > MAXIMUM_SUPPORTED_BYTES) {
      throw MediaImportException("ERR_MEDIA_IMPORT_INVALID_INPUT", "会议录音大小限制无效")
    }
    val uri = runCatching { Uri.parse(sourceUri.trim()) }.getOrNull()
      ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "无法读取所选录音")
    if (uri.scheme !in setOf("content", "file")) {
      throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "无法读取所选录音")
    }
    val metadata = resolveMediaSourceMetadata(appContext, uri)
    val mimeType = resolvedSupportedMimeType(metadata.fileName, metadata.mimeType)
      ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "不支持此录音格式")
    val videoSource = mimeType.startsWith("video/")
    metadata.byteSize?.let { size ->
      if (size <= 0L) throw MediaImportException("ERR_MEDIA_IMPORT_EMPTY", "录音文件为空")
      // A video container can be much larger than the audio track LaoJi keeps.
      // Applying the remote audio limit to the source video rejected valid
      // imports before extraction (for example, a 1.5 GiB video with a small
      // AAC track). Audio sources are already the final upload payload and can
      // be checked immediately; video output is checked while extracting.
      if (!videoSource && size > maximumBytes) {
        throw MediaImportException("ERR_MEDIA_IMPORT_TOO_LARGE", "该录音过大，暂无法上传")
      }
    }
    ensureRoot()
    ensureSpace(if (videoSource) null else metadata.byteSize, maximumBytes)
    val directory = File(root, normalizedMeetingId)
    if (!directory.exists() && !directory.mkdirs()) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "无法创建录音保存位置")
    }
    if (!directory.isDirectory) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "录音保存位置不可用")
    }
    val extension = if (videoSource) "m4a" else preferredMediaExtension(metadata.fileName, mimeType)
    val tempFileName = if (videoSource) {
      "$normalizedAssetId.audio.part"
    } else {
      "$normalizedAssetId.$extension.part"
    }
    val finalFileName = "$normalizedAssetId.$extension"
    val journalFile = File(directory, JOURNAL_FILE)
    val current = readJournal(journalFile)
    if (current != null) {
      if (
        current.meetingId != normalizedMeetingId
        || current.assetId != normalizedAssetId
        || current.origin != origin
        || current.sourceUri != uri.toString()
      ) {
        throw MediaImportException("ERR_MEDIA_IMPORT_IDENTITY_CONFLICT", "这条录音已经导入")
      }
      return@synchronized true
    }
    if (File(directory, tempFileName).exists() || File(directory, finalFileName).exists()) {
      throw MediaImportException("ERR_MEDIA_IMPORT_IDENTITY_CONFLICT", "这条录音已经导入")
    }
    writeJournal(
      directory,
      journalFile,
      MediaIngestJournal(
        meetingId = normalizedMeetingId,
        assetId = normalizedAssetId,
        origin = origin,
        sourceUri = uri.toString(),
        sourceLastModifiedMs = metadata.lastModifiedMs,
        fileName = metadata.fileName,
        mimeType = mimeType,
        state = "staged",
        tempFileName = tempFileName,
        finalFileName = finalFileName,
        byteSize = null,
        durationMs = null,
        checksumSha256 = null,
        createdAtMs = System.currentTimeMillis().coerceAtLeast(0L),
      ),
    )
    true
  }

  fun ingest(
    sourceUri: String,
    meetingId: String,
    assetId: String,
    origin: String,
    maximumBytes: Long,
  ): IngestedMeetingMedia = synchronized(mediaImportLockFor(meetingId.trim())) {
    val normalizedMeetingId = validateIdentity(meetingId, "meeting")
    val normalizedAssetId = validateIdentity(assetId, "asset")
    if (origin !in setOf("file_import", "share_intent", "recording_merge")) {
      throw MediaImportException("ERR_MEDIA_IMPORT_INVALID_INPUT", "会议录音来源无效")
    }
    if (maximumBytes <= 0L || maximumBytes > MAXIMUM_SUPPORTED_BYTES) {
      throw MediaImportException("ERR_MEDIA_IMPORT_INVALID_INPUT", "会议录音大小限制无效")
    }
    val uri = runCatching { Uri.parse(sourceUri.trim()) }.getOrNull()
      ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "无法读取所选录音")
    if (uri.scheme !in setOf("content", "file")) {
      throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "无法读取所选录音")
    }
    val metadata = resolveMediaSourceMetadata(appContext, uri)
    val mimeType = resolvedSupportedMimeType(metadata.fileName, metadata.mimeType)
      ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "不支持此录音格式")
    val videoSource = mimeType.startsWith("video/")
    metadata.byteSize?.let { size ->
      if (size <= 0L) throw MediaImportException("ERR_MEDIA_IMPORT_EMPTY", "录音文件为空")
      if (!videoSource && size > maximumBytes) {
        throw MediaImportException("ERR_MEDIA_IMPORT_TOO_LARGE", "该录音过大，暂无法上传")
      }
    }
    ensureRoot()
    ensureSpace(if (videoSource) null else metadata.byteSize, maximumBytes)
    val directory = File(root, normalizedMeetingId)
    if (!directory.exists() && !directory.mkdirs()) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "无法创建录音保存位置")
    }
    if (!directory.isDirectory) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "录音保存位置不可用")
    }
    val extension = if (videoSource) "m4a" else preferredMediaExtension(metadata.fileName, mimeType)
    var finalFile = File(directory, "$normalizedAssetId.$extension")
    val tempFile = if (videoSource) {
      File(directory, "$normalizedAssetId.audio.part")
    } else {
      File(directory, "$normalizedAssetId.$extension.part")
    }
    val journalFile = File(directory, JOURNAL_FILE)
    val current = readJournal(journalFile)
    if (current != null && (
        current.meetingId != normalizedMeetingId ||
          current.assetId != normalizedAssetId ||
          current.origin != origin ||
          current.sourceUri != uri.toString()
      )) {
      throw MediaImportException("ERR_MEDIA_IMPORT_IDENTITY_CONFLICT", "这条录音已经导入")
    }
    current?.readyResult(directory)?.takeIf {
      it.meetingId == normalizedMeetingId && it.assetId == normalizedAssetId
    }?.let { return@synchronized it }
    // A process death can leave a journal in copying/extracting/prepared. The
    // old implementation treated its temporary file as an identity conflict,
    // which left the optimistic meeting shell stuck in `preparing` forever.
    // Reuse the same journal identity and restart the idempotent ingest from
    // the source. A prepared temp file is finalized without decoding again.
    val resumable = current != null && current.state in setOf("staged", "copying", "extracting", "prepared")
    if (resumable && current!!.state == "prepared") {
      val preparedTemp = File(directory, current.tempFileName)
      val preparedFinal = File(directory, current.finalFileName)
      if (!preparedFinal.exists() && preparedTemp.isFile) {
        Os.rename(preparedTemp.absolutePath, preparedFinal.absolutePath)
        syncDirectory(directory)
      }
      val completed = current.copy(state = "ready").readyResult(directory)
      if (completed != null) {
        writeJournal(directory, journalFile, current.copy(state = "ready"))
        return@synchronized completed
      }
    }
    if (!resumable && (finalFile.exists() || tempFile.exists())) {
      throw MediaImportException("ERR_MEDIA_IMPORT_IDENTITY_CONFLICT", "这条录音已经导入")
    }
    if (resumable) {
      // Partial copying/extraction is never trusted. Remove only the partial
      // bytes and keep the journal identity so a retry is deterministic.
      File(directory, current!!.tempFileName).delete()
      File(directory, current.finalFileName).delete()
      finalFile = File(directory, if (videoSource) "$normalizedAssetId.m4a" else current.finalFileName)
    }
    val createdAtMs = System.currentTimeMillis().coerceAtLeast(0L)
    var journal = if (resumable) {
      current!!.copy(
        sourceUri = uri.toString(),
        sourceLastModifiedMs = metadata.lastModifiedMs,
        fileName = metadata.fileName,
        mimeType = mimeType,
        state = if (videoSource) "extracting" else "copying",
        tempFileName = if (videoSource) "$normalizedAssetId.audio.part" else "$normalizedAssetId.${preferredMediaExtension(metadata.fileName, mimeType)}.part",
        finalFileName = finalFile.name,
        byteSize = null,
        durationMs = null,
        checksumSha256 = null,
      )
    } else MediaIngestJournal(
      normalizedMeetingId,
      normalizedAssetId,
      origin,
      uri.toString(),
      metadata.lastModifiedMs,
      metadata.fileName,
      mimeType,
      if (videoSource) "extracting" else "copying",
      tempFile.name,
      finalFile.name,
      null,
      null,
      null,
      createdAtMs,
    )
    writeJournal(directory, journalFile, journal)
    try {
      if (videoSource) {
        val extracted = MediaAudioExtractor.extract(appContext, uri, tempFile, maximumBytes)
        val outputBytes = tempFile.length()
        if (outputBytes <= 0L) {
          throw MediaImportException("ERR_MEDIA_IMPORT_EMPTY", "视频中没有可用的音频内容")
        }
        if (extracted.durationMs <= 0L) {
          throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "无法读取视频音频时长")
        }
        if (outputBytes > maximumBytes) {
          throw MediaImportException("ERR_MEDIA_IMPORT_TOO_LARGE", "提取后的音频超过当前允许的大小")
        }
        val outputExtension = extracted.extension
        finalFile = File(directory, "$normalizedAssetId.$outputExtension")
        if (finalFile.exists()) {
          throw MediaImportException("ERR_MEDIA_IMPORT_IDENTITY_CONFLICT", "这条录音已经导入")
        }
        val checksum = sha256File(tempFile, maximumBytes)
        journal = journal.copy(
          fileName = audioOutputFileName(metadata.fileName, outputExtension),
          mimeType = extracted.mimeType,
          state = "prepared",
          finalFileName = finalFile.name,
          byteSize = outputBytes,
          durationMs = extracted.durationMs,
          checksumSha256 = checksum,
        )
      } else {
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
                throw MediaImportException("ERR_MEDIA_IMPORT_TOO_LARGE", "录音文件超过大小限制")
              }
              output.write(buffer, 0, count)
              digest.update(buffer, 0, count)
            }
            output.flush()
            output.fd.sync()
          }
        }
        if (copied <= 0L) throw MediaImportException("ERR_MEDIA_IMPORT_EMPTY", "录音文件为空")
        metadata.byteSize?.let { expected ->
          if (expected != copied) {
            throw MediaImportException("ERR_MEDIA_IMPORT_CHANGED", "录音文件在导入过程中发生变化")
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
      }
      writeJournal(directory, journalFile, journal)
      Os.rename(tempFile.absolutePath, finalFile.absolutePath)
      syncDirectory(directory)
      journal = journal.copy(state = "ready")
      writeJournal(directory, journalFile, journal)
      journal.readyResult(directory)
        ?: throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "录音保存结果不完整")
    } catch (error: Throwable) {
      tempFile.delete()
      if (current != null && current.state in setOf("staged", "copying", "extracting", "prepared")) {
        // Keep a resumable journal after a transient provider/IO failure. The
        // next application start can retry the same source and shell identity
        // instead of leaving an orphaned `preparing` meeting.
        writeJournal(
          directory,
          journalFile,
          journal.copy(
            state = if (videoSource) "extracting" else "copying",
            byteSize = null,
            durationMs = null,
            checksumSha256 = null,
          ),
        )
      } else if (!finalFile.exists()) journalFile.delete()
      syncDirectory(directory)
      if (error is MediaImportException) throw error
      throw MediaImportException("ERR_MEDIA_IMPORT_FAILED", "录音导入失败", error)
    }
  }

  fun recoverPending(): List<IngestedMeetingMedia> {
    val directories = synchronized(mediaImportRootLock) {
      if (!root.exists()) return emptyList()
      root.listFiles { file -> file.isDirectory }.orEmpty().sortedBy { it.name }
    }
    return directories.mapNotNull { directory ->
      synchronized(mediaImportLockFor(directory.name)) {
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
          "staged", "copying", "extracting" -> ingest(
            sourceUri = journal.sourceUri,
            meetingId = journal.meetingId,
            assetId = journal.assetId,
            origin = journal.origin,
            maximumBytes = MAXIMUM_SUPPORTED_BYTES,
          )
          else -> {
            File(directory, journal.tempFileName).delete()
            journalFile.delete()
            syncDirectory(directory)
            null
          }
        }
      }
    }
  }

  fun acknowledge(meetingId: String, assetId: String): Boolean = synchronized(mediaImportLockFor(meetingId.trim())) {
    val directory = File(root, validateIdentity(meetingId, "meeting"))
    val journalFile = File(directory, JOURNAL_FILE)
    val journal = readJournal(journalFile) ?: return@synchronized false
    if (journal.assetId != validateIdentity(assetId, "asset")) return@synchronized false
    val deleted = journalFile.delete()
    File(directory, "$JOURNAL_FILE.tmp").delete()
    syncDirectory(directory)
    deleted
  }

  fun discard(meetingId: String, assetId: String): Boolean = synchronized(mediaImportLockFor(meetingId.trim())) {
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

  fun deleteMeetingAssets(meetingId: String): Int = synchronized(mediaImportLockFor(meetingId.trim())) {
    val directory = File(root, validateIdentity(meetingId, "meeting"))
    if (!directory.exists()) return@synchronized 0
    if (!directory.isDirectory) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "录音保存位置不可用")
    }
    val files = directory.walkBottomUp().count { it.isFile }
    if (!directory.deleteRecursively()) {
      throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "无法删除会议录音")
    }
    syncDirectory(root)
    files
  }

  private fun ensureRoot() {
    synchronized(mediaImportRootLock) {
      if (!root.exists() && !root.mkdirs()) {
        throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "无法创建录音保存位置")
      }
      if (!root.isDirectory) {
        throw MediaImportException("ERR_MEDIA_IMPORT_STORAGE", "录音保存位置不可用")
      }
    }
  }

  private fun ensureSpace(byteSize: Long?, maximumBytes: Long) {
    val required = byteSize?.let { size -> max(size + size / 10L, size + MINIMUM_SPACE_HEADROOM) }
      ?: max(maximumBytes / 10L, MINIMUM_SPACE_HEADROOM)
    val available = runCatching { StatFs(root.absolutePath).availableBytes }.getOrDefault(0L)
    if (available <= 0L || available < required) {
      throw MediaImportException("ERR_MEDIA_IMPORT_NO_SPACE", "本机存储空间不足")
    }
  }

  private fun openSource(uri: Uri): InputStream = when (uri.scheme) {
    "content" -> appContext.contentResolver.openInputStream(uri)
    "file" -> uri.path?.let(::File)?.let(::FileInputStream)
    else -> null
  } ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "无法打开所选录音")

  private fun sha256File(file: File, maximumBytes: Long): String {
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    FileInputStream(file).use { input ->
      val buffer = ByteArray(COPY_BUFFER_BYTES)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count == 0) continue
        total += count
        if (total > maximumBytes) {
          throw MediaImportException("ERR_MEDIA_IMPORT_TOO_LARGE", "提取后的音频超过当前允许的大小")
        }
        digest.update(buffer, 0, count)
      }
    }
    if (total <= 0L) throw MediaImportException("ERR_MEDIA_IMPORT_EMPTY", "音频文件为空")
    return digest.digest().joinToString("") { byte ->
      "%02x".format(byte.toInt() and 0xff)
    }
  }

  private fun inspectAudio(file: File): Long {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(file.absolutePath)
      val hasAudio = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO)
      if (hasAudio != null && !hasAudio.equals("yes", ignoreCase = true)) {
        throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "所选文件不包含音轨")
      }
      val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "无法读取录音时长")
      if (duration < 0L) {
        throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "录音时长无效")
      }
      return duration
    } catch (error: MediaImportException) {
      throw error
    } catch (error: Throwable) {
      throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "无法读取录音信息", error)
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
      throw MediaImportException("ERR_MEDIA_IMPORT_INVALID_INPUT", "会议录音标识无效")
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
