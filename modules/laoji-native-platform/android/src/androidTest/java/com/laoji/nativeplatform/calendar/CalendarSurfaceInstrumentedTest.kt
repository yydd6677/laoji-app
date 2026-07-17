package com.laoji.nativeplatform.calendar

// CAL-DAY-PAGER-001 / CAL-ALLDAY-EXPAND-001 / CAL-TIME-PRECISION-001 /
// CAL-MONTH-EXPAND-001: API 35 runtime coverage for the source-derived native behavior.

import android.graphics.Rect
import android.view.InputDevice
import android.view.Gravity
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import android.widget.FrameLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.viewpager2.widget.ViewPager2
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CalendarSurfaceInstrumentedTest {
  @Test
  fun createFabAccessibilityBoundsMatchItsRealTouchTarget() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val action = AtomicReference<CalendarCreateAction?>()
      val fabRef = AtomicReference<CalendarCreateFabView>()
      scenario.onActivity { activity ->
        val fab = CalendarCreateFabView(activity).apply {
          setActionListener(action::set)
        }
        fabRef.set(fab)
        activity.root.addView(
          fab,
          FrameLayout.LayoutParams(
            activity.dp(CalendarShellContract.FAB_GESTURE_SURFACE_DP),
            activity.dp(CalendarShellContract.FAB_GESTURE_SURFACE_DP),
            Gravity.END or Gravity.BOTTOM,
          ),
        )
      }
      waitUntil(scenario) { fabRef.get().width > 0 && fabRef.get().height > 0 }

      val center = AtomicReference<ScreenPoint>()
      scenario.onActivity { activity ->
        val fab = fabRef.get()
        val info = fab.createAccessibilityNodeInfo()
        val actual = Rect().also(info::getBoundsInScreen)
        val location = IntArray(2).also(fab::getLocationOnScreen)
        val size = activity.dp(CalendarShellContract.FAB_SIZE_DP)
        val expected = Rect(
          location[0] + fab.width - size,
          location[1] + fab.height - size,
          location[0] + fab.width,
          location[1] + fab.height,
        )
        assertEquals(expected, actual)
        center.set(ScreenPoint(actual.exactCenterX(), actual.exactCenterY()))
      }

      injectTap(center.get())
      waitUntil(scenario) { action.get() == CalendarCreateAction.MENU }
    }
  }

  @Test
  fun singleDayComposesOwnersUsesMeasuredAllDayHeightAndCreatesWithSnapshotDuration() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val day = selectedDay()
      val openedEvent = AtomicReference<CalendarEvent?>()
      val createRequest = AtomicReference<CalendarDraft?>()
      val surfaceRef = addDaySurface(
        scenario,
        calendarSnapshot(day, centerAllDayCount = 4, defaultDurationMinutes = 45),
        onOpened = openedEvent::set,
        onCreate = createRequest::set,
      )

      waitForDaySurface(scenario, surfaceRef)
      scenario.onActivity { activity ->
        val surface = surfaceRef.get()
        assertEquals(3, surface.childCount)
        assertTrue(surface.getChildAt(0) === surface.dayWeekHeaderView)
        assertTrue(surface.getChildAt(1) === surface.dayAllDaySectionView)
        assertTrue(surface.getChildAt(2) === surface.threePageDayPager)
        assertEquals(3, surface.descendants<DayTimelinePageView>().size)

        val allDayPage = centerAllDayPage(surface, day)
        assertEquals(
          listOf("全天-0", "全天-1", "还有 2 项"),
          allDayPage.descendants<TextView>().map { it.text.toString() },
        )
        allDayPage.descendants<TextView>().single { it.text.toString() == "还有 2 项" }.performClick()
        assertTrue(surface.dayAllDaySectionView.isExpanded())

        val page = centerTimelinePage(surface, day)
        assertEquals(
          DayPagerContract.TIMELINE_TOTAL_HEIGHT_DP * activity.resources.displayMetrics.density,
          page.timelineCanvas.contentHeight(),
          0.01f,
        )
        val eventNode = page.timelineCanvas.accessibilityNodeProvider.createAccessibilityNodeInfo(1)
        assertNotNull(eventNode)
        assertTrue(requireNotNull(eventNode).isClickable)
        assertTrue(
          page.timelineCanvas.accessibilityNodeProvider.performAction(
            1,
            AccessibilityNodeInfo.ACTION_CLICK,
            null,
          ),
        )
        val beforeScroll = page.timelineCanvas.scrollOffset()
        assertTrue(
          page.timelineCanvas.accessibilityNodeProvider.performAction(
            View.NO_ID,
            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,
            null,
          ),
        )
        assertTrue(page.timelineCanvas.scrollOffset() < beforeScroll)
      }
      assertEquals("timed", openedEvent.get()?.sourceEventId)

      val expectedExpandedHeight = AtomicReference<Int>()
      scenario.onActivity { activity ->
        expectedExpandedHeight.set(
          DayAllDaySectionContract.visibleHeightPx(
            eventCount = 4,
            expanded = true,
            rowHeightPx = DayAllDaySectionContract.rowHeightPx(activity.resources.displayMetrics.density),
          ),
        )
      }
      waitUntil(scenario) {
        surfaceRef.get().dayAllDaySectionView.measuredHeight == expectedExpandedHeight.get()
      }
      val createPoint = AtomicReference<ScreenPoint>()
      scenario.onActivity { activity ->
        val page = centerTimelinePage(surfaceRef.get(), day)
        createPoint.set(
          page.gestureLayer.screenPoint(
            page.gestureLayer.width - activity.dp(80f).toFloat(),
            page.gestureLayer.height * 0.55f,
          ),
        )
      }
      injectTap(createPoint.get())
      waitUntil(scenario) { surfaceRef.get().currentDraft() != null }
      val draft = requireNotNull(surfaceRef.get().currentDraft())
      assertEquals(45L, draft.endAbsoluteMinute() - draft.startAbsoluteMinute())
      assertNull(createRequest.get())

      injectTap(timelinePoint(scenario, surfaceRef::get, day, draft.startMinutes))
      waitUntil(scenario) { createRequest.get() != null }
      assertEquals(draft, createRequest.get())
    }
  }

  @Test
  fun headerAndAllDayGesturesDriveContinuousPagerAndKeepAdjacentHeightStable() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val day = selectedDay()
      val selected = AtomicReference<Int?>()
      val surfaceRef = addDaySurface(
        scenario,
        calendarSnapshot(
          day,
          centerAllDayCount = 4,
          nextAllDayCount = 9,
          previousAllDayCount = 5,
        ),
        onSelected = selected::set,
      )
      waitForDaySurface(scenario, surfaceRef)
      scenario.onActivity {
        val surface = surfaceRef.get()
        centerAllDayPage(surface, day).descendants<TextView>()
          .single { it.text.toString() == "还有 2 项" }
          .performClick()
      }
      waitUntil(scenario) {
        val allDay = surfaceRef.get().dayAllDaySectionView
        allDay.isExpanded() && allDay.renderedHeight() == DayAllDaySectionContract.visibleHeightPx(
          eventCount = 4,
          expanded = true,
          rowHeightPx = DayAllDaySectionContract.rowHeightPx(allDay.resources.displayMetrics.density),
        )
      }

      val headerView = { surfaceRef.get().dayWeekHeaderView as View }
      val headerStart = viewFractionPoint(scenario, headerView, 0.82f, 0.5f)
      scenario.onActivity { it.root.resetTouchTrace() }
      val bodyProbe = startPointer(ScreenPoint(headerStart.x, headerStart.y + 300f))
      cancelPointer(bodyProbe, ScreenPoint(headerStart.x, headerStart.y + 300f))
      scenario.onActivity { activity ->
        assertTrue("body probe did not reach activity: ${activity.root.touchTrace()}", activity.root.touchTrace().isNotEmpty())
      }
      scenario.onActivity { it.root.resetTouchTrace() }
      val downTime = startPointer(headerStart)
      SystemClock.sleep(40L)
      movePointer(downTime, viewFractionPoint(scenario, headerView, 0.52f, 0.5f))
      SystemClock.sleep(40L)
      movePointer(downTime, viewFractionPoint(scenario, headerView, 0.40f, 0.5f))
      try {
        waitUntil(scenario) { abs(surfaceRef.get().threePageDayPager.currentPositionProgress()) > 0.05f }
      } catch (failure: AssertionError) {
        val details = AtomicReference<String>()
        scenario.onActivity { activity ->
          val surface = surfaceRef.get()
          val router = requireNotNull(surface.dayWeekHeaderView.readPrivateField("touchRouter"))
          val pager = surface.threePageDayPager
          val internalPager = pager.readPrivateField("pager") as ViewPager2
          val header = surface.dayWeekHeaderView
          val headerLocation = IntArray(2).also(header::getLocationOnScreen)
          val headerVisible = Rect().also(header::getGlobalVisibleRect)
          val track = requireNotNull(header.readPrivateField("track")) as View
          details.set(
            "headerProgress=${surface.dayWeekHeaderView.currentPositionProgress()}, " +
              "pagerProgress=${pager.currentPositionProgress()}, forwarding=${router.readPrivateField("forwarding")}, " +
              "rejected=${router.readPrivateField("rejected")}, associated=${pager.readPrivateField("associatedDragActive")}, " +
              "hasDown=${router.readPrivateField("downEvent") != null}, " +
              "down=${router.readPrivateField("downX")},${router.readPrivateField("downY")}, " +
              "headerStart=$headerStart, headerLocation=${headerLocation.contentToString()}, " +
              "headerVisible=$headerVisible, headerSize=${header.width}x${header.height}, " +
              "trackSize=${track.width}x${track.height}, trackTranslation=${track.translationX}, " +
              "rootTrace=${activity.root.touchTrace()}, " +
              "fakeDragging=${internalPager.isFakeDragging}, scrollState=${internalPager.scrollState}, " +
              "pagerSize=${internalPager.width}x${internalPager.height}",
          )
        }
        throw AssertionError("associated header drag did not advance: ${details.get()}", failure)
      }
      waitUntil(scenario) {
        val allDay = surfaceRef.get().dayAllDaySectionView
        val cap = DayAllDaySectionContract.expandedHeightCapPx(
          DayAllDaySectionContract.rowHeightPx(allDay.resources.displayMetrics.density),
        )
        allDay.stableEventCount() == 9 && allDay.renderedHeight() == cap
      }
      scenario.onActivity { activity ->
        val surface = surfaceRef.get()
        val pagerProgress = surface.threePageDayPager.currentPositionProgress()
        assertEquals(pagerProgress, surface.dayWeekHeaderView.currentPositionProgress(), 0.02f)
        assertEquals(pagerProgress, surface.dayAllDaySectionView.currentPositionProgress(), 0.02f)
        assertEquals(9, surface.dayAllDaySectionView.stableEventCount())
        assertTrue(surface.threePageDayPager.positionProgressDispatchCount() > 1)
        val cap = DayAllDaySectionContract.expandedHeightCapPx(
          DayAllDaySectionContract.rowHeightPx(activity.resources.displayMetrics.density),
        )
        assertEquals(cap, surface.dayAllDaySectionView.renderedHeight())
      }
      movePointer(downTime, viewFractionPoint(scenario, headerView, 0.18f, 0.5f))
      SystemClock.sleep(40L)
      movePointer(downTime, viewFractionPoint(scenario, headerView, 0.05f, 0.5f))
      SystemClock.sleep(40L)
      endPointer(downTime, viewFractionPoint(scenario, headerView, 0f, 0.5f))
      waitUntil(scenario, timeoutMs = 4_000L) { selected.get() == day + 1 }
      scenario.onActivity {
        val surface = surfaceRef.get()
        assertEquals(day + 1, surface.threePageDayPager.currentCenterEpochDay())
        assertEquals(0f, surface.threePageDayPager.currentPositionProgress(), 0.001f)
        assertEquals(0f, surface.dayWeekHeaderView.currentPositionProgress(), 0.001f)
        assertEquals(0f, surface.dayAllDaySectionView.currentPositionProgress(), 0.001f)
        assertTrue(surface.dayAllDaySectionView.isExpanded())
      }

      val savedAllDayScroll = AtomicReference<Int>()
      scenario.onActivity {
        val page = centerAllDayPage(surfaceRef.get(), day + 1)
        val scroll = page.descendants<DayAllDayScrollView>().single()
        scroll.scrollTo(0, 1_000_000)
        savedAllDayScroll.set(scroll.scrollY)
        assertTrue(scroll.scrollY > 0)
        surfaceRef.get().setSelectedEpochDay(day)
      }
      waitUntil(scenario) {
        surfaceRef.get().threePageDayPager.currentCenterEpochDay() == day &&
          abs(surfaceRef.get().threePageDayPager.currentPositionProgress()) < 0.001f
      }
      scenario.onActivity { surfaceRef.get().setSelectedEpochDay(day + 1) }
      waitUntil(scenario) {
        surfaceRef.get().threePageDayPager.currentCenterEpochDay() == day + 1 &&
          abs(surfaceRef.get().threePageDayPager.currentPositionProgress()) < 0.001f &&
          surfaceRef.get().threePageDayPager.isSettledAndInteractive() &&
          centerAllDayPage(surfaceRef.get(), day + 1).descendants<DayAllDayScrollView>().single().scrollY ==
          savedAllDayScroll.get()
      }

      swipeWithFrames(
        scenario,
        view = { surfaceRef.get().dayAllDaySectionView },
        startFraction = 0.18f,
        endFraction = 0.86f,
      )
      waitUntil(scenario, timeoutMs = 4_000L) { selected.get() == day }
      assertTrue(surfaceRef.get().dayAllDaySectionView.isExpanded())
    }
  }

  @Test
  fun timelineHorizontalSwipeLetsPagerTakeOwnershipAndClearsPendingGesture() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val day = selectedDay()
      val selected = AtomicReference<Int?>()
      val surfaceRef = addDaySurface(scenario, calendarSnapshot(day), onSelected = selected::set)
      val originalPage = AtomicReference<DayTimelinePageView>()
      val swipeCoordinates = AtomicReference<FloatArray>()
      waitForDaySurface(scenario, surfaceRef)
      scenario.onActivity {
        val page = centerTimelinePage(surfaceRef.get(), day)
        originalPage.set(page)
        val location = IntArray(2)
        page.gestureLayer.getLocationOnScreen(location)
        val y = location[1] + page.timelineCanvas.minuteToScreenY(637)
        swipeCoordinates.set(
          floatArrayOf(
            location[0] + page.gestureLayer.width * 0.78f,
            y,
            location[0] + page.gestureLayer.width * 0.12f,
            y,
          ),
        )
      }
      val coordinates = swipeCoordinates.get()
      injectSwipe(coordinates[0], coordinates[1], coordinates[2], coordinates[3])
      waitUntil(scenario, timeoutMs = 4_000L) { selected.get() == day + 1 }
      scenario.onActivity {
        val layer = originalPage.get().gestureLayer
        assertNull(layer.readPrivateField("previewEvent"))
        assertNull(layer.readPrivateField("gestureOriginalEvent"))
        assertNull(layer.readPrivateField("gestureOriginalDraft"))
        assertEquals(CalendarGestureOwner.PENDING_EMPTY, layer.readPrivateField("gestureOwner"))
      }
    }
  }

  @Test
  fun eventMoveBothResizesAndDraftCancelDetachRestoreTransientState() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val day = selectedDay()
      val mutations = mutableListOf<MutationCapture>()
      val drafts = CopyOnWriteArrayList<DraftCapture>()
      val surfaceRef = addDaySurface(
        scenario,
        calendarSnapshot(day, defaultDurationMinutes = 30),
        onDraft = { draft, reason -> drafts += DraftCapture(draft, reason) },
        onMutation = { kind, original, optimistic ->
          mutations += MutationCapture(kind, original, optimistic)
          true
        },
      )
      waitForDaySurface(scenario, surfaceRef)

      injectTap(timelinePoint(scenario, surfaceRef::get, day, 637))
      waitUntil(scenario) { centerTimelinePage(surfaceRef.get(), day).timelineCanvas.selectedEvent() != null }

      val moveStart = timelinePoint(scenario, surfaceRef::get, day, 637)
      val moveDown = startPointer(moveStart)
      SystemClock.sleep(ViewConfiguration.getLongPressTimeout().toLong() + 100L)
      val moveEnd = timelinePoint(scenario, surfaceRef::get, day, 647)
      movePointer(moveDown, moveEnd)
      SystemClock.sleep(40L)
      endPointer(moveDown, moveEnd)
      waitUntil(scenario) { mutations.any { it.kind == CalendarMutationKind.MOVE } }
      assertEquals(615, mutations.first { it.kind == CalendarMutationKind.MOVE }.optimistic.startMinutes)
      assertEquals(675, mutations.first { it.kind == CalendarMutationKind.MOVE }.optimistic.endMinutes)

      performHandleResize(scenario, surfaceRef, day, "eventStartHandleRect", targetMinute = 590)
      waitUntil(scenario) { mutations.any { it.kind == CalendarMutationKind.RESIZE_START } }
      assertEquals(600, mutations.first { it.kind == CalendarMutationKind.RESIZE_START }.optimistic.startMinutes)

      performHandleResize(scenario, surfaceRef, day, "eventEndHandleRect", targetMinute = 677)
      waitUntil(scenario) { mutations.any { it.kind == CalendarMutationKind.RESIZE_END } }
      assertEquals(675, mutations.first { it.kind == CalendarMutationKind.RESIZE_END }.optimistic.endMinutes)

      injectTap(timelinePoint(scenario, surfaceRef::get, day, 900))
      waitUntil(scenario) { surfaceRef.get().currentDraft() != null }
      val originalDraft = requireNotNull(surfaceRef.get().currentDraft())
      waitUntil(scenario) {
        centerTimelinePage(surfaceRef.get(), day).gestureLayer.readPrivateField("draftRect") != null
      }

      val cancelStart = handlePoint(scenario, surfaceRef::get, day, "draftRect")
      val cancelEnd = ScreenPoint(cancelStart.x, cancelStart.y + 30f *
        InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density)
      val cancelDown = startPointer(cancelStart)
      movePointer(cancelDown, cancelEnd)
      SystemClock.sleep(24L)
      cancelPointer(cancelDown, cancelEnd)
      assertEquals(originalDraft, surfaceRef.get().currentDraft())
      assertEquals(originalDraft, drafts.last().draft)
      assertEquals("gesture-cancelled", drafts.last().reason)

      val detachStart = handlePoint(scenario, surfaceRef::get, day, "draftRect")
      val detachEnd = ScreenPoint(detachStart.x, detachStart.y + 30f *
        InstrumentationRegistry.getInstrumentation().targetContext.resources.displayMetrics.density)
      val detachDown = startPointer(detachStart)
      movePointer(detachDown, detachEnd)
      scenario.onActivity { activity ->
        val surface = surfaceRef.get()
        val page = centerTimelinePage(surface, day)
        activity.root.removeView(surface)
        assertNull(surface.currentDraft())
        assertNull(page.gestureLayer.readPrivateField("previewEvent"))
        activity.root.addView(
          surface,
          ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
      }
      waitForDaySurface(scenario, surfaceRef)
      cancelPointer(detachDown, detachEnd)
      assertNull(surfaceRef.get().currentDraft())
      assertNull(drafts.last().draft)
      assertEquals("detached", drafts.last().reason)

      scenario.recreate()
      val recreatedRef = addDaySurface(scenario, calendarSnapshot(day, defaultDurationMinutes = 30))
      waitForDaySurface(scenario, recreatedRef)
      assertNull(recreatedRef.get().currentDraft())
      scenario.onActivity {
        centerTimelinePage(recreatedRef.get(), day).let { page ->
          assertNull(page.gestureLayer.readPrivateField("previewEvent"))
          assertNull(page.gestureLayer.readPrivateField("gestureOriginalDraft"))
        }
      }
    }
  }

  @Test
  fun monthUsesPerDayAndEventSemanticsAndClosesWithoutFadingTheDetailPager() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val day = selectedDay()
      val selected = AtomicReference<Int?>()
      val opened = AtomicReference<CalendarEvent?>()
      val pagerRef = addMonthSurface(scenario, day, selected::set, opened::set)
      waitForMonthSurface(scenario, pagerRef, day)

      scenario.onActivity {
        val row = requireNotNull(visibleWeekRow(pagerRef.get(), day))
        val rowStart = row.readPrivateField("rowStartEpochDay") as Int
        val dateVirtualId = 1 + day - rowStart
        val dateNode = row.accessibilityNodeProvider.createAccessibilityNodeInfo(dateVirtualId)
        assertNotNull(dateNode)
        assertTrue(requireNotNull(dateNode).contentDescription.toString().contains("日程"))
        assertTrue(
          row.accessibilityNodeProvider.performAction(
            dateVirtualId,
            AccessibilityNodeInfo.ACTION_CLICK,
            null,
          ),
        )
      }
      waitUntil(scenario, timeoutMs = 2_000L) {
        visibleMonthEventOwner(pagerRef.get()) != null && monthTransitionSettled(pagerRef.get())
      }

      scenario.onActivity {
        val row = requireNotNull(visibleWeekRow(pagerRef.get(), day))
        val eventNode = row.accessibilityNodeProvider.createAccessibilityNodeInfo(100)
        assertNotNull(eventNode)
        assertTrue(requireNotNull(eventNode).contentDescription.toString().contains("定时日程"))
        assertTrue(row.accessibilityNodeProvider.performAction(100, AccessibilityNodeInfo.ACTION_CLICK, null))
      }
      assertEquals("timed", opened.get()?.sourceEventId)

      val closePoint = monthDatePoint(scenario, pagerRef::get, day)
      scenario.onActivity { it.root.resetTouchTrace() }
      injectTap(closePoint)
      scenario.onActivity { activity ->
        val page = visibleMonthPage(pagerRef.get())
        val owner = page.descendantsBySimpleName("SelectedDayEventsOwner").single()
        val row = requireNotNull(visibleWeekRow(pagerRef.get(), day))
        assertEquals(
          "closePoint=$closePoint, rowDown=${row.readPrivateField("downX")},${row.readPrivateField("downY")}, " +
            "expanded=${page.readPrivateField("expandedSelection")}, transitioning=${page.readPrivateField("transitioning")}, " +
            "rootTrace=${activity.root.touchTrace()}",
          View.INVISIBLE,
          owner.visibility,
        )
        assertNull(page.readPrivateField("displayedSelectedEpochDay"))
      }
      waitUntil(scenario) { visibleMonthEventOwner(pagerRef.get()) == null }
    }
  }

  @Test
  // CAL-MONTH-EXPAND-HOST-001
  fun monthExpansionSurvivesImmediateSelectedDateSnapshotRebind() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val day = selectedDay()
      val targetDay = CalendarDateMath.toEpochDay(2026, 7, 20)
      val selected = AtomicReference<Int?>()
      val pagerRef = AtomicReference<ThreePageMonthPager>()
      scenario.onActivity { activity ->
        activity.root.setPadding(0, activity.statusBarInsetPx(), 0, 0)
        lateinit var pager: ThreePageMonthPager
        pager = ThreePageMonthPager(activity).apply {
          setListener(object : MonthCalendarListener {
            override fun onMonthChanged(monthEpochDay: Int) = Unit

            override fun onDateSelected(epochDay: Int) {
              selected.set(epochDay)
              // CAL-MONTH-EXPAND-001: CalendarHostView synchronously renders a
              // selected-date snapshot before the 350 ms row transition ends.
              pager.setSnapshot(calendarSnapshot(day).copy(selectedEpochDay = epochDay))
            }

            override fun onEventOpened(event: CalendarEvent) = Unit
          })
          jumpToMonth(day)
          setSnapshot(calendarSnapshot(day))
        }
        activity.root.addView(
          pager,
          ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        pagerRef.set(pager)
      }
      waitForMonthSurface(scenario, pagerRef, targetDay)

      injectTap(monthDatePoint(scenario, pagerRef::get, targetDay))
      try {
        waitUntil(scenario, timeoutMs = 3_000L) {
          selected.get() == targetDay &&
            visibleMonthEventOwner(pagerRef.get()) != null &&
            monthTransitionSettled(pagerRef.get())
        }
      } catch (failure: AssertionError) {
        val details = AtomicReference<String>()
        scenario.onActivity {
          val page = visibleMonthPage(pagerRef.get())
          val owner = page.descendantsBySimpleName("SelectedDayEventsOwner").single()
          val rows = page.descendantsBySimpleName("MonthWeekRowView").joinToString { row ->
            "${row.readPrivateField("rowStartEpochDay")}:top=${row.top},y=${row.y}," +
              "translation=${row.translationY},visible=${row.visibility}"
          }
          details.set(
            "callback=${selected.get()}, expanded=${page.readPrivateField("expandedSelection")}, " +
              "displayed=${page.readPrivateField("displayedSelectedEpochDay")}, " +
              "transitioning=${page.readPrivateField("transitioning")}, " +
              "animator=${page.readPrivateField("transitionAnimator")}, " +
              "owner=${owner.visibility}/${owner.alpha}/${owner.height}, rows=[$rows]",
          )
        }
        throw AssertionError("snapshot rebind broke month expansion: ${details.get()}", failure)
      }
      scenario.onActivity {
        val page = visibleMonthPage(pagerRef.get())
        val selection = page.readPrivateField("expandedSelection") as MonthExpandedSelection
        assertEquals(targetDay, selection.epochDay)
        val selectedRow = requireNotNull(visibleWeekRow(pagerRef.get(), targetDay))
        assertTrue("selected week must move to the top edge", selectedRow.y < selectedRow.height * 0.1f)
      }
    }
  }

  @Test
  fun monthCrossRowRunsTwoLegsAndCrossMonthOrInterruptionCannotRestoreStaleSelection() {
    ActivityScenario.launch(CalendarSurfaceTestActivity::class.java).use { scenario ->
      val day = selectedDay()
      val selected = AtomicReference<Int?>()
      val selectedAt = AtomicReference<Pair<Int, Long>?>()
      val pagerRef = addMonthSurface(scenario, day, onSelected = { epochDay ->
        selected.set(epochDay)
        selectedAt.set(epochDay to SystemClock.uptimeMillis())
      })
      waitForMonthSurface(scenario, pagerRef, day)
      val initialPoint = monthDatePoint(scenario, pagerRef::get, day)
      injectTap(initialPoint)
      try {
        waitUntil(scenario, timeoutMs = 2_000L) {
          visibleMonthEventOwner(pagerRef.get()) != null && monthTransitionSettled(pagerRef.get())
        }
      } catch (failure: AssertionError) {
        val details = AtomicReference<String>()
        scenario.onActivity {
          val pager = pagerRef.get()
          val page = visibleMonthPage(pager)
          val row = requireNotNull(visibleWeekRow(pager, day))
          val bounds = Rect().also(row::getGlobalVisibleRect)
          val internalPager = pager.readPrivateField("pager") as ViewPager2
          details.set(
            "point=$initialPoint, rowBounds=$bounds, rowDown=${row.readPrivateField("downX")},${row.readPrivateField("downY")}, " +
              "expanded=${page.readPrivateField("expandedSelection")}, displayed=${page.readPrivateField("displayedSelectedEpochDay")}, " +
              "transitioning=${page.readPrivateField("transitioning")}, recentering=${pager.readPrivateField("recentering")}, " +
              "currentItem=${internalPager.currentItem}, scrollState=${internalPager.scrollState}",
          )
        }
        throw AssertionError("month window tap did not open: ${details.get()}", failure)
      }

      val nextRowDay = day + 7
      injectTap(monthDatePoint(scenario, pagerRef::get, nextRowDay))
      scenario.onActivity {
        assertNull(visibleMonthEventOwner(pagerRef.get()))
      }
      SystemClock.sleep(200L)
      scenario.onActivity { assertNull(visibleMonthEventOwner(pagerRef.get())) }
      waitUntil(scenario, timeoutMs = 2_000L) {
        selected.get() == nextRowDay && visibleMonthEventOwner(pagerRef.get()) != null &&
          monthTransitionSettled(pagerRef.get())
      }
      scenario.onActivity {
        val page = visibleMonthPage(pagerRef.get())
        assertEquals(nextRowDay, page.readPrivateField("displayedSelectedEpochDay"))
        assertFalse(page.readPrivateField("transitioning") as Boolean)
      }

      val interruptedTarget = day + 14
      injectTap(monthDatePoint(scenario, pagerRef::get, interruptedTarget))
      SystemClock.sleep(100L)
      scenario.onActivity { activity ->
        val page = visibleMonthPage(pagerRef.get())
        page.layout(page.left, page.top, page.right, page.bottom - activity.dp(24f))
      }
      waitUntil(scenario) {
        val page = visibleMonthPage(pagerRef.get())
        page.readPrivateField("transitioning") == false &&
          page.readPrivateField("displayedSelectedEpochDay") == interruptedTarget
      }
      scenario.onActivity {
        val page = visibleMonthPage(pagerRef.get())
        assertEquals(
          interruptedTarget,
          (page.readPrivateField("expandedSelection") as? MonthExpandedSelection)?.epochDay,
        )
      }

      val august = CalendarDateMath.toEpochDay(2026, 8, 1)
      assertNotNull(visibleWeekRow(pagerRef.get(), august))
      val crossMonthStart = SystemClock.uptimeMillis()
      val closeProbe = AtomicReference<CrossMonthProbe>()
      val openProbe = AtomicReference<CrossMonthProbe>()
      val probeLatch = CountDownLatch(2)
      scenario.onActivity { it.root.resetTouchTrace() }
      injectTap(monthDatePoint(scenario, pagerRef::get, august))
      val pager = pagerRef.get()
      pager.postDelayed(
        {
          closeProbe.set(captureCrossMonthProbe(pager, selected.get()))
          probeLatch.countDown()
        },
        200L,
      )
      pager.postDelayed(
        {
          openProbe.set(captureCrossMonthProbe(pager, selected.get()))
          probeLatch.countDown()
        },
        500L,
      )
      assertTrue("cross-month probes did not execute", probeLatch.await(1_500L, TimeUnit.MILLISECONDS))

      val closing = requireNotNull(closeProbe.get())
      assertEquals(CalendarDateMath.monthStart(day), closing.monthEpochDay)
      assertEquals(august, closing.pendingCrossMonthEpochDay)
      assertNull(closing.displayedSelectedEpochDay)
      assertTrue(closing.transitioning)
      assertEquals(View.INVISIBLE, closing.eventOwnerVisibility)
      assertTrue("selection escaped before close finished", closing.externalSelectedEpochDay != august)

      val opening = requireNotNull(openProbe.get())
      assertEquals(CalendarDateMath.monthStart(august), opening.monthEpochDay)
      assertNull(opening.pendingCrossMonthEpochDay)
      assertEquals(august, opening.displayedSelectedEpochDay)
      assertTrue(opening.transitioning)
      assertEquals(View.VISIBLE, opening.eventOwnerVisibility)
      assertTrue(opening.eventOwnerAlpha in 0f..1f)
      assertEquals(august, opening.externalSelectedEpochDay)

      waitUntil(scenario, timeoutMs = 2_000L) {
        pagerRef.get().currentMonthEpochDay() == CalendarDateMath.monthStart(august)
      }
      val augustSelectionAt = requireNotNull(selectedAt.get())
      assertEquals(august, augustSelectionAt.first)
      assertTrue(
        augustSelectionAt.second - crossMonthStart >= MonthExpandedLayoutContract.ROW_ANIMATION_DURATION_MS,
      )
      waitUntil(scenario, timeoutMs = 2_000L) {
        val page = visibleMonthPage(pagerRef.get())
        page.readPrivateField("transitioning") == false &&
          page.readPrivateField("displayedSelectedEpochDay") == august
      }
      scenario.onActivity {
        val page = visibleMonthPage(pagerRef.get())
        assertEquals(august, selected.get())
        assertNotNull(page.readPrivateField("expandedSelection"))
        assertNotNull(visibleMonthEventOwner(pagerRef.get()))
      }
      assertTrue(
        SystemClock.uptimeMillis() - crossMonthStart >=
          MonthExpandedLayoutContract.ROW_ANIMATION_DURATION_MS * 2,
      )
    }
  }

  private fun addDaySurface(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    snapshot: CalendarSnapshot,
    onSelected: (Int) -> Unit = {},
    onOpened: (CalendarEvent) -> Unit = {},
    onCreate: (CalendarDraft) -> Unit = {},
    onDraft: (CalendarDraft?, String) -> Unit = { _, _ -> },
    onMutation: (CalendarMutationKind, CalendarEvent, CalendarEvent) -> Boolean = { _, _, _ -> true },
  ): AtomicReference<SingleDayCalendarView> {
    val surfaceRef = AtomicReference<SingleDayCalendarView>()
    scenario.onActivity { activity ->
      activity.root.setPadding(0, activity.statusBarInsetPx(), 0, 0)
      val surface = SingleDayCalendarView(activity).apply {
        setListener(object : DayCalendarListener {
          override fun onDateSelected(epochDay: Int) = onSelected(epochDay)
          override fun onEventOpened(event: CalendarEvent) = onOpened(event)
          override fun onCreateRequested(draft: CalendarDraft) = onCreate(draft)
          override fun onDraftChanged(draft: CalendarDraft?, reason: String) = onDraft(draft, reason)
          override fun onMutationRequested(
            kind: CalendarMutationKind,
            original: CalendarEvent,
            optimistic: CalendarEvent,
          ): Boolean = onMutation(kind, original, optimistic)
        })
        setSnapshot(snapshot)
      }
      activity.root.addView(
        surface,
        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
      )
      surfaceRef.set(surface)
    }
    return surfaceRef
  }

  private fun addMonthSurface(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    day: Int,
    onSelected: (Int) -> Unit,
    onOpened: (CalendarEvent) -> Unit = {},
  ): AtomicReference<ThreePageMonthPager> {
    val pagerRef = AtomicReference<ThreePageMonthPager>()
    scenario.onActivity { activity ->
      activity.root.setPadding(0, activity.statusBarInsetPx(), 0, 0)
      val pager = ThreePageMonthPager(activity).apply {
        setListener(object : MonthCalendarListener {
          override fun onMonthChanged(monthEpochDay: Int) = Unit
          override fun onDateSelected(epochDay: Int) = onSelected(epochDay)
          override fun onEventOpened(event: CalendarEvent) = onOpened(event)
        })
        jumpToMonth(day)
        setSnapshot(calendarSnapshot(day))
      }
      activity.root.addView(
        pager,
        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
      )
      pagerRef.set(pager)
    }
    return pagerRef
  }

  private fun waitForDaySurface(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    surfaceRef: AtomicReference<SingleDayCalendarView>,
  ) {
    waitUntil(scenario) {
      surfaceRef.get().isLaidOut && surfaceRef.get().hasWindowFocus() &&
        surfaceRef.get().descendants<DayTimelinePageView>().size == 3 &&
        surfaceRef.get().threePageDayPager.isSettledAndInteractive()
    }
  }

  private fun waitForMonthSurface(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    pagerRef: AtomicReference<ThreePageMonthPager>,
    epochDay: Int,
  ) {
    waitUntil(scenario) {
      pagerRef.get().isLaidOut && pagerRef.get().hasWindowFocus() &&
        pagerRef.get().isSettledAndInteractive()
    }
    try {
      waitUntil(scenario) { visibleWeekRow(pagerRef.get(), epochDay) != null }
    } catch (failure: AssertionError) {
      val details = AtomicReference<String>()
      scenario.onActivity {
        val pager = pagerRef.get()
        val pages = pager.descendantsBySimpleName("MonthPageView").joinToString("; ") { page ->
          val pageBounds = Rect()
          val pageVisible = page.getGlobalVisibleRect(pageBounds)
          val rows = page.descendantsBySimpleName("MonthWeekRowView")
            .filter { row ->
              val start = row.readPrivateField("rowStartEpochDay") as? Int
              start != null && epochDay in start..(start + 6)
            }
            .joinToString { row ->
              val rowBounds = Rect()
              val rowVisible = row.getGlobalVisibleRect(rowBounds)
              "row(start=${row.readPrivateField("rowStartEpochDay")}, size=${row.width}x${row.height}, " +
                "top=${row.top}, y=${row.y}, translation=${row.translationY}, visible=$rowVisible:$rowBounds)"
            }
          "page(month=${page.readPrivateField("monthEpochDay")}, size=${page.width}x${page.height}, " +
            "visible=$pageVisible:$pageBounds, rows=[$rows])"
        }
        details.set(
          "pager=${pager.width}x${pager.height}, currentMonth=${pager.currentMonthEpochDay()}, pages=[$pages]",
        )
      }
      throw AssertionError("current month date hit area is not visible: ${details.get()}", failure)
    }
  }

  private fun performHandleResize(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    surfaceRef: AtomicReference<SingleDayCalendarView>,
    day: Int,
    fieldName: String,
    targetMinute: Int,
  ) {
    waitUntil(scenario) {
      centerTimelinePage(surfaceRef.get(), day).gestureLayer.readPrivateField(fieldName) != null
    }
    val start = handlePoint(scenario, surfaceRef::get, day, fieldName)
    val targetY = timelinePoint(scenario, surfaceRef::get, day, targetMinute).y
    val target = ScreenPoint(start.x, targetY)
    val down = startPointer(start)
    SystemClock.sleep(32L)
    movePointer(down, target)
    SystemClock.sleep(32L)
    endPointer(down, target)
  }

  private fun calendarSnapshot(
    day: Int,
    centerAllDayCount: Int = 0,
    nextAllDayCount: Int = 0,
    previousAllDayCount: Int = 0,
    defaultDurationMinutes: Int = 30,
  ): CalendarSnapshot = CalendarSnapshot(
    generation = 7,
    rangeStartEpochDay = day - 45,
    rangeEndEpochDayExclusive = day + 46,
    selectedEpochDay = day,
    todayEpochDay = day - 1,
    settings = CalendarSettings(defaultEventDurationMinutes = defaultDurationMinutes),
    events = buildList {
      add(timedEvent(day))
      addAll(allDayEvents("前日", previousAllDayCount, day - 1))
      addAll(allDayEvents("全天", centerAllDayCount, day))
      addAll(allDayEvents("次日", nextAllDayCount, day + 1))
    },
  )

  private fun timedEvent(day: Int): CalendarEvent = CalendarEvent(
    sourceEventId = "timed",
    occurrenceDate = "2026-07-17",
    title = "定时日程",
    startEpochDay = day,
    endEpochDay = day,
    startMinutes = 607,
    endMinutes = 667,
    timeZoneId = "Asia/Shanghai",
    allDay = false,
    editable = true,
    revision = 1,
  )

  private fun allDayEvents(prefix: String, count: Int, day: Int): List<CalendarEvent> =
    List(count) { index ->
      CalendarEvent(
        sourceEventId = "$prefix-$index-$day",
        occurrenceDate = "2026-07-17",
        title = "$prefix-$index",
        startEpochDay = day,
        endEpochDay = day,
        endEpochDayExclusive = day + 1,
        startMinutes = null,
        endMinutes = null,
        timeZoneId = "Asia/Shanghai",
        allDay = true,
        editable = true,
        revision = 1,
      )
    }

  private fun selectedDay(): Int = CalendarDateMath.toEpochDay(2026, 7, 17)

  private fun centerTimelinePage(surface: SingleDayCalendarView, epochDay: Int): DayTimelinePageView =
    surface.descendants<DayTimelinePageView>().single { page ->
      (page.gestureLayer.readPrivateField("binding") as? DayPageBinding)?.epochDay == epochDay
    }

  private fun centerAllDayPage(surface: SingleDayCalendarView, epochDay: Int): DayAllDayPageView =
    surface.descendants<DayAllDayPageView>().single { it.boundEpochDay == epochDay }

  private fun visibleWeekRow(root: View, epochDay: Int): View? =
    visibleMonthPage(root).descendantsBySimpleName("MonthWeekRowView")
      .mapNotNull { row ->
        val rowStart = row.readPrivateField("rowStartEpochDay") as? Int ?: return@mapNotNull null
        val bounds = Rect()
        if (epochDay !in rowStart..(rowStart + 6) || !row.getGlobalVisibleRect(bounds)) return@mapNotNull null
        val dateHitHeight = row.resources.displayMetrics.density * 31f
        if (bounds.width() <= 2 || bounds.height() < dateHitHeight) return@mapNotNull null
        row to bounds.width().toLong() * bounds.height().toLong()
      }
      .maxByOrNull { it.second }
      ?.first

  private fun visibleMonthPage(root: View): View {
    val currentMonth = (root as? ThreePageMonthPager)?.currentMonthEpochDay()
    return root.descendantsBySimpleName("MonthPageView")
      .mapNotNull { page ->
        if (currentMonth != null && page.readPrivateField("monthEpochDay") != currentMonth) {
          return@mapNotNull null
        }
        val bounds = Rect()
        if (!page.getGlobalVisibleRect(bounds) || bounds.width() <= 2 || bounds.height() <= 2) {
          return@mapNotNull null
        }
        page to bounds.width().toLong() * bounds.height().toLong()
      }
      .maxByOrNull { it.second }
      ?.first
      ?: error("No current month page is fully visible")
  }

  private fun captureCrossMonthProbe(
    root: ThreePageMonthPager,
    externalSelectedEpochDay: Int?,
  ): CrossMonthProbe {
    val page = visibleMonthPage(root)
    val owner = page.descendantsBySimpleName("SelectedDayEventsOwner").single()
    return CrossMonthProbe(
      monthEpochDay = root.currentMonthEpochDay(),
      pendingCrossMonthEpochDay = page.readPrivateField("pendingCrossMonthEpochDay") as? Int,
      displayedSelectedEpochDay = page.readPrivateField("displayedSelectedEpochDay") as? Int,
      transitioning = page.readPrivateField("transitioning") as Boolean,
      eventOwnerVisibility = owner.visibility,
      eventOwnerAlpha = owner.alpha,
      externalSelectedEpochDay = externalSelectedEpochDay,
    )
  }

  private fun visibleMonthEventOwner(root: View): View? =
    visibleMonthPage(root).descendantsBySimpleName("SelectedDayEventsOwner")
      .singleOrNull { it.visibility == View.VISIBLE && it.alpha > 0.99f }

  private fun monthTransitionSettled(root: View): Boolean =
    visibleMonthPage(root).readPrivateField("transitioning") == false

  private fun monthDatePoint(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    pager: () -> ThreePageMonthPager,
    epochDay: Int,
  ): ScreenPoint {
    val result = AtomicReference<ScreenPoint>()
    scenario.onActivity { activity ->
      val row = requireNotNull(visibleWeekRow(pager(), epochDay))
      val rowStart = row.readPrivateField("rowStartEpochDay") as Int
      val column = epochDay - rowStart
      val gridStart = activity.dp(MonthExpandedLayoutContract.GRID_START_MARGIN_DP).toFloat()
      val gridEnd = activity.dp(MonthExpandedLayoutContract.GRID_END_MARGIN_DP).toFloat()
      val cellWidth = (row.width - gridStart - gridEnd) / MonthExpandedLayoutContract.DAY_PAGE_COUNT
      result.set(
        row.screenPoint(
          gridStart + (column + 0.5f) * cellWidth,
          activity.dp(16f).toFloat(),
        ),
      )
    }
    return result.get()
  }

  private fun timelinePoint(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    surface: () -> SingleDayCalendarView,
    epochDay: Int,
    minute: Int,
    xFromRightDp: Float = 80f,
  ): ScreenPoint {
    val result = AtomicReference<ScreenPoint>()
    scenario.onActivity { activity ->
      val page = centerTimelinePage(surface(), epochDay)
      result.set(
        page.gestureLayer.screenPoint(
          page.gestureLayer.width - activity.dp(xFromRightDp).toFloat(),
          page.timelineCanvas.minuteToScreenY(minute),
        ),
      )
    }
    return result.get()
  }

  private fun handlePoint(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    surface: () -> SingleDayCalendarView,
    epochDay: Int,
    fieldName: String,
  ): ScreenPoint {
    val result = AtomicReference<ScreenPoint>()
    scenario.onActivity {
      val layer = centerTimelinePage(surface(), epochDay).gestureLayer
      val rect = layer.readPrivateField(fieldName) as CalendarRect
      result.set(layer.screenPoint(rect.centerX(), rect.centerY()))
    }
    return result.get()
  }

  private fun viewFractionPoint(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    view: () -> View,
    xFraction: Float,
    yFraction: Float,
  ): ScreenPoint {
    val result = AtomicReference<ScreenPoint>()
    scenario.onActivity {
      val target = view()
      val visible = Rect()
      check(target.getLocalVisibleRect(visible) && visible.width() > 2 && visible.height() > 2)
      val location = IntArray(2)
      target.getLocationOnScreen(location)
      result.set(
        ScreenPoint(
          location[0] +
            (visible.left + visible.width() * xFraction).coerceIn(visible.left + 1f, visible.right - 1f),
          location[1] +
            (visible.top + visible.height() * yFraction).coerceIn(visible.top + 1f, visible.bottom - 1f),
        ),
      )
    }
    return result.get()
  }

  private fun swipeWithFrames(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    view: () -> View,
    startFraction: Float,
    endFraction: Float,
  ) {
    val start = viewFractionPoint(scenario, view, startFraction, 0.5f)
    val end = viewFractionPoint(scenario, view, endFraction, 0.5f)
    val downTime = startPointer(start)
    repeat(6) { index ->
      SystemClock.sleep(24L)
      val fraction = (index + 1) / 7f
      movePointer(
        downTime,
        ScreenPoint(
          start.x + (end.x - start.x) * fraction,
          start.y + (end.y - start.y) * fraction,
        ),
      )
    }
    SystemClock.sleep(24L)
    endPointer(downTime, end)
  }

  private fun startPointer(point: ScreenPoint): Long {
    val downTime = SystemClock.uptimeMillis()
    sendPointer(downTime, MotionEvent.ACTION_DOWN, point)
    return downTime
  }

  private fun injectSwipe(startX: Float, startY: Float, endX: Float, endY: Float) {
    val downTime = SystemClock.uptimeMillis()
    sendPointer(downTime, MotionEvent.ACTION_DOWN, ScreenPoint(startX, startY))
    repeat(18) { index ->
      SystemClock.sleep(8L)
      val fraction = (index + 1) / 19f
      sendPointer(
        downTime,
        MotionEvent.ACTION_MOVE,
        ScreenPoint(
          startX + (endX - startX) * fraction,
          startY + (endY - startY) * fraction,
        ),
      )
    }
    SystemClock.sleep(8L)
    sendPointer(downTime, MotionEvent.ACTION_UP, ScreenPoint(endX, endY))
  }

  private fun injectTap(point: ScreenPoint) {
    val downTime = startPointer(point)
    SystemClock.sleep(16L)
    endPointer(downTime, point)
  }

  private fun movePointer(downTime: Long, point: ScreenPoint) {
    sendPointer(downTime, MotionEvent.ACTION_MOVE, point)
  }

  private fun endPointer(downTime: Long, point: ScreenPoint) {
    sendPointer(downTime, MotionEvent.ACTION_UP, point)
  }

  private fun cancelPointer(downTime: Long, point: ScreenPoint) {
    sendPointer(downTime, MotionEvent.ACTION_CANCEL, point)
  }

  private fun sendPointer(
    downTime: Long,
    action: Int,
    point: ScreenPoint,
  ) {
    val event = MotionEvent.obtain(
      downTime,
      SystemClock.uptimeMillis().coerceAtLeast(downTime),
      action,
      point.x,
      point.y,
      0,
    ).apply { source = InputDevice.SOURCE_TOUCHSCREEN }
    try {
      InstrumentationRegistry.getInstrumentation().sendPointerSync(event)
    } finally {
      event.recycle()
    }
  }

  private fun View.screenPoint(localX: Float, localY: Float): ScreenPoint {
    val location = IntArray(2)
    getLocationOnScreen(location)
    return ScreenPoint(location[0] + localX, location[1] + localY)
  }

  private fun CalendarRect.centerX(): Float = (left + right) / 2f

  private fun CalendarRect.centerY(): Float = (top + bottom) / 2f

  private fun Any.readPrivateField(name: String): Any? {
    var type: Class<*>? = javaClass
    while (type != null) {
      try {
        return type.getDeclaredField(name).let { field ->
          field.isAccessible = true
          field.get(this)
        }
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name was not found on ${javaClass.name}")
  }

  private fun ThreePageDayPager.isSettledAndInteractive(): Boolean {
    val internalPager = readPrivateField("pager") as ViewPager2
    return readPrivateField("recentering") == false &&
      internalPager.isUserInputEnabled &&
      internalPager.scrollState == ViewPager2.SCROLL_STATE_IDLE
  }

  private fun ThreePageMonthPager.isSettledAndInteractive(): Boolean {
    val internalPager = readPrivateField("pager") as ViewPager2
    return readPrivateField("recentering") == false &&
      internalPager.isUserInputEnabled &&
      internalPager.scrollState == ViewPager2.SCROLL_STATE_IDLE
  }

  private inline fun <reified T : View> View.descendants(): List<T> = descendants(T::class.java)

  private fun <T : View> View.descendants(type: Class<T>): List<T> =
    allDescendants().filter(type::isInstance).map { requireNotNull(type.cast(it)) }

  private fun View.descendantsBySimpleName(name: String): List<View> =
    allDescendants().filter { it.javaClass.simpleName == name }

  private fun View.allDescendants(): List<View> {
    val matches = mutableListOf<View>()
    val pending = ArrayDeque<View>()
    pending.add(this)
    while (pending.isNotEmpty()) {
      val current = pending.removeFirst()
      matches += current
      if (current is ViewGroup) repeat(current.childCount) { index -> pending.addLast(current.getChildAt(index)) }
    }
    return matches
  }

  private fun CalendarSurfaceTestActivity.dp(value: Float): Int =
    (value * resources.displayMetrics.density).roundToInt()

  private fun CalendarSurfaceTestActivity.statusBarInsetPx(): Int {
    val resourceId = resources.getIdentifier("status_bar_height", "dimen", "android")
    return if (resourceId == 0) 0 else resources.getDimensionPixelSize(resourceId)
  }

  private fun waitUntil(
    scenario: ActivityScenario<CalendarSurfaceTestActivity>,
    timeoutMs: Long = 3_000L,
    condition: () -> Boolean,
  ) {
    val deadline = SystemClock.uptimeMillis() + timeoutMs
    while (SystemClock.uptimeMillis() < deadline) {
      val met = AtomicBoolean(false)
      scenario.onActivity { met.set(condition()) }
      if (met.get()) return
      Thread.sleep(25L)
    }
    val met = AtomicBoolean(false)
    scenario.onActivity { met.set(condition()) }
    assertTrue("condition was not met within ${timeoutMs}ms", met.get())
  }

  private data class MutationCapture(
    val kind: CalendarMutationKind,
    val original: CalendarEvent,
    val optimistic: CalendarEvent,
  )

  private data class DraftCapture(
    val draft: CalendarDraft?,
    val reason: String,
  )

  private data class ScreenPoint(val x: Float, val y: Float)

  private data class CrossMonthProbe(
    val monthEpochDay: Int,
    val pendingCrossMonthEpochDay: Int?,
    val displayedSelectedEpochDay: Int?,
    val transitioning: Boolean,
    val eventOwnerVisibility: Int,
    val eventOwnerAlpha: Float,
    val externalSelectedEpochDay: Int?,
  )
}
