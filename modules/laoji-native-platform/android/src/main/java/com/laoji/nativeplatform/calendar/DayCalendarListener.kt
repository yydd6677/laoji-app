package com.laoji.nativeplatform.calendar

// CAL-DAY-PAGER-001 / CAL-DAY-DRAG-001: semantic boundary between the native day surface and host.

interface DayCalendarListener {
  fun onDateSelected(epochDay: Int)
  fun onEventOpened(event: CalendarEvent)
  fun onCreateRequested(draft: CalendarDraft)
  fun onDraftChanged(draft: CalendarDraft?, reason: String)
  fun onMutationRequested(
    kind: CalendarMutationKind,
    original: CalendarEvent,
    optimistic: CalendarEvent,
  ): Boolean
}
