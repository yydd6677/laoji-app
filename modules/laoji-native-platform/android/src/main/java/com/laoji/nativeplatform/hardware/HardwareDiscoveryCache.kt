package com.laoji.nativeplatform.hardware

/** Process-local scan coalescing. Rapid refreshes must not exhaust Android's
 * BLE scan-start quota; concurrent callers share the same bounded scan. */
internal class HardwareDiscoveryCache<T>(private val intervalMs: Long = 7_000L) {
  private var beganAt: Long? = null
  private var result: Result<List<T>>? = null

  @Synchronized fun get(nowMs: () -> Long, load: () -> List<T>): List<T> {
    val now = nowMs()
    val previous = beganAt
    if (previous != null && now >= previous && now - previous < intervalMs) {
      result?.let { return it.getOrThrow() }
    }
    beganAt = now
    val loaded = runCatching { load().toList() }
    result = loaded
    return loaded.getOrThrow()
  }
}
