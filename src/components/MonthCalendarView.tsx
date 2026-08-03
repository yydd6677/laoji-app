import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
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
import { Appearance, Colors as C, withAlpha } from '../theme/colors';
import type { CalEvent } from '../types';
import { selectTasksForDate } from '../utils/taskOrdering';
import { layoutMonthWeekEvents } from '../utils/monthEventLayout';
import {
  addDays,
  addMonths,
  dateKey,
  isSameDay,
  isSameMonth,
  monthCells,
  startOfMonth,
} from '../utils/calendarDate';
import { useCurrentDate } from '../hooks/useCurrentDate';
import { eventListTitle } from '../utils/eventTitle';
import {
  colorForEventCategory,
  fillColorForEventCategory,
  textColorForEventCategory,
} from '../utils/eventColors';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAY_HEIGHT = 32;
const GRID_SIDE_START = 16;
const GRID_SIDE_END = 11.5;
const DATE_TOP = 10;
const DATE_CIRCLE = 22;
const EVENT_TOP = 29;
const EVENT_HEIGHT = 20;
const EVENT_GAP = 3;
const ROW_ANIMATION_MS = 350;
const PROGRAMMATIC_MONTH_ANIMATION_MS = 400;
const accelerateDecelerate = (progress: number) => Math.cos((progress + 1) * Math.PI) / 2 + 0.5;

