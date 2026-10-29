import React, { useEffect, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeCalendarEditDraftSnapshot } from 'laoji-native-platform';
import { CalendarSlidePage } from './CalendarSlidePage';
import { CalendarTextTitleBar } from './CalendarTitleBar';
import { MotionPressable } from './MotionPressable';
import { useTheme } from '../theme/ThemeProvider';
import { isValidEventDate } from '../utils/eventDraftValidation';
import { SCHEDULE_PERIODS, schedulePeriodLabel } from '../domain/scheduleTime';

const ITEM = 40;
const years = Array.from({ length: 201 }, (_, i) => 1900 + i);
const months = Array.from({ length: 12 }, (_, i) => i + 1);
const hours = Array.from({ length: 24 }, (_, i) => i);
const minutes = Array.from({ length: 60 }, (_, i) => i);
const pad = (value: number) => String(value).padStart(2, '0');
const dateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function Wheel({ values, value, label, onChange, format = String }: {
  values: number[]; value: number; label: string; onChange: (value: number) => void; format?: (value: number) => string;
}) {
  const { colors: C } = useTheme();
  const list = useRef<FlatList<number>>(null);
  const selected = Math.max(0, values.indexOf(value));
  const current = useRef(selected);
  const change = (index: number, scroll: boolean) => {
    const bounded = Math.max(0, Math.min(values.length - 1, index));
    if (scroll) list.current?.scrollToIndex({ index: bounded, animated: true });
    if (bounded !== current.current) { current.current = bounded; onChange(values[bounded]); }
  };
  useEffect(() => {
    if (current.current === selected) return;
    current.current = selected;
    list.current?.scrollToIndex({ index: selected, animated: false });
  }, [selected]);
  return <View style={s.wheel} accessibilityRole="adjustable" accessibilityLabel={label}
    accessibilityValue={{ min: values[0], max: values[values.length - 1], now: value, text: format(value) }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={event => change(selected + (event.nativeEvent.actionName === 'increment' ? 1 : -1), true)}>
    <FlatList ref={list} data={values} initialScrollIndex={selected} keyExtractor={String}
      getItemLayout={(_, index) => ({ length: ITEM, offset: ITEM * index, index })}
      contentContainerStyle={{ paddingVertical: ITEM * 2 }} showsVerticalScrollIndicator={false}
      snapToInterval={ITEM} decelerationRate="fast" initialNumToRender={7} maxToRenderPerBatch={9} windowSize={5}
      onMomentumScrollEnd={event => change(Math.round(event.nativeEvent.contentOffset.y / ITEM), false)}
      onScrollEndDrag={event => change(Math.round(event.nativeEvent.contentOffset.y / ITEM), false)}
      renderItem={({ item }) => <MotionPressable style={s.wheelItem} onPress={() => change(values.indexOf(item), true)}
        accessibilityRole="button" accessibilityLabel={format(item)} accessibilityState={{ selected: item === value }}>
        <Text style={{ fontSize: 18, color: item === value ? C.primary : C.sub }}>{format(item)}</Text>
      </MotionPressable>} />
    <View pointerEvents="none" style={[s.selection, { borderColor: C.divider }]} />
  </View>;
}

/** Opening/cancelling is read-only. Temporary clocks only become values on
 * Done; unset, period and exact remain mutually exclusive. */
export function EventTimeEditor({ visible, dateOnly, value, onCancel, onDone, onInvalid }: {
  visible: boolean; dateOnly: boolean; value: NativeCalendarEditDraftSnapshot;
  onCancel: () => void; onDone: (value: NativeCalendarEditDraftSnapshot, baseline: NativeCalendarEditDraftSnapshot) => void; onInvalid: () => void;
}) {
  const { colors: C } = useTheme();
  const [draft, setDraft] = useState(value);
  const [target, setTarget] = useState<'start' | 'end'>('start');
  const priorVisible = useRef(false), incoming = useRef(value), baseline = useRef(value);
  incoming.current = value;
  useEffect(() => {
    if (visible && !priorVisible.current) { baseline.current = incoming.current; setDraft(incoming.current); setTarget('start'); }
    priorVisible.current = visible;
  }, [visible]);
  const precision = draft.timePrecision ?? (draft.startTime ? 'exact' : 'unspecified');
  const rawDate = target === 'start' ? draft.startDate : draft.endDate || draft.startDate;
  const activeDate = isValidEventDate(rawDate) ? new Date(`${rawDate}T12:00:00`) : new Date();
  const clock = (target === 'start' ? draft.startTime : draft.endTime) ?? (target === 'start' ? '10:00' : '11:00');
  const [hour, minute] = clock.split(':').map(Number);
  const endEnabled = Boolean(draft.endTime);
  const writeDate = (year: number, month: number, day: number) => {
    const next = dateKey(new Date(year, month - 1, Math.min(day, new Date(year, month, 0).getDate())));
    setDraft(current => target === 'end' ? { ...current, endDate: next }
      : { ...current, startDate: next, endDate: current.endDate === current.startDate ? next : current.endDate });
  };
  const writeClock = (nextHour: number, nextMinute: number) => setDraft(current => ({ ...current,
    timePrecision: 'exact', timePeriod: null, isAllDay: false,
    ...(target === 'start' ? { startTime: `${pad(nextHour)}:${pad(nextMinute)}` } : { endTime: `${pad(nextHour)}:${pad(nextMinute)}` }),
  }));
  const selectPrecision = (next: 'unspecified' | 'period' | 'exact') => {
    setTarget('start');
    setDraft(current => ({ ...current, timePrecision: next, isAllDay: false,
      timePeriod: next === 'period' ? current.timePeriod ?? 'morning' : null,
      startTime: next === 'exact' ? current.startTime ?? '10:00' : null,
      endTime: next === 'exact' ? current.endTime : null,
    }));
  };
  const choice = (key: string, label: string, selected: boolean, onPress: () => void) => <MotionPressable key={key}
    style={[s.choice, { borderBottomColor: C.divider }]} onPress={onPress} accessibilityRole="button"
    accessibilityLabel={label} accessibilityState={{ selected }}>
    <Text style={{ fontSize: 16, color: selected ? C.primary : C.text }}>{label}</Text>
    {selected ? <Text style={{ color: C.primary }}>✓</Text> : null}
  </MotionPressable>;
  return <CalendarSlidePage visible={visible} direction="vertical" onRequestClose={onCancel} testID="event-time-page">
    <CalendarTextTitleBar title={dateOnly ? '日期' : '时间'} onLeft={onCancel} rightText="完成" onRight={() => {
      const candidate = dateOnly && !draft.startDate ? { ...draft, startDate: dateKey(activeDate), endDate: dateKey(activeDate) } : draft;
      if (candidate.endDate && candidate.startDate && candidate.endDate < candidate.startDate
        || candidate.endTime && (!candidate.startTime || (candidate.endDate || candidate.startDate) === candidate.startDate && candidate.endTime <= candidate.startTime)) {
        onInvalid(); return;
      }
      onDone(candidate, baseline.current);
    }} />
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      {!dateOnly ? <>
        {choice('unset', '未设置', precision === 'unspecified', () => selectPrecision('unspecified'))}
        {choice('period', '时段', precision === 'period', () => selectPrecision('period'))}
        {choice('exact', '具体时间', precision === 'exact', () => selectPrecision('exact'))}
        {precision === 'period' ? SCHEDULE_PERIODS.map(period => choice(period, schedulePeriodLabel(period)!,
          draft.timePeriod === period, () => setDraft(current => ({ ...current, timePeriod: period as NativeCalendarEditDraftSnapshot['timePeriod'] })))) : null}
      </> : null}
      {!dateOnly && precision === 'exact' && endEnabled ? <View style={s.endpoints}>
        {choice('start', `开始 ${draft.startTime}`, target === 'start', () => setTarget('start'))}
        {choice('end', `结束 ${draft.endTime}`, target === 'end', () => setTarget('end'))}
      </View> : null}
      {dateOnly || precision === 'exact' ? <View style={s.wheels}>
        <Wheel values={years} value={activeDate.getFullYear()} label="年" format={year => `${year}年`}
          onChange={year => writeDate(year, activeDate.getMonth() + 1, activeDate.getDate())} />
        <Wheel values={months} value={activeDate.getMonth() + 1} label="月" format={month => `${month}月`}
          onChange={month => writeDate(activeDate.getFullYear(), month, activeDate.getDate())} />
        <Wheel values={Array.from({ length: new Date(activeDate.getFullYear(), activeDate.getMonth() + 1, 0).getDate() }, (_, i) => i + 1)}
          value={activeDate.getDate()} label="日" format={day => `${day}日`} onChange={day => writeDate(activeDate.getFullYear(), activeDate.getMonth() + 1, day)} />
      </View> : null}
      {!dateOnly && precision === 'exact' ? <>
        <View style={s.wheels}>
          <Wheel values={hours} value={hour} label="小时" format={pad} onChange={h => writeClock(h, minute)} />
          <Wheel values={minutes} value={minute} label="分钟" format={pad} onChange={m => writeClock(hour, m)} />
        </View>
        {choice('end-toggle', endEnabled ? '移除结束时间' : '添加结束时间', false, () => {
          setTarget(endEnabled ? 'start' : 'end');
          setDraft(current => ({ ...current, startTime: current.startTime ?? '10:00', endTime: endEnabled ? null : '11:00' }));
        })}
      </> : null}
    </ScrollView>
  </CalendarSlidePage>;
}

const s = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 24 }, choice: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth },
  endpoints: { paddingTop: 8 }, wheels: { flexDirection: 'row', height: ITEM * 5 }, wheel: { flex: 1, height: ITEM * 5 },
  wheelItem: { height: ITEM, alignItems: 'center', justifyContent: 'center' },
  selection: { position: 'absolute', top: ITEM * 2, height: ITEM, left: 0, right: 0, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
});
