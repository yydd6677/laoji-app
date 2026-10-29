package com.laoji.nativeplatform.media

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** One bounded writer for the service-owned recovery file. UI commands never wait for a save. */
internal class MinutesPlaybackRecoveryWriter(
  private val store: MinutesPlaybackRecoveryStore,
  private val executor: ExecutorService = Executors.newSingleThreadExecutor { task ->
    Thread(task, "LaoJi-playback-recovery").apply { isDaemon = true }
  },
) : AutoCloseable {
  private data class Pending(
    val generation: Long,
    val record: MinutesPlaybackRecoveryRecord,
    val completion: (Boolean) -> Unit,
  )

  private val stateLock = Any()
  private val ioLock = Any()
  private var generation = 0L
  private var pending: Pending? = null
  private var draining = false
  private var closed = false

  fun enqueue(record: MinutesPlaybackRecoveryRecord, completion: (Boolean) -> Unit) {
    synchronized(stateLock) {
      check(!closed) { "Playback recovery writer is closed" }
      // Only the newest checkpoint matters while the preceding atomic write is in flight.
      pending = Pending(generation, record, completion)
      if (!draining) {
        draining = true
        executor.execute(::drain)
      }
    }
  }

  /** Destructive transitions wait for the in-flight write, then delete it. Stale saves cannot win. */
  fun clear() {
    synchronized(stateLock) {
      generation += 1L
      pending = null
    }
    synchronized(ioLock) { store.clear() }
  }

  private fun drain() {
    while (true) {
      val next = synchronized(stateLock) {
        val queued = pending
        if (queued == null) {
          draining = false
          return
        }
        pending = null
        queued
      }
      val saved = synchronized(ioLock) {
        if (synchronized(stateLock) { next.generation != generation }) false
        else runCatching { store.save(next.record) }.getOrDefault(false)
      }
      if (synchronized(stateLock) { next.generation == generation }) next.completion(saved)
    }
  }

  /** Service destruction flushes the last checkpoint, not every ordinary page exit. */
  override fun close() {
    synchronized(stateLock) {
      if (closed) return
      closed = true
    }
    try {
      executor.submit {}.get()
    } finally {
      executor.shutdown()
    }
  }
}
