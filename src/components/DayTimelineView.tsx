import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C, withAlpha } from '../theme/colors';
import type { CalEvent } from '../types';
import { selectTasksForDate } from '../utils/taskOrdering';
import { eventDisplaysAsAllDay, sortAllDayEvents } from '../utils/eventAllDay';
import { layoutTimelineEvents, type TimelineEvent } from '../utils/dayTimelineLayout';
import {
  projectTimelineEdit,
  timelineEdgeScrollStep,
  type TimelineEditKind,
  type TimelineMinuteRange,
} from '../utils/dayTimelineGestures';
import {
  addDays,
  dateKey,
  isSameDay,
  minutesToTime,
  sundayStartOfWeek,
  timeToMinutes,
} from '../utils/calendarDate';
import { eventListTitle } from '../utils/eventTitle';
import {
  colorForEventCategory,
  fillColorForEventCategory,
  textColorForEventCategory,
} from '../utils/eventColors';

const TIME_GUTTER = 56;
const DAY_CANVAS_HEIGHT = 1236;
const TOP_SPACE = 16;
const BOTTOM_SPACE = 20;
const HOUR_HEIGHT = (DAY_CANVAS_HEIGHT - TOP_SPACE - BOTTOM_SPACE) / 24;
const DAY_MINUTES = 24 * 60;
const DAY_HEADER_HEIGHT = 52;
const ALL_DAY_ITEM_HEIGHT = 25;
const ALL_DAY_COLLAPSED_ROWS = 3;
const ALL_DAY_MAX_EXPANDED_ROWS = 7.5;
const QUICK_CREATE_MINUTES = 30;
const QUICK_CREATE_SNAP_MINUTES = 30;
const REPEAT_ACTION_GUARD_MS = 700;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

type TimelineEditPreview = TimelineMinuteRange & {
  event: CalEvent;
  original: TimelineMinuteRange;
  saving: boolean;
};

