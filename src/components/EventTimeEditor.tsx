import React from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CalendarSlidePage } from './CalendarSlidePage';
import { CalendarTextTitleBar } from './CalendarTitleBar';
import { CalendarSwitch } from './CalendarSwitch';
import { EventTimeRangeArrow } from './EventTimeRangeArrow';
import { Colors as C } from '../theme/colors';

export type EventTimeValue = {
  startDate: Date;
  endDate: Date;
  startTime: Date;
  endTime: Date;
  isAllDay: boolean;
};

type TimeTarget = 'start' | 'end';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const WHEEL_ITEM_HEIGHT = 36;
const WHEEL_VISIBLE_ITEMS = 7;
const WHEEL_HEIGHT = WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE_ITEMS;
const WHEEL_PADDING = WHEEL_ITEM_HEIGHT * Math.floor(WHEEL_VISIBLE_ITEMS / 2);
const DATE_BASE = new Date(2010, 0, 1);
const DATE_OPTION_COUNT = 22000;
const DATE_OPTIONS = Array.from({ length: DATE_OPTION_COUNT }, (_, index) => index);
const YEAR_OPTIONS = Array.from({ length: 201 }, (_, index) => 1900 + index);
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, index) => index);
const MINUTE_OPTIONS = Array.from({ length: 12 }, (_, index) => index * 5);

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function cloneValue(value: EventTimeValue): EventTimeValue {
  return {
    startDate: cloneDate(value.startDate),
    endDate: cloneDate(value.endDate),
    startTime: cloneDate(value.startTime),
    endTime: cloneDate(value.endTime),
    isAllDay: value.isAllDay,
  };
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function combineDateAndTime(date: Date, time: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    time.getHours(),
    time.getMinutes(),
    0,
    0,
  );
}

function splitDateTime(value: Date): { date: Date; time: Date } {
  const time = new Date();
  time.setHours(value.getHours(), value.getMinutes(), 0, 0);
  return { date: startOfDay(value), time };
}

function dayNumber(value: Date): number {
  return Math.floor(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86400000);
}

function addDays(value: Date, amount: number): Date {
  const next = startOfDay(value);
  next.setDate(next.getDate() + amount);
  return next;
}

function dateFromOption(index: number): Date {
  return addDays(DATE_BASE, index);
}

function dateOptionIndex(value: Date): number {
  return Math.max(0, Math.min(DATE_OPTION_COUNT - 1, dayNumber(value) - dayNumber(DATE_BASE)));
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function formatDate(value: Date, includeYear = false): string {
  return `${includeYear ? `${value.getFullYear()}年` : ''}${value.getMonth() + 1}月${value.getDate()}日`;
}

function formatWeekday(value: Date): string {
  return `周${WEEKDAYS[value.getDay()]}`;
}

function formatTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

function TimeWheel({
  values,
  selectedIndex,
  labelForIndex,
  accessibilityLabel,
  testID,
  weight = 1,
  onSelect,
}: {
  values: number[];
  selectedIndex: number;
  labelForIndex: (value: number, index: number) => string;
  accessibilityLabel: string;
  testID: string;
  weight?: number;
  onSelect: (value: number, index: number) => void;
}) {
  const listRef = React.useRef<FlatList<number>>(null);
  const [activeIndex, setActiveIndex] = React.useState(selectedIndex);

  React.useEffect(() => {
    setActiveIndex(selectedIndex);
    listRef.current?.scrollToIndex({ index: selectedIndex, animated: false });
  }, [selectedIndex]);

  const choose = React.useCallback((index: number, scroll = true) => {
    const next = Math.max(0, Math.min(values.length - 1, index));
    setActiveIndex(next);
    if (scroll) listRef.current?.scrollToIndex({ index: next, animated: true });
    onSelect(values[next], next);
  }, [onSelect, values]);

  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    choose(Math.round(event.nativeEvent.contentOffset.y / WHEEL_ITEM_HEIGHT), false);
  };

  const trackCenterItem = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.max(
      0,
      Math.min(values.length - 1, Math.round(event.nativeEvent.contentOffset.y / WHEEL_ITEM_HEIGHT)),
    );
    setActiveIndex(current => current === next ? current : next);
  };

  return (
    <View
      style={[s.wheelColumn, { flex: weight }]}
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: labelForIndex(values[activeIndex], activeIndex) }}
      accessibilityActions={[
        { name: 'increment', label: '下一个' },
        { name: 'decrement', label: '上一个' },
      ]}
      onAccessibilityAction={event => {
        if (event.nativeEvent.actionName === 'increment') choose(activeIndex + 1);
        if (event.nativeEvent.actionName === 'decrement') choose(activeIndex - 1);
      }}
      testID={testID}
    >
      <FlatList
        ref={listRef}
        data={values}
        keyExtractor={value => String(value)}
        renderItem={({ item, index }) => {
          const distance = Math.min(3, Math.abs(index - activeIndex));
          return (
            <TouchableOpacity
              style={s.wheelItem}
              onPress={() => choose(index)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={{ selected: index === activeIndex }}
            >
              <Text style={[
                s.wheelText,
                index === activeIndex && s.wheelTextSelected,
                distance === 1 && s.wheelTextNear,
                distance >= 2 && s.wheelTextFar,
              ]}>
                {labelForIndex(item, index)}
              </Text>
            </TouchableOpacity>
          );
        }}
        initialScrollIndex={selectedIndex}
        getItemLayout={(_data, index) => ({
          length: WHEEL_ITEM_HEIGHT,
          offset: WHEEL_ITEM_HEIGHT * index,
          index,
        })}
        contentContainerStyle={s.wheelContent}
        showsVerticalScrollIndicator={false}
        snapToInterval={WHEEL_ITEM_HEIGHT}
        decelerationRate="fast"
        scrollEventThrottle={16}
        onScroll={trackCenterItem}
        onMomentumScrollEnd={settle}
        onScrollToIndexFailed={({ index }) => {
          requestAnimationFrame(() => listRef.current?.scrollToIndex({ index, animated: false }));
        }}
        initialNumToRender={11}
        maxToRenderPerBatch={13}
        windowSize={9}
        removeClippedSubviews
      />
      <View
        pointerEvents="none"
        testID={`${testID}-divider-top`}
        style={[s.wheelDivider, s.wheelDividerTop]}
      />
      <View
        pointerEvents="none"
        testID={`${testID}-divider-bottom`}
        style={[s.wheelDivider, s.wheelDividerBottom]}
      />
    </View>
  );
}

