package com.laoji.nativeplatform.calendarpages

// CAL-SEARCH-001 / CAL-DETAIL-001 / CAL-EDIT-001: normalized snapshots cross the bridge;
// native calendar pages emit semantic actions and never mutate the event repository.

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

internal const val CALENDAR_PAGE_SCHEMA_VERSION = 1

internal data class CalendarPageEventRef(
  val sourceEventId: String,
  val occurrenceDate: String,
) {
  fun toBridge(): Map<String, Any> = mapOf(
    "sourceEventId" to sourceEventId,
    "occurrenceDate" to occurrenceDate,
  )
}

internal enum class CalendarPageLoadState(val wireName: String) {
  LOADING("loading"),
  READY("ready"),
  EMPTY("empty"),
  ERROR("error");

  companion object {
    fun fromWireName(value: String?): CalendarPageLoadState = entries.firstOrNull {
      it.wireName == value
    } ?: READY
  }
}

internal data class CalendarSearchRow(
  val ref: CalendarPageEventRef,
  val title: String,
  val dateLabel: String,
  val timeLabel: String,
  val monthLabel: String,
  val dayLabel: String,
  val weekdayLabel: String,
  val showDate: Boolean,
)

internal data class CalendarSearchPageState(
  val query: String = "",
  val loadState: CalendarPageLoadState = CalendarPageLoadState.READY,
  val message: String? = null,
  val rows: List<CalendarSearchRow> = emptyList(),
)

internal data class CalendarDetailPageState(
  val loadState: CalendarPageLoadState = CalendarPageLoadState.LOADING,
  val message: String? = null,
  val ref: CalendarPageEventRef? = null,
  val title: String = "",
  val timeLabel: String = "",
  val repeatLabel: String? = null,
  val location: String? = null,
  val notes: String? = null,
  val reminderLabel: String? = null,
  val recurring: Boolean = false,
  val recurrenceException: Boolean = false,
  val editable: Boolean = true,
  val deleting: Boolean = false,
)

internal data class CalendarEditDraft(
  val title: String = "",
  val startDate: String = "",
  val endDate: String = "",
  val startTime: String? = null,
  val endTime: String? = null,
  val allDay: Boolean = false,
  val repeat: String = "once",
  val reminderMinutes: Int? = null,
  val location: String = "",
  val notes: String = "",
) {
  val hasTime: Boolean
    get() = startTime != null || endTime != null

  fun normalized(): CalendarEditDraft {
    val normalizedStartDate = startDate.trim()
    val normalizedEndDate = endDate.trim().ifEmpty { normalizedStartDate }
    val normalizedTitle = title.trimEnd()
    return if (allDay) {
      copy(
        title = normalizedTitle,
        startDate = normalizedStartDate,
        endDate = normalizedEndDate,
        startTime = null,
        endTime = null,
        reminderMinutes = null,
      )
    } else {
      copy(
        title = normalizedTitle,
        startDate = normalizedStartDate,
        endDate = normalizedEndDate,
        startTime = startTime?.trim()?.ifEmpty { null },
        endTime = endTime?.trim()?.ifEmpty { null },
      )
    }
  }

  fun toBridge(): Map<String, Any?> = mapOf(
    "title" to title,
    "startDate" to startDate,
    "endDate" to endDate,
    "startTime" to startTime,
    "endTime" to endTime,
    "isAllDay" to allDay,
    "repeat" to repeat,
    "reminderMinutes" to reminderMinutes,
    "location" to location,
    "notes" to notes,
  )
}

internal data class CalendarEditPageState(
  val loadState: CalendarPageLoadState = CalendarPageLoadState.READY,
  val message: String? = null,
  val draft: CalendarEditDraft = CalendarEditDraft(),
  val editing: Boolean = false,
  val recurring: Boolean = false,
  val recurrenceException: Boolean = false,
  val saving: Boolean = false,
  val dirty: Boolean = false,
)

