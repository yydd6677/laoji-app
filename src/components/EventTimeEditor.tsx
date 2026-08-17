import React from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
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
  hasEndTime: boolean;
  isAllDay: boolean;
};

type TimeTarget = 'start' | 'end';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const WHEEL_ITEM_HEIGHT = 36;
const WHEEL_VISIBLE_ITEMS = 7;
const WHEEL_HEIGHT = WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE_ITEMS;
const WHEEL_PADDING = WHEEL_ITEM_HEIGHT * Math.floor(WHEEL_VISIBLE_ITEMS / 2);
const DATE_MIN_YEAR = 1900;
const DATE_MAX_YEAR = 2100;
const DATE_BASE = new Date(DATE_MIN_YEAR, 0, 1);
const DATE_MAX = new Date(DATE_MAX_YEAR, 11, 31);
const DATE_OPTION_COUNT = Math.round(
  (Date.UTC(DATE_MAX_YEAR + 1, 0, 1) - Date.UTC(DATE_MIN_YEAR, 0, 1)) / 86400000,
);
const DATE_OPTIONS = Array.from({ length: DATE_OPTION_COUNT }, (_, index) => index);
const YEAR_OPTIONS = Array.from(
  { length: DATE_MAX_YEAR - DATE_MIN_YEAR + 1 },
  (_, index) => DATE_MIN_YEAR + index,
);
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
    hasEndTime: value.hasEndTime,
    isAllDay: value.isAllDay,
  };
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
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

function normalizeDate(value: Date, fallback = new Date()): Date {
  const fallbackDate = isValidDate(fallback) ? fallback : DATE_BASE;
  const candidate = startOfDay(isValidDate(value) ? value : fallbackDate);
  if (dayNumber(candidate) < dayNumber(DATE_BASE)) return cloneDate(DATE_BASE);
  if (dayNumber(candidate) > dayNumber(DATE_MAX)) return cloneDate(DATE_MAX);
  return candidate;
}

function normalizeTime(value: Date, fallbackHour: number): Date {
  const source = isValidDate(value) ? value : new Date(2000, 0, 1, fallbackHour, 0);
  const minute = Math.max(0, Math.min(55, Math.round(source.getMinutes() / 5) * 5));
  return new Date(2000, 0, 1, source.getHours(), minute, 0, 0);
}

