package com.laoji.nativeplatform.calendarpages

// UI-TITLE-COMMON-001: mounts the production detail page for source-shaped
// title hierarchy and action-slot instrumentation.

import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.ComponentActivity

class CalendarDetailPageTestActivity : ComponentActivity() {
  lateinit var page: CalendarDetailPageView
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    page = CalendarDetailPageView(this, calendarPageTestAppContext(applicationContext)).apply {
      setSnapshot(
        mapOf(
          "schemaVersion" to 1,
          "state" to "ready",
          "event" to mapOf(
            "sourceEventId" to "title-source-fixture",
            "occurrenceDate" to "2026-07-17",
            "title" to "源码标题栏评审",
            "timeLabel" to "7月17日 周五 10:00 - 10:30",
            "recurring" to false,
            "recurrenceException" to false,
            "editable" to true,
          ),
        ),
      )
      commitProps()
    }
    setContentView(
      page,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }
}
