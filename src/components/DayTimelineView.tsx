import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import type { CalEvent } from '../types';
import { selectTasksForDate } from '../utils/taskOrdering';
import {
  addDays,
  dateKey,
  isSameDay,
  minutesToTime,
  sundayStartOfWeek,
  timeToMinutes,
} from '../utils/calendarDate';

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
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

type TimelineEvent = {
  event: CalEvent;
  start: number;
  end: number;
  column: number;
  columns: number;
};

export function DayTimelineView({
  date,
  events,
  onDateChange,
  onOpenEvent,
  onCreate,
}: {
  date: Date;
  events: CalEvent[];
  onDateChange: (date: Date) => void;
  onOpenEvent: (event: CalEvent) => void;
  onCreate: (startDate: Date, startTime: string, endDate: Date, endTime: string) => void;
}) {
  const { width } = useWindowDimensions();
  const [now, setNow] = useState(() => new Date());
  const pagerRef = useRef<ScrollView | null>(null);
  const dayGestureActive = useRef(false);
  const dayGestureHandled = useRef(false);
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

  const shiftByAccessibility = (event: { nativeEvent: { actionName: string } }) => {
    if (event.nativeEvent.actionName === 'decrement') onDateChange(addDays(date, -1));
    if (event.nativeEvent.actionName === 'increment') onDateChange(addDays(date, 1));
  };

  return (
    <View
      style={s.root}
      accessibilityRole="adjustable"
      accessibilityLabel={`单日视图，${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`}
      accessibilityHint="左右滑动切换日期"
      accessibilityActions={[
        { name: 'decrement', label: '前一天' },
        { name: 'increment', label: '后一天' },
      ]}
      onAccessibilityAction={shiftByAccessibility}
    >
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        bounces={false}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        contentOffset={{ x: pageWidth, y: 0 }}
        onScrollBeginDrag={() => {
          dayGestureActive.current = true;
          dayGestureHandled.current = false;
        }}
        onMomentumScrollEnd={settleDate}
        scrollEventThrottle={16}
        testID="day-view-pager"
      >
        {dates.map((pageDate, index) => (
          <DayPage
            key={`${dateKey(pageDate)}-${index}`}
            date={pageDate}
            width={pageWidth}
            events={events}
            active={index === 1}
            onDateChange={onDateChange}
            onOpenEvent={onOpenEvent}
            onCreate={onCreate}
            now={now}
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
  now,
}: {
  date: Date;
  width: number;
  events: CalEvent[];
  active: boolean;
  onDateChange: (date: Date) => void;
  onOpenEvent: (event: CalEvent) => void;
  onCreate: (startDate: Date, startTime: string, endDate: Date, endTime: string) => void;
  now: Date;
}) {
  const scrollRef = useRef<ScrollView | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [quickSlot, setQuickSlot] = useState<{ start: number; end: number } | null>(null);
  const [allDayExpanded, setAllDayExpanded] = useState(false);
  const allDayHeight = useRef(new Animated.Value(0)).current;
  const today = now;
  const selectedKey = dateKey(date);
  const selectedEvents = useMemo(
    () => selectTasksForDate(events, selectedKey).filter(event => eventOccupiesDate(event, selectedKey)),
    [events, selectedKey],
  );
  const allDayEvents = useMemo(
    () => selectedEvents.filter(eventShowsAsAllDay),
    [selectedEvents],
  );
  const timelineEvents = useMemo(
    () => layoutTimelineEvents(selectedEvents, selectedKey),
    [selectedEvents, selectedKey],
  );
  const weekStart = sundayStartOfWeek(date);
  const weekDates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const availableWidth = Math.max(180, width - TIME_GUTTER - 6);

  useEffect(() => {
    setQuickSlot(null);
    setAllDayExpanded(false);
  }, [selectedKey]);

  const collapsedAllDayCount = allDayEvents.length > ALL_DAY_COLLAPSED_ROWS
    ? ALL_DAY_COLLAPSED_ROWS
    : allDayEvents.length;
  const targetAllDayHeight = (
    allDayExpanded
      ? Math.min(allDayEvents.length, ALL_DAY_MAX_EXPANDED_ROWS)
      : collapsedAllDayCount
  ) * ALL_DAY_ITEM_HEIGHT;

  useEffect(() => {
    Animated.timing(allDayHeight, {
      toValue: targetAllDayHeight,
      duration: 100,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [allDayHeight, targetAllDayHeight]);

  useEffect(() => {
    if (!active || viewportHeight <= 0) return;
    const firstStart = timelineEvents[0]?.start;
    const focusMinutes = isSameDay(date, now)
      ? now.getHours() * 60 + now.getMinutes()
      : firstStart ?? 8 * 60;
    const focusY = TOP_SPACE + (focusMinutes / 60) * HOUR_HEIGHT;
    const maxScroll = Math.max(0, DAY_CANVAS_HEIGHT - viewportHeight);
    const target = Math.max(0, Math.min(maxScroll, focusY - viewportHeight / 2));
    const frame = requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: target, animated: false }));
    return () => cancelAnimationFrame(frame);
  }, [active, date, selectedKey, timelineEvents, viewportHeight]);

  const onTimelineLayout = (event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height);
    setViewportHeight(current => current === height ? current : height);
  };

  return (
    <View
      style={[s.page, { width }]}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      <View style={s.dayHeader}>
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
                onPress={() => onDateChange(weekDate)}
                disabled={!active}
                activeOpacity={0.68}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled: !active }}
                accessibilityLabel={`${weekDate.getMonth() + 1}月${weekDate.getDate()}日，周${WEEKDAYS[index]}${current ? '，今天' : ''}`}
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
        <View style={s.allDayRow}>
          <View style={s.allDayLabelLane}>
            <Text style={s.allDayLabel}>全天</Text>
          </View>
          <Animated.View style={[s.allDayViewport, { height: allDayHeight }]}>
            <ScrollView
              showsVerticalScrollIndicator={false}
              scrollEnabled={allDayExpanded && allDayEvents.length > ALL_DAY_MAX_EXPANDED_ROWS}
              nestedScrollEnabled
            >
              {(allDayExpanded || allDayEvents.length <= ALL_DAY_COLLAPSED_ROWS
                ? allDayEvents
                : allDayEvents.slice(0, ALL_DAY_COLLAPSED_ROWS - 1)
              ).map(event => (
                <TouchableOpacity
                  key={event.id}
                  style={s.allDayChip}
                  onPress={() => onOpenEvent(event)}
                  disabled={!active}
                  activeOpacity={0.72}
                  accessibilityRole="button"
                  accessibilityLabel={`${event.title}，全天`}
                >
                  <Text style={s.allDayTitle} numberOfLines={1}>{event.title}</Text>
                </TouchableOpacity>
              ))}
              {!allDayExpanded && allDayEvents.length > ALL_DAY_COLLAPSED_ROWS ? (
                <TouchableOpacity
                  style={s.allDayMoreRow}
                  onPress={() => setAllDayExpanded(true)}
                  disabled={!active}
                  accessibilityRole="button"
                  accessibilityLabel={`展开其余${allDayEvents.length - (ALL_DAY_COLLAPSED_ROWS - 1)}项全天日程`}
                >
                  <Text style={s.allDayMoreText}>
                    还有 {allDayEvents.length - (ALL_DAY_COLLAPSED_ROWS - 1)} 项
                  </Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          </Animated.View>
          {allDayEvents.length > ALL_DAY_COLLAPSED_ROWS ? (
            <TouchableOpacity
              style={s.allDayExpandButton}
              onPress={() => setAllDayExpanded(value => !value)}
              disabled={!active}
              accessibilityRole="button"
              accessibilityLabel={allDayExpanded ? '收起全天日程' : '展开全天日程'}
              accessibilityState={{ expanded: allDayExpanded }}
              testID={active ? 'all-day-expand-toggle' : undefined}
            >
              <Ionicons name={allDayExpanded ? 'chevron-up' : 'chevron-down'} size={12} color={C.sub} />
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={s.timelineScroll}
        contentContainerStyle={s.timelineContent}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        onLayout={onTimelineLayout}
        scrollEnabled={active}
        testID={active ? 'day-timeline-scroll' : undefined}
      >
        <View style={s.timelineGrid}>
          {Array.from({ length: 25 }, (_, hour) => (
            <React.Fragment key={hour}>
              <Text
                style={[s.hourLabel, { top: TOP_SPACE + hour * HOUR_HEIGHT - 8 }]}
                pointerEvents="none"
                testID={active ? `day-hour-${String(hour).padStart(2, '0')}` : undefined}
              >
                {`${String(hour).padStart(2, '0')}:00`}
              </Text>
              <View style={[s.hourDivider, { top: TOP_SPACE + hour * HOUR_HEIGHT }]} pointerEvents="none" />
            </React.Fragment>
          ))}

          {Array.from({ length: 48 }, (_, slot) => {
            const start = slot * 30;
            const end = start + 30;
            return (
              <TouchableOpacity
                key={slot}
                style={[s.halfHourSlot, { top: TOP_SPACE + (start / 60) * HOUR_HEIGHT }]}
                onPress={() => setQuickSlot({ start, end })}
                disabled={!active}
                activeOpacity={1}
                accessibilityRole="button"
                accessibilityLabel={`${minutesToTime(start)}，新建日程`}
                testID={active ? `day-slot-${minutesToTime(start)}` : undefined}
              />
            );
          })}

          {quickSlot ? (
            <TouchableOpacity
              style={[
                s.quickCreateBlock,
                {
                  top: TOP_SPACE + (quickSlot.start / 60) * HOUR_HEIGHT,
                  height: Math.max(25, ((quickSlot.end - quickSlot.start) / 60) * HOUR_HEIGHT),
                },
              ]}
              onPress={() => onCreate(
                date,
                minutesToTime(quickSlot.start),
                quickSlot.end === DAY_MINUTES ? addDays(date, 1) : date,
                quickSlot.end === DAY_MINUTES ? '00:00' : minutesToTime(quickSlot.end),
              )}
              disabled={!active}
              activeOpacity={0.72}
              accessibilityRole="button"
              accessibilityLabel={`${minutesToTime(quickSlot.start)}至${minutesToTime(quickSlot.end)}，新建日程`}
              testID={active ? 'day-quick-create' : undefined}
            >
              <Ionicons name="add" size={14} color={C.primary} />
              <Text style={s.quickCreateText}>新建日程</Text>
            </TouchableOpacity>
          ) : null}

          {timelineEvents.map(item => {
            const columnGap = 2;
            const eventWidth = (availableWidth - columnGap * Math.max(0, item.columns - 1)) / item.columns;
            const top = TOP_SPACE + (item.start / 60) * HOUR_HEIGHT;
            const height = Math.max(24, ((item.end - item.start) / 60) * HOUR_HEIGHT - 1);
            return (
              <TouchableOpacity
                key={item.event.id}
                style={[
                  s.timelineEvent,
                  {
                    top,
                    height,
                    left: TIME_GUTTER + 3 + item.column * (eventWidth + columnGap),
                    width: eventWidth,
                  },
                ]}
                onPress={() => onOpenEvent(item.event)}
                disabled={!active}
                activeOpacity={0.74}
                accessibilityRole="button"
                accessibilityLabel={`${item.event.title}，${minutesToTime(item.start)}至${minutesToTime(item.end)}`}
                testID={active ? `timeline-event-${item.event.id}` : undefined}
              >
                <Text style={s.timelineEventTitle} numberOfLines={height < 39 ? 1 : 2}>{item.event.title}</Text>
                {height >= 39 ? (
                  <Text style={s.timelineEventTime} numberOfLines={1}>
                    {minutesToTime(item.start)} - {minutesToTime(item.end)}
                  </Text>
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
    <View style={[s.currentLine, { top: TOP_SPACE + (minutes / 60) * HOUR_HEIGHT - 3.5 }]} pointerEvents="none">
      <View style={s.currentDot} />
      <View style={s.currentRule} />
    </View>
  );
}

export function layoutTimelineEvents(events: CalEvent[], selectedDate: string): TimelineEvent[] {
  const source = events
    .filter(event => !eventShowsAsAllDay(event) && Boolean(event.startTime))
    .map(event => {
      const range = eventRangeForDate(event, selectedDate);
      return range ? { event, ...range, column: 0, columns: 1 } : null;
    })
    .filter((item): item is TimelineEvent => item !== null)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const groups: TimelineEvent[][] = [];
  let group: TimelineEvent[] = [];
  let groupEnd = -1;
  source.forEach(item => {
    if (group.length > 0 && item.start >= groupEnd) {
      groups.push(group);
      group = [];
      groupEnd = -1;
    }
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  });
  if (group.length > 0) groups.push(group);

  groups.forEach(items => {
    const columnEnds: number[] = [];
    items.forEach(item => {
      let column = columnEnds.findIndex(end => end <= item.start);
      if (column < 0) column = columnEnds.length;
      columnEnds[column] = item.end;
      item.column = column;
    });
    const columns = Math.max(1, columnEnds.length);
    items.forEach(item => { item.columns = columns; });
  });

  return source;
}

function eventRangeForDate(event: CalEvent, selectedDate: string): { start: number; end: number } | null {
  const startTime = timeToMinutes(event.startTime);
  if (startTime === null) return null;
  const spansDays = Boolean(event.endDate && event.endDate !== event.startDate);
  let start = selectedDate === event.startDate ? startTime : 0;
  let end = timeToMinutes(event.endTime);

  if (spansDays) {
    if (selectedDate < event.startDate || selectedDate > (event.endDate ?? event.startDate)) return null;
    if (selectedDate !== event.endDate) end = DAY_MINUTES;
    else {
      end = end ?? DAY_MINUTES;
      if (end === 0 && selectedDate !== event.startDate) return null;
    }
  } else {
    if (selectedDate !== event.startDate) return null;
    if (end === null || end <= start) end = Math.min(DAY_MINUTES, start + 60);
  }

  start = Math.max(0, Math.min(DAY_MINUTES - 1, start));
  end = Math.max(start + 15, Math.min(DAY_MINUTES, end));
  return { start, end };
}

function eventShowsAsAllDay(event: CalEvent): boolean {
  if (event.isAllDay || !event.startTime) return true;
  if (!event.endDate || !event.endTime) return false;
  const start = eventDateTimeMinutes(event.startDate, event.startTime);
  const end = eventDateTimeMinutes(event.endDate, event.endTime);
  if (start === null || end === null || end <= start) return false;
  const duration = end - start;
  const startMinute = timeToMinutes(event.startTime);
  return duration >= DAY_MINUTES || (startMinute === 0 && duration >= DAY_MINUTES - 1);
}

function eventOccupiesDate(event: CalEvent, selectedDate: string): boolean {
  return !(
    event.startDate < selectedDate
    && event.endDate === selectedDate
    && !event.isAllDay
    && event.endTime === '00:00'
  );
}

function eventDateTimeMinutes(date: string, time: string): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const minute = timeToMinutes(time);
  if (!dateMatch || minute === null) return null;
  return Math.floor(Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
  ) / 60000) + minute;
}

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
    left: TIME_GUTTER + 3,
    right: 3,
    zIndex: 3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderWidth: 1,
    borderColor: C.primary,
    borderRadius: 2,
    backgroundColor: C.primaryLight,
  },
  quickCreateText: { fontSize: 12, lineHeight: 17, color: C.primary },
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
  timelineEventTitle: { fontSize: 12, lineHeight: 16, color: C.primaryPressed },
  timelineEventTime: { fontSize: 10, lineHeight: 14, color: C.primaryPressed },
  currentLine: { position: 'absolute', left: TIME_GUTTER - 3.5, right: 0, height: 7, zIndex: 5, flexDirection: 'row', alignItems: 'center' },
  currentDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: C.red },
  currentRule: { flex: 1, height: 1, backgroundColor: C.red },
});
