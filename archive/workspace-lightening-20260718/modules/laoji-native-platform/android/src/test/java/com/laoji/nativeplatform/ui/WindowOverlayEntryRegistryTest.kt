package com.laoji.nativeplatform.ui

// UI-TOAST-WINDOW-001: execute latest-wins and stale-owner dismissal arbitration.

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class WindowOverlayEntryRegistryTest {
  private data class Entry(
    val kind: WindowOverlayKind,
    val ownerId: String,
  )

  @Test
  fun `latest owner replaces the slot and stale removal cannot dismiss it`() {
    val registry = WindowOverlayEntryRegistry<Entry>({ it.kind }, { it.ownerId })
    val first = Entry(WindowOverlayKind.TOAST, "toast-first")
    val second = Entry(WindowOverlayKind.TOAST, "toast-second")

    assertNull(registry.put(first))
    assertSame(first, registry.currentForOwner(WindowOverlayKind.TOAST, first.ownerId))
    assertSame(first, registry.put(second))
    assertNull(registry.currentForOwner(WindowOverlayKind.TOAST, first.ownerId))
    assertSame(second, registry.currentForOwner(WindowOverlayKind.TOAST, second.ownerId))
    assertTrue(registry.contains(WindowOverlayKind.TOAST))

    assertFalse(registry.removeIfCurrent(first))
    assertSame(second, registry[WindowOverlayKind.TOAST])
    assertTrue(registry.removeIfCurrent(second))
    assertFalse(registry.contains(WindowOverlayKind.TOAST))
  }
}
