package com.laoji.nativeplatform.media

import com.laoji.nativeplatform.minutes.MinutesPlayerSource
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class MinutesPlaybackRecoveryWriterTest {
  private fun record(position: Long) = MinutesPlaybackRecoveryRecord(
    source = MinutesPlayerSource("local:recording", "file:///recording.wav", storageScope = "guest"),
    positionMs = position, rate = 1.25f, wasPlaying = false, savedAtEpochMs = 123L,
  )

  private open class Store : MinutesPlaybackRecoveryStore {
    @Volatile var current: MinutesPlaybackRecoveryRecord? = null
    val saved = mutableListOf<MinutesPlaybackRecoveryRecord>()
    override fun load(activeStorageScope: String) = current
    override fun save(record: MinutesPlaybackRecoveryRecord): Boolean {
      saved.add(record); current = record; return true
    }
    override fun clear() { current = null }
  }

  private class ManualExecutor : AbstractExecutorService() {
    val tasks = java.util.ArrayDeque<Runnable>()
    private var stopped = false
    override fun execute(command: Runnable) { check(!stopped); tasks.add(command) }
    fun runAll() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    override fun shutdown() { stopped = true }
    override fun shutdownNow(): MutableList<Runnable> = tasks.toMutableList().also { tasks.clear(); stopped = true }
    override fun isShutdown() = stopped
    override fun isTerminated() = stopped && tasks.isEmpty()
    override fun awaitTermination(timeout: Long, unit: TimeUnit) = isTerminated
  }

  @Test fun pendingCheckpointsAreBoundedAndOnlyTheLatestIsWritten() {
    val executor = ManualExecutor(); val store = Store()
    val writer = MinutesPlaybackRecoveryWriter(store, executor)
    val completed = mutableListOf<Long>()
    for (position in 1L..100L) writer.enqueue(record(position)) { if (it) completed.add(position) }
    assertTrue(store.saved.isEmpty())
    assertEquals(1, executor.tasks.size)
    executor.runAll()
    assertEquals(listOf(record(100)), store.saved)
    assertEquals(listOf(100L), completed)
    executor.shutdown()
  }

  @Test fun clearingInvalidatesQueuedWritesWithoutResurrection() {
    val executor = ManualExecutor(); val store = Store()
    val writer = MinutesPlaybackRecoveryWriter(store, executor)
    var completed = false
    writer.enqueue(record(1)) { completed = true }
    writer.clear(); executor.runAll()
    assertNull(store.current); assertTrue(store.saved.isEmpty()); assertFalse(completed)
    writer.enqueue(record(2)) {}; executor.runAll()
    assertEquals(record(2), store.current)
    executor.shutdown()
  }

  @Test fun enqueueDoesNotWaitForAnInFlightDiskWrite() {
    val entered = CountDownLatch(1); val release = CountDownLatch(1)
    val store = object : Store() {
      override fun save(record: MinutesPlaybackRecoveryRecord): Boolean {
        if (record.positionMs == 1L) { entered.countDown(); check(release.await(3, TimeUnit.SECONDS)) }
        return super.save(record)
      }
    }
    val writer = MinutesPlaybackRecoveryWriter(store)
    try {
      writer.enqueue(record(1)) {}
      assertTrue(entered.await(3, TimeUnit.SECONDS))
      // This executes on the caller while the worker is held inside store.save.
      writer.enqueue(record(2)) {}
      assertNull(store.current)
    } finally { release.countDown(); writer.close() }
    assertEquals(listOf(record(1), record(2)), store.saved)
  }

  @Test fun clearWaitsForAnInFlightWriteThenDeletesItsResult() {
    val entered = CountDownLatch(1); val release = CountDownLatch(1)
    val store = object : Store() {
      override fun save(record: MinutesPlaybackRecoveryRecord): Boolean {
        entered.countDown(); check(release.await(3, TimeUnit.SECONDS)); return super.save(record)
      }
    }
    val writer = MinutesPlaybackRecoveryWriter(store)
    val clearer = Executors.newSingleThreadExecutor()
    try {
      writer.enqueue(record(1)) {}; assertTrue(entered.await(3, TimeUnit.SECONDS))
      val cleared = clearer.submit { writer.clear() }
      assertFalse(cleared.isDone)
      release.countDown(); cleared.get(3, TimeUnit.SECONDS)
      assertNull(store.current)
    } finally { release.countDown(); writer.close(); clearer.shutdownNow() }
  }

  @Test fun aFailedWriteDoesNotDisableTheNextCheckpoint() {
    val executor = ManualExecutor()
    val store = object : Store() {
      override fun save(record: MinutesPlaybackRecoveryRecord): Boolean {
        if (record.positionMs == 1L) throw IllegalStateException("disk unavailable")
        return super.save(record)
      }
    }
    val writer = MinutesPlaybackRecoveryWriter(store, executor)
    val outcomes = mutableListOf<Boolean>()
    writer.enqueue(record(1), outcomes::add); executor.runAll()
    writer.enqueue(record(2), outcomes::add); executor.runAll()
    assertEquals(listOf(false, true), outcomes); assertEquals(record(2), store.current)
    executor.shutdown()
  }

  @Test fun serviceCloseFlushesTheLastCheckpointAndRejectsNewWrites() {
    val store = Store(); val writer = MinutesPlaybackRecoveryWriter(store)
    writer.enqueue(record(43)) {}; writer.close(); writer.close()
    assertEquals(record(43), store.current)
    assertThrows(IllegalStateException::class.java) { writer.enqueue(record(44)) {} }
  }
}
