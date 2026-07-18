package com.laoji.nativeplatform.calendarpages

// CAL-REPEAT-RRULE-001: the source normal-instance and exception-instance matrix.

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarEditRecurrenceScopeTest {
  @Test
  fun `new and non-recurring events keep recurrence controls editable`() {
    assertTrue(CalendarEditPageState(editing = false, recurring = false).recurrenceRuleEditable)
    assertTrue(CalendarEditPageState(editing = true, recurring = false).recurrenceRuleEditable)
  }

  @Test
  fun `unresolved and exceptional occurrence edits hide recurrence controls`() {
    assertEquals(
      CalendarRecurrenceControlMode.HIDDEN,
      CalendarEditPageState(
        editing = true,
        recurring = true,
        recurrenceScope = null,
      ).recurrenceRuleMode,
    )
    assertEquals(
      CalendarRecurrenceControlMode.HIDDEN,
      CalendarEditPageState(
        editing = true,
        recurring = true,
        recurrenceException = true,
        recurrenceScope = CalendarEditRecurrenceScope.OCCURRENCE,
      ).recurrenceRuleMode,
    )
  }

  @Test
  fun `normal occurrence keeps recurrence controls visible but disabled`() {
    val state = CalendarEditPageState(
      editing = true,
      recurring = true,
      recurrenceException = false,
      recurrenceScope = CalendarEditRecurrenceScope.OCCURRENCE,
    )
    assertEquals(CalendarRecurrenceControlMode.DISABLED, state.recurrenceRuleMode)
    assertFalse(state.recurrenceRuleEditable)
  }

  @Test
  fun `unresolved recurring scope is not editable`() {
    assertFalse(CalendarEditPageState(
      editing = true,
      recurring = true,
      recurrenceScope = null,
    ).recurrenceRuleEditable)
  }

  @Test
  fun `following and series edits expose recurrence controls`() {
    assertTrue(CalendarEditPageState(
      editing = true,
      recurring = true,
      recurrenceScope = CalendarEditRecurrenceScope.FOLLOWING,
    ).recurrenceRuleEditable)
    assertTrue(CalendarEditPageState(
      editing = true,
      recurring = true,
      recurrenceScope = CalendarEditRecurrenceScope.SERIES,
    ).recurrenceRuleEditable)
  }
}
