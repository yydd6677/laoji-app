package com.laoji.nativeplatform.hardware

import org.junit.Assert.*
import org.junit.Test

class HardwareGattWriteAdmissionTest {
  @Test fun onlyNotAdmittedBusyFragmentsRetryAndAcceptedWritesAreNeverRepeated() {
    var now = 0L; var calls = 0
    val gate = HardwareGattWriteAdmission({ now }, { now += it })
    val result = gate.await(201, { true }) { if (++calls < 3) 201 else 0 }
    assertEquals(0, result); assertEquals(3, calls); assertEquals(30L, now)
  }
  @Test fun permissionAndUnsupportedFailuresAreImmediate() {
    for (status in listOf(1, 4, 6, 200, -1)) {
      var calls = 0
      val gate = HardwareGattWriteAdmission({ 0 }, { throw AssertionError("delayed fatal status") })
      assertEquals(status, gate.await(201, { true }) { calls++; status }); assertEquals(1, calls)
    }
  }
  @Test fun persistentBusyHasAnAbsoluteAndIterationBound() {
    var now = 0L; var calls = 0
    val gate = HardwareGattWriteAdmission({ now }, { now += it })
    assertEquals(201, gate.await(201, { true }) { calls++; 201 })
    assertEquals(300L, now); assertEquals(21, calls)
    var frozenCalls = 0
    assertEquals(201, HardwareGattWriteAdmission({ 0 }, {}).await(201, { true }) { frozenCalls++; 201 })
    assertEquals(21, frozenCalls)
  }
  @Test fun disconnectCancelsAdmissionWithoutSendingAnotherFragment() {
    var connected = true; var calls = 0
    val gate = HardwareGattWriteAdmission({ 0 }, { connected = false })
    assertEquals(201, gate.await(201, { connected }) { calls++; 201 }); assertEquals(1, calls)
    assertEquals(201, gate.await(201, { false }) { throw AssertionError("write after disconnect") })
  }
}