export function MonthCalendarView({
  month,
  selectedDate,
  events,
  onSelectDate,
  onMonthChange,
  onOpenEvent,
  onCreate,
}: {
  month: Date;
  selectedDate: Date;
  events: CalEvent[];
  onSelectDate: (date: Date) => void;
  onMonthChange: (month: Date) => void;
  onOpenEvent: (event: CalEvent) => void;
  onCreate: (date: Date) => void;
}) {
  const { width, height: windowHeight } = useWindowDimensions();
  const pageWidth = Math.max(280, width);
  const pagerRef = useRef<ScrollView | null>(null);
  const monthGestureActive = useRef(false);
  const monthGestureHandled = useRef(false);
  const gestureTargetMonthRef = useRef<string | null>(null);
  const activeExpandedCloserRef = useRef<((afterClose: () => void) => void) | null>(null);
  const transitionRunRef = useRef(0);
  const transitionProgress = useRef(new Animated.Value(0)).current;
  const [bodyHeight, setBodyHeight] = useState(() => Math.max(320, windowHeight - 250));
  const [displayMonth, setDisplayMonth] = useState(() => startOfMonth(month));
  const [monthTransition, setMonthTransition] = useState<{
    from: Date;
    to: Date;
    direction: -1 | 1;
    run: number;
  } | null>(null);
  const today = useCurrentDate();
  const pages = useMemo(
    () => [-1, 0, 1].map(offset => addMonths(displayMonth, offset)),
    [displayMonth],
  );

  useEffect(() => {
    const target = startOfMonth(month);
    const targetKey = dateKey(target);
    if (isSameMonth(target, displayMonth)) {
      if (monthTransition) {
        transitionRunRef.current += 1;
        transitionProgress.stopAnimation();
        setMonthTransition(null);
      }
      return;
    }
    if (monthTransition && isSameMonth(monthTransition.to, target)) return;

    if (gestureTargetMonthRef.current === targetKey) {
      gestureTargetMonthRef.current = null;
      transitionRunRef.current += 1;
      transitionProgress.stopAnimation();
      setMonthTransition(null);
      setDisplayMonth(target);
      return;
    }

    const run = transitionRunRef.current + 1;
    transitionRunRef.current = run;
    const beginTransition = () => {
      if (transitionRunRef.current !== run) return;
      const direction: -1 | 1 = target.getTime() < displayMonth.getTime() ? -1 : 1;
      transitionProgress.stopAnimation();
      transitionProgress.setValue(0);
      setMonthTransition({ from: displayMonth, to: target, direction, run });
      requestAnimationFrame(() => {
        Animated.timing(transitionProgress, {
          toValue: 1,
          duration: PROGRAMMATIC_MONTH_ANIMATION_MS,
          easing: accelerateDecelerate,
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (!finished || transitionRunRef.current !== run) return;
          setDisplayMonth(target);
          setMonthTransition(null);
        });
      });
    };

    const closeExpanded = activeExpandedCloserRef.current;
    if (closeExpanded) {
      activeExpandedCloserRef.current = null;
      closeExpanded(beginTransition);
    } else {
      beginTransition();
    }
  }, [displayMonth, month, monthTransition, transitionProgress]);

  useLayoutEffect(() => {
    pagerRef.current?.scrollTo({ x: pageWidth, animated: false });
  }, [displayMonth, pageWidth]);

  const settleMonth = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!monthGestureActive.current || monthGestureHandled.current) return;
    const page = Math.max(0, Math.min(2, Math.round(event.nativeEvent.contentOffset.x / pageWidth)));
    monthGestureActive.current = false;
    monthGestureHandled.current = true;
    if (page === 1) {
      pagerRef.current?.scrollTo({ x: pageWidth, animated: false });
      return;
    }
    const target = addMonths(displayMonth, page === 0 ? -1 : 1);
    gestureTargetMonthRef.current = dateKey(target);
    onMonthChange(target);
  };

  const onBodyLayout = (event: LayoutChangeEvent) => {
    const height = Math.max(0, Math.round(event.nativeEvent.layout.height));
    setBodyHeight(current => current === height ? current : height);
  };

  const accessibilityShift = (event: { nativeEvent: { actionName: string } }) => {
    if (event.nativeEvent.actionName === 'decrement') onMonthChange(addMonths(displayMonth, -1));
    if (event.nativeEvent.actionName === 'increment') onMonthChange(addMonths(displayMonth, 1));
  };

  const pageProps = {
    width: pageWidth,
    height: bodyHeight,
    selectedDate,
    today,
    events,
    onSelectDate,
    onMonthChange,
    onOpenEvent,
    onCreate,
  };

  return (
    <View
      style={[
        s.calendar,
        Appearance.surfaceRadius > 0 && {
          marginTop: 6,
          marginBottom: 6,
          borderRadius: Appearance.surfaceRadius,
          borderWidth: Appearance.borderWidth,
          borderColor: C.border,
          shadowColor: C.purpleDark,
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: Appearance.shadowOpacity,
          shadowRadius: 8,
          elevation: 2,
          overflow: 'hidden',
        },
      ]}
    >
      <View style={s.weekdayRow}>
        {WEEKDAYS.map((day, index) => (
          <Text key={day} style={s.weekday} testID={`calendar-weekday-${index}`}>{day}</Text>
        ))}
      </View>
      <View style={s.body} onLayout={onBodyLayout} testID="calendar-month-body">
        {monthTransition ? (
          <Animated.View
            style={[
              s.monthTransitionTrack,
              {
                width: pageWidth * 2,
                left: monthTransition.direction > 0 ? 0 : -pageWidth,
                transform: [{
                  translateX: transitionProgress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, monthTransition.direction > 0 ? -pageWidth : pageWidth],
                  }),
                }],
              },
            ]}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID="calendar-programmatic-month-transition"
          >
            {(monthTransition.direction > 0
              ? [monthTransition.from, monthTransition.to]
              : [monthTransition.to, monthTransition.from]
            ).map(transitionMonth => (
              <MonthPage
                key={`transition-${dateKey(transitionMonth)}`}
                month={transitionMonth}
                active={false}
                {...pageProps}
              />
            ))}
          </Animated.View>
        ) : <ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          bounces={false}
          decelerationRate="fast"
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: pageWidth, y: 0 }}
          onScrollBeginDrag={() => {
            monthGestureActive.current = true;
            monthGestureHandled.current = false;
          }}
          onMomentumScrollEnd={settleMonth}
          scrollEventThrottle={16}
          accessibilityRole="adjustable"
          accessibilityLabel={`${displayMonth.getFullYear()}年${displayMonth.getMonth() + 1}月`}
          accessibilityHint="左右滑动切换月份"
          accessibilityActions={[
            { name: 'decrement', label: '上一个月' },
            { name: 'increment', label: '下一个月' },
          ]}
          onAccessibilityAction={accessibilityShift}
          testID="calendar-month-pager"
        >
          {pages.map((pageMonth, pageIndex) => (
            <MonthPage
              key={dateKey(pageMonth)}
              month={pageMonth}
              width={pageWidth}
              height={bodyHeight}
              active={pageIndex === 1}
              selectedDate={selectedDate}
              today={today}
              events={events}
              onSelectDate={onSelectDate}
              onMonthChange={onMonthChange}
              onOpenEvent={onOpenEvent}
              onCreate={onCreate}
              onExpandedCloserChange={pageIndex === 1 ? closer => {
                activeExpandedCloserRef.current = closer;
              } : undefined}
            />
          ))}
        </ScrollView>}
      </View>
    </View>
  );
}

