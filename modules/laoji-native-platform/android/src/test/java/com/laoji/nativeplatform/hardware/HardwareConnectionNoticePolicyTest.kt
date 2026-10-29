package com.laoji.nativeplatform.hardware

import org.junit.Assert.*
import org.junit.Test

class HardwareConnectionNoticePolicyTest {
  @Test fun byteProgressDoesNotChangeTheNotificationIdentity() {
    val identity = HardwareConnectionNoticePolicy.text("transferring")
    repeat(100) { assertEquals(identity, HardwareConnectionNoticePolicy.text("transferring")) }
    assertNotEquals(identity, HardwareConnectionNoticePolicy.text("ready"))
    assertEquals("正在录音", HardwareConnectionNoticePolicy.text("recording"))
    assertEquals("录音已暂停", HardwareConnectionNoticePolicy.text("paused"))
    assertEquals("正在保存录音", HardwareConnectionNoticePolicy.text("finalizing"))
  }
  @Test fun wakeRenewalIsBoundedButReacquiresAnExpiredLock() {
    assertTrue(HardwareConnectionNoticePolicy.renewWake(false, 20, 0))
    assertFalse(HardwareConnectionNoticePolicy.renewWake(true, 299_999, 0))
    assertTrue(HardwareConnectionNoticePolicy.renewWake(true, 300_000, 0))
    assertTrue(HardwareConnectionNoticePolicy.needsWake("recording"))
    assertTrue(HardwareConnectionNoticePolicy.needsWake("paused"))
    assertTrue(HardwareConnectionNoticePolicy.needsWake("transferring"))
    assertFalse(HardwareConnectionNoticePolicy.needsWake("ready"))
    assertFalse(HardwareConnectionNoticePolicy.needsWake("disconnected"))
  }
}