export function EventTimeEditor({
  visible,
  value,
  initialTarget,
  onCancel,
  onDone,
  onInvalid,
}: {
  visible: boolean;
  value: EventTimeValue;
  initialTarget: TimeTarget;
  onCancel: () => void;
  onDone: (value: EventTimeValue) => void;
  onInvalid: () => void;
}) {
  const [draft, setDraft] = React.useState<EventTimeValue>(() => cloneValue(value));
  const [target, setTarget] = React.useState<TimeTarget>(initialTarget);

  React.useEffect(() => {
    if (!visible) return;
    setDraft(cloneValue(value));
    setTarget(initialTarget);
  }, [initialTarget, value, visible]);

  const startMoment = combineDateAndTime(draft.startDate, draft.startTime);
  const endMoment = combineDateAndTime(draft.endDate, draft.endTime);
  const invalid = draft.isAllDay
    ? dayNumber(draft.endDate) < dayNumber(draft.startDate)
    : endMoment.getTime() <= startMoment.getTime();
  const activeDate = target === 'start' ? draft.startDate : draft.endDate;
  const activeTime = target === 'start' ? draft.startTime : draft.endTime;

  const updateStartMoment = (nextStart: Date) => {
    setDraft(current => {
      const currentStart = combineDateAndTime(current.startDate, current.startTime);
      const currentEnd = combineDateAndTime(current.endDate, current.endTime);
      const duration = Math.max(5 * 60000, currentEnd.getTime() - currentStart.getTime());
      const nextEnd = new Date(nextStart.getTime() + duration);
      const startParts = splitDateTime(nextStart);
      const endParts = splitDateTime(nextEnd);
      return {
        ...current,
        startDate: startParts.date,
        startTime: startParts.time,
        endDate: endParts.date,
        endTime: endParts.time,
      };
    });
  };

  const updateDate = (nextDate: Date) => {
    if (target === 'start') {
      setDraft(current => {
        if (current.isAllDay) {
          const span = Math.max(0, dayNumber(current.endDate) - dayNumber(current.startDate));
          return { ...current, startDate: startOfDay(nextDate), endDate: addDays(nextDate, span) };
        }
        return current;
      });
      if (!draft.isAllDay) updateStartMoment(combineDateAndTime(nextDate, draft.startTime));
      return;
    }
    setDraft(current => ({ ...current, endDate: startOfDay(nextDate) }));
  };

  const updateHour = (hour: number) => {
    const nextTime = cloneDate(activeTime);
    nextTime.setHours(hour, nextTime.getMinutes(), 0, 0);
    if (target === 'start') updateStartMoment(combineDateAndTime(draft.startDate, nextTime));
    else setDraft(current => ({ ...current, endTime: nextTime }));
  };

  const updateMinute = (minute: number) => {
    const nextTime = cloneDate(activeTime);
    nextTime.setMinutes(minute, 0, 0);
    if (target === 'start') updateStartMoment(combineDateAndTime(draft.startDate, nextTime));
    else setDraft(current => ({ ...current, endTime: nextTime }));
  };

  const updateAllDayDate = (year?: number, month?: number, day?: number) => {
    const nextYear = year ?? activeDate.getFullYear();
    const nextMonth = month ?? activeDate.getMonth() + 1;
    const nextDay = Math.min(day ?? activeDate.getDate(), daysInMonth(nextYear, nextMonth));
    updateDate(new Date(nextYear, nextMonth - 1, nextDay));
  };

  const toggleAllDay = (checked: boolean) => {
    setDraft(current => {
      if (checked) {
        return {
          ...current,
          isAllDay: true,
          endDate: dayNumber(current.endDate) < dayNumber(current.startDate)
            ? cloneDate(current.startDate)
            : current.endDate,
        };
      }
      const start = combineDateAndTime(current.startDate, current.startTime);
      let end = combineDateAndTime(current.endDate, current.endTime);
      if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 60 * 60000);
      const endParts = splitDateTime(end);
      return { ...current, isAllDay: false, endDate: endParts.date, endTime: endParts.time };
    });
  };

  const renderSummary = (summaryTarget: TimeTarget) => {
    const selected = target === summaryTarget;
    const date = summaryTarget === 'start' ? draft.startDate : draft.endDate;
    const time = summaryTarget === 'start' ? draft.startTime : draft.endTime;
    const danger = summaryTarget === 'end' && invalid;
    const color = danger ? C.red : selected ? C.primary : C.text;
    return (
      <TouchableOpacity
        style={[
          s.summaryEndpoint,
          summaryTarget === 'start' ? s.summaryStartEndpoint : s.summaryEndEndpoint,
        ]}
        onPress={() => setTarget(summaryTarget)}
        activeOpacity={0.65}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={summaryTarget === 'start' ? '编辑开始时间' : '编辑结束时间'}
      >
        <Text style={[s.summaryMain, { color }]}>
          {draft.isAllDay ? formatDate(date) : formatTime(time)}
        </Text>
        <Text style={[s.summaryMinor, { color }]}>
          {draft.isAllDay ? formatWeekday(date) : `${formatDate(date)} ${formatWeekday(date)}`}
        </Text>
      </TouchableOpacity>
    );
  };

  const dayOptions = React.useMemo(
    () => Array.from({ length: daysInMonth(activeDate.getFullYear(), activeDate.getMonth() + 1) }, (_, index) => index + 1),
    [activeDate],
  );
  const roundedMinuteIndex = Math.max(0, Math.min(MINUTE_OPTIONS.length - 1, Math.round(activeTime.getMinutes() / 5)));

  return (
    <CalendarSlidePage
      visible={visible}
      direction="vertical"
      testID="event-time-page"
      onRequestClose={onCancel}
    >
      <CalendarTextTitleBar
        title="时间"
        onLeft={onCancel}
        rightText="完成"
        onRight={() => {
          if (invalid) {
            onInvalid();
            return;
          }
          onDone(cloneValue(draft));
        }}
        rightTestID="event-time-done"
      />
      <View style={s.titleGap} />
      <View style={s.allDayRow} testID="event-time-all-day-row">
        <Text style={s.allDayText}>全天</Text>
        <CalendarSwitch
          checked={draft.isAllDay}
          onChange={toggleAllDay}
          accessibilityLabel="全天日程"
          testID="event-all-day-toggle"
        />
      </View>
      <View style={s.sectionDivider} />

      <View style={s.summaryRow}>
        {renderSummary('start')}
        {renderSummary('end')}
        <View style={s.summaryArrow}>
          <EventTimeRangeArrow testID="event-time-range-arrow" />
        </View>
      </View>

      <View style={s.pickerWrap}>
        {draft.isAllDay ? (
          <View key={`all-day-${target}`} style={s.wheels}>
            <TimeWheel
              values={YEAR_OPTIONS}
              selectedIndex={Math.max(0, Math.min(YEAR_OPTIONS.length - 1, activeDate.getFullYear() - 1900))}
              labelForIndex={year => `${year}年`}
              accessibilityLabel="年份"
              testID="event-time-year-wheel"
              onSelect={year => updateAllDayDate(year)}
            />
            <TimeWheel
              values={MONTH_OPTIONS}
              selectedIndex={activeDate.getMonth()}
              labelForIndex={month => `${month}月`}
              accessibilityLabel="月份"
              testID="event-time-month-wheel"
              onSelect={month => updateAllDayDate(undefined, month)}
            />
            <TimeWheel
              key={`${activeDate.getFullYear()}-${activeDate.getMonth()}`}
              values={dayOptions}
              selectedIndex={Math.min(dayOptions.length - 1, activeDate.getDate() - 1)}
              labelForIndex={day => `${day}日`}
              accessibilityLabel="日期"
              testID="event-time-day-wheel"
              onSelect={day => updateAllDayDate(undefined, undefined, day)}
            />
          </View>
        ) : (
          <View key={`timed-${target}`} style={s.wheels}>
            <TimeWheel
              values={DATE_OPTIONS}
              selectedIndex={dateOptionIndex(activeDate)}
              labelForIndex={index => {
                const date = dateFromOption(index);
                return `${formatDate(date, date.getFullYear() !== new Date().getFullYear())} ${formatWeekday(date)}`;
              }}
              accessibilityLabel="日期"
              testID="event-time-date-wheel"
              weight={2}
              onSelect={index => updateDate(dateFromOption(index))}
            />
            <TimeWheel
              values={HOUR_OPTIONS}
              selectedIndex={activeTime.getHours()}
              labelForIndex={hour => String(hour).padStart(2, '0')}
              accessibilityLabel="小时"
              testID="event-time-hour-wheel"
              onSelect={updateHour}
            />
            <TimeWheel
              values={MINUTE_OPTIONS}
              selectedIndex={roundedMinuteIndex}
              labelForIndex={minute => String(minute).padStart(2, '0')}
              accessibilityLabel="分钟"
              testID="event-time-minute-wheel"
              onSelect={updateMinute}
            />
          </View>
        )}
      </View>
      <View style={s.sectionDivider} />
    </CalendarSlidePage>
  );
}

