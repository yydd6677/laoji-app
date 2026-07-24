package com.laoji.nativeplatform.mediaimport

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet

data class PendingMediaImportIntent(
  val token: String,
  val uri: String?,
  val mimeType: String?,
  val fileName: String?,
  val byteSize: Long?,
  val lastModifiedMs: Long?,
  val fingerprint: String?,
  val receivedAtMs: Long,
  val errorCode: String?,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "token" to token,
    "uri" to uri,
    "mimeType" to mimeType,
    "fileName" to fileName,
    "byteSize" to byteSize,
    "lastModifiedMs" to lastModifiedMs,
    "fingerprint" to fingerprint,
    "receivedAtMs" to receivedAtMs,
    "errorCode" to errorCode,
  )

  fun toJson(): JSONObject = JSONObject()
    .put("token", token)
    .put("uri", uri)
    .put("mimeType", mimeType)
    .put("fileName", fileName)
    .put("byteSize", byteSize)
    .put("lastModifiedMs", lastModifiedMs)
    .put("fingerprint", fingerprint)
    .put("receivedAtMs", receivedAtMs)
    .put("errorCode", errorCode)

  companion object {
    fun fromJson(value: JSONObject): PendingMediaImportIntent? {
      val token = value.optString("token").trim()
      val receivedAtMs = value.optLong("receivedAtMs", -1L)
      if (token.isBlank() || receivedAtMs < 0L) return null
      fun optionalString(key: String): String? = value.optString(key)
        .takeIf { !value.isNull(key) }
        ?.trim()
        ?.takeIf(String::isNotBlank)
      fun optionalLong(key: String): Long? = value.optLong(key, -1L).takeIf { it >= 0L }
      return PendingMediaImportIntent(
        token = token,
        uri = optionalString("uri"),
        mimeType = optionalString("mimeType"),
        fileName = optionalString("fileName"),
        byteSize = optionalLong("byteSize"),
        lastModifiedMs = optionalLong("lastModifiedMs"),
        fingerprint = optionalString("fingerprint"),
        receivedAtMs = receivedAtMs,
        errorCode = optionalString("errorCode"),
      )
    }
  }
}

object MediaImportIntentInbox {
  private const val PREFERENCES = "laoji-media-import-intents-v1"
  private const val QUEUE_KEY = "pending"
  private const val RECENT_KEY = "recent_fingerprints"
  private const val MAX_PENDING = 8
  private const val MAX_RECENT = 16
  private const val DUPLICATE_WINDOW_MS = 30_000L
  private val listeners = CopyOnWriteArraySet<(Map<String, Any?>) -> Unit>()

  private data class RecentFingerprint(
    val fingerprint: String,
    val receivedAtMs: Long,
  ) {
    fun toJson(): JSONObject = JSONObject()
      .put("fingerprint", fingerprint)
      .put("receivedAtMs", receivedAtMs)
  }

  @JvmStatic
  fun offer(context: Context, intent: Intent?) {
    if (intent == null || intent.action !in setOf(
        Intent.ACTION_SEND,
        Intent.ACTION_SEND_MULTIPLE,
        Intent.ACTION_VIEW,
      )) return
    if (
      intent.action == Intent.ACTION_VIEW
      && intent.data?.scheme?.lowercase(Locale.ROOT) !in setOf("content", "file")
    ) return
    val appContext = context.applicationContext
    val nowMs = System.currentTimeMillis().coerceAtLeast(0L)
    val item = parseIntent(appContext, intent, nowMs)
    val accepted = runCatching {
      synchronized(this) {
        val queue = readQueue(appContext).toMutableList()
        val recent = readRecentFingerprints(appContext)
          .filter { nowMs - it.receivedAtMs in 0..DUPLICATE_WINDOW_MS }
          .toMutableList()
        val duplicate = item.fingerprint?.let { fingerprint ->
          queue.any { current -> current.fingerprint == fingerprint } ||
            recent.any { current -> current.fingerprint == fingerprint }
        } == true
        if (duplicate) return@synchronized false
        queue += item
        item.fingerprint?.let { recent += RecentFingerprint(it, nowMs) }
        writeState(
          appContext,
          queue.takeLast(MAX_PENDING),
          recent.takeLast(MAX_RECENT),
        )
        true
      }
    }.getOrDefault(false)
    if (accepted) listeners.forEach { listener -> runCatching { listener(item.toMap()) } }
  }

  @Synchronized
  fun peek(context: Context): PendingMediaImportIntent? = readQueue(context.applicationContext).firstOrNull()

  @Synchronized
  fun acknowledge(context: Context, token: String): Boolean {
    val normalized = token.trim()
    if (normalized.isBlank()) return false
    val queue = readQueue(context.applicationContext)
    val next = queue.filterNot { it.token == normalized }
    if (next.size == queue.size) return false
    writeQueue(context.applicationContext, next)
    return true
  }

