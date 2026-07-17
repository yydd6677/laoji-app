package com.laoji.nativeplatform.calendarpages

// CAL-DETAIL-001 / CAL-EDIT-001: route-level native view contracts. CAL-SEARCH-001
// is instantiated by the Activity window owner, never as a sibling Fabric root.

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LaojiCalendarDetailModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiCalendarDetail")
    Constant("snapshotSchemaVersion") { CALENDAR_PAGE_SCHEMA_VERSION }
    View(CalendarDetailPageView::class) {
      Events("onAction")
      Prop("snapshot") { view: CalendarDetailPageView, snapshot: Map<String, Any?> ->
        view.setSnapshot(snapshot)
      }
      OnViewDidUpdateProps<CalendarDetailPageView> { view -> view.commitProps() }
    }
  }
}

class LaojiCalendarEditModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiCalendarEdit")
    Constant("snapshotSchemaVersion") { CALENDAR_PAGE_SCHEMA_VERSION }
    View(CalendarEditPageView::class) {
      Events("onAction")
      Prop("snapshot") { view: CalendarEditPageView, snapshot: Map<String, Any?> ->
        view.setSnapshot(snapshot)
      }
      OnViewDidUpdateProps<CalendarEditPageView> { view -> view.commitProps() }
    }
  }
}