function MonthPage({
  month,
  width,
  height,
  active,
  selectedDate,
  today,
  events,
  onSelectDate,
  onMonthChange,
  onOpenEvent,
  onCreate,
  onExpandedCloserChange,
}: {
  month: Date;
  width: number;
  height: number;
  active: boolean;
  selectedDate: Date;
  today: Date;
  events: CalEvent[];
  onSelectDate: (date: Date) => void;
  onMonthChange: (month: Date) => void;
  onOpenEvent: (event: CalEvent) => void;
  onCreate: (date: Date) => void;
  onExpandedCloserChange?: (
    closer: ((afterClose: () => void) => void) | null,
  ) => void;
}) {
  const rows = useMemo(() => {
    const cells = monthCells(month);
    return Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
  }, [month]);
  const rowHeight = height > 0 ? height / rows.length : 1;
  const rowOffsets = useRef<Animated.Value[]>([]);
  if (rowOffsets.current.length !== rows.length) {
    rowOffsets.current = rows.map(() => new Animated.Value(0));
  }
  const animating = useRef(false);
  const pendingOpenRow = useRef<number | null>(null);
  const [expanded, setExpanded] = useState<{ date: Date; row: number } | null>(null);
  const [panelVisible, setPanelVisible] = useState(false);
  useEffect(() => {
    if (expanded !== null) return;
    rowOffsets.current.forEach(value => value.setValue(0));
    animating.current = false;
  }, [expanded, height]);

  const runAnimation = (
    targets: number[],
    callback?: () => void,
  ) => {
    animating.current = true;
    Animated.parallel(
      rowOffsets.current.map((value, index) => Animated.timing(value, {
        toValue: targets[index] ?? 0,
        duration: ROW_ANIMATION_MS,
        easing: accelerateDecelerate,
        useNativeDriver: true,
      })),
    ).start(({ finished }) => {
      animating.current = false;
      if (finished) callback?.();
    });
  };

  const openRow = (date: Date, rowIndex: number) => {
    pendingOpenRow.current = rowIndex;
    setPanelVisible(true);
    setExpanded({ date, row: rowIndex });
  };

  useEffect(() => {
    const rowIndex = pendingOpenRow.current;
    if (!expanded || rowIndex === null || expanded.row !== rowIndex) return;
    pendingOpenRow.current = null;
    const targets = rows.map((_, index) => {
      if (index <= rowIndex) return -rowIndex * rowHeight;
      return height - (rowIndex + 2) * rowHeight;
    });
    requestAnimationFrame(() => runAnimation(targets));
  }, [expanded, height, rowHeight, rows]);

  const closeRow = (afterClose?: () => void) => {
    pendingOpenRow.current = null;
    setPanelVisible(false);
    runAnimation(rows.map(() => 0), () => {
      setExpanded(null);
      afterClose?.();
    });
  };

  useEffect(() => {
    if (!onExpandedCloserChange) return undefined;
    if (!active || !expanded) {
      onExpandedCloserChange(null);
      return undefined;
    }
    onExpandedCloserChange(afterClose => closeRow(afterClose));
    return () => onExpandedCloserChange(null);
  }, [active, expanded, onExpandedCloserChange]);

  const resetSelectionAfterClose = () => {
    const firstVisibleDate = rows[0][0].date;
    const lastVisibleDate = rows[rows.length - 1][6].date;
    if (today >= firstVisibleDate && today <= lastVisibleDate) onSelectDate(today);
    else onSelectDate(startOfMonth(month));
  };

  const selectDate = (date: Date, rowIndex: number) => {
    if (!active || animating.current) return;
    if (!isSameMonth(date, month)) {
      onSelectDate(date);
      onMonthChange(startOfMonth(date));
      return;
    }

    onSelectDate(date);
    if (!expanded) {
      openRow(date, rowIndex);
      return;
    }
    if (expanded.row === rowIndex) {
      if (isSameDay(expanded.date, date)) {
        closeRow(resetSelectionAfterClose);
      } else {
        setExpanded({ date, row: rowIndex });
      }
      return;
    }
    closeRow(() => openRow(date, rowIndex));
  };

  const moveExpandedDate = (date: Date) => {
    if (!expanded) return;
    setExpanded({ date, row: expanded.row });
    onSelectDate(date);
  };

  const expandedPanelHeight = expanded === null
    ? 0
    : Math.max(0, height - rowHeight * (expanded.row === rows.length - 1 ? 1 : 2));

  return (
    <View
      style={[s.monthPage, { width, height }]}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      {expanded && panelVisible ? (
        <ExpandedDayPager
          weekStart={rows[expanded.row][0].date}
          selectedDate={expanded.date}
          events={events}
          width={width}
          top={rowHeight}
          height={expandedPanelHeight}
          onDateChange={moveExpandedDate}
          onOpenEvent={onOpenEvent}
          onCreate={onCreate}
        />
      ) : null}

      {rows.map((row, rowIndex) => (
        <MonthWeekRow
          key={dateKey(row[0].date)}
          row={row}
          rowIndex={rowIndex}
          rowHeight={rowHeight}
          width={width}
          offset={rowOffsets.current[rowIndex]}
          today={today}
          expanded={expanded}
          events={events}
          disabled={!active}
          onSelectDate={selectDate}
        />
      ))}
    </View>
  );
}

