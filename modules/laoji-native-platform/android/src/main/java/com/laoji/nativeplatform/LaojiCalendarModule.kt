package com.laoji.nativeplatform

// CAL-ROOT-001: Expo props carry snapshots and resolutions; events carry semantic user operations.

import com.laoji.nativeplatform.calendar.CalendarEvent
import com.laoji.nativeplatform.calendar.CalendarInstanceLayout
import com.laoji.nativeplatform.calendar.CalendarHostView
import com.laoji.nativeplatform.calendar.CalendarMutationResolution
import com.laoji.nativeplatform.calendar.CalendarSettings
import com.laoji.nativeplatform.calendar.CalendarSnapshot
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class CalendarSettingsRecord : Record {
  @Field
  var defaultEventDurationMinutes: Int = 30

  @Field
  var firstDayOfWeek: Int = 0

  fun toModel(): CalendarSettings = CalendarSettings(
    defaultEventDurationMinutes = defaultEventDurationMinutes,
    firstDayOfWeek = firstDayOfWeek
  )
}

// CAL-DAY-COMPOSE-001: the bridge accepts the same percentage rectangle that
// Feishu's Rust-backed InstanceLayout adapter produces.
class CalendarInstanceLayoutRecord : Record {
  @Field
  var xOffsetPercent: Double = 0.0

  @Field
  var yOffsetPercent: Double = 0.0

  @Field
  var widthPercent: Double = 0.0

  @Field
  var heightPercent: Double = 0.0

  @Field
  var zIndex: Int = 0

  @Field
  var fullDisplayWidthPercent: Double? = null

  fun toModel(): CalendarInstanceLayout = CalendarInstanceLayout(
    xOffsetPercent = xOffsetPercent.toFloat(),
    yOffsetPercent = yOffsetPercent.toFloat(),
    widthPercent = widthPercent.toFloat(),
    heightPercent = heightPercent.toFloat(),
    zIndex = zIndex,
    fullDisplayWidthPercent = fullDisplayWidthPercent?.toFloat(),
  ).normalized()
}

class CalendarEventRecord : Record {
  @Field
  var sourceEventId: String = ""

  @Field
  var occurrenceDate: String = ""

  @Field
  var title: String = ""

  @Field
  var startEpochDay: Int = 0

  @Field
  var endEpochDay: Int = 0

  @Field
  var endEpochDayExclusive: Int? = null

  @Field
  var startMinutes: Int? = null

  @Field
  var endMinutes: Int? = null

  @Field
  var timeZoneId: String = ""

  @Field
  var allDay: Boolean = false

  @Field
  var editable: Boolean = false

  @Field
  var revision: Int = 0

  @Field
  var instanceLayout: CalendarInstanceLayoutRecord? = null

  fun toModel(): CalendarEvent = CalendarEvent(
    sourceEventId = sourceEventId,
    occurrenceDate = occurrenceDate,
    title = title,
    startEpochDay = startEpochDay,
    endEpochDay = endEpochDay,
    endEpochDayExclusive = endEpochDayExclusive,
    startMinutes = startMinutes,
    endMinutes = endMinutes,
    timeZoneId = timeZoneId,
    allDay = allDay,
    editable = editable,
    revision = revision,
    instanceLayout = instanceLayout?.toModel(),
  )
}

class CalendarSnapshotRecord : Record {
  @Field
  var schemaVersion: Int = 1

  @Field
  var generation: Int = 0

  @Field
  var rangeStartEpochDay: Int = 0

  @Field
  var rangeEndEpochDayExclusive: Int = 1

  @Field
  var selectedEpochDay: Int = 0

  @Field
  var todayEpochDay: Int = 0

  @Field
  var settings: CalendarSettingsRecord = CalendarSettingsRecord()

  @Field
  var events: List<CalendarEventRecord> = emptyList()

  fun toModel(): CalendarSnapshot = CalendarSnapshot(
    schemaVersion = schemaVersion,
    generation = generation,
    rangeStartEpochDay = rangeStartEpochDay,
    rangeEndEpochDayExclusive = rangeEndEpochDayExclusive,
    selectedEpochDay = selectedEpochDay,
    todayEpochDay = todayEpochDay,
    settings = settings.toModel(),
    events = events.map(CalendarEventRecord::toModel)
  )
}

class CalendarMutationResolutionRecord : Record {
  @Field
  var operationId: String = ""

  @Field
  var accepted: Boolean = false

  @Field
  var replacement: CalendarEventRecord? = null

  @Field
  var message: String? = null

  fun toModel(): CalendarMutationResolution = CalendarMutationResolution(
    operationId = operationId,
    accepted = accepted,
    replacement = replacement?.toModel(),
    message = message
  )
}

class LaojiCalendarModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaojiCalendar")

    Constant("snapshotSchemaVersion") { 1 }
    Constant("implementation") { "android-classic-view" }

    View(CalendarHostView::class) {
      Events(
        "onModeChange",
        "onVisibleRangeChange",
        "onDateSelect",
        "onEventOpen",
        "onCreateEvent",
        "onDraftChange",
        "onMutationCommit",
        "onMutationResolved",
        "onPickerStateChange",
        "onSemanticEvent",
        "onTabPress"
      )

      Prop("mode") { view: CalendarHostView, mode: String? ->
        view.setMode(mode)
      }

      Prop("snapshot") { view: CalendarHostView, snapshot: CalendarSnapshotRecord? ->
        view.setSnapshot(snapshot?.toModel())
      }

      Prop("selectedEpochDay") { view: CalendarHostView, epochDay: Int? ->
        view.setSelectedEpochDay(epochDay)
      }

      Prop("visibleMonthEpochDay") { view: CalendarHostView, epochDay: Int? ->
        view.setVisibleMonthEpochDay(epochDay)
      }

      // UI-SHELL-BOTTOM-MAIN-001: resume selected-icon motion in the active Expo root.
      Prop("bottomBarSelectionCommand") { view: CalendarHostView, command: Int? ->
        view.setBottomBarSelectionCommand(command)
      }

      Prop("mutationResolution") { view: CalendarHostView, resolution: CalendarMutationResolutionRecord? ->
        view.resolveMutation(resolution?.toModel())
      }

      OnViewDestroys<CalendarHostView> { view ->
        view.dispose()
      }
    }
  }
}