  fun addListener(listener: (Map<String, Any?>) -> Unit) {
    listeners += listener
  }

  fun removeListener(listener: (Map<String, Any?>) -> Unit) {
    listeners -= listener
  }

  private fun parseIntent(context: Context, intent: Intent, nowMs: Long): PendingMediaImportIntent {
    val uris = linkedSetOf<Uri>()
    if (intent.action == Intent.ACTION_VIEW) {
      intent.data?.let(uris::add)
    } else {
      if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        streamList(intent).forEach(uris::add)
      } else {
        streamUri(intent)?.let(uris::add)
      }
      val clip = intent.clipData
      if (clip != null) {
        for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(uris::add)
      }
    }
    val token = UUID.randomUUID().toString()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE || uris.size > 1) {
      return PendingMediaImportIntent(
        token, null, null, null, null, null, null, nowMs, "multiple_not_supported",
      )
    }
    val uri = uris.firstOrNull() ?: return PendingMediaImportIntent(
      token, null, null, null, null, null, null, nowMs, "missing_file",
    )
    if (uri.scheme !in setOf("content", "file")) {
      return PendingMediaImportIntent(
        token, null, null, null, null, null, null, nowMs, "unreadable_uri",
      )
    }
    val metadata = resolveMediaSourceMetadata(context, uri, intent.type)
    val mimeType = resolvedSupportedMimeType(metadata.fileName, metadata.mimeType)
    if (mimeType == null) {
      return PendingMediaImportIntent(
        token,
        uri.toString(),
        metadata.mimeType,
        metadata.fileName,
        metadata.byteSize,
        metadata.lastModifiedMs,
        mediaSourceFingerprint(metadata),
        nowMs,
        "unsupported_type",
      )
    }
    return PendingMediaImportIntent(
      token,
      uri.toString(),
      mimeType,
      metadata.fileName,
      metadata.byteSize,
      metadata.lastModifiedMs,
      mediaSourceFingerprint(metadata),
      nowMs,
      null,
    )
  }

  @Suppress("DEPRECATION")
  private fun streamUri(intent: Intent): Uri? = if (Build.VERSION.SDK_INT >= 33) {
    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
  } else {
    intent.getParcelableExtra(Intent.EXTRA_STREAM)
  }

  @Suppress("DEPRECATION")
  private fun streamList(intent: Intent): List<Uri> = if (Build.VERSION.SDK_INT >= 33) {
    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
  } else {
    intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
  }

  private fun readQueue(context: Context): List<PendingMediaImportIntent> {
    val encoded = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .getString(QUEUE_KEY, null) ?: return emptyList()
    return runCatching {
      val values = JSONArray(encoded)
      buildList {
        for (index in 0 until values.length()) {
          PendingMediaImportIntent.fromJson(values.optJSONObject(index) ?: continue)?.let(::add)
        }
      }
    }.getOrElse { emptyList() }
  }

  private fun readRecentFingerprints(context: Context): List<RecentFingerprint> {
    val encoded = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .getString(RECENT_KEY, null) ?: return emptyList()
    return runCatching {
      val values = JSONArray(encoded)
      buildList {
        for (index in 0 until values.length()) {
          val value = values.optJSONObject(index) ?: continue
          val fingerprint = value.optString("fingerprint").trim()
          val receivedAtMs = value.optLong("receivedAtMs", -1L)
          if (fingerprint.isNotBlank() && receivedAtMs >= 0L) {
            add(RecentFingerprint(fingerprint, receivedAtMs))
          }
        }
      }
    }.getOrElse { emptyList() }
  }

  private fun writeQueue(context: Context, queue: List<PendingMediaImportIntent>) {
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val editor = preferences.edit()
    if (queue.isEmpty()) editor.remove(QUEUE_KEY)
    else editor.putString(QUEUE_KEY, JSONArray().apply { queue.forEach { put(it.toJson()) } }.toString())
    check(editor.commit()) { "media import intent inbox could not be persisted" }
  }

  private fun writeState(
    context: Context,
    queue: List<PendingMediaImportIntent>,
    recent: List<RecentFingerprint>,
  ) {
    val editor = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
    if (queue.isEmpty()) editor.remove(QUEUE_KEY)
    else editor.putString(QUEUE_KEY, JSONArray().apply { queue.forEach { put(it.toJson()) } }.toString())
    if (recent.isEmpty()) editor.remove(RECENT_KEY)
    else editor.putString(RECENT_KEY, JSONArray().apply { recent.forEach { put(it.toJson()) } }.toString())
    check(editor.commit()) { "media import intent inbox could not be persisted" }
  }
}