export function DayTimelineView({
  date,
  events,
  onDateChange,
  onOpenEvent,
  onCreate,
  onChangeEventTime,
}: {
  date: Date;
  events: CalEvent[];
  onDateChange: (date: Date) => void;
  onOpenEvent: (event: CalEvent) => void;
  onCreate: (startDate: Date, startTime: string, endDate: Date, endTime: string) => void;
  onChangeEventTime?: (
    event: CalEvent,
    changes: Pick<CalEvent, 'startDate' | 'endDate' | 'startTime' | 'endTime'>,
  ) => Promise<boolean>;
}) {
  const { width, height } = useWindowDimensions();
  const [now, setNow] = useState(() => new Date());
  const pagerRef = useRef<ScrollView | null>(null);
  const dayGestureActive = useRef(false);
  const dayGestureHandled = useRef(false);
  const [transientClearSignal, setTransientClearSignal] = useState(0);
  const [allDayExpanded, setAllDayExpanded] = useState(false);
  const [allDayScrollY, setAllDayScrollY] = useState(0);
  const pageWidth = Math.max(280, width);
  const dates = useMemo(() => [addDays(date, -1), date, addDays(date, 1)], [date]);

  useEffect(() => {
    const updateNow = () => setNow(new Date());
    const timer = setInterval(updateNow, 30_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') updateNow();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  useLayoutEffect(() => {
    pagerRef.current?.scrollTo({ x: pageWidth, animated: false });
  }, [date, pageWidth]);

  const settleDate = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!dayGestureActive.current || dayGestureHandled.current) return;
    const page = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
    dayGestureActive.current = false;
    dayGestureHandled.current = true;
    if (page === 1) {
      pagerRef.current?.scrollTo({ x: pageWidth, animated: false });
      return;
    }
    onDateChange(addDays(date, page === 0 ? -1 : 1));
  };

  return (
    <View style={s.root} accessible={false}>
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        bounces={false}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        accessible={false}
        contentOffset={{ x: pageWidth, y: 0 }}
        onScrollBeginDrag={() => {
          dayGestureActive.current = true;
          dayGestureHandled.current = false;
          setTransientClearSignal(value => value + 1);
        }}
        onMomentumScrollEnd={settleDate}
        scrollEventThrottle={16}
        testID="day-view-pager"
      >
        {dates.map((pageDate, index) => (
          <DayPage
            key={dateKey(pageDate)}
            date={pageDate}
            width={pageWidth}
            events={events}
            active={index === 1}
            onDateChange={onDateChange}
            onOpenEvent={onOpenEvent}
            onCreate={onCreate}
            onChangeEventTime={onChangeEventTime}
            now={now}
            screenHeight={height}
            transientClearSignal={transientClearSignal}
            allDayExpanded={allDayExpanded}
            allDayScrollY={allDayScrollY}
            onAllDayExpandedChange={setAllDayExpanded}
            onAllDayScrollChange={setAllDayScrollY}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function DayPage({
  date,
  width,
  events,
  active,
  onDateChange,
  onOpenEvent,
  onCreate,
  onChangeEventTime,
  now,
  screenHeight,
  transientClearSignal,
  allDayExpanded,
  allDayScrollY,
  onAllDayExpandedChange,
  onAllDayScrollChange,
}: {
  date: Date;
  width: number;
  events: CalEvent[];
  active: boolean;
  onDateChange: (date: Date) => void;
  onOpenEvent: (event: CalEvent) => void;
  onCreate: (startDate: Date, startTime: string, endDate: Date, endTime: string) => void;
  onChangeEventTime?: (
    event: CalEvent,
    changes: Pick<CalEvent, 'startDate' | 'endDate' | 'startTime' | 'endTime'>,
  ) => Promise<boolean>;
  now: Date;
  screenHeight: number;
  transientClearSignal: number;
  allDayExpanded: boolean;
  allDayScrollY: number;
  onAllDayExpandedChange: (expanded: boolean) => void;
  onAllDayScrollChange: (offset: number) => void;
}) {
  const scrollRef = useRef<ScrollView | null>(null);
  const allDayScrollRef = useRef<ScrollView | null>(null);
  const positionedDateRef = useRef<string | null>(null);
  const lastCreateRef = useRef<{ key: string; at: number } | null>(null);
  const lastOpenRef = useRef<{ key: string; at: number } | null>(null);
  const timelineScrollYRef = useRef(0);
  const quickSlotRef = useRef<TimelineMinuteRange | null>(null);
  const quickGestureRef = useRef<{
    kind: TimelineEditKind;
    original: TimelineMinuteRange;
    scrollStart: number;
    moved: boolean;
  } | null>(null);
  const editPreviewRef = useRef<TimelineEditPreview | null>(null);
  const editGestureRef = useRef<{
    kind: TimelineEditKind;
    original: TimelineMinuteRange;
    scrollStart: number;
  } | null>(null);
  const longPressConsumedRef = useRef<string | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [quickSlot, setQuickSlot] = useState<{ start: number; end: number } | null>(null);
  const [editPreview, setEditPreview] = useState<TimelineEditPreview | null>(null);
  const allDayHeight = useRef(new Animated.Value(0)).current;
  const today = now;
  const selectedKey = dateKey(date);
  const selectedEvents = useMemo(
    () => selectTasksForDate(events, selectedKey),
    [events, selectedKey],
  );
  const allDayEvents = useMemo(
    () => sortAllDayEvents(
      selectedEvents.filter(eventDisplaysAsAllDay),
      events,
    ),
    [events, selectedEvents],
  );
  const timelineEvents = useMemo(
    () => layoutTimelineEvents(selectedEvents, selectedKey),
    [selectedEvents, selectedKey],
  );
  const weekStart = sundayStartOfWeek(date);
  const weekDates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const availableWidth = Math.max(180, width - TIME_GUTTER - 6);
  const updateQuickSlot = useCallback((next: TimelineMinuteRange | null) => {
    quickSlotRef.current = next;
    setQuickSlot(next);
  }, []);
  const clearQuickSlot = useCallback(() => {
    quickGestureRef.current = null;
    updateQuickSlot(null);
  }, [updateQuickSlot]);
  const updateEditPreview = useCallback((next: TimelineEditPreview | null) => {
    editPreviewRef.current = next;
    setEditPreview(next);
  }, []);

  const cancelTimelineEdit = useCallback(() => {
    editGestureRef.current = null;
    longPressConsumedRef.current = null;
    updateEditPreview(null);
  }, [updateEditPreview]);

  useEffect(() => {
    clearQuickSlot();
    positionedDateRef.current = null;
    lastCreateRef.current = null;
    lastOpenRef.current = null;
    cancelTimelineEdit();
  }, [cancelTimelineEdit, clearQuickSlot, selectedKey]);

  useEffect(() => {
    clearQuickSlot();
    cancelTimelineEdit();
  }, [cancelTimelineEdit, clearQuickSlot, transientClearSignal]);

  const collapsedAllDayCount = allDayEvents.length > ALL_DAY_COLLAPSED_ROWS
    ? ALL_DAY_COLLAPSED_ROWS
    : allDayEvents.length;
  const targetAllDayHeight = (
    allDayExpanded
      ? Math.min(allDayEvents.length, ALL_DAY_MAX_EXPANDED_ROWS)
      : collapsedAllDayCount
  ) * ALL_DAY_ITEM_HEIGHT;
  const allDayMaxScroll = allDayExpanded
    ? Math.max(0, allDayEvents.length * ALL_DAY_ITEM_HEIGHT - targetAllDayHeight)
    : 0;

  useEffect(() => {
    if (!active || allDayEvents.length === 0) return;
    const clamped = Math.max(0, Math.min(allDayScrollY, allDayMaxScroll));
    if (clamped !== allDayScrollY) onAllDayScrollChange(clamped);
    if (clamped === 0 && allDayScrollY === 0) return;
    const frame = requestAnimationFrame(() => {
      allDayScrollRef.current?.scrollTo({ y: clamped, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, allDayEvents.length, allDayMaxScroll, allDayScrollY, onAllDayScrollChange, selectedKey]);

  useEffect(() => {
    Animated.timing(allDayHeight, {
      toValue: targetAllDayHeight,
      duration: 100,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [allDayHeight, targetAllDayHeight]);

  useEffect(() => {
    if (
      !active
      || viewportHeight <= 0
      || positionedDateRef.current === selectedKey
    ) return;
    const firstStart = timelineEvents[0]?.start;
    const focusMinutes = isSameDay(date, now)
      ? now.getHours() * 60 + now.getMinutes()
      : firstStart ?? 8 * 60;
    const focusY = TOP_SPACE + (focusMinutes / 60) * HOUR_HEIGHT;
    const maxScroll = Math.max(0, DAY_CANVAS_HEIGHT - viewportHeight);
    const target = Math.max(0, Math.min(maxScroll, focusY - viewportHeight / 2));
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: target, animated: false });
      positionedDateRef.current = selectedKey;
    });
    return () => cancelAnimationFrame(frame);
    // Event refreshes must not move a timeline the user has already positioned.
    // The latest events are intentionally read only when a date first becomes active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selectedKey, viewportHeight]);

  const onTimelineLayout = (event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height);
    if (viewportHeight > 0 && viewportHeight !== height) clearQuickSlot();
    setViewportHeight(current => current === height ? current : height);
  };

  const openEvent = (event: CalEvent) => {
    clearQuickSlot();
    const key = `${event.id}:${event.startDate}:${event.startTime ?? ''}`;
    if (longPressConsumedRef.current === key) {
      longPressConsumedRef.current = null;
      return;
    }
    const actionTime = Date.now();
    const elapsed = actionTime - (lastOpenRef.current?.at ?? actionTime);
    if (
      lastOpenRef.current?.key === key
      && elapsed >= 0
      && elapsed < REPEAT_ACTION_GUARD_MS
    ) return;
    lastOpenRef.current = { key, at: actionTime };
    onOpenEvent(event);
  };

  const selectQuickSlot = (start: number) => {
    updateQuickSlot({ start, end: start + QUICK_CREATE_MINUTES });
  };

  const createFromQuickSlot = useCallback((slot: { start: number; end: number }) => {
    const actionKey = `${selectedKey}:${slot.start}:${slot.end}`;
    const actionTime = Date.now();
    const elapsed = actionTime - (lastCreateRef.current?.at ?? actionTime);
    if (
      lastCreateRef.current?.key === actionKey
      && elapsed >= 0
      && elapsed < REPEAT_ACTION_GUARD_MS
    ) return;

    lastCreateRef.current = { key: actionKey, at: actionTime };
    clearQuickSlot();
    const endDayOffset = Math.floor(slot.end / DAY_MINUTES);
    const endMinute = slot.end % DAY_MINUTES;
    try {
      onCreate(
        date,
        minutesToTime(slot.start),
        addDays(date, endDayOffset),
        minutesToTime(endMinute),
      );
    } catch (error) {
      lastCreateRef.current = null;
      throw error;
    }
  }, [clearQuickSlot, date, onCreate, selectedKey]);

  const canEditTimelineItem = useCallback((item: TimelineEvent) => (
    Boolean(onChangeEventTime)
    && item.event.startDate === selectedKey
    && (!item.event.endDate || item.event.endDate === selectedKey)
    && item.end > item.start
  ), [onChangeEventTime, selectedKey]);

  const startTimelineEdit = useCallback((item: TimelineEvent) => {
    if (!active || !canEditTimelineItem(item)) return;
    clearQuickSlot();
    longPressConsumedRef.current = `${item.event.id}:${item.event.startDate}:${item.event.startTime ?? ''}`;
    updateEditPreview({
      event: item.event,
      start: item.start,
      end: item.end,
      original: { start: item.start, end: item.end },
      saving: false,
    });
  }, [active, canEditTimelineItem, clearQuickSlot, updateEditPreview]);

  const beginTimelineGesture = useCallback((kind: TimelineEditKind) => {
    const current = editPreviewRef.current;
    if (!current || current.saving) return;
    editGestureRef.current = {
      kind,
      original: { start: current.start, end: current.end },
      scrollStart: timelineScrollYRef.current,
    };
  }, []);

  const moveTimelineGesture = useCallback((dy: number, moveY: number) => {
    const current = editPreviewRef.current;
    const gesture = editGestureRef.current;
    if (!current || current.saving || !gesture) return;

    const edgeStep = timelineEdgeScrollStep(moveY, screenHeight);
    if (edgeStep !== 0 && viewportHeight > 0) {
      const maxScroll = Math.max(0, DAY_CANVAS_HEIGHT - viewportHeight);
      const nextScroll = Math.max(0, Math.min(maxScroll, timelineScrollYRef.current + edgeStep));
      if (nextScroll !== timelineScrollYRef.current) {
        timelineScrollYRef.current = nextScroll;
        scrollRef.current?.scrollTo({ y: nextScroll, animated: false });
      }
    }

    const projected = projectTimelineEdit({
      kind: gesture.kind,
      original: gesture.original,
      deltaPixels: dy + timelineScrollYRef.current - gesture.scrollStart,
      pixelsPerMinute: HOUR_HEIGHT / 60,
    });
    updateEditPreview({ ...current, ...projected });
  }, [screenHeight, updateEditPreview, viewportHeight]);

  const commitTimelineEdit = useCallback(async () => {
    const current = editPreviewRef.current;
    editGestureRef.current = null;
    if (!current || current.saving || !onChangeEventTime) return;
    if (current.start === current.original.start && current.end === current.original.end) return;

    const pending = { ...current, saving: true };
    updateEditPreview(pending);
    let applied = false;
    try {
      applied = await onChangeEventTime(current.event, {
        startDate: selectedKey,
        endDate: current.event.endDate === undefined ? undefined : selectedKey,
        startTime: minutesToTime(current.start),
        endTime: minutesToTime(current.end),
      });
    } catch {
      applied = false;
    }

    if (editPreviewRef.current !== pending) return;
    // The source event remains unchanged until the repository confirms the write,
    // so clearing the preview is also the deterministic failure rollback.
    updateEditPreview(null);
    longPressConsumedRef.current = null;
    if (!applied) return;
  }, [onChangeEventTime, selectedKey, updateEditPreview]);

  const terminateTimelineGesture = useCallback(() => {
    const current = editPreviewRef.current;
    const gesture = editGestureRef.current;
    editGestureRef.current = null;
    if (!current || !gesture || current.saving) return;
    updateEditPreview({ ...current, ...gesture.original });
  }, [updateEditPreview]);

  const nudgeTimelineEdit = useCallback((kind: TimelineEditKind, minutes: number) => {
    const current = editPreviewRef.current;
    if (!current || current.saving) return;
    const projected = projectTimelineEdit({
      kind,
      original: { start: current.start, end: current.end },
      deltaPixels: minutes * (HOUR_HEIGHT / 60),
      pixelsPerMinute: HOUR_HEIGHT / 60,
    });
    updateEditPreview({ ...current, ...projected });
  }, [updateEditPreview]);

  const beginQuickGesture = useCallback((kind: TimelineEditKind) => {
    const current = quickSlotRef.current;
    if (!current) return;
    quickGestureRef.current = {
      kind,
      original: current,
      scrollStart: timelineScrollYRef.current,
      moved: false,
    };
  }, []);

  const moveQuickGesture = useCallback((dy: number, moveY: number) => {
    const gesture = quickGestureRef.current;
    if (!gesture) return;
    if (Math.abs(dy) > 2) gesture.moved = true;

    const edgeStep = timelineEdgeScrollStep(moveY, screenHeight);
    if (edgeStep !== 0 && viewportHeight > 0) {
      const maxScroll = Math.max(0, DAY_CANVAS_HEIGHT - viewportHeight);
      const nextScroll = Math.max(0, Math.min(maxScroll, timelineScrollYRef.current + edgeStep));
      if (nextScroll !== timelineScrollYRef.current) {
        timelineScrollYRef.current = nextScroll;
        scrollRef.current?.scrollTo({ y: nextScroll, animated: false });
      }
    }

    updateQuickSlot(projectTimelineEdit({
      kind: gesture.kind,
      original: gesture.original,
      deltaPixels: dy + timelineScrollYRef.current - gesture.scrollStart,
      pixelsPerMinute: HOUR_HEIGHT / 60,
      snapIntervalMinutes: QUICK_CREATE_SNAP_MINUTES,
      minDurationMinutes: QUICK_CREATE_MINUTES,
    }));
  }, [screenHeight, updateQuickSlot, viewportHeight]);

  const finishQuickGesture = useCallback((kind: TimelineEditKind) => {
    const gesture = quickGestureRef.current;
    const current = quickSlotRef.current;
    quickGestureRef.current = null;
    if (kind === 'move' && gesture && !gesture.moved && current) {
      createFromQuickSlot(current);
    }
  }, [createFromQuickSlot]);

  const terminateQuickGesture = useCallback(() => {
    const gesture = quickGestureRef.current;
    quickGestureRef.current = null;
    if (gesture) updateQuickSlot(gesture.original);
  }, [updateQuickSlot]);

  const makeQuickResponder = useCallback((kind: TimelineEditKind) => PanResponder.create({
    onStartShouldSetPanResponder: () => active && Boolean(quickSlotRef.current),
    onMoveShouldSetPanResponder: (_event, gesture) => (
      Boolean(quickSlotRef.current) && Math.abs(gesture.dy) > 2
    ),
    onPanResponderGrant: () => beginQuickGesture(kind),
    onPanResponderMove: (_event, gesture) => moveQuickGesture(gesture.dy, gesture.moveY),
    onPanResponderRelease: () => finishQuickGesture(kind),
    onPanResponderTerminate: terminateQuickGesture,
    onPanResponderTerminationRequest: () => false,
  }), [active, beginQuickGesture, finishQuickGesture, moveQuickGesture, terminateQuickGesture]);
  const quickMoveResponder = useMemo(
    () => makeQuickResponder('move'),
    [makeQuickResponder],
  );
  const quickStartResponder = useMemo(
    () => makeQuickResponder('resize-start'),
    [makeQuickResponder],
  );
  const quickEndResponder = useMemo(
    () => makeQuickResponder('resize-end'),
    [makeQuickResponder],
  );

  const makeTimelineResponder = useCallback((kind: TimelineEditKind) => PanResponder.create({
    onStartShouldSetPanResponder: () => kind !== 'move' && Boolean(editPreviewRef.current),
    onMoveShouldSetPanResponder: (_event, gesture) => (
      Boolean(editPreviewRef.current)
      && Math.abs(gesture.dy) > 2
    ),
    onPanResponderGrant: () => beginTimelineGesture(kind),
    onPanResponderMove: (_event, gesture) => moveTimelineGesture(gesture.dy, gesture.moveY),
    onPanResponderRelease: () => { void commitTimelineEdit(); },
    onPanResponderTerminate: terminateTimelineGesture,
    onPanResponderTerminationRequest: () => false,
  }), [beginTimelineGesture, commitTimelineEdit, moveTimelineGesture, terminateTimelineGesture]);
  const moveTimelineResponder = useMemo(
    () => makeTimelineResponder('move'),
    [makeTimelineResponder],
  );
  const resizeStartResponder = useMemo(
    () => makeTimelineResponder('resize-start'),
    [makeTimelineResponder],
  );
  const resizeEndResponder = useMemo(
    () => makeTimelineResponder('resize-end'),
    [makeTimelineResponder],
  );

  const shiftByAccessibility = (event: { nativeEvent: { actionName: string } }) => {
    if (event.nativeEvent.actionName === 'decrement') onDateChange(addDays(date, -1));
    if (event.nativeEvent.actionName === 'increment') onDateChange(addDays(date, 1));
  };

  return (
    <View
      style={[s.page, { width }]}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      <View key="day-header" style={s.dayHeader} accessible={false}>
        <View style={s.timeZoneHeader}>
          <Text style={s.timeZoneText}>{timeZoneLabel(date)}</Text>
        </View>
        <View style={s.weekStrip}>
          {weekDates.map((weekDate, index) => {
            const selected = isSameDay(weekDate, date);
            const current = isSameDay(weekDate, today);
            return (
              <TouchableOpacity
                key={dateKey(weekDate)}
                style={s.weekDay}
                onPress={() => {
                  clearQuickSlot();
                  onDateChange(weekDate);
                }}
                disabled={!active}
                activeOpacity={0.68}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled: !active }}
                accessibilityLabel={`${weekDate.getMonth() + 1}月${weekDate.getDate()}日，周${WEEKDAYS[index]}${current ? '，今天' : ''}`}
                accessibilityHint={selected ? '使用调整操作切换前后一天' : '双击切换到这一天'}
                accessibilityActions={selected ? [
                  { name: 'decrement', label: '前一天' },
                  { name: 'increment', label: '后一天' },
                ] : undefined}
                onAccessibilityAction={selected ? shiftByAccessibility : undefined}
                testID={active ? `day-header-${dateKey(weekDate)}` : undefined}
              >
                <Text style={[
                  s.weekName,
                  current && s.weekNameToday,
                  selected && s.weekNameSelected,
                ]}>
                  {WEEKDAYS[index]}
                </Text>
                <View style={[
                  s.weekNumberCircle,
                  selected && current && s.weekNumberCircleToday,
                  selected && !current && s.weekNumberCircleSelected,
                ]}>
                  <Text style={[
                    s.weekNumber,
                    current && !selected && s.weekNumberToday,
                    selected && current && s.weekNumberSelectedToday,
                    selected && !current && s.weekNumberSelected,
                  ]}>
                    {weekDate.getDate()}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {allDayEvents.length > 0 ? (
        <View key="all-day-row" style={s.allDayRow} accessible={false}>
          <View style={s.allDayLabelLane}>
            <Text style={s.allDayLabel}>全天</Text>
          </View>
          <Animated.View style={[s.allDayViewport, { height: allDayHeight }]}>
            <ScrollView
              ref={allDayScrollRef}
              showsVerticalScrollIndicator={false}
              scrollEnabled={allDayExpanded && allDayEvents.length > ALL_DAY_MAX_EXPANDED_ROWS}
              nestedScrollEnabled
              contentOffset={{ x: 0, y: Math.min(allDayScrollY, allDayMaxScroll) }}
              onScroll={event => {
                if (!active || !allDayExpanded) return;
                onAllDayScrollChange(Math.max(0, Math.min(
                  event.nativeEvent.contentOffset.y,
                  allDayMaxScroll,
                )));
              }}
              scrollEventThrottle={16}
              testID={active ? 'all-day-scroll' : undefined}
            >
              {(allDayExpanded || allDayEvents.length <= ALL_DAY_COLLAPSED_ROWS
                ? allDayEvents
                : allDayEvents.slice(0, ALL_DAY_COLLAPSED_ROWS - 1)
              ).map(event => (
                <TouchableOpacity
                  key={event.id}
                  style={[s.allDayChip, {
                    backgroundColor: fillColorForEventCategory(event.category),
                    borderLeftColor: colorForEventCategory(event.category),
                  }]}
                  onPress={() => openEvent(event)}
                  disabled={!active}
                  activeOpacity={0.72}
                  accessibilityRole="button"
                  accessible={active}
                  accessibilityState={{ disabled: !active }}
                  accessibilityLabel={`${eventListTitle(event.title)}，全天`}
                  accessibilityHint="双击查看日程详情"
                >
                  <Text
                    style={[s.allDayTitle, { color: textColorForEventCategory(event.category) }]}
                    numberOfLines={1}
                    accessible={false}
                  >
                    {eventListTitle(event.title)}
                  </Text>
                </TouchableOpacity>
              ))}
              {!allDayExpanded && allDayEvents.length > ALL_DAY_COLLAPSED_ROWS ? (
                <TouchableOpacity
                  style={s.allDayMoreRow}
                  onPress={() => onAllDayExpandedChange(true)}
                  disabled={!active}
                  accessibilityRole="button"
                  accessible={active}
                  accessibilityState={{ disabled: !active }}
                  accessibilityLabel={`展开其余${allDayEvents.length - (ALL_DAY_COLLAPSED_ROWS - 1)}项全天日程`}
                >
                  <Text style={s.allDayMoreText} accessible={false}>
                    还有 {allDayEvents.length - (ALL_DAY_COLLAPSED_ROWS - 1)} 项
                  </Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          </Animated.View>
          {allDayEvents.length > ALL_DAY_COLLAPSED_ROWS ? (
            <TouchableOpacity
              style={s.allDayExpandButton}
              onPress={() => onAllDayExpandedChange(!allDayExpanded)}
              disabled={!active}
              accessibilityRole="button"
              accessible={active}
              accessibilityLabel={allDayExpanded ? '收起全天日程' : '展开全天日程'}
              accessibilityState={{ expanded: allDayExpanded, disabled: !active }}
              testID={active ? 'all-day-expand-toggle' : undefined}
            >
              <Ionicons
                name={allDayExpanded ? 'chevron-up' : 'chevron-down'}
                size={12}
                color={C.sub}
                accessible={false}
              />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <ScrollView
        key="timeline-scroll"
        ref={scrollRef}
        style={s.timelineScroll}
        contentContainerStyle={s.timelineContent}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        onLayout={onTimelineLayout}
        onScrollBeginDrag={clearQuickSlot}
        onScroll={event => {
          timelineScrollYRef.current = Math.max(0, event.nativeEvent.contentOffset.y);
        }}
        scrollEventThrottle={16}
        scrollEnabled={active && !editPreview}
        accessible={false}
        testID={active ? 'day-timeline-scroll' : undefined}
      >
        <View style={s.timelineGrid}>
          {Array.from({ length: 25 }, (_, hour) => (
            <React.Fragment key={hour}>
              <Text
                style={[s.hourLabel, { top: TOP_SPACE + hour * HOUR_HEIGHT - 8 }]}
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no"
                testID={active ? `day-hour-${String(hour).padStart(2, '0')}` : undefined}
              >
                {formatTimelineHourLabel(hour)}
              </Text>
              <View
                style={[s.hourDivider, { top: TOP_SPACE + hour * HOUR_HEIGHT }]}
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            </React.Fragment>
          ))}

          {Array.from({ length: 48 }, (_, slot) => {
            const start = slot * 30;
            const end = start + QUICK_CREATE_MINUTES;
            const selected = Boolean(
              quickSlot && start >= quickSlot.start && start < quickSlot.end,
            );
            return (
              <TouchableOpacity
                key={slot}
                style={[s.halfHourSlot, { top: TOP_SPACE + (start / 60) * HOUR_HEIGHT }]}
                onPress={() => selectQuickSlot(start)}
                disabled={!active}
                activeOpacity={1}
                accessibilityRole="button"
                accessible={active && !selected}
                accessibilityElementsHidden={!active || selected}
                importantForAccessibility={active && !selected ? 'yes' : 'no-hide-descendants'}
                accessibilityState={{ disabled: !active }}
                accessibilityLabel={`${formatTimelineRange(start, end)}，空白时段`}
                accessibilityHint="双击选择半小时时段"
                testID={active ? `day-slot-${minutesToTime(start)}` : undefined}
              />
            );
          })}

          {quickSlot ? (
            <>
              <Text
                style={[
                  s.quickTimeLabel,
                  { top: TOP_SPACE + (quickSlot.start / 60) * HOUR_HEIGHT - 8 },
                ]}
                pointerEvents="none"
                accessible={false}
                testID={active ? 'day-quick-start-label' : undefined}
              >
                {formatTimelineTime(quickSlot.start)}
              </Text>
              <Text
                style={[
                  s.quickTimeLabel,
                  { top: TOP_SPACE + (quickSlot.end / 60) * HOUR_HEIGHT - 8 },
                ]}
                pointerEvents="none"
                accessible={false}
                testID={active ? 'day-quick-end-label' : undefined}
              >
                {formatTimelineTime(quickSlot.end)}
              </Text>
              <View
                style={[
                  s.quickCreateBlock,
                  {
                    top: TOP_SPACE + (quickSlot.start / 60) * HOUR_HEIGHT,
                    height: Math.max(
                      25,
                      ((Math.min(quickSlot.end, DAY_MINUTES) - quickSlot.start) / 60) * HOUR_HEIGHT,
                    ),
                  },
                ]}
                accessibilityRole="button"
                accessible={active}
                accessibilityState={{ disabled: !active }}
                accessibilityLabel={`${formatTimelineRange(quickSlot.start, quickSlot.end)}，添加日程`}
                accessibilityHint="双击打开日程编辑，拖动可调整时段"
                accessibilityActions={[{ name: 'activate', label: '添加日程' }]}
                onAccessibilityTap={() => createFromQuickSlot(quickSlot)}
                onAccessibilityAction={event => {
                  if (event.nativeEvent.actionName === 'activate') {
                    createFromQuickSlot(quickSlot);
                  }
                }}
                testID={active ? 'day-quick-create' : undefined}
                {...quickMoveResponder.panHandlers}
              >
                <Text style={s.quickCreateText} accessible={false}>添加日程</Text>
                <View
                  style={[s.quickHandleTouch, s.quickHandleStartTouch]}
                  accessible={false}
                  testID={active ? 'day-quick-start-handle' : undefined}
                  {...quickStartResponder.panHandlers}
                >
                  <View style={s.quickHandleDot} />
                </View>
                <View
                  style={[s.quickHandleTouch, s.quickHandleEndTouch]}
                  accessible={false}
                  testID={active ? 'day-quick-end-handle' : undefined}
                  {...quickEndResponder.panHandlers}
                >
                  <View style={s.quickHandleDot} />
                </View>
              </View>
            </>
          ) : null}

          {timelineEvents.map(item => {
            const selectedEdit = editPreview?.event.id === item.event.id ? editPreview : null;
            const columnGap = 2;
            const eventWidth = (availableWidth - columnGap * Math.max(0, item.columns - 1)) / item.columns;
            const displayWidth = eventWidth * item.columnSpan + columnGap * (item.columnSpan - 1);
            const displayStart = selectedEdit?.start ?? item.start;
            const displayEnd = selectedEdit?.end ?? item.end;
            const top = TOP_SPACE + (displayStart / 60) * HOUR_HEIGHT;
            const height = Math.max(24, ((displayEnd - displayStart) / 60) * HOUR_HEIGHT - 1);
            return (
              <TouchableOpacity
                key={item.event.id}
                style={[
                  s.timelineEvent,
                  selectedEdit && s.timelineEventEditing,
                  {
                    backgroundColor: fillColorForEventCategory(item.event.category),
                    borderLeftColor: colorForEventCategory(item.event.category),
                    borderColor: colorForEventCategory(item.event.category),
                    top,
                    height,
                    left: TIME_GUTTER + 3 + item.column * (eventWidth + columnGap),
                    width: displayWidth,
                    zIndex: selectedEdit ? 50 : item.zIndex,
                  },
                ]}
                onPress={() => {
                  if (selectedEdit) return;
                  openEvent(item.event);
                }}
                onLongPress={() => startTimelineEdit(item)}
                delayLongPress={320}
                disabled={!active}
                activeOpacity={selectedEdit ? 1 : 0.74}
                accessibilityRole={selectedEdit ? 'adjustable' : 'button'}
                accessible={active}
                accessibilityState={{ disabled: !active, busy: Boolean(selectedEdit?.saving) }}
                accessibilityLabel={`${eventListTitle(item.event.title)}，${formatTimelineRange(displayStart, displayEnd)}`}
                accessibilityHint={selectedEdit
                  ? '上下调整移动十五分钟，确认保存，取消恢复原时间'
                  : onChangeEventTime && canEditTimelineItem(item)
                    ? '双击查看详情，可用调整时间操作编辑'
                    : '双击查看日程详情'}
                accessibilityActions={selectedEdit ? [
                  { name: 'decrement', label: '提前十五分钟' },
                  { name: 'increment', label: '推迟十五分钟' },
                  { name: 'activate', label: '保存时间' },
                  { name: 'escape', label: '取消调整' },
                ] : onChangeEventTime && canEditTimelineItem(item) ? [
                  { name: 'edit', label: '调整时间' },
                ] : undefined}
                onAccessibilityAction={event => {
                  const action = event.nativeEvent.actionName;
                  if (action === 'edit') startTimelineEdit(item);
                  if (action === 'decrement') nudgeTimelineEdit('move', -15);
                  if (action === 'increment') nudgeTimelineEdit('move', 15);
                  if (action === 'activate') { void commitTimelineEdit(); }
                  if (action === 'escape') cancelTimelineEdit();
                }}
                testID={active ? `timeline-event-${item.event.id}` : undefined}
                {...(selectedEdit ? moveTimelineResponder.panHandlers : {})}
              >
                <Text
                  style={[s.timelineEventTitle, { color: textColorForEventCategory(item.event.category) }]}
                  numberOfLines={height < 39 ? 1 : 2}
                  accessible={false}
                >
                  {eventListTitle(item.event.title)}
                </Text>
                {height >= 39 ? (
                  <Text
                    style={[s.timelineEventTime, { color: textColorForEventCategory(item.event.category) }]}
                    numberOfLines={1}
                    accessible={false}
                  >
                    {formatTimelineRange(displayStart, displayEnd, ' - ')}
                  </Text>
                ) : null}
                {selectedEdit ? (
                  <>
                    <View
                      style={[s.timelineResizeHandle, s.timelineResizeHandleTop]}
                      accessible={active}
                      accessibilityRole="adjustable"
                      accessibilityLabel="调整日程开始时间"
                      accessibilityActions={[
                        { name: 'decrement', label: '开始时间提前十五分钟' },
                        { name: 'increment', label: '开始时间推迟十五分钟' },
                      ]}
                      onAccessibilityAction={event => {
                        nudgeTimelineEdit(
                          'resize-start',
                          event.nativeEvent.actionName === 'decrement' ? -15 : 15,
                        );
                      }}
                      testID={active ? `timeline-resize-start-${item.event.id}` : undefined}
                      {...resizeStartResponder.panHandlers}
                    >
                      <View style={s.timelineResizeKnob} />
                    </View>
                    <View
                      style={[s.timelineResizeHandle, s.timelineResizeHandleBottom]}
                      accessible={active}
                      accessibilityRole="adjustable"
                      accessibilityLabel="调整日程结束时间"
                      accessibilityActions={[
                        { name: 'decrement', label: '结束时间提前十五分钟' },
                        { name: 'increment', label: '结束时间推迟十五分钟' },
                      ]}
                      onAccessibilityAction={event => {
                        nudgeTimelineEdit(
                          'resize-end',
                          event.nativeEvent.actionName === 'decrement' ? -15 : 15,
                        );
                      }}
                      testID={active ? `timeline-resize-end-${item.event.id}` : undefined}
                      {...resizeEndResponder.panHandlers}
                    >
                      <View style={s.timelineResizeKnob} />
                    </View>
                    {selectedEdit.saving ? (
                      <View style={s.timelineSaving} pointerEvents="none">
                        <ActivityIndicator size="small" color={C.primary} />
                      </View>
                    ) : null}
                  </>
                ) : null}
              </TouchableOpacity>
            );
          })}

          {isSameDay(date, now) ? <CurrentTimeLine now={now} /> : null}
        </View>
      </ScrollView>
    </View>
  );
}

function CurrentTimeLine({ now }: { now: Date }) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return (
    <View
      style={[s.currentLine, { top: TOP_SPACE + (minutes / 60) * HOUR_HEIGHT - 3.5 }]}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={s.currentDot} />
      <View style={s.currentRule} />
    </View>
  );
}

export function formatTimelineTime(minutes: number): string {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const dayOffset = Math.floor(safeMinutes / DAY_MINUTES);
  const minuteOfDay = safeMinutes % DAY_MINUTES;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  if (safeMinutes === DAY_MINUTES) return '24:00';
  const prefix = dayOffset > 0 ? '次日' : '';
  return `${prefix}${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function formatTimelineHourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function formatTimelineRange(
  start: number,
  end: number,
  separator = '至',
): string {
  return `${formatTimelineTime(start)}${separator}${formatTimelineTime(end)}`;
}

export { sortAllDayEvents } from '../utils/eventAllDay';
export { layoutTimelineEvents } from '../utils/dayTimelineLayout';

function timeZoneLabel(date: Date): string {
  const totalMinutes = -new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    12,
  ).getTimezoneOffset();
  const sign = totalMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(totalMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `GMT${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

const s = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: C.body },
  page: { height: '100%', backgroundColor: C.body },
  dayHeader: {
    height: DAY_HEADER_HEIGHT,
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.divider,
    backgroundColor: C.body,
  },
  timeZoneHeader: { width: TIME_GUTTER, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 5 },
  timeZoneText: { fontSize: 9, lineHeight: 12, color: C.faint },
  weekStrip: { flex: 1, flexDirection: 'row' },
  weekDay: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  weekName: { height: 17, fontSize: 12, lineHeight: 17, color: C.sub },
  weekNameToday: { color: C.primary },
  weekNameSelected: { color: C.primary },
  weekNumberCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  weekNumberCircleToday: { backgroundColor: C.primary },
  weekNumberCircleSelected: { backgroundColor: C.border },
  weekNumber: { fontSize: 16, lineHeight: 21, color: C.text },
  weekNumberToday: { color: C.primary },
  weekNumberSelectedToday: { color: '#FFFFFF' },
  weekNumberSelected: { color: C.faint },
  allDayRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.divider,
  },
  allDayLabelLane: { width: TIME_GUTTER, height: ALL_DAY_ITEM_HEIGHT, justifyContent: 'center' },
  allDayLabel: { paddingRight: 7, textAlign: 'right', fontSize: 10, color: C.sub },
  allDayViewport: { flex: 1, overflow: 'hidden' },
  allDayChip: {
    height: ALL_DAY_ITEM_HEIGHT,
    justifyContent: 'center',
    backgroundColor: C.primaryLight,
    borderLeftWidth: 2,
    borderLeftColor: C.primary,
    borderRadius: 2,
    paddingHorizontal: 5,
    marginRight: 3,
  },
  allDayTitle: { fontSize: 11, color: C.primaryPressed },
  allDayMoreRow: {
    height: ALL_DAY_ITEM_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 7,
    marginRight: 3,
    backgroundColor: C.inputBg,
  },
  allDayMoreText: { fontSize: 11, lineHeight: 16, color: C.sub },
  allDayExpandButton: {
    width: 24,
    height: ALL_DAY_ITEM_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timelineScroll: { flex: 1 },
  timelineContent: { minHeight: DAY_CANVAS_HEIGHT },
  timelineGrid: { height: DAY_CANVAS_HEIGHT, position: 'relative' },
  hourLabel: {
    position: 'absolute',
    left: 0,
    width: TIME_GUTTER,
    height: 16,
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 16,
    color: C.faint,
  },
  quickTimeLabel: {
    position: 'absolute',
    left: 0,
    width: TIME_GUTTER,
    height: 16,
    zIndex: 8,
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 16,
    color: C.primary,
    backgroundColor: C.body,
  },
  hourDivider: {
    position: 'absolute',
    left: TIME_GUTTER,
    right: 0,
    height: 0.5,
    backgroundColor: C.divider,
  },
  halfHourSlot: {
    position: 'absolute',
    left: TIME_GUTTER,
    right: 0,
    height: HOUR_HEIGHT / 2,
    zIndex: 1,
  },
  quickCreateBlock: {
    position: 'absolute',
    left: TIME_GUTTER,
    right: 3,
    zIndex: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0.5,
    borderColor: C.primary,
    borderRadius: 4,
    backgroundColor: withAlpha(C.primary, 0.15),
    overflow: 'visible',
  },
  quickCreateText: { fontSize: 13, lineHeight: 18, color: C.primary },
  quickHandleTouch: {
    position: 'absolute',
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9,
  },
  quickHandleStartTouch: { top: -16, right: '17%' },
  quickHandleEndTouch: { bottom: -16, left: '17%' },
  quickHandleDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: C.primary,
    backgroundColor: C.body,
  },
  timelineEvent: {
    position: 'absolute',
    zIndex: 4,
    backgroundColor: C.primaryLight,
    borderLeftWidth: 3,
    borderLeftColor: C.primary,
    borderRadius: 2,
    paddingHorizontal: 5,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  timelineEventEditing: {
    borderWidth: 1,
    borderColor: C.primary,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.16,
    shadowRadius: 5,
    elevation: 5,
  },
  timelineResizeHandle: {
    position: 'absolute',
    left: 3,
    right: 0,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
  },
  timelineResizeHandleTop: { top: 0 },
  timelineResizeHandleBottom: { bottom: 0 },
  timelineResizeKnob: {
    width: 28,
    height: 3,
    borderRadius: 2,
    backgroundColor: C.primary,
  },
  timelineSaving: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(C.body, 0.72),
    zIndex: 4,
  },
  timelineEventTitle: { fontSize: 12, lineHeight: 16, color: C.primaryPressed },
  timelineEventTime: { fontSize: 10, lineHeight: 14, color: C.primaryPressed },
  currentLine: { position: 'absolute', left: TIME_GUTTER - 3.5, right: 0, height: 7, zIndex: 5, flexDirection: 'row', alignItems: 'center' },
  currentDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: C.red },
  currentRule: { flex: 1, height: 1, backgroundColor: C.red },
});