internal data class CalendarEditValidation(
  val valid: Boolean,
  val message: String? = null,
)

internal object CalendarEditValidator {
  private val repeatValues = setOf("once", "daily", "weekly", "monthly", "yearly")
  private val dateFormatter = DateTimeFormatter.ISO_LOCAL_DATE
  private val timeFormatter = DateTimeFormatter.ofPattern("HH:mm")

  // CAL-EDIT-001: date is mandatory, while a non-all-day event may intentionally have no time.
  fun validate(value: CalendarEditDraft): CalendarEditValidation {
    val draft = value.normalized()
    if (draft.title.isBlank()) return CalendarEditValidation(false, "请输入事项标题")
    val startDate = parseDate(draft.startDate)
      ?: return CalendarEditValidation(false, "请选择有效的开始日期")
    val endDate = parseDate(draft.endDate)
      ?: return CalendarEditValidation(false, "请选择有效的结束日期")
    if (endDate.isBefore(startDate)) return CalendarEditValidation(false, "结束日期不能早于开始日期")
    if (draft.repeat !in repeatValues) return CalendarEditValidation(false, "重复规则不受支持")
    if (draft.reminderMinutes != null && draft.reminderMinutes < 0) {
      return CalendarEditValidation(false, "提醒时间必须为非负分钟数")
    }
    if (draft.allDay) return CalendarEditValidation(true)

    val hasStart = draft.startTime != null
    val hasEnd = draft.endTime != null
    if (hasStart != hasEnd) return CalendarEditValidation(false, "开始时间和结束时间需要同时填写")
    if (!hasStart) {
      return if (draft.reminderMinutes == null) CalendarEditValidation(true)
      else CalendarEditValidation(false, "没有具体时间的日程不能设置提前提醒")
    }
    val startTime = parseTime(draft.startTime)
      ?: return CalendarEditValidation(false, "开始时间格式不正确")
    val endTime = parseTime(draft.endTime)
      ?: return CalendarEditValidation(false, "结束时间格式不正确")
    if (!LocalDateTime.of(endDate, endTime).isAfter(LocalDateTime.of(startDate, startTime))) {
      return CalendarEditValidation(false, "结束时间需要晚于开始时间")
    }
    return CalendarEditValidation(true)
  }

  private fun parseDate(value: String?): LocalDate? = try {
    value?.let { LocalDate.parse(it, dateFormatter) }
  } catch (_: DateTimeParseException) {
    null
  }

  private fun parseTime(value: String?): LocalTime? = try {
    value?.let { LocalTime.parse(it, timeFormatter) }
  } catch (_: DateTimeParseException) {
    null
  }
}

internal object CalendarPageSnapshotParser {
  fun search(snapshot: Map<String, Any?>): CalendarSearchPageState {
    if (snapshot.int("schemaVersion", CALENDAR_PAGE_SCHEMA_VERSION) != CALENDAR_PAGE_SCHEMA_VERSION) {
      return CalendarSearchPageState(
        loadState = CalendarPageLoadState.ERROR,
        message = "搜索数据版本不受支持",
      )
    }
    return CalendarSearchPageState(
      query = snapshot.string("query"),
      loadState = CalendarPageLoadState.fromWireName(snapshot.stringOrNull("state")),
      message = snapshot.stringOrNull("message"),
      rows = snapshot.mapList("results").mapNotNull(::searchRow),
    )
  }

