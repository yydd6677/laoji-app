package com.laoji.nativeplatform.audio

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RecorderLevelHubTest {
  @Before
  fun setUp() = RecorderLevelHub.clearAllForTest()

  @After
  fun tearDown() = RecorderLevelHub.clearAllForTest()

  @Test
  fun `MIN-REC-BRIDGE-001 repeated levels still advance sequence`() = runBlocking {
    val source = RecorderLevelHub.observe("meeting-a")
    val observed = mutableListOf<RecorderLevelFrame>()
    val collector = launch(Dispatchers.Unconfined) {
      source.filterNotNull().take(2).collect(observed::add)
    }

    val first = publish("meeting-a", normalized = 0.5f, durationMs = 100L)
    val second = publish("meeting-a", normalized = 0.5f, durationMs = 200L)
    collector.join()

    assertEquals(1L, first.sequence)
    assertEquals(2L, second.sequence)
    assertEquals(listOf(1L, 2L), observed.map(RecorderLevelFrame::sequence))
    assertEquals(second, source.value)
  }

  @Test
  fun `MIN-REC-BRIDGE-001 isolates sessions`() {
    publish("meeting-a", normalized = 0.2f, durationMs = 100L)
    publish("meeting-b", normalized = 0.8f, durationMs = 900L)

    assertEquals(0.2f, RecorderLevelHub.latest("meeting-a")?.normalized)
    assertEquals(100L, RecorderLevelHub.latest("meeting-a")?.durationMs)
    assertEquals(0.8f, RecorderLevelHub.latest("meeting-b")?.normalized)
    assertEquals(900L, RecorderLevelHub.latest("meeting-b")?.durationMs)
  }

  @Test
  fun `MIN-REC-BRIDGE-001 retains only the last 160 samples`() {
    repeat(200) { index ->
      publish("meeting-a", normalized = index / 199f, durationMs = index.toLong())
    }

    val bars = RecorderLevelHub.summary("meeting-a", count = 160)

    assertEquals(160, bars.size)
    assertEquals(40f / 199f, bars.first(), 0.0001f)
    assertEquals(1f, bars.last(), 0.0001f)
  }

  @Test
  fun `MIN-REC-BRIDGE-001 peak buckets match the TypeScript summary contract`() {
    assertEquals(
      listOf(0.9f, 0.8f),
      RecorderLevelHub.samplesToBars(listOf(0.1f, 0.9f, 0.2f, 0.8f), count = 2),
    )
    assertEquals(
      listOf(0.5f, 1f, 0.04f),
      RecorderLevelHub.samplesToBars(listOf(2f, 4f, 0f), count = 3),
    )
  }

  @Test
  fun `MIN-REC-BRIDGE-001 capture clears the session after preserving bars`() {
    publish("meeting-a", normalized = 0.3f, durationMs = 100L)
    publish("meeting-a", normalized = 0.7f, durationMs = 200L)

    val bars = RecorderLevelHub.captureSummaryAndClear("meeting-a")

    assertEquals(listOf(0.3f, 0.7f), bars)
    assertNull(RecorderLevelHub.latest("meeting-a"))
    assertTrue(RecorderLevelHub.summary("meeting-a").isEmpty())
  }

  @Test
  fun `MIN-REC-BRIDGE-001 concurrent publishers cannot duplicate sequence values`() {
    val executor = Executors.newFixedThreadPool(8)
    val ready = CountDownLatch(8)
    val start = CountDownLatch(1)
    val done = CountDownLatch(8)
    repeat(8) { worker ->
      executor.execute {
        ready.countDown()
        start.await()
        repeat(50) { index ->
          publish("meeting-a", normalized = (worker + index) / 64f, durationMs = index.toLong())
        }
        done.countDown()
      }
    }

    assertTrue(ready.await(2, TimeUnit.SECONDS))
    start.countDown()
    assertTrue(done.await(5, TimeUnit.SECONDS))
    executor.shutdownNow()

    assertEquals(400L, RecorderLevelHub.latest("meeting-a")?.sequence)
    assertEquals(50, RecorderLevelHub.summary("meeting-a").size)
  }

  private fun publish(sessionId: String, normalized: Float, durationMs: Long): RecorderLevelFrame =
    RecorderLevelHub.publish(
      sessionId = sessionId,
      normalized = normalized,
      peak = 100,
      rms = 50,
      durationMs = durationMs,
      capturedAtElapsedMs = durationMs,
    )
}
