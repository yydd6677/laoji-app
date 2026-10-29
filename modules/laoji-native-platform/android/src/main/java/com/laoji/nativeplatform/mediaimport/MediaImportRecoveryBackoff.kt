package com.laoji.nativeplatform.mediaimport

/** Retry timing only. The ingest journal remains the durable work owner. */
internal class MediaImportRecoveryBackoff(private val now: () -> Long = System::currentTimeMillis) {
  private data class Retry(val failures: Int, val afterMs: Long)
  private val retries = mutableMapOf<String, Retry>()

  @Synchronized fun ready(key: String): Boolean = (retries[key]?.afterMs ?: 0) <= now()
  @Synchronized fun failed(key: String) {
    val count = ((retries[key]?.failures ?: 0) + 1).coerceAtMost(5)
    retries[key] = Retry(count, now() + (30_000L shl (count - 1)).coerceAtMost(300_000L))
  }
  @Synchronized fun succeeded(key: String) { retries.remove(key) }
  @Synchronized fun retain(keys: Set<String>) { retries.keys.retainAll(keys) }
}
