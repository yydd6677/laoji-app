package com.laoji.nativeplatform.calendar

// CAL-ROOT-001 / UI-ANDROID-COMPOSITION-001: CalendarHost owns its complete active-tab tree.

import android.annotation.SuppressLint
import android.content.Context
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.laoji.nativeplatform.NativeThemePreference
import com.laoji.nativeplatform.ui.LaojiNativeBottomBarView
import com.laoji.nativeplatform.ui.NativeBottomTab
import com.laoji.nativeplatform.ui.installStatusBarInsetPadding
import com.laoji.nativeplatform.evidence.FeishuEvidence
import com.laoji.nativeplatform.projection.ProjectionEnvelope
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.Calendar
import kotlin.math.roundToInt

@SuppressLint("ViewConstructor")
class CalendarHostView(context: Context, appContext: AppContext) : ExpoView(context, appContext),
  CalendarToolbarListener,
  CalendarPickerListener,
  MonthCalendarListener,
  DayCalendarListener,
  CalendarCreateActionListener {
  override val shouldUseAndroidLayout: Boolean = true

  val onModeChange by EventDispatcher<Map<String, Any>>()
  val onVisibleRangeChange by EventDispatcher<Map<String, Any>>()
  val onDateSelect by EventDispatcher<Map<String, Any>>()
  val onEventOpen by EventDispatcher<Map<String, Any>>()
  val onCreateEvent by EventDispatcher<Map<String, Any>>()
  val onDraftChange by EventDispatcher<Map<String, Any>>()
  val onMutationCommit by EventDispatcher<Map<String, Any>>()
  val onMutationResolved by EventDispatcher<Map<String, Any>>()
  val onPickerStateChange by EventDispatcher<Map<String, Any>>()
  val onSemanticEvent by EventDispatcher<Map<String, Any>>()
  val onTabPress by EventDispatcher<Map<String, Any?>>()

  private val toolbar = CalendarToolbarView(context, appContext)
  private val indicator = CalendarIndicatorView(context)
  private val palette = CalendarUi.palette(context)
  private val content = FrameLayout(context)
  private val monthPager = ThreePageMonthPager(context)
  // CAL-DAY-PAGER-001: CalendarHost owns one composed day surface with separate native interaction layers.
  private val dayView = SingleDayCalendarView(context)
  // UI-SHELL-001 TEST: CalendarHost owns exactly one create control for both month and day modes.
  private val createFab = CalendarCreateFabView(context)
  // CAL-PICKER-HOST-001: QuickChoose is a full-content transparent touch owner, not a fixed panel.
  private val pickerPanel = CalendarQuickChooseHostView(context)
  @FeishuEvidence("UI-SHELL-BOTTOM-MAIN-001")
  private val bottomBar = LaojiNativeBottomBarView(context, appContext).apply {
    setBridgeEventsEnabled(false)
    setSelectedTab(NativeBottomTab.SCHEDULE.wireName)
    setTabPressListener { tab ->
      if (tab == NativeBottomTab.SCHEDULE) returnToToday()
      onTabPress(mapOf("type" to "tabPress", "tab" to tab.wireName))
    }
  }
  private val ledger = CalendarMutationLedger()
  private val operationIds = CalendarOperationIdGenerator()
  private val handledResolutionIds = linkedSetOf<String>()
  private val acknowledgedEvents = linkedMapOf<String, CalendarEvent>()
  private var mode = CalendarMode.MONTH
  private var baseSnapshot: CalendarSnapshot? = null
  private var renderedSnapshot: CalendarSnapshot? = null
  private var currentProjection: ProjectionEnvelope? = null
  private var selectedEpochDay = currentEpochDay()
  private var pickerState = CalendarPickerState.closed(selectedEpochDay)
  private var pendingPickerCloseReason: String? = null
  private var pendingPickerCloseEvent = true
  private var visibleMonthInitialized = false
  private var nowProvider: () -> Calendar = { Calendar.getInstance() }
  private var disposed = false

  fun setProfileEntrySnapshot(snapshot: Map<String, Any?>) {
    toolbar.setProfileEntrySnapshot(snapshot)
  }

  init {
    // CAL-ROOT-001: ExpoView's padding-box clip can suppress Android-managed child display lists.
    setWillNotDraw(false)
    clipToPadding = false
    setBackgroundColor(palette.background)
    orientation = VERTICAL
    clipChildren = true
    installStatusBarInsetPadding()
    toolbar.setListener(this)
    toolbar.setTitle(CalendarUi.monthTitle(selectedEpochDay))
    addView(
      toolbar,
      LayoutParams(
        LayoutParams.MATCH_PARENT,
        CalendarUi.dp(context, CalendarShellContract.TITLE_BAR_HEIGHT_DP).toInt()
      )
    )
    indicator.setListener(this)
    indicator.setMode(mode)
    addView(
      indicator,
      LayoutParams(
        LayoutParams.MATCH_PARENT,
        CalendarUi.dp(context, CalendarIndicatorView.HEIGHT_DP).roundToInt(),
      ),
    )

    monthPager.setListener(this)
    monthPager.jumpToMonth(selectedEpochDay)
    dayView.setListener(this)
    content.addView(monthPager, calendarContentLayoutParams(context))
    content.addView(dayView, calendarContentLayoutParams(context))
    styleVividSurface(monthPager)
    styleVividSurface(dayView)
    createFab.setActionListener(this)
    content.addView(
      createFab,
      FrameLayout.LayoutParams(
        CalendarUi.dp(context, CalendarShellContract.FAB_GESTURE_SURFACE_DP).toInt(),
        CalendarUi.dp(context, CalendarShellContract.FAB_GESTURE_SURFACE_DP).toInt(),
        android.view.Gravity.END or android.view.Gravity.BOTTOM
      ).apply {
        marginEnd = CalendarUi.dp(context, CalendarShellContract.FAB_EDGE_MARGIN_DP).toInt()
        bottomMargin = CalendarUi.dp(context, CalendarShellContract.FAB_EDGE_MARGIN_DP).toInt()
      }
    )
    content.addView(
      pickerPanel,
      FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT),
    )
    pickerPanel.setListener(this)
    addView(content, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))
    addView(bottomBar, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    pickerPanel.prepare(selectedEpochDay, mode)
    updateModeVisibility()
  }

  fun setMode(value: String?) {
    updateMode(CalendarMode.fromBridge(value), emit = false)
  }

  fun setSnapshot(snapshot: CalendarSnapshot?) {
    if (disposed) return
    if (snapshot == null) {
      baseSnapshot = null
      renderedSnapshot = null
      currentProjection = null
      monthPager.setSnapshot(null)
      dayView.setSnapshot(null)
      pickerPanel.setDateData(CalendarQuickChooseDateData.EMPTY)
      return
    }
    if (snapshot.schemaVersion != 1) {
      emitSemantic("snapshot-rejected", mapOf("reason" to "unsupported-schema", "schemaVersion" to snapshot.schemaVersion))
      return
    }
    if (snapshot.projectionInvalid) {
      emitSemantic("snapshot-rejected", mapOf("reason" to "invalid-projection"))
      return
    }
    val incomingProjection = snapshot.projection
    if (currentProjection != null && incomingProjection == null) {
      emitSemantic("snapshot-rejected", mapOf("reason" to "missing-projection"))
      return
    }
    if (incomingProjection != null && !incomingProjection.isAcceptableReplacement(currentProjection)) {
      emitSemantic("snapshot-rejected", mapOf("reason" to "stale-projection"))
      return
    }
    val currentGeneration = baseSnapshot?.generation
    if (currentGeneration != null && snapshot.generation < currentGeneration) {
      emitSemantic(
        "snapshot-rejected",
        mapOf("reason" to "stale-generation", "generation" to snapshot.generation, "currentGeneration" to currentGeneration)
      )
      return
    }
    val normalized = snapshot.normalized()
    val incomingByIdentity = normalized.events.associateBy(CalendarEvent::identity)
    acknowledgedEvents.entries.removeAll { (identity, acknowledged) ->
      val incoming = incomingByIdentity[identity]
      incoming == acknowledged || (incoming != null && incoming.revision > acknowledged.revision)
    }
    baseSnapshot = normalized.copy(
      events = normalized.events.map { acknowledgedEvents[it.identity] ?: it } +
        acknowledgedEvents.values.filter { acknowledged ->
          normalized.events.none { it.identity == acknowledged.identity }
        }
    )
    currentProjection = normalized.projection
    selectedEpochDay = normalized.selectedEpochDay
    if (!visibleMonthInitialized) {
      monthPager.jumpToMonth(selectedEpochDay)
      visibleMonthInitialized = true
    }
    renderSnapshot()
  }

  fun setSelectedEpochDay(epochDay: Int?) {
    if (epochDay == null) return
    selectDate(epochDay, source = "prop", emit = false)
  }

  fun setVisibleMonthEpochDay(epochDay: Int?) {
    if (epochDay == null) return
    visibleMonthInitialized = true
    monthPager.jumpToMonth(epochDay)
    updateToolbarTitle()
  }

  fun setBottomBarSelectionCommand(command: Int?) {
    if (disposed) return
    bottomBar.setSelectionAnimationCommand(command)
  }

  internal fun setNowProviderForTest(provider: () -> Calendar) {
    nowProvider = provider
  }

  internal fun currentSelectedEpochDay(): Int = selectedEpochDay

  fun resolveMutation(resolution: CalendarMutationResolution?) {
    if (resolution == null || resolution.operationId in handledResolutionIds) return
    val operation = ledger.pendingOperations().firstOrNull { it.operationId == resolution.operationId }
    val result = ledger.resolve(resolution)
    handledResolutionIds += resolution.operationId
    while (handledResolutionIds.size > 128) handledResolutionIds.remove(handledResolutionIds.first())

    if (operation != null && result.event != null && result.status != CalendarResolutionStatus.IGNORED) {
      val base = baseSnapshot
      if (base != null) {
        val replacement = result.event
        var replaced = false
        val events = base.events.map { event ->
          if (event.identity == operation.original.identity) {
            replaced = true
            replacement
          } else {
            event
          }
        }.toMutableList()
        if (!replaced && result.status == CalendarResolutionStatus.ACK) events += replacement
        baseSnapshot = base.copy(events = events)
      }
      if (result.status == CalendarResolutionStatus.ACK) {
        acknowledgedEvents[operation.original.identity] = result.event
      } else {
        acknowledgedEvents.remove(operation.original.identity)
      }
    }
    renderSnapshot()
    onMutationResolved(
      buildMap {
        put("operationId", result.operationId)
        put("status", result.status.bridgeValue)
        result.message?.let { put("message", it) }
      }
    )
    emitSemantic(
      "mutation-${result.status.bridgeValue}",
      buildMap {
        put("operationId", result.operationId)
        result.message?.let { put("message", it) }
      }
    )
    when (result.status) {
      CalendarResolutionStatus.ACK -> announceForAccessibility("日程修改已保存")
      CalendarResolutionStatus.ROLLBACK -> announceForAccessibility(result.message ?: "日程修改已撤销")
      CalendarResolutionStatus.IGNORED -> Unit
    }
  }

  fun dispose() {
    disposed = true
    ledger.clear()
    acknowledgedEvents.clear()
    createFab.setActionListener(null)
    bottomBar.setTabPressListener(null)
    pickerPanel.dispose()
    dayView.clearDraft("disposed", emit = false)
  }

  override fun onTitleClicked() {
    // CAL-PICKER-HOST-001: title taps reverse an in-flight transition from its current progress.
    when (pickerPanel.expandState) {
      CalendarPickerExpandState.OPENING,
      CalendarPickerExpandState.OPENED -> closePicker("title")
      CalendarPickerExpandState.CLOSING,
      CalendarPickerExpandState.CLOSED -> openPicker()
    }
  }

  private fun openPicker() {
    val visibleDate = CalendarDateMath.fromEpochDay(
      if (mode == CalendarMode.MONTH) monthPager.currentMonthEpochDay() else selectedEpochDay,
    )
    val committedEpochDay = if (pickerPanel.expandState == CalendarPickerExpandState.CLOSING) {
      pickerState.committedEpochDay
    } else {
      CalendarQuickChooseContract.commitYearMonth(
        selectedEpochDay,
        visibleDate.year,
        visibleDate.month,
      )
    }
    pickerState = CalendarPickerState(
      expandState = CalendarPickerExpandState.OPENING,
      contentState = CalendarQuickChooseContract.initialContentState(mode),
      committedEpochDay = committedEpochDay,
    )
    pendingPickerCloseReason = null
    pendingPickerCloseEvent = true
    createFab.visibility = View.GONE
    pickerPanel.open(committedEpochDay, mode)
    onPickerStateChange(pickerPayload("opened"))
    emitSemantic("picker-open", emptyMap())
  }

  override fun onModeClicked(mode: CalendarMode) {
    updateMode(mode, emit = true)
  }

  override fun onProfileClicked() {
    closePicker("settings-open", emitEvent = false)
    emitSemantic("settings-open", emptyMap())
  }

  override fun onSearchClicked() {
    closePicker("search-open", emitEvent = false)
    emitSemantic("search-open", emptyMap())
  }

  override fun onCreateAction(action: CalendarCreateAction) {
    emitSemantic(action.semanticType, emptyMap())
  }

  // CAL-PICKER-001: wheel/date settle commits immediately while QuickChoose remains open.
  override fun onPickerDateCommitted(epochDay: Int) {
    pickerState = pickerState.withCommittedEpochDay(epochDay)
    monthPager.jumpToMonth(epochDay)
    selectDate(epochDay, source = "picker", emit = true)
    emitVisibleRange("picker")
    onPickerStateChange(pickerPayload("committed"))
  }

  override fun onPickerExpandStateChanged(state: CalendarPickerExpandState) {
    pickerState = pickerState.copy(expandState = state)
    if (state != CalendarPickerExpandState.CLOSED) {
      createFab.visibility = View.GONE
      return
    }
    createFab.visibility = View.VISIBLE
    val reason = pendingPickerCloseReason ?: "closed"
    val emitEvent = pendingPickerCloseEvent
    pendingPickerCloseReason = null
    pendingPickerCloseEvent = true
    if (emitEvent) {
      onPickerStateChange(pickerPayload(reason))
      emitSemantic("picker-close", mapOf("reason" to reason))
    }
  }

  override fun onPickerExpandProgressChanged(progress: Float) {
    toolbar.setExpandProgress(progress)
  }

  override fun onPickerContentStateChanged(state: CalendarPickerContentState) {
    pickerState = pickerState.copy(contentState = state)
  }

  override fun onMonthChanged(monthEpochDay: Int) {
    updateToolbarTitle()
    emitVisibleRange("swipe")
    emitSemantic("month-change", mapOf("monthEpochDay" to monthEpochDay))
  }

  override fun onDateSelected(epochDay: Int) {
    selectDate(epochDay, source = if (mode == CalendarMode.MONTH) "month" else "day-strip", emit = true)
  }

  override fun onEventOpened(event: CalendarEvent) {
    onEventOpen(eventPayload(event))
    emitSemantic(
      "event-open",
      mapOf("sourceEventId" to event.sourceEventId, "occurrenceDate" to event.occurrenceDate)
    )
  }

  override fun onEmptyCreateRequested(epochDay: Int) {
    selectDate(epochDay, source = "month-empty-create", emit = true)
    emitSemantic("create-manual", mapOf("epochDay" to epochDay))
  }

  override fun onCreateRequested(draft: CalendarDraft) {
    onCreateEvent(draftPayload(draft))
    emitSemantic("create-request", draftPayload(draft))
  }

  override fun onDraftChanged(draft: CalendarDraft?, reason: String) {
    val payload = buildMap<String, Any> {
      put("reason", reason)
      put("active", draft != null)
      if (draft != null) putAll(draftPayload(draft))
    }
    onDraftChange(payload)
    emitSemantic("draft-$reason", payload)
  }

  override fun onMutationRequested(
    kind: CalendarMutationKind,
    original: CalendarEvent,
    optimistic: CalendarEvent
  ): Boolean {
    if (ledger.pendingOperations().any { it.original.identity == original.identity }) {
      emitSemantic(
        "mutation-blocked",
        mapOf("reason" to "operation-pending", "sourceEventId" to original.sourceEventId)
      )
      return false
    }
    val operationId = operationIds.next()
    val mutation = CalendarMutation(operationId, kind, original, optimistic)
    if (!ledger.begin(mutation)) return false
    renderSnapshot()
    val payload = mutationPayload(mutation)
    onMutationCommit(payload)
    emitSemantic("mutation-commit", payload)
    return true
  }

  private fun updateMode(next: CalendarMode, emit: Boolean) {
    if (mode == next) return
    mode = next
    closePicker("mode-change", emitEvent = false)
    if (pickerPanel.expandState == CalendarPickerExpandState.CLOSED) {
      pickerPanel.prepare(selectedEpochDay, mode)
    }
    renderedSnapshot?.let(::bindSnapshotToActiveMode)
    updateModeVisibility()
    updateToolbarTitle()
    if (emit) {
      onModeChange(mapOf("mode" to mode.bridgeValue))
      emitVisibleRange("mode-change")
      emitSemantic("mode-change", mapOf("mode" to mode.bridgeValue))
    }
  }

  // UI-SHELL-RESELECT-001: mirrors Feishu's shared backToday event without remounting this root.
  private fun returnToToday() {
    val now = nowProvider()
    val today = CalendarDateMath.toEpochDay(
      now.get(Calendar.YEAR),
      now.get(Calendar.MONTH) + 1,
      now.get(Calendar.DAY_OF_MONTH),
    )
    val minute = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
    val monthGridStart = CalendarDateMath.monthGridStart(today)
    val monthGridEnd = monthGridStart + CalendarDateMath.monthWeekCount(today) * 7
    baseSnapshot = baseSnapshot?.let { base ->
      base.copy(
        rangeStartEpochDay = minOf(base.rangeStartEpochDay, monthGridStart),
        rangeEndEpochDayExclusive = maxOf(base.rangeEndEpochDayExclusive, monthGridEnd),
        selectedEpochDay = today,
        todayEpochDay = today,
      )
    }
    selectedEpochDay = today
    if (pickerState.committedEpochDay != today) {
      pickerState = pickerState.withCommittedEpochDay(today)
      pickerPanel.updateCommittedDate(today)
    }
    visibleMonthInitialized = true
    val rendered = renderSnapshot(bindActiveSurface = false)
    when (mode) {
      CalendarMode.MONTH -> {
        monthPager.setSnapshot(rendered)
        monthPager.returnToToday(today)
      }
      CalendarMode.DAY -> dayView.returnToToday(rendered, today, minute)
    }
    updateToolbarTitle()

    val selection = mapOf("epochDay" to today, "source" to "tab-reselect")
    onDateSelect(selection)
    emitVisibleRange("tab-reselect")
    emitSemantic("back-today", selection)
  }

  private fun updateModeVisibility() {
    indicator.setMode(mode)
    monthPager.visibility = if (mode == CalendarMode.MONTH) View.VISIBLE else View.GONE
    dayView.visibility = if (mode == CalendarMode.DAY) View.VISIBLE else View.GONE
  }

  private fun selectDate(epochDay: Int, source: String, emit: Boolean) {
    selectedEpochDay = baseSnapshot?.let {
      epochDay.coerceIn(it.rangeStartEpochDay, it.rangeEndEpochDayExclusive - 1)
    } ?: epochDay
    if (pickerState.isOpen) {
      pickerState = pickerState.withCommittedEpochDay(selectedEpochDay)
      pickerPanel.updateCommittedDate(selectedEpochDay)
    }
    renderSnapshot()
    updateToolbarTitle()
    if (emit) {
      val payload = mapOf("epochDay" to selectedEpochDay, "source" to source)
      onDateSelect(payload)
      emitSemantic("date-select", payload)
      if (mode == CalendarMode.DAY) emitVisibleRange(source)
    }
  }

  private fun renderSnapshot(bindActiveSurface: Boolean = true): CalendarSnapshot? {
    val base = baseSnapshot ?: return null
    val rendered = base.copy(
      selectedEpochDay = selectedEpochDay,
      events = ledger.overlay(base.events)
    )
    renderedSnapshot = rendered
    if (bindActiveSurface) bindSnapshotToActiveMode(rendered)
    pickerPanel.setDateData(CalendarQuickChooseContract.dateData(rendered))
    updateToolbarTitle()
    return rendered
  }

  private fun bindSnapshotToActiveMode(snapshot: CalendarSnapshot) {
    when (mode) {
      CalendarMode.MONTH -> monthPager.setSnapshot(snapshot)
      CalendarMode.DAY -> dayView.setSnapshot(snapshot)
    }
  }

  private fun updateToolbarTitle() {
    val epochDay = if (mode == CalendarMode.MONTH) monthPager.currentMonthEpochDay() else selectedEpochDay
    toolbar.setTitle(CalendarUi.monthTitle(epochDay))
  }

  private fun closePicker(reason: String, emitEvent: Boolean = true) {
    if (pickerPanel.expandState == CalendarPickerExpandState.CLOSED) return
    pendingPickerCloseReason = reason
    pendingPickerCloseEvent = emitEvent
    pickerPanel.close()
  }

  private fun emitVisibleRange(source: String) {
    val start: Int
    val end: Int
    if (mode == CalendarMode.MONTH) {
      val month = monthPager.currentMonthEpochDay()
      start = CalendarDateMath.monthGridStart(month)
      end = start + CalendarDateMath.monthWeekCount(month) * 7
    } else {
      start = selectedEpochDay
      end = selectedEpochDay + 1
    }
    onVisibleRangeChange(
      mapOf(
        "mode" to mode.bridgeValue,
        "rangeStartEpochDay" to start,
        "rangeEndEpochDayExclusive" to end,
        "selectedEpochDay" to selectedEpochDay,
        "source" to source
      )
    )
  }

  private fun pickerPayload(reason: String): Map<String, Any> = mapOf(
    "open" to pickerState.isOpen,
    "year" to pickerState.committedDate.year,
    "month" to pickerState.committedDate.month,
    "preservedDayOfMonth" to pickerState.committedDate.day,
    "reason" to reason
  )

  private fun draftPayload(draft: CalendarDraft): Map<String, Any> = mapOf(
    "startEpochDay" to draft.startEpochDay,
    "endEpochDay" to draft.endEpochDay,
    "startMinutes" to draft.startMinutes,
    "endMinutes" to draft.endMinutes,
    "allDay" to false
  )

  private fun eventPayload(event: CalendarEvent): Map<String, Any> = buildMap {
    put("sourceEventId", event.sourceEventId)
    put("occurrenceDate", event.occurrenceDate)
    put("title", event.title)
    put("startEpochDay", event.startEpochDay)
    put("endEpochDay", event.endEpochDay)
    event.endEpochDayExclusive?.let { put("endEpochDayExclusive", it) }
    event.startMinutes?.let { put("startMinutes", it) }
    event.endMinutes?.let { put("endMinutes", it) }
    put("timeZoneId", event.timeZoneId)
    put("allDay", event.allDay)
    put("editable", event.editable)
    put("revision", event.revision)
  }

  private fun mutationPayload(mutation: CalendarMutation): Map<String, Any> = buildMap {
    put("operationId", mutation.operationId)
    put("kind", mutation.kind.bridgeValue)
    put("sourceEventId", mutation.original.sourceEventId)
    put("occurrenceDate", mutation.original.occurrenceDate)
    put("startEpochDay", mutation.optimistic.startEpochDay)
    put("endEpochDay", mutation.optimistic.endEpochDay)
    mutation.optimistic.startMinutes?.let { put("startMinutes", it) }
    mutation.optimistic.endMinutes?.let { put("endMinutes", it) }
    put("baseRevision", mutation.original.revision)
    baseSnapshot?.projection?.let { projection -> put("projection", projectionPayload(projection)) }
  }

  private fun projectionPayload(projection: ProjectionEnvelope): Map<String, Any> = mapOf(
    "deviceEpoch" to projection.deviceEpoch,
    "entityId" to projection.entityId,
    "entityRevision" to projection.entityRevision,
    "viewRevision" to projection.viewRevision,
    "surfaceInstanceId" to projection.surfaceInstanceId,
    "payloadSha256" to projection.payloadSha256,
  )

  private fun emitSemantic(type: String, details: Map<String, Any>) {
    onSemanticEvent(buildMap {
      put("type", type)
      putAll(details)
    })
  }

  private fun currentEpochDay(): Int {
    val calendar = Calendar.getInstance()
    return CalendarDateMath.toEpochDay(
      calendar.get(Calendar.YEAR),
      calendar.get(Calendar.MONTH) + 1,
      calendar.get(Calendar.DAY_OF_MONTH)
    )
  }

  // [PRODUCT] The vivid skin changes the calendar silhouette as well as its
  // palette: both retained views become an inset, rounded surface while the
  // standard skin remains edge-to-edge and source-shaped.
  private fun styleVividSurface(view: View) {
    if (!NativeThemePreference.isVivid(context)) return
    view.background = CalendarUi.background(
      palette.surface,
      16f,
      context,
      palette.divider,
      1f,
    )
    view.clipToOutline = true
    view.outlineProvider = ViewOutlineProvider.BACKGROUND
  }
}
