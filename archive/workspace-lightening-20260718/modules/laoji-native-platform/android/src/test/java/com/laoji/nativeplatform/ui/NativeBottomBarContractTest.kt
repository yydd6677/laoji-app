package com.laoji.nativeplatform.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeBottomBarContractTest {
  @Test
  fun `UI-SHELL-BOTTOM-MAIN-001 keeps source item geometry and one physical pixel divider`() {
    assertEquals(65f, NativeBottomBarContract.CONTENT_HEIGHT_DP, 0f)
    assertEquals(1, NativeBottomBarContract.DIVIDER_HEIGHT_PX)
    assertEquals(22f, NativeBottomBarContract.ICON_SIZE_DP, 0f)
    assertEquals(38f, NativeBottomBarContract.ICON_CONTAINER_WIDTH_DP, 0f)
    assertEquals(30f, NativeBottomBarContract.ICON_CONTAINER_HEIGHT_DP, 0f)
    assertEquals(9f, NativeBottomBarContract.ICON_CONTAINER_TOP_DP, 0f)
    assertEquals(44f, NativeBottomBarContract.LABEL_TOP_DP, 0f)
    assertEquals(12f, NativeBottomBarContract.LABEL_TEXT_SP, 0f)
  }

  @Test
  fun `UI-SHELL-BOTTOM-MAIN-001 rounds dp like the source on non-integer density`() {
    assertEquals(171, NativeBottomBarContract.dpToPx(65f, 2.625f))
    assertEquals(58, NativeBottomBarContract.dpToPx(22f, 2.625f))
    assertEquals(172, NativeBottomBarContract.totalHeightPx(65f, 2.625f, navigationInsetPx = 0))
    assertEquals(206, NativeBottomBarContract.totalHeightPx(65f, 2.625f, navigationInsetPx = 34))
  }

  @Test
  fun `UI-SHELL-BOTTOM-MAIN-001 preserves the source icon-only selection motion`() {
    assertEquals(1f, NativeBottomBarContract.PRESS_SCALE_FROM, 0f)
    assertEquals(0.8f, NativeBottomBarContract.PRESS_SCALE_TO, 0f)
    assertEquals(125L, NativeBottomBarContract.PRESS_LEG_DURATION_MS)
  }

  @Test
  fun `UI-SHELL-BOTTOM-MAIN-001 consumes positive cross-root motion commands once`() {
    val gate = NativeBottomBarSelectionCommandGate()

    assertFalse(gate.accept(null))
    assertFalse(gate.accept(0))
    assertTrue(gate.accept(1))
    assertFalse(gate.accept(1))
    assertFalse(gate.accept(-1))
    assertTrue(gate.accept(3))
    assertFalse(gate.accept(2))
  }
}
