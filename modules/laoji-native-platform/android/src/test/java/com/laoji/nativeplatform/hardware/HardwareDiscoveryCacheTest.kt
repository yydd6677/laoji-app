package com.laoji.nativeplatform.hardware

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class HardwareDiscoveryCacheTest {
  @Test fun rapidRefreshSharesThePreviousScanButANewWindowRefreshes() {
    val cache = HardwareDiscoveryCache<String>(); var calls = 0; var clock = 0L
    fun scan() = cache.get({ clock }) { calls++; listOf("board-$calls") }
    assertEquals(listOf("board-1"), scan())
    clock = 6999; repeat(10) { assertEquals(listOf("board-1"), scan()) }
    assertEquals(1, calls)
    clock = 7000; assertEquals(listOf("board-2"), scan())
  }
  @Test fun failedStartAlsoConsumesTheWindowInsteadOfRetryStorming() {
    val cache = HardwareDiscoveryCache<String>(); var calls = 0
    val failure = IllegalStateException("scan rejected")
    repeat(8) {
      try { cache.get({ 0L }) { calls++; throw failure }; fail("accepted scan") }
      catch (caught: IllegalStateException) { assertSame(failure, caught) }
    }
    assertEquals(1, calls)
    assertEquals(listOf("recovered"), cache.get({ 7000L }) { listOf("recovered") })
  }
  @Test fun concurrentCallersWaitForTheSameScan() {
    val cache = HardwareDiscoveryCache<String>(); val entered = CompletableFuture<Unit>()
    val release = CompletableFuture<Unit>(); val one = CompletableFuture<List<String>>()
    val two = CompletableFuture<List<String>>()
    val a = Thread { one.complete(cache.get({ 1L }) { entered.complete(Unit); release.get(2, TimeUnit.SECONDS); listOf("board") }) }
    a.start(); entered.get(2, TimeUnit.SECONDS)
    val b = Thread { two.complete(cache.get({ 2L }) { throw AssertionError("duplicate scanner") }) }
    b.start(); release.complete(Unit)
    assertEquals(listOf("board"), one.get(2, TimeUnit.SECONDS))
    assertEquals(listOf("board"), two.get(2, TimeUnit.SECONDS))
    a.join(2000); b.join(2000)
  }
}