  fun detail(snapshot: Map<String, Any?>): CalendarDetailPageState {
    if (snapshot.int("schemaVersion", CALENDAR_PAGE_SCHEMA_VERSION) != CALENDAR_PAGE_SCHEMA_VERSION) {
      return CalendarDetailPageState(
        loadState = CalendarPageLoadState.ERROR,
        message = "日程数据版本不受支持",
      )
    }
    val event = snapshot.map("event")
    return CalendarDetailPageState(
      loadState = CalendarPageLoadState.fromWireName(snapshot.stringOrNull("state")),
      message = snapshot.stringOrNull("message"),
      ref = event?.eventRef(),
      title = event?.string("title").orEmpty(),
      timeLabel = event?.string("timeLabel").orEmpty(),
      repeatLabel = event?.stringOrNull("repeatLabel"),
      location = event?.stringOrNull("location"),
      notes = event?.stringOrNull("notes"),
      reminderLabel = event?.stringOrNull("reminderLabel"),
      recurring = event?.boolean("recurring") ?: false,
      recurrenceException = event?.boolean("recurrenceException") ?: false,
      editable = event?.boolean("editable") ?: true,
      deleting = snapshot.boolean("deleting"),
    )
  }

  fun edit(snapshot: Map<String, Any?>): CalendarEditPageState {
    if (snapshot.int("schemaVersion", CALENDAR_PAGE_SCHEMA_VERSION) != CALENDAR_PAGE_SCHEMA_VERSION) {
      return CalendarEditPageState(
        loadState = CalendarPageLoadState.ERROR,
        message = "编辑数据版本不受支持",
      )
    }
    return CalendarEditPageState(
      loadState = CalendarPageLoadState.fromWireName(snapshot.stringOrNull("state")),
      message = snapshot.stringOrNull("message"),
      draft = editDraft(snapshot.map("draft") ?: emptyMap()).normalized(),
      editing = snapshot.boolean("editing"),
      recurring = snapshot.boolean("recurring"),
      recurrenceException = snapshot.boolean("recurrenceException"),
      saving = snapshot.boolean("saving"),
      dirty = snapshot.boolean("dirty"),
    )
  }

  private fun searchRow(value: Map<String, Any?>): CalendarSearchRow? {
    val ref = value.eventRef() ?: return null
    return CalendarSearchRow(
      ref = ref,
      title = value.string("title"),
      dateLabel = value.string("dateLabel"),
      timeLabel = value.string("timeLabel"),
      monthLabel = value.string("monthLabel"),
      dayLabel = value.string("dayLabel"),
      weekdayLabel = value.string("weekdayLabel"),
      showDate = value.boolean("showDate"),
    )
  }

  private fun editDraft(value: Map<String, Any?>): CalendarEditDraft = CalendarEditDraft(
    title = value.string("title"),
    startDate = value.string("startDate"),
    endDate = value.string("endDate"),
    startTime = value.stringOrNull("startTime"),
    endTime = value.stringOrNull("endTime"),
    allDay = value.boolean("isAllDay"),
    repeat = value.stringOrNull("repeat") ?: "once",
    reminderMinutes = value.intOrNull("reminderMinutes"),
    location = value.string("location"),
    notes = value.string("notes"),
  )
}

private fun Map<String, Any?>.eventRef(): CalendarPageEventRef? {
  val sourceEventId = string("sourceEventId")
  val occurrenceDate = string("occurrenceDate")
  if (sourceEventId.isBlank() || occurrenceDate.isBlank()) return null
  return CalendarPageEventRef(sourceEventId, occurrenceDate)
}

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.map(key: String): Map<String, Any?>? =
  this[key] as? Map<String, Any?>

@Suppress("UNCHECKED_CAST")
private fun Map<String, Any?>.mapList(key: String): List<Map<String, Any?>> =
  (this[key] as? List<*>)?.mapNotNull { it as? Map<String, Any?> }.orEmpty()

private fun Map<String, Any?>.string(key: String): String = this[key] as? String ?: ""
private fun Map<String, Any?>.stringOrNull(key: String): String? =
  (this[key] as? String)?.takeIf(String::isNotBlank)
private fun Map<String, Any?>.boolean(key: String): Boolean = this[key] as? Boolean ?: false
private fun Map<String, Any?>.int(key: String, fallback: Int): Int = intOrNull(key) ?: fallback
private fun Map<String, Any?>.intOrNull(key: String): Int? = (this[key] as? Number)?.toInt()
