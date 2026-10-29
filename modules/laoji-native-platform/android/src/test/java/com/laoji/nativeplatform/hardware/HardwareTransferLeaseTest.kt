package com.laoji.nativeplatform.hardware

import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class HardwareTransferLeaseTest {
  private class Resource : Closeable { var closes = 0; override fun close() { closes++ } }
  private fun lost() = HardwareRuntimeException("transport_lost", "连接已断开。")

  @Test fun successfulScopeClosesExactlyOnce() {
    val lease = HardwareTransferLease(); val resource = Resource()
    assertEquals(7, lease.use(resource) { 7 })
    lease.close(); assertEquals(1, resource.closes)
  }
  @Test fun cancellationBeforeRegistrationClosesAndRejectsLateSocket() {
    val lease = HardwareTransferLease(); val resource = Resource(); val error = lost()
    lease.cancel(error)
    try { lease.use(resource) { fail("ran cancelled operation") }; fail("accepted cancellation") }
    catch (caught: HardwareRuntimeException) { assertSame(error, caught) }
    assertEquals(1, resource.closes)
  }
  @Test fun firstFailureWinsAndCancellingTwiceDoesNotDoubleClose() {
    val lease = HardwareTransferLease(); val resource = Resource(); val first = lost()
    lease.use(resource) {
      lease.cancel(first); lease.cancel(lost())
      try { lease.check(); fail("ignored loss") }
      catch (caught: HardwareRuntimeException) { assertSame(first, caught) }
    }
    assertEquals(1, resource.closes)
  }
  @Test fun exceptionAndConnectionFailureStillCloseResource() {
    val resource = Resource(); val lease = HardwareTransferLease()
    try { lease.use(resource) { throw java.io.IOException("connect failed") }; fail("ignored error") }
    catch (_: java.io.IOException) { }
    assertEquals(1, resource.closes)
  }
  @Test fun lossInterruptsARealBlockedSocketReadWithoutItsTwentySecondTimeout() {
    ServerSocket(0).use { server ->
      val accepted = CompletableFuture<Socket>()
      val acceptor = Thread { accepted.complete(server.accept()) }.apply { isDaemon = true; start() }
      val lease = HardwareTransferLease(); val reading = CompletableFuture<Unit>(); val finished = CompletableFuture<Unit>()
      val worker = Thread {
        try {
          lease.use(Socket("127.0.0.1", server.localPort)) { socket ->
            socket.soTimeout = 20_000; reading.complete(Unit)
            socket.getInputStream().read()
            finished.completeExceptionally(AssertionError("read should be interrupted"))
          }
        } catch (_: java.io.IOException) { finished.complete(Unit) }
      }.apply { isDaemon = true; start() }
      accepted.get(2, TimeUnit.SECONDS).use {
        reading.get(2, TimeUnit.SECONDS)
        lease.cancel(lost())
        finished.get(2, TimeUnit.SECONDS)
      }
      worker.join(2000); acceptor.join(2000)
      assertFalse(worker.isAlive)
    }
  }
}
