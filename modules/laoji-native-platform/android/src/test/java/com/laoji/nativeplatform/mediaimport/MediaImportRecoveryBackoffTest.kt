package com.laoji.nativeplatform.mediaimport

import org.junit.Assert.*
import org.junit.Test

class MediaImportRecoveryBackoffTest {
  @Test fun failedSourceBacksOffWithoutBlockingAnotherImport() {
    var now = 1_000L
    val retries = MediaImportRecoveryBackoff { now }
    assertTrue(retries.ready("failed"))
    retries.failed("failed")
    assertFalse(retries.ready("failed"))
    assertTrue(retries.ready("healthy"))
    now += 30_000
    assertTrue(retries.ready("failed"))
    retries.failed("failed")
    now += 30_000
    assertFalse(retries.ready("failed"))
    now += 30_000
    assertTrue(retries.ready("failed"))
    repeat(10) { retries.failed("failed"); now += 300_000; assertTrue(retries.ready("failed")) }
    retries.succeeded("failed")
    retries.failed("failed")
    now += 30_000
    assertTrue(retries.ready("failed"))
  }
  @Test fun deletedJournalsReleaseTheirRetryState() {
    val retries = MediaImportRecoveryBackoff { 1_000 }
    retries.failed("removed")
    retries.retain(setOf("retained"))
    assertTrue(retries.ready("removed"))
  }
}