function normalizeValue(value: EventTimeValue): EventTimeValue {
  const startDate = normalizeDate(value.startDate);
  return {
    startDate,
    endDate: normalizeDate(value.endDate, startDate),
    startTime: normalizeTime(value.startTime, 10),
    endTime: normalizeTime(value.endTime, 11),
    hasEndTime: Boolean(value.hasEndTime),
    isAllDay: Boolean(value.isAllDay),
  };
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
  const boundedSelectedIndex = Math.max(0, Math.min(values.length - 1, selectedIndex));
  const [activeIndex, setActiveIndex] = React.useState(boundedSelectedIndex);
  const activeIndexRef = React.useRef(boundedSelectedIndex);

  React.useEffect(() => {
    const next = Math.max(0, Math.min(values.length - 1, selectedIndex));
    if (activeIndexRef.current === next) return;
    activeIndexRef.current = next;
    setActiveIndex(next);
    listRef.current?.scrollToIndex({ index: next, animated: false });
  }, [selectedIndex, values.length]);

  const choose = React.useCallback((index: number, scroll = true) => {
    const next = Math.max(0, Math.min(values.length - 1, index));
    if (activeIndexRef.current === next) {
      if (scroll) listRef.current?.scrollToIndex({ index: next, animated: true });
      return;
    }
    activeIndexRef.current = next;
    setActiveIndex(next);
    if (scroll) listRef.current?.scrollToIndex({ index: next, animated: true });
    onSelect(values[next], next);
  }, [onSelect, values]);

  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    choose(Math.round(event.nativeEvent.contentOffset.y / WHEEL_ITEM_HEIGHT), false);
  };

  const trackCenterItem = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    choose(Math.round(event.nativeEvent.contentOffset.y / WHEEL_ITEM_HEIGHT), false);
  };

  return (
    <View
      style={[s.wheelColumn, { flex: weight }]}
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{
        min: 0,
        max: values.length - 1,
        now: activeIndex,
        text: labelForIndex(values[activeIndex], activeIndex),
      }}
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
              accessibilityLabel={labelForIndex(item, index)}
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
        nestedScrollEnabled
        scrollEventThrottle={16}
        onScroll={trackCenterItem}
        onScrollEndDrag={settle}
        onMomentumScrollEnd={settle}
        testID={`${testID}-list`}
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
  const [draft, setDraft] = React.useState<EventTimeValue>(() => normalizeValue(value));
  const [target, setTarget] = React.useState<TimeTarget>(initialTarget);
  const incomingValueRef = React.useRef(value);
  const previousVisibleRef = React.useRef(false);
  incomingValueRef.current = value;

  React.useEffect(() => {
    const opening = visible && !previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (!opening) return;
    setDraft(normalizeValue(incomingValueRef.current));
    setTarget(initialTarget);
  }, [initialTarget, visible]);

  const startMoment = combineDateAndTime(draft.startDate, draft.startTime);
  const endMoment = combineDateAndTime(draft.endDate, draft.endTime);
  const invalid = draft.isAllDay
    ? dayNumber(draft.endDate) < dayNumber(draft.startDate)
    : draft.hasEndTime && endMoment.getTime() <= startMoment.getTime();
  const activeDate = target === 'start' ? draft.startDate : draft.endDate;
  const activeTime = target === 'start' ? draft.startTime : draft.endTime;

  const valueWithStartMoment = (current: EventTimeValue, nextStart: Date): EventTimeValue => {
    const currentStart = combineDateAndTime(current.startDate, current.startTime);
    const currentEnd = combineDateAndTime(current.endDate, current.endTime);
    const dateSpan = Math.max(0, dayNumber(current.endDate) - dayNumber(current.startDate));
    if (!current.hasEndTime) {
      const startParts = splitDateTime(nextStart);
      return {
        ...current,
        startDate: normalizeDate(startParts.date),
        startTime: normalizeTime(startParts.time, 10),
        endDate: normalizeDate(addDays(startParts.date, dateSpan), startParts.date),
      };
    }
    const duration = Math.max(5 * 60000, currentEnd.getTime() - currentStart.getTime());
    const nextEnd = new Date(nextStart.getTime() + duration);
    const startParts = splitDateTime(nextStart);
    const endParts = splitDateTime(nextEnd);
    return {
      ...current,
      startDate: normalizeDate(startParts.date),
      startTime: normalizeTime(startParts.time, 10),
      endDate: normalizeDate(endParts.date, startParts.date),
      endTime: normalizeTime(endParts.time, 11),
    };
  };

  const updateDate = (nextDate: Date) => {
    setDraft(current => {
      if (target === 'start') {
        if (current.isAllDay) {
          const span = Math.max(0, dayNumber(current.endDate) - dayNumber(current.startDate));
          return {
            ...current,
            startDate: normalizeDate(nextDate),
            endDate: normalizeDate(addDays(nextDate, span), nextDate),
          };
        }
        return valueWithStartMoment(current, combineDateAndTime(nextDate, current.startTime));
      }
      return { ...current, endDate: normalizeDate(nextDate, current.startDate) };
    });
  };

  const updateHour = (hour: number) => {
    setDraft(current => {
      const currentTime = target === 'start' ? current.startTime : current.endTime;
      const nextTime = cloneDate(currentTime);
      nextTime.setHours(hour, nextTime.getMinutes(), 0, 0);
      if (target === 'start') {
        return valueWithStartMoment(current, combineDateAndTime(current.startDate, nextTime));
      }
      return { ...current, endTime: normalizeTime(nextTime, 11) };
    });
  };

  const updateMinute = (minute: number) => {
    setDraft(current => {
      const currentTime = target === 'start' ? current.startTime : current.endTime;
      const nextTime = cloneDate(currentTime);
      nextTime.setMinutes(minute, 0, 0);
      if (target === 'start') {
        return valueWithStartMoment(current, combineDateAndTime(current.startDate, nextTime));
      }
      return { ...current, endTime: normalizeTime(nextTime, 11) };
    });
  };

  const updateAllDayDate = (year?: number, month?: number, day?: number) => {
    setDraft(current => {
      const currentDate = target === 'start' ? current.startDate : current.endDate;
      const nextYear = year ?? currentDate.getFullYear();
      const nextMonth = month ?? currentDate.getMonth() + 1;
      const nextDay = Math.min(day ?? currentDate.getDate(), daysInMonth(nextYear, nextMonth));
      const nextDate = new Date(nextYear, nextMonth - 1, nextDay);
      if (target === 'start') {
        const span = Math.max(0, dayNumber(current.endDate) - dayNumber(current.startDate));
        return {
          ...current,
          startDate: normalizeDate(nextDate),
          endDate: normalizeDate(addDays(nextDate, span), nextDate),
        };
      }
      return { ...current, endDate: normalizeDate(nextDate, current.startDate) };
    });
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
      if (!current.hasEndTime) return { ...current, isAllDay: false };
      let end = combineDateAndTime(current.endDate, current.endTime);
      if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 60 * 60000);
      const endParts = splitDateTime(end);
      return {
        ...current,
        isAllDay: false,
        endDate: normalizeDate(endParts.date, current.startDate),
        endTime: normalizeTime(endParts.time, 11),
      };
    });
  };

  const toggleEndTime = (checked: boolean) => {
    setDraft(current => {
      if (!checked) return { ...current, hasEndTime: false };
      const start = combineDateAndTime(current.startDate, current.startTime);
      let end = combineDateAndTime(current.endDate, current.endTime);
      if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 60 * 60000);
      const endParts = splitDateTime(end);
      return {
        ...current,
        hasEndTime: true,
        endDate: normalizeDate(endParts.date, current.startDate),
        endTime: normalizeTime(endParts.time, 11),
      };
    });
  };

  const renderSummary = (summaryTarget: TimeTarget) => {
    const selected = target === summaryTarget;
    const date = summaryTarget === 'start' ? draft.startDate : draft.endDate;
    const time = summaryTarget === 'start' ? draft.startTime : draft.endTime;
    const timeEnabled = summaryTarget === 'start' || draft.hasEndTime;
    const dateText = formatDate(date, date.getFullYear() !== new Date().getFullYear());
    const valueText = draft.isAllDay
      ? `${dateText} ${formatWeekday(date)}`
      : `${dateText} ${formatWeekday(date)} ${timeEnabled ? formatTime(time) : '未设置'}`;
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
        accessibilityLabel={`编辑${summaryTarget === 'start' ? '开始' : '结束'}${draft.isAllDay || !timeEnabled ? '日期' : '时间'}`}
        accessibilityValue={{ text: valueText }}
      >
        <Text style={[s.summaryMain, { color }]}>
          {draft.isAllDay ? dateText : timeEnabled ? formatTime(time) : '未设置'}
        </Text>
        <Text style={[s.summaryMinor, { color }]}>
          {draft.isAllDay ? formatWeekday(date) : `${dateText} ${formatWeekday(date)}`}
        </Text>
      </TouchableOpacity>
    );
  };

  const dayOptions = React.useMemo(
    () => Array.from({ length: daysInMonth(activeDate.getFullYear(), activeDate.getMonth() + 1) }, (_, index) => index + 1),
    [activeDate],
  );
  const minuteIndex = Math.max(0, MINUTE_OPTIONS.indexOf(activeTime.getMinutes()));
  const activeTimeEnabled = target === 'start' || draft.hasEndTime;

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
      <ScrollView
        style={s.pageScroll}
        contentContainerStyle={s.pageContent}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        testID="event-time-scroll"
      >
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

        {!draft.isAllDay ? (
          <View style={s.allDayRow} testID="event-time-end-enabled-row">
            <Text style={s.allDayText}>结束时间</Text>
            <CalendarSwitch
              checked={draft.hasEndTime}
              onChange={toggleEndTime}
              accessibilityLabel="结束时间"
              testID="event-end-time-toggle"
            />
          </View>
        ) : null}
        {!draft.isAllDay ? <View style={s.sectionDivider} /> : null}

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
                selectedIndex={Math.max(0, Math.min(YEAR_OPTIONS.length - 1, activeDate.getFullYear() - DATE_MIN_YEAR))}
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
              {activeTimeEnabled ? (
                <>
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
                    selectedIndex={minuteIndex}
                    labelForIndex={minute => String(minute).padStart(2, '0')}
                    accessibilityLabel="分钟"
                    testID="event-time-minute-wheel"
                    onSelect={updateMinute}
                  />
                </>
              ) : null}
            </View>
          )}
        </View>
        <View style={s.sectionDivider} />
      </ScrollView>
    </CalendarSlidePage>
  );
}

const s = StyleSheet.create({
  pageScroll: { flex: 1, backgroundColor: C.body },
  pageContent: { flexGrow: 1, paddingBottom: 16 },
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