function MonthWeekRow({
  row,
  rowIndex,
  rowHeight,
  width,
  offset,
  today,
  expanded,
  events,
  disabled,
  onSelectDate,
}: {
  row: ReturnType<typeof monthCells>;
  rowIndex: number;
  rowHeight: number;
  width: number;
  offset: Animated.Value;
  today: Date;
  expanded: { date: Date; row: number } | null;
  events: CalEvent[];
  disabled: boolean;
  onSelectDate: (date: Date, rowIndex: number) => void;
}) {
  const capacity = Math.max(0, Math.floor((rowHeight - EVENT_TOP) / (EVENT_HEIGHT + EVENT_GAP)));
  const layout = useMemo(
    () => layoutMonthWeekEvents(events, row.map(cell => cell.key), capacity),
    [capacity, events, row],
  );
  const contentWidth = Math.max(0, width - GRID_SIDE_START - GRID_SIDE_END);
  const cellWidth = contentWidth / 7;

  return (
    <Animated.View
      style={[
        s.weekRow,
        {
          top: rowIndex * rowHeight,
          height: rowHeight,
          transform: [{ translateY: offset }],
        },
      ]}
      testID={`calendar-week-row-${row[0].key}`}
    >
      <View style={s.weekGridLayer} pointerEvents="none">
        {Array.from({ length: 6 }, (_, index) => (
          <View
            key={`calendar-column-divider-${row[0].key}-${index}`}
            style={[s.weekColumnDivider, { left: `${((index + 1) / 7) * 100}%` }]}
          />
        ))}
      </View>
      {row.map((cell, column) => (
        <MonthDayCell
          key={cell.key}
          date={cell.date}
          inMonth={cell.inMonth}
          current={isSameDay(cell.date, today)}
          selected={Boolean(expanded && isSameDay(cell.date, expanded.date))}
          anotherDateSelected={Boolean(expanded && !isSameDay(expanded.date, today))}
          eventCount={layout.eventCounts[column]}
          overflow={layout.hiddenCounts[column]}
          disabled={disabled}
          onPress={() => onSelectDate(cell.date, rowIndex)}
        />
      ))}

      <View style={s.weekEventLayer} pointerEvents="none">
        {layout.segments.filter(segment => segment.visible).map(segment => (
          <View
            key={segment.key}
            style={[
              s.weekEventChip,
              {
                borderLeftColor: colorForEventCategory(segment.event.category),
                backgroundColor: fillColorForEventCategory(segment.event.category),
              },
              {
                top: segment.slot * (EVENT_HEIGHT + EVENT_GAP),
                left: segment.column * cellWidth,
                width: Math.max(1, segment.span * cellWidth - 3),
                borderRadius: Appearance.cardRadius > 6 ? 5 : 2,
              },
            ]}
            testID={`calendar-event-chip-${segment.event.id}-${row[segment.column].key}`}
          >
            <Text
              style={[s.eventChipText, { color: textColorForEventCategory(segment.event.category) }]}
              numberOfLines={1}
            >
              {eventListTitle(segment.event.title)}
            </Text>
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

function MonthDayCell({
  date,
  inMonth,
  current,
  selected,
  anotherDateSelected,
  eventCount,
  overflow,
  disabled,
  onPress,
}: {
  date: Date;
  inMonth: boolean;
  current: boolean;
  selected: boolean;
  anotherDateSelected: boolean;
  eventCount: number;
  overflow: number;
  disabled: boolean;
  onPress: () => void;
}) {
  const todayHasCircle = current && !anotherDateSelected;

  return (
    <TouchableOpacity
      style={s.dayCell}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.72}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={[
        `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
        current ? '今天' : '',
        selected ? '已展开' : '',
        eventCount ? `${eventCount}条日程` : '无日程',
      ].filter(Boolean).join('，')}
      testID={`calendar-day-${dateKey(date)}`}
    >
      <View style={[
        s.dateCircle,
        selected && !current && s.dateCircleSelected,
        todayHasCircle && s.dateCircleToday,
      ]}>
        <Text style={[
          s.dateNumber,
          !inMonth && s.dateNumberAdjacent,
          current && !todayHasCircle && s.dateNumberToday,
          selected && !current && s.dateNumberSelected,
          todayHasCircle && s.dateNumberSelectedToday,
        ]}>
          {date.getDate()}
        </Text>
      </View>

      {overflow > 0 ? (
        <View style={s.overflowBadge} testID={`calendar-overflow-${dateKey(date)}`}>
          <Text style={s.overflowText}>{overflow > 9 ? '+N' : `+${overflow}`}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

function ExpandedDayPager({
  weekStart,
  selectedDate,
  events,
  width,
  top,
  height,
  onDateChange,
  onOpenEvent,
  onCreate,
}: {
  weekStart: Date;
  selectedDate: Date;
  events: CalEvent[];
  width: number;
  top: number;
  height: number;
  onDateChange: (date: Date) => void;
  onOpenEvent: (event: CalEvent) => void;
  onCreate: (date: Date) => void;
}) {
  const ref = useRef<ScrollView | null>(null);
  const mounted = useRef(false);
  const previousIndex = useRef(-1);
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const selectedIndex = Math.max(0, dates.findIndex(date => isSameDay(date, selectedDate)));
  const initialSelectedIndex = useRef(selectedIndex).current;

  useLayoutEffect(() => {
    ref.current?.scrollTo({
      x: selectedIndex * width,
      animated: mounted.current && previousIndex.current !== selectedIndex,
    });
    mounted.current = true;
    previousIndex.current = selectedIndex;
  }, [selectedIndex, width]);

  const settleDate = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.max(0, Math.min(6, Math.round(event.nativeEvent.contentOffset.x / width)));
    onDateChange(dates[index]);
  };

  return (
    <View
      style={[s.expandedPanel, { top, height }]}
      testID="calendar-expanded-day-panel"
    >
      <ScrollView
        ref={ref}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        contentOffset={{ x: initialSelectedIndex * width, y: 0 }}
        onMomentumScrollEnd={settleDate}
        nestedScrollEnabled
        testID="calendar-expanded-day-pager"
      >
        {dates.map(date => (
          <ExpandedDayPage
            key={dateKey(date)}
            date={date}
            width={width}
            events={selectTasksForDate(events, dateKey(date))}
            onOpenEvent={onOpenEvent}
            onCreate={onCreate}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function ExpandedDayPage({
  date,
  width,
  events,
  onOpenEvent,
  onCreate,
}: {
  date: Date;
  width: number;
  events: CalEvent[];
  onOpenEvent: (event: CalEvent) => void;
  onCreate: (date: Date) => void;
}) {
  if (events.length === 0) {
    return (
      <View
        style={[s.expandedPage, s.expandedEmpty, { width }]}
        testID={`calendar-expanded-day-${dateKey(date)}`}
      >
        <Image
          source={require('../../assets/calendar-day-empty.png')}
          style={s.expandedEmptyImage}
          resizeMode="contain"
          accessible={false}
          accessibilityIgnoresInvertColors
          testID={`calendar-expanded-empty-asset-${dateKey(date)}`}
        />
        <View style={s.emptyCopy}>
          <Text style={s.emptyText}>暂无日程，</Text>
          <TouchableOpacity onPress={() => onCreate(date)} activeOpacity={0.7}>
            <Text style={s.emptyAction}>点击创建</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={[s.expandedPage, { width }]}
      contentContainerStyle={s.expandedListContent}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
      testID={`calendar-expanded-day-${dateKey(date)}`}
    >
      {events.map(event => (
        <TouchableOpacity
          key={event.id}
          style={[
            s.expandedEventRow,
            Appearance.cardRadius > 6 && {
              marginHorizontal: 12,
              marginBottom: 8,
              paddingBottom: 8,
              backgroundColor: C.card,
              borderRadius: Appearance.cardRadius,
              borderWidth: Appearance.borderWidth,
              borderColor: C.border,
            },
          ]}
          onPress={() => onOpenEvent(event)}
          activeOpacity={0.74}
          accessibilityRole="button"
          accessibilityLabel={`${eventListTitle(event.title)}，${eventTimeLabel(event)}`}
        >
          <View
            style={[s.expandedEventDot, { backgroundColor: colorForEventCategory(event.category) }]}
          />
          <View style={s.expandedEventCopy}>
            <Text
              style={[s.expandedEventTitle, { color: textColorForEventCategory(event.category) }]}
              numberOfLines={1}
            >
              {eventListTitle(event.title)}
            </Text>
            <Text style={[s.expandedEventMeta, { color: textColorForEventCategory(event.category) }]} numberOfLines={1}>
              {[eventTimeLabel(event), event.location].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function eventTimeLabel(event: CalEvent): string {
  if (event.startTime && event.endTime) return `${event.startTime} - ${event.endTime}`;
  if (event.startTime) return event.startTime;
  if (event.spanning && event.endDate) return '跨日';
  return '全天';
}

const s = StyleSheet.create({
  calendar: { flex: 1, minHeight: 0, backgroundColor: C.body },
  weekdayRow: {
    height: WEEKDAY_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.divider,
  },
  weekday: { flex: 1, textAlign: 'center', fontSize: 12, color: C.text },
  body: { flex: 1, minHeight: 0, overflow: 'hidden' },
  monthTransitionTrack: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  monthPage: { position: 'relative', overflow: 'hidden', backgroundColor: C.body },
  weekRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 2,
    paddingLeft: GRID_SIDE_START,
    paddingRight: GRID_SIDE_END,
    flexDirection: 'row',
    backgroundColor: C.body,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.calendarGridDivider,
  },
  weekGridLayer: {
    position: 'absolute',
    left: GRID_SIDE_START,
    right: GRID_SIDE_END,
    top: 0,
    bottom: 0,
  },
  weekColumnDivider: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: C.calendarGridDivider,
  },
  dayCell: { flex: 1, minWidth: 0, position: 'relative', paddingTop: DATE_TOP },
  dateCircle: {
    width: DATE_CIRCLE,
    height: DATE_CIRCLE,
    borderRadius: DATE_CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateCircleToday: { backgroundColor: C.primary },
  dateCircleSelected: { backgroundColor: C.border },
  dateNumber: { fontSize: 12, lineHeight: 16, color: C.text, textAlign: 'center' },
  dateNumberAdjacent: { color: C.disabled },
  dateNumberToday: { color: C.primary },
  dateNumberSelected: { color: C.faint },
  dateNumberSelectedToday: { color: '#FFFFFF' },
  overflowBadge: {
    position: 'absolute',
    right: 2,
    top: DATE_TOP + 2,
    minWidth: 19,
    height: 12,
    paddingHorizontal: 2,
    borderRadius: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(C.sub, 0.12),
  },
  overflowText: { fontSize: 10, lineHeight: 12, color: C.sub },
  weekEventLayer: {
    position: 'absolute',
    left: GRID_SIDE_START,
    right: GRID_SIDE_END,
    top: EVENT_TOP,
    bottom: 0,
    zIndex: 3,
  },
  weekEventChip: {
    position: 'absolute',
    height: EVENT_HEIGHT,
    borderRadius: 2,
    borderLeftWidth: 2,
    borderLeftColor: C.primary,
    backgroundColor: C.primaryLight,
    paddingLeft: 3,
    paddingRight: 2,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  eventChipText: { fontSize: 14, lineHeight: 20, color: C.primaryPressed },
  expandedPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 1,
    backgroundColor: C.appBg,
    overflow: 'hidden',
  },
  expandedPage: { height: '100%', backgroundColor: C.appBg },
  expandedListContent: { paddingVertical: 0 },
  expandedEventRow: { minHeight: 48, paddingBottom: 6, flexDirection: 'row', alignItems: 'flex-start' },
  expandedEventDot: {
    width: 7,
    height: 7,
    borderRadius: 2,
    marginLeft: 20,
    marginTop: 14,
    backgroundColor: C.primary,
  },
  expandedEventCopy: { flex: 1, minWidth: 0, marginLeft: 14, marginRight: 14, paddingTop: 7 },
  expandedEventTitle: { fontSize: 14, lineHeight: 20, color: C.text },
  expandedEventMeta: { fontSize: 12, lineHeight: 17, color: C.text },
  expandedEmpty: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  expandedEmptyImage: { width: 125, height: 94 },
  emptyCopy: { flexDirection: 'row', alignItems: 'center' },
  emptyText: { fontSize: 14, color: C.faint },
  emptyAction: { fontSize: 14, color: C.primary },
});
