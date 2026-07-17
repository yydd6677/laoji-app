package com.laoji.nativeplatform.evidence

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// UI-ANDROID-RUNTIME-001
class FeishuEvidenceContractTest {
  @Test
  fun evidenceIdsAreStrictAndStable() {
    val pattern = Regex("^(?:CAL|MIN|UI)-[A-Z0-9-]+-[0-9]{3}$")
    assertTrue(pattern.matches("UI-CALENDAR-INDICATOR-001"))
    assertTrue(pattern.matches("CAL-PICKER-WHEEL-TAP-001"))
    assertFalse(pattern.matches("invented-button"))
  }
}
