package com.laoji.nativeplatform.hardware

/** Retry only a synchronously rejected BUSY admission, never an accepted
 * write or a missing callback. Android cannot identify a late callback after
 * a timeout, so the transport must retire that connection instead of reuse. */
internal class HardwareGattWriteAdmission(
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
  private val pause: (Long) -> Unit = { Thread.sleep(it) },
) {
  fun await(busyCode: Int, attached: () -> Boolean, submit: () -> Int): Int {
    val began = nowMs()
    var attempts = 0
    while (attached()) {
      val result = submit()
      if (result != busyCode) return result
      attempts++
      val remaining = 300 - (nowMs() - began).coerceAtLeast(0)
      if (remaining <= 0 || attempts >= 21) return result
      pause(minOf(15, remaining))
    }
    return busyCode
  }
}
