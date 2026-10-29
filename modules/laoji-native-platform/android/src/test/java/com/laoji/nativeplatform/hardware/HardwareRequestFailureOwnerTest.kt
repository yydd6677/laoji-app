package com.laoji.nativeplatform.hardware

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.lang.reflect.InvocationTargetException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Exercise the actual runtime owner without Android/radio/file dependencies.
 * No new production seam or second connection state machine is introduced. */
class HardwareRequestFailureOwnerTest {
  private fun field(name: String) = HardwareRuntime.javaClass.getDeclaredField(name).also { it.isAccessible = true }
  private fun <T> isolated(work: () -> T): T {
    val names = listOf("transport", "snapshot", "epoch", "context")
    val saved = names.associateWith { field(it).get(HardwareRuntime) }
    assertNull(field("live").get(HardwareRuntime)); assertNull(field("liveRealtime").get(HardwareRuntime))
    try {
      field("context").set(HardwareRuntime, null)
      field("epoch").setLong(HardwareRuntime, 42L)
      field("snapshot").set(HardwareRuntime, HardwareRuntimeSnapshot("recording", "ble", "ble:unit", sessionId = "capture-unit"))
      return work()
    } finally { saved.forEach { (name, value) -> field(name).set(HardwareRuntime, value) } }
  }
  private class Transport(val action: () -> Unit) : HardwareDuplexTransport {
    var closes = 0
    override val transportName = "ble"
    override val locator = "ble:unit"
    override fun read(timeoutMs: Int): HardwareFrame? = null
    override fun write(message: JSONObject) { action() }
    override fun isAttached() = closes == 0
    override fun close() { closes++ }
  }
  private fun requestFailure(): Throwable {
    val request = HardwareRuntime.javaClass.declaredMethods.single { it.name == "request" && it.parameterCount == 5 }
    request.isAccessible = true
    try { request.invoke(HardwareRuntime, "capture.pause", emptyMap<String, Any?>(), null, null, null) }
    catch (error: InvocationTargetException) { return error.cause!! }
    throw AssertionError("request unexpectedly succeeded")
  }
  @Test fun directWriteFailurePublishesTheConnectionOutcomeBeforeRejectingTheOperation() = isolated {
    val error = HardwareTransportException("无线录音设备连接超时。")
    val transport = Transport { throw error }; field("transport").set(HardwareRuntime, transport)
    assertSame(error, requestFailure())
    assertEquals(1, transport.closes); assertNull(field("transport").get(HardwareRuntime))
    assertEquals(43L, field("epoch").getLong(HardwareRuntime))
    val state = HardwareRuntime.getState()
    assertEquals("retryable_error", state.phase); assertNull(state.sessionId)
    assertEquals("transport_lost", state.errorCode); assertEquals(error.message, state.errorMessage)
  }
  @Test fun obsoleteWriteFailureCannotCloseOrRelabelAReplacementConnection() = isolated {
    val replacement = Transport {}
    val newer = HardwareRuntimeSnapshot("ready", "ble", "ble:newer")
    val error = HardwareTransportException("old write failed")
    val old = Transport {
      field("transport").set(HardwareRuntime, replacement)
      field("epoch").setLong(HardwareRuntime, 43L)
      field("snapshot").set(HardwareRuntime, newer)
      throw error
    }
    field("transport").set(HardwareRuntime, old)
    assertSame(error, requestFailure())
    assertSame(replacement, field("transport").get(HardwareRuntime))
    assertSame(newer, HardwareRuntime.getState()); assertEquals(0, replacement.closes)
  }
  @Test fun nonTransportRejectionDoesNotRetireAHealthyConnection() = isolated {
    val error = HardwareRuntimeException("busy", "设备当前无法执行这项操作。")
    val transport = Transport { throw error }; field("transport").set(HardwareRuntime, transport)
    assertSame(error, requestFailure()); assertEquals(0, transport.closes)
    assertEquals("recording", HardwareRuntime.getState().phase)
    assertEquals(42L, field("epoch").getLong(HardwareRuntime))
  }

  /** Force the old terminal callback to wait for the owner lock, then replace
   * the connection. The generation check must happen after acquiring it. */
  private fun replacementWinsWhileFailureWaits(action: (Transport) -> Unit) = isolated {
    val error = AtomicReference<Throwable?>()
    val old = Transport { }
    val replacement = Transport { }
    val newer = HardwareRuntimeSnapshot("ready", "ble", "ble:newer")
    field("transport").set(HardwareRuntime, old)
    val thread = Thread {
      try { action(old) } catch (failure: Throwable) { error.set(failure) }
    }
    val lock = field("lock").get(HardwareRuntime)
    try {
      synchronized(lock) {
        thread.start()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (thread.state != Thread.State.BLOCKED && thread.isAlive && System.nanoTime() < deadline) Thread.sleep(1)
        assertEquals("old callback must reach the owner lock", Thread.State.BLOCKED, thread.state)
        field("transport").set(HardwareRuntime, replacement)
        field("epoch").setLong(HardwareRuntime, 43L)
        field("snapshot").set(HardwareRuntime, newer)
      }
      thread.join(2000)
      assertFalse("old callback must settle", thread.isAlive)
      error.get()?.let { throw AssertionError("old callback threw", it) }
      assertSame(replacement, field("transport").get(HardwareRuntime))
      assertSame(newer, HardwareRuntime.getState())
      assertEquals(0, replacement.closes)
      assertEquals(43L, field("epoch").getLong(HardwareRuntime))
    } finally {
      if (thread.isAlive) { thread.interrupt(); thread.join(2000) }
    }
  }

  @Test fun staleForegroundServiceFailureCannotCloseAReplacementConnection() =
    replacementWinsWhileFailureWaits { HardwareRuntime.serviceUnavailable(42L) }

  @Test fun staleReaderFailureCannotCloseAReplacementConnection() =
    replacementWinsWhileFailureWaits { old ->
      // Throwing in read enters the actual reader catch path without any
      // Android Bluetooth or timing assumptions.
      val reader = HardwareRuntime.javaClass.declaredMethods.single { it.name == "readLoop" }
      reader.isAccessible = true
      val broken = object : HardwareDuplexTransport {
        override val transportName = old.transportName
        override val locator = old.locator
        override fun read(timeoutMs: Int): HardwareFrame? = throw HardwareTransportException("old reader failed")
        override fun write(message: JSONObject) = Unit
        override fun isAttached() = true
        override fun close() = Unit
      }
      field("transport").set(HardwareRuntime, broken)
      reader.invoke(HardwareRuntime, broken, 42L)
    }
}
