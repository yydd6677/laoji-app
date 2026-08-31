package com.laoji.nativeplatform.mediaimport

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import java.io.File
import java.security.MessageDigest
import java.util.Locale

internal data class MediaSourceMetadata(
  val uri: Uri,
  val fileName: String,
  val mimeType: String?,
  val byteSize: Long?,
  val lastModifiedMs: Long?,
)

internal data class InspectedMeetingMediaSource(
  val uri: Uri,
  val fileName: String,
  val mimeType: String,
  val byteSize: Long?,
  val lastModifiedMs: Long?,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "sourceUri" to uri.toString(),
    "fileName" to fileName,
    "mimeType" to mimeType,
    "byteSize" to byteSize,
    "lastModifiedMs" to lastModifiedMs,
  )
}

internal val supportedMeetingMediaMimeTypes = linkedSetOf(
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/aacp",
  "audio/ogg",
  "application/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
)

internal val supportedAudioMeetingMediaMimeTypes = supportedMeetingMediaMimeTypes
  .filterNot { it.startsWith("video/") }

private val supportedExtensions = mapOf(
  "wav" to "audio/wav",
  "mp3" to "audio/mpeg",
  "m4a" to "audio/mp4",
  "aac" to "audio/aac",
  "ogg" to "audio/ogg",
  "webm" to "audio/webm",
  "flac" to "audio/flac",
  "mp4" to "video/mp4",
  "mov" to "video/quicktime",
  "mkv" to "video/x-matroska",
)

internal fun normalizeMediaMimeType(value: String?): String? = value
  ?.substringBefore(';')
  ?.trim()
  ?.lowercase(Locale.ROOT)
  ?.takeIf { it.isNotBlank() && it != "*/*" && it != "audio/*" }

internal fun mediaFileExtension(fileName: String): String? = fileName
  .substringAfterLast('.', "")
  .lowercase(Locale.ROOT)
  .takeIf(supportedExtensions::containsKey)

internal fun resolvedSupportedMimeType(fileName: String, hintedMimeType: String?): String? {
  val mimeType = normalizeMediaMimeType(hintedMimeType)
  if (mimeType in supportedMeetingMediaMimeTypes) return mimeType
  return mediaFileExtension(fileName)?.let(supportedExtensions::get)
}

internal fun preferredMediaExtension(fileName: String, mimeType: String): String {
  val current = mediaFileExtension(fileName)
  if (current != null) return current
  return when (normalizeMediaMimeType(mimeType)) {
    "audio/wav", "audio/wave", "audio/x-wav" -> "wav"
    "audio/mpeg", "audio/mp3" -> "mp3"
    "audio/mp4", "audio/x-m4a" -> "m4a"
    "audio/aac", "audio/aacp" -> "aac"
    "audio/ogg", "application/ogg" -> "ogg"
    "audio/webm" -> "webm"
    "audio/flac", "audio/x-flac" -> "flac"
    "video/mp4" -> "mp4"
    "video/webm" -> "webm"
    "video/quicktime" -> "mov"
    "video/x-matroska" -> "mkv"
    else -> "audio"
  }
}

/** Display name used after a video has been reduced to its audio track. */
internal fun audioOutputFileName(fileName: String, extension: String): String {
  val normalizedExtension = extension.trim().lowercase(Locale.ROOT).ifBlank { "m4a" }
  val sanitized = sanitizeMediaDisplayName(fileName)
  val base = sanitized.substringBeforeLast('.', sanitized).trim().ifBlank { "会议录音" }
  return "$base.$normalizedExtension"
}

internal fun sanitizeMediaDisplayName(value: String?): String {
  val normalized = value
    ?.replace(Regex("[\\/\\u0000-\\u001f\\u007f]"), "_")
    ?.trim()
    ?.take(240)
    .orEmpty()
  return normalized.ifBlank { "会议录音" }
}

internal fun resolveMediaSourceMetadata(
  context: Context,
  uri: Uri,
  hintedMimeType: String? = null,
): MediaSourceMetadata {
  var displayName: String? = null
  var byteSize: Long? = null
  var lastModifiedMs: Long? = null
  if (uri.scheme == "content") {
    val projection = arrayOf(
      OpenableColumns.DISPLAY_NAME,
      OpenableColumns.SIZE,
    )
    runCatching {
      context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return@use
        cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { index ->
          displayName = cursor.getString(index)
        }
        cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { index ->
          if (!cursor.isNull(index)) byteSize = cursor.getLong(index).takeIf { it >= 0L }
        }
      }
    }
    fun queryLong(column: String): Long? = runCatching {
      context.contentResolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        cursor.getColumnIndex(column).takeIf { it >= 0 }?.let { index ->
          if (cursor.isNull(index)) null else cursor.getLong(index).takeIf { it >= 0L }
        }
      }
    }.getOrNull()
    lastModifiedMs = queryLong(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
      ?: queryLong(MediaStore.MediaColumns.DATE_MODIFIED)?.let { value ->
        if (value in 1..9_999_999_999L) value * 1_000L else value
      }
  } else if (uri.scheme == "file") {
    uri.path?.let(::File)?.let { file ->
      displayName = file.name
      if (file.exists()) {
        byteSize = file.length().takeIf { it >= 0L }
        lastModifiedMs = file.lastModified().takeIf { it > 0L }
      }
    }
  }
  val fileName = sanitizeMediaDisplayName(displayName ?: uri.lastPathSegment)
  val mimeType = normalizeMediaMimeType(
    hintedMimeType ?: runCatching { context.contentResolver.getType(uri) }.getOrNull(),
  )
  return MediaSourceMetadata(uri, fileName, mimeType, byteSize, lastModifiedMs)
}

internal fun inspectMeetingMediaSource(
  context: Context,
  sourceUri: String,
  hintedMimeType: String? = null,
): InspectedMeetingMediaSource {
  val uri = runCatching { Uri.parse(sourceUri.trim()) }.getOrNull()
    ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "无法读取所选录音")
  if (uri.scheme !in setOf("content", "file")) {
    throw MediaImportException("ERR_MEDIA_IMPORT_UNREADABLE", "无法读取所选录音")
  }
  val metadata = resolveMediaSourceMetadata(context, uri, hintedMimeType)
  val mimeType = resolvedSupportedMimeType(metadata.fileName, metadata.mimeType)
    ?: throw MediaImportException("ERR_MEDIA_IMPORT_UNSUPPORTED_TYPE", "不支持此录音格式")
  if (metadata.byteSize != null && metadata.byteSize <= 0L) {
    throw MediaImportException("ERR_MEDIA_IMPORT_EMPTY", "录音文件为空")
  }
  return InspectedMeetingMediaSource(
    uri,
    metadata.fileName,
    mimeType,
    metadata.byteSize,
    metadata.lastModifiedMs,
  )
}

internal fun mediaSourceFingerprint(metadata: MediaSourceMetadata): String = sha256Hex(
  // Provider metadata can disappear when the same granted document URI is re-encoded.
  // The short duplicate window therefore keys on decoded URI identity only.
  listOf(
    metadata.uri.scheme?.lowercase(Locale.ROOT).orEmpty(),
    metadata.uri.authority?.lowercase(Locale.ROOT).orEmpty(),
    metadata.uri.path.orEmpty(),
    metadata.uri.query.orEmpty(),
  ).joinToString("\u001e"),
)

internal fun sha256Hex(value: String): String = MessageDigest.getInstance("SHA-256")
  .digest(value.toByteArray(Charsets.UTF_8))
  .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