const s = StyleSheet.create({
  titleGap: { height: 12 },
  allDayRow: { minHeight: 22, marginVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  allDayText: { flex: 1, fontSize: 16, lineHeight: 22, color: C.text },
  sectionDivider: { height: StyleSheet.hairlineWidth, marginLeft: 16, marginVertical: 14, backgroundColor: C.divider },
  summaryRow: { position: 'relative', minHeight: 66, flexDirection: 'row', alignItems: 'flex-start' },
  summaryEndpoint: { width: '50%', minWidth: 0, paddingTop: 11 },
  summaryStartEndpoint: { paddingLeft: 46, paddingRight: 12 },
  summaryEndEndpoint: { paddingLeft: 36, paddingRight: 16 },
  summaryMain: { fontSize: 18, lineHeight: 24 },
  summaryMinor: { marginTop: 1, fontSize: 14, lineHeight: 22 },
  summaryArrow: { position: 'absolute', left: '50%', top: 11, marginLeft: -4, width: 8, height: 32 },
  pickerWrap: { paddingVertical: 20 },
  wheels: { height: WHEEL_HEIGHT, flexDirection: 'row', paddingHorizontal: 16 },
  wheelColumn: { height: WHEEL_HEIGHT, overflow: 'hidden' },
  wheelContent: { paddingVertical: WHEEL_PADDING },
  wheelItem: { height: WHEEL_ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  wheelText: { fontSize: 17, lineHeight: 24, color: C.faint, textAlign: 'center' },
  wheelTextSelected: { fontSize: 20, lineHeight: 28, color: C.text, transform: [{ scaleX: 1.176 }] },
  wheelTextNear: { color: C.faint },
  wheelTextFar: { color: C.disabled },
  wheelDivider: { position: 'absolute', left: 8, right: 8, height: StyleSheet.hairlineWidth, backgroundColor: C.divider },
  wheelDividerTop: { top: WHEEL_PADDING },
  wheelDividerBottom: { top: WHEEL_PADDING + WHEEL_ITEM_HEIGHT },
});
