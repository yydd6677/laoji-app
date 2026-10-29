package com.laoji.nativeplatform.hardware

import java.io.Closeable

/** One network request owns one live socket. Loss must interrupt blocked I/O,
 * not merely change a Future that has already completed. */
internal class HardwareTransferLease : Closeable {
  private val lock = Any()
  private var failure: HardwareRuntimeException? = null
  private var resource: Closeable? = null

  fun check() = synchronized(lock) { failure?.let { throw it } }

  fun cancel(error: HardwareRuntimeException) {
    val previous = synchronized(lock) {
      if (failure == null) failure = error
      resource.also { resource = null }
    }
    runCatching { previous?.close() }
  }

  fun <T : Closeable, R> use(value: T, action: (T) -> R): R {
    val rejected = synchronized(lock) {
      failure ?: if (resource != null) {
        HardwareRuntimeException("busy", "另一段录音正在接收。")
      } else { resource = value; null }
    }
    if (rejected != null) {
      runCatching { value.close() }
      throw rejected
    }
    try {
      check()
      return action(value)
    } finally {
      val owned = synchronized(lock) {
        if (resource === value) { resource = null; true } else false
      }
      if (owned) runCatching { value.close() }
    }
  }

  override fun close() = cancel(HardwareRuntimeException("transport_lost", "录音设备的传输连接已关闭。"))
}
