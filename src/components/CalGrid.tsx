import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
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
import { CalEvent } from '../types';
import { selectTasksForDate } from '../utils/taskOrdering';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const CALENDAR_MARGIN = 14;
const MONTH_PAGE_PADDING = 8;
const WEEKDAY_ROW_HEIGHT = 24;
const DATE_CELL_HEIGHT = 52;
const POPOVER_GAP = 10;
const POPOVER_HEADER_HEIGHT = 36;
const POPOVER_ROW_HEIGHT = 49;

interface Props {
  year: number;
  month: number;
  selDay: number;
  onDay: (day: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onTitle?: () => void;
  onEvent?: (event: CalEvent) => void;
  events: CalEvent[];
}

type Cell = { day: number; current: boolean };
type MonthDescriptor = { year: number; month: number };

function mondayFirstIndex(day: number): number {
  return (day + 6) % 7;
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthAtOffset(year: number, month: number, offset: number): MonthDescriptor {
  const value = new Date(year, month - 1 + offset, 1);
  return { year: value.getFullYear(), month: value.getMonth() + 1 };
}

function monthCells(year: number, month: number): Cell[] {
  const firstWeekday = mondayFirstIndex(new Date(year, month - 1, 1).getDay());
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysInPreviousMonth = new Date(year, month - 1, 0).getDate();
  const cells: Cell[] = [];
  for (let index = 0; index < firstWeekday; index += 1) {
    cells.push({ day: daysInPreviousMonth - firstWeekday + 1 + index, current: false });
  }
  for (let day = 1; day <= daysInMonth; day += 1) cells.push({ day, current: true });
  while (cells.length < 42) cells.push({ day: cells.length - daysInMonth - firstWeekday + 1, current: false });
  return cells;
}

function eventTimeLabel(event: CalEvent): string {
  if (event.startTime && event.endTime) return `${event.startTime}-${event.endTime}`;
  if (event.startTime) return event.startTime;
  return '全天';
}

export function calendarPopoverColumnCount(eventCount: number): number {
  if (eventCount <= 1) return 1;
  return Math.min(3, Math.ceil(Math.sqrt(eventCount)));
}

export function CalGrid({
  year,
  month,
  selDay,
  onDay,
  onPrev,
  onNext,
  onTitle,
  onEvent,
  events,
}: Props) {
  const { width: windowWidth } = useWindowDimensions();
  const pageWidth = Math.max(280, windowWidth - CALENDAR_MARGIN * 2);
  const pagerRef = useRef<ScrollView | null>(null);
  const popoverAnimation = useRef(new Animated.Value(0)).current;
  const popoverSwitchAnimation = useRef(new Animated.Value(1)).current;
  const transitionRef = useRef(0);
  const [popoverDate, setPopoverDate] = useState<string | null>(null);
  const today = new Date();
  const todayKey = dateKey(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const pages = useMemo(
    () => [-1, 0, 1].map(offset => monthAtOffset(year, month, offset)),
    [month, year],
  );

  const closePopover = (after?: () => void) => {
    const transition = ++transitionRef.current;
    popoverSwitchAnimation.stopAnimation?.();
    popoverSwitchAnimation.setValue(1);
    if (!popoverDate) {
      after?.();
      return;
    }
    popoverAnimation.stopAnimation?.();
    Animated.timing(popoverAnimation, {
      toValue: 0,
      duration: 120,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished || transition !== transitionRef.current) return;
      setPopoverDate(null);
      after?.();
    });
  };

  const openPopover = (nextDate: string, day: number) => {
    if (popoverDate === nextDate) {
      closePopover();
      return;
    }

    ++transitionRef.current;
    popoverAnimation.stopAnimation?.();
    popoverSwitchAnimation.stopAnimation?.();
    onDay(day);
    setPopoverDate(nextDate);

    if (popoverDate) {
      popoverAnimation.setValue(1);
      popoverSwitchAnimation.setValue(0);
      Animated.timing(popoverSwitchAnimation, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
      return;
    }

    popoverSwitchAnimation.setValue(1);
    popoverAnimation.setValue(0);
    Animated.timing(popoverAnimation, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  };

  useLayoutEffect(() => {
    pagerRef.current?.scrollTo?.({ x: pageWidth, y: 0, animated: false });
  }, [month, pageWidth, year]);

  useEffect(() => {
    transitionRef.current += 1;
    setPopoverDate(null);
    popoverAnimation.setValue(0);
    popoverSwitchAnimation.setValue(1);
  }, [month, popoverAnimation, popoverSwitchAnimation, year]);

  const handleMonthSettled = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
    if (page === 0) onPrev();
    else if (page === 2) onNext();
    else pagerRef.current?.scrollTo?.({ x: pageWidth, y: 0, animated: false });
  };

  const handleMonthAccessibilityAction = (event: { nativeEvent: { actionName: string } }) => {
    closePopover();
    if (event.nativeEvent.actionName === 'decrement') onPrev();
    if (event.nativeEvent.actionName === 'increment') onNext();
  };

  const renderPopover = (
    descriptor: MonthDescriptor,
    isCurrentPage: boolean,
    cells: Cell[],
  ) => {
    if (!isCurrentPage || !popoverDate) return null;
    const dayEvents = selectTasksForDate(events, popoverDate);
    const columns = calendarPopoverColumnCount(dayEvents.length);
    const selectedDay = Number(popoverDate.slice(-2));
    const selectedCellIndex = cells.findIndex(cell => cell.current && cell.day === selectedDay);
    if (selectedCellIndex < 0) return null;
    const selectedColumn = selectedCellIndex % 7;
    const selectedRow = Math.floor(selectedCellIndex / 7);
    const innerWidth = pageWidth - MONTH_PAGE_PADDING * 2;
    const anchorX = MONTH_PAGE_PADDING + ((selectedColumn + 0.5) * innerWidth) / 7;
    const visibleRows = Math.min(3, Math.max(1, Math.ceil(Math.max(1, dayEvents.length) / columns)));
    const bubbleHeight = dayEvents.length === 0
      ? 80
      : POPOVER_HEADER_HEIGHT + visibleRows * POPOVER_ROW_HEIGHT;
    const bubbleWidth = dayEvents.length <= 1
      ? Math.min(223, pageWidth - 20)
      : dayEvents.length <= 4
        ? Math.min(255, pageWidth - 20)
        : Math.min(398, pageWidth - 16);
    const selectedCellTop = WEEKDAY_ROW_HEIGHT + selectedRow * DATE_CELL_HEIGHT;
    const topWhenAbove = selectedCellTop - bubbleHeight - POPOVER_GAP;
    const showBelow = topWhenAbove < 0;
    const rawTop = showBelow
      ? selectedCellTop + 40 + POPOVER_GAP
      : topWhenAbove;
    const calendarHeight = WEEKDAY_ROW_HEIGHT + DATE_CELL_HEIGHT * 6;
    const top = Math.max(0, Math.min(rawTop, calendarHeight - bubbleHeight));
    const left = Math.max(6, Math.min(anchorX - bubbleWidth / 2, pageWidth - bubbleWidth - 6));
    const pointerLeft = Math.max(15, Math.min(anchorX - left - 8, bubbleWidth - 30));

    return (
      <Animated.View
        style={[
          s.popoverLayer,
          {
            top,
            left,
            width: bubbleWidth,
            opacity: popoverAnimation,
            transform: [
              {
                translateY: popoverAnimation.interpolate({
                  inputRange: [0, 1],
                  outputRange: [showBelow ? -6 : 6, 0],
                }),
              },
              { scale: popoverAnimation.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
              {
                scale: popoverSwitchAnimation.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.96, 1],
                }),
              },
            ],
          },
        ]}
        testID="calendar-event-popover"
      >
        <View style={[s.popoverBubble, { height: bubbleHeight }]}>
          <Text style={s.popoverDateLabel}>
            {descriptor.month}月{selectedDay}日 · {dayEvents.length}项
          </Text>
          {dayEvents.length === 0 ? (
            <Text style={s.popoverEmpty}>当日暂无日程</Text>
          ) : (
            <ScrollView
              style={[s.popoverScroll, { maxHeight: bubbleHeight - POPOVER_HEADER_HEIGHT }]}
              contentContainerStyle={s.popoverGrid}
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
            >
              {dayEvents.map(event => (
                <View
                  key={event.id}
                  style={[s.popoverItemSlot, { width: `${100 / columns}%` }]}
                  testID={`calendar-popover-slot-${event.id}`}
                >
                  <TouchableOpacity
                    style={s.popoverItem}
                    onPress={() => onEvent?.(event)}
                    disabled={!onEvent}
                    activeOpacity={onEvent ? 0.78 : 1}
                    accessibilityRole={onEvent ? 'button' : undefined}
                    accessibilityLabel={`${event.title}，${eventTimeLabel(event)}`}
                  >
                    <View style={[s.popoverDot, { backgroundColor: event.color }]} />
                    <View style={s.popoverItemText}>
                      <Text style={s.popoverTitle} numberOfLines={1}>{event.title}</Text>
                      <Text style={s.popoverTime} numberOfLines={1}>{eventTimeLabel(event)}</Text>
                    </View>
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
        <View
          style={[
            s.popoverPointer,
            showBelow ? s.popoverPointerTop : s.popoverPointerBottom,
            { left: pointerLeft },
          ]}
        />
      </Animated.View>
    );
  };

  const renderMonthPage = (descriptor: MonthDescriptor, pageIndex: number) => {
    const isCurrentPage = pageIndex === 1;
    const cells = monthCells(descriptor.year, descriptor.month);
    const rows = Array.from({ length: 6 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
    return (
      <View
        key={`${descriptor.year}-${descriptor.month}`}
        style={[s.monthPage, { width: pageWidth }]}
        accessibilityElementsHidden={!isCurrentPage}
        importantForAccessibility={isCurrentPage ? 'auto' : 'no-hide-descendants'}
        testID={`calendar-month-page-${pageIndex}`}
      >
        <View style={s.weekdayRow}>
          {WEEKDAYS.map((weekday, index) => (
            <Text key={weekday} style={[s.weekdayText, index >= 5 && s.weekendText]}>{weekday}</Text>
          ))}
        </View>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} style={s.dateRow}>
            {row.map((cell, columnIndex) => {
              const cellDate = cell.current
                ? dateKey(descriptor.year, descriptor.month, cell.day)
                : '';
              const isToday = cell.current && cellDate === todayKey;
              const isSelected = isCurrentPage && cell.current && cell.day === selDay;
              const isSelectedOnly = isSelected && !isToday;
              const isWeekend = columnIndex >= 5;
              const eventCount = cell.current ? selectTasksForDate(events, cellDate).length : 0;
              const dayLabel = cell.current
                ? [
                    `${descriptor.year}年${descriptor.month}月${cell.day}日`,
                    isToday ? '今天' : '',
                    isSelected ? '已选择' : '',
                    eventCount > 0 ? `${eventCount}条日程` : '无日程',
                  ].filter(Boolean).join('，')
                : undefined;
              return (
                <TouchableOpacity
                  key={columnIndex}
                  onPress={() => {
                    if (cell.current && isCurrentPage) openPopover(cellDate, cell.day);
                  }}
                  disabled={!cell.current || !isCurrentPage}
                  style={s.cell}
                  activeOpacity={cell.current && isCurrentPage ? 0.72 : 1}
                  accessibilityRole="button"
                  accessibilityLabel={dayLabel}
                  accessibilityState={{ disabled: !cell.current || !isCurrentPage, selected: isSelected }}
                >
                  <View style={[
                    s.dayMarker,
                    isToday && s.todayMarker,
                    isSelectedOnly && s.selectedMarker,
                  ]}>
                    <Text style={[
                      s.dayNumber,
                      isWeekend && cell.current && s.weekendNumber,
                      isSelectedOnly && s.selectedNumber,
                      isToday && s.todayNumber,
                      !cell.current && s.adjacentNumber,
                    ]}>
                      {cell.day}
                    </Text>
                  </View>
                  {eventCount > 0 ? (
                    <View
                      style={s.eventCountBadge}
                      testID={`calendar-day-count-${cellDate}`}
                      accessible={false}
                      importantForAccessibility="no"
                    >
                      <Text
                        style={s.eventCountText}
                        testID={`calendar-day-count-text-${cellDate}`}
                      >
                        {eventCount > 99 ? '99+' : String(eventCount)}
                      </Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
        {renderPopover(descriptor, isCurrentPage, cells)}
      </View>
    );
  };

  return (
    <View style={s.card}>
      <View style={s.monthHeader}>
        <TouchableOpacity
          onPress={onTitle}
          disabled={!onTitle}
          style={s.monthTitle}
          accessibilityRole="button"
          accessibilityLabel={`打开完整日历，${year}年${month}月`}
          accessibilityState={{ disabled: !onTitle }}
          testID="calendar-open-month"
        >
          <Text style={s.monthText}>{year}年{month}月</Text>
          {onTitle ? <Ionicons name="chevron-forward" size={14} color={C.purple} /> : null}
        </TouchableOpacity>
      </View>
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        nestedScrollEnabled
        bounces={false}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        contentOffset={{ x: pageWidth, y: 0 }}
        onScrollBeginDrag={() => closePopover()}
        onMomentumScrollEnd={handleMonthSettled}
        scrollEventThrottle={16}
        accessibilityRole="adjustable"
        accessibilityLabel={`当前月份，${year}年${month}月`}
        accessibilityHint="左右滑动切换月份"
        accessibilityActions={[
          { name: 'decrement', label: '上一个月' },
          { name: 'increment', label: '下一个月' },
        ]}
        onAccessibilityAction={handleMonthAccessibilityAction}
        testID="calendar-month-pager"
      >
        {pages.map(renderMonthPage)}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: 20,
    marginHorizontal: CALENDAR_MARGIN,
    paddingTop: 16,
    paddingBottom: 12,
    overflow: 'hidden',
    shadowColor: '#6432B4',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 4,
  },
  monthHeader: { minHeight: 30, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  monthTitle: { minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10 },
  monthText: { fontSize: 17, fontWeight: '800', color: C.text },
  monthPage: { paddingHorizontal: MONTH_PAGE_PADDING, position: 'relative' },
  popoverLayer: { position: 'absolute', zIndex: 20, elevation: 10 },
  popoverBubble: {
    width: '100%',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: C.pinkBorder,
    paddingHorizontal: 9,
    paddingTop: 8,
    paddingBottom: 9,
    shadowColor: '#5028A0',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 8,
  },
  popoverDateLabel: { fontSize: 13, lineHeight: 18, color: C.sub, fontWeight: '700', paddingHorizontal: 4, marginBottom: 3 },
  popoverScroll: { flexGrow: 0 },
  popoverGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  popoverEmpty: { fontSize: 15, color: C.faint, textAlign: 'center', paddingVertical: 10 },
  popoverItemSlot: { padding: 3 },
  popoverItem: { minHeight: 40, borderRadius: 7, backgroundColor: C.tasksBg, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  popoverDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  popoverItemText: { flex: 1, minWidth: 0 },
  popoverTitle: { fontSize: 13, lineHeight: 16, color: C.text, fontWeight: '700' },
  popoverTime: { fontSize: 10, lineHeight: 13, color: C.sub },
  popoverPointer: {
    position: 'absolute',
    width: 15,
    height: 15,
    backgroundColor: '#FFFFFF',
    borderColor: C.pinkBorder,
    transform: [{ rotate: '45deg' }],
    zIndex: 21,
  },
  popoverPointerTop: { top: -7, borderLeftWidth: 1, borderTopWidth: 1 },
  popoverPointerBottom: { bottom: -7, borderRightWidth: 1, borderBottomWidth: 1 },
  weekdayRow: { flexDirection: 'row', height: WEEKDAY_ROW_HEIGHT, alignItems: 'center' },
  weekdayText: { flex: 1, textAlign: 'center', fontSize: 12, color: C.faint, fontWeight: '600' },
  weekendText: { color: '#91A8E8' },
  dateRow: { flexDirection: 'row' },
  cell: { flex: 1, height: DATE_CELL_HEIGHT, alignItems: 'center', justifyContent: 'flex-start' },
  dayMarker: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  todayMarker: { backgroundColor: C.purpleDark, borderColor: C.purpleDark },
  selectedMarker: { backgroundColor: C.card, borderColor: C.purple },
  dayNumber: { fontSize: 16, lineHeight: 20, color: C.text, fontWeight: '500' },
  weekendNumber: { color: C.blue },
  todayNumber: { color: '#FFFFFF', fontWeight: '800' },
  selectedNumber: { color: C.purpleDark, fontWeight: '800' },
  adjacentNumber: { color: '#D5D0ED' },
  eventCountBadge: {
    position: 'absolute',
    bottom: 0,
    minWidth: 22,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DCCDF4',
    backgroundColor: '#F7F2FF',
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventCountText: { fontSize: 11, lineHeight: 14, color: C.purpleDark, fontWeight: '800' },
});
