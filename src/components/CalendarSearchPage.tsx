import React, { useMemo, useState } from 'react';
import {
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CalendarSlidePage } from './CalendarSlidePage';
import { dateFromKey, formatMonthTitle } from '../utils/calendarDate';
import { sortEventsForSearch } from '../utils/eventOrdering';
import { materializeEventsForSearch } from '../utils/eventRecurrence';
import { Colors as C } from '../theme/colors';
import type { CalEvent } from '../types';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export type CalendarSearchGroup = {
  key: string;
  date: Date;
  monthKey: string;
  showMonthHeader: boolean;
  events: CalEvent[];
};

export function buildCalendarSearchGroups(
  events: CalEvent[],
  query: string,
  today = new Date(),
): CalendarSearchGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const matches = events.filter(event => searchableEventValues(event)
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery)));
  const sorted = sortEventsForSearch(materializeEventsForSearch(matches, today), today);
  const groups: Omit<CalendarSearchGroup, 'showMonthHeader'>[] = [];
  const groupByDate = new Map<string, Omit<CalendarSearchGroup, 'showMonthHeader'>>();

  sorted.forEach(event => {
    const existing = groupByDate.get(event.startDate);
    if (existing) {
      existing.events.push(event);
      return;
    }
    const date = dateFromKey(event.startDate);
    const group = {
      key: event.startDate,
      date,
      monthKey: event.startDate.slice(0, 7),
      events: [event],
    };
    groups.push(group);
    groupByDate.set(event.startDate, group);
  });

  return groups.map((group, index) => ({
    ...group,
    showMonthHeader: index === 0 || groups[index - 1].monthKey !== group.monthKey,
  }));
}

function searchableEventValues(event: CalEvent): string[] {
  const date = dateFromKey(event.startDate);
  const endDate = event.endDate ? dateFromKey(event.endDate) : null;
  return [
    event.title,
    event.startDate,
    event.endDate,
    `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`,
    `${date.getMonth() + 1}月${date.getDate()}日`,
    endDate ? `${endDate.getMonth() + 1}月${endDate.getDate()}日` : '',
    event.startTime,
    event.endTime,
    event.location,
    event.description,
    event.detail,
    event.rawText,
    event.category,
  ].filter((value): value is string => Boolean(value));
}

export function CalendarSearchPage({
  visible,
  events,
  onOpenEvent,
  onClose,
}: {
  visible: boolean;
  events: CalEvent[];
  onOpenEvent: (event: CalEvent) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () => buildCalendarSearchGroups(events, query),
    [events, query],
  );

  const close = () => {
    setQuery('');
    Keyboard.dismiss();
    onClose();
  };

  return (
    <CalendarSlidePage
      visible={visible}
      onRequestClose={close}
      testID="calendar-search-page"
    >
      <View style={s.header} testID="calendar-search-header">
        <TouchableOpacity
          style={s.backButton}
          onPress={close}
          activeOpacity={0.68}
          accessibilityRole="button"
          accessibilityLabel="退出搜索"
        >
          <Ionicons name="chevron-back" size={24} color={C.text} />
        </TouchableOpacity>
        <View style={s.searchBar} testID="calendar-search-bar">
          <Ionicons name="search-outline" size={20} color={C.faint} />
          <TextInput
            autoFocus={visible}
            style={s.input}
            placeholder="搜索"
            placeholderTextColor={C.faint}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            maxLength={100}
            accessibilityLabel="搜索日程"
            testID="calendar-search-input"
          />
          <TouchableOpacity
            style={s.clearButton}
            onPress={() => setQuery('')}
            disabled={!query}
            activeOpacity={0.68}
            accessibilityRole="button"
            accessibilityLabel="清空搜索内容"
            accessibilityState={{ disabled: !query }}
            testID="calendar-search-clear"
          >
            {query ? <Ionicons name="close-circle" size={20} color={C.faint} /> : null}
          </TouchableOpacity>
        </View>
      </View>

      <SearchBody
        query={query}
        groups={groups}
        onOpenEvent={onOpenEvent}
      />
    </CalendarSlidePage>
  );
}

function SearchBody({
  query,
  groups,
  onOpenEvent,
}: {
  query: string;
  groups: CalendarSearchGroup[];
  onOpenEvent: (event: CalEvent) => void;
}) {
  if (!query.trim()) {
    return <View style={s.idle} testID="calendar-search-idle" />;
  }

  if (groups.length === 0) {
    return (
      <View style={s.noResult} testID="calendar-search-empty">
        <View style={s.noResultArtwork}>
          <Ionicons name="search-outline" size={58} color={C.disabled} />
        </View>
        <Text style={s.noResultText}>无相关结果</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={s.results}
      contentContainerStyle={s.resultsContent}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      testID="calendar-search-results"
    >
      {groups.map(group => (
        <View key={group.key} testID={`calendar-search-group-${group.key}`}>
          {group.showMonthHeader ? (
            <Text style={s.monthTitle} testID={`calendar-search-month-${group.monthKey}`}>
              {formatMonthTitle(group.date)}
            </Text>
          ) : null}
          {group.events.map((event, index) => (
            <SearchEventRow
              key={event.id}
              event={event}
              date={group.date}
              showDate={index === 0}
              onPress={() => onOpenEvent(event)}
            />
          ))}
          <View
            style={s.dayGap}
            testID={`calendar-search-day-gap-${group.key}`}
          />
        </View>
      ))}
    </ScrollView>
  );
}

function SearchEventRow({
  event,
  date,
  showDate,
  onPress,
}: {
  event: CalEvent;
  date: Date;
  showDate: boolean;
  onPress: () => void;
}) {
  const supportingText = event.description || event.detail;
  const taller = Boolean(supportingText);
  const today = isToday(date);

  return (
    <View
      style={[s.eventLine, taller && s.eventLineTall]}
      testID={`calendar-search-event-${event.id}`}
    >
      <View style={s.dateLane}>
        {showDate ? (
          <>
            <Text style={[s.weekday, today && s.todayText]}>{WEEKDAYS[date.getDay()]}</Text>
            <Text style={[s.monthDay, today && s.todayText]}>{date.getDate()}</Text>
          </>
        ) : null}
      </View>
      <TouchableOpacity
        style={[s.eventChip, taller && s.eventChipTall]}
        onPress={onPress}
        activeOpacity={0.72}
        accessibilityRole="button"
        accessibilityLabel={`${event.title}，${event.startDate}，${eventTimeLabel(event)}`}
        testID={`calendar-search-chip-${event.id}`}
      >
        <View
          style={s.eventStrip}
          testID={`calendar-search-strip-${event.id}`}
        />
        <View
          style={s.eventCopy}
          testID={`calendar-search-copy-${event.id}`}
        >
          <Text style={s.eventTitle} numberOfLines={1}>{event.title}</Text>
          <Text style={s.eventMeta} numberOfLines={1}>
            {eventMetaLabel(event)}
          </Text>
          {supportingText ? (
            <Text style={s.eventSupporting} numberOfLines={1}>
              {`描述: ${supportingText}`}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    </View>
  );
}

function eventTimeLabel(event: CalEvent): string {
  const time = event.startTime && event.endTime
    ? `${event.startTime} - ${event.endTime}`
    : event.startTime || '全天';
  if (!event.spanning || !event.endDate || event.endDate === event.startDate) return time;
  const end = dateFromKey(event.endDate);
  return `${time} · 至${end.getMonth() + 1}月${end.getDate()}日`;
}

function eventMetaLabel(event: CalEvent): string {
  const time = eventTimeLabel(event);
  return event.location ? `${time} ${event.location}` : time;
}

function isToday(date: Date): boolean {
  const today = new Date();
  return date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
}

const s = StyleSheet.create({
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.body,
  },
  backButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBar: {
    flex: 1,
    height: 56,
    paddingLeft: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    height: 56,
    paddingTop: 15,
    paddingBottom: 15,
    paddingHorizontal: 11,
    fontSize: 22,
    lineHeight: 26,
    color: C.text,
  },
  clearButton: {
    width: 56,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  idle: { flex: 1, backgroundColor: C.body },
  noResult: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 80,
    backgroundColor: C.body,
  },
  noResultArtwork: {
    width: 116,
    height: 116,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noResultText: { marginTop: 10, fontSize: 14, lineHeight: 20, color: C.sub },
  results: { flex: 1, backgroundColor: C.body },
  resultsContent: { paddingTop: 14, paddingBottom: 28 },
  monthTitle: {
    marginLeft: 16,
    marginTop: 5,
    marginBottom: 17,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
    color: C.text,
  },
  eventLine: {
    minHeight: 60,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  eventLineTall: { minHeight: 78 },
  dateLane: {
    width: 57,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekday: { fontSize: 12, lineHeight: 17, fontWeight: '700', color: C.text },
  monthDay: { fontSize: 20, lineHeight: 24, fontWeight: '700', color: C.text },
  todayText: { color: C.primary },
  eventChip: {
    flex: 1,
    height: 50,
    marginRight: 5,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: C.primaryLight,
  },
  eventChipTall: { height: 68 },
  eventStrip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 2,
    backgroundColor: C.primary,
  },
  eventCopy: {
    flex: 1,
    minWidth: 0,
    paddingLeft: 8,
    paddingRight: 6,
    paddingTop: 4,
  },
  eventTitle: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: C.text },
  eventMeta: { marginTop: 2, fontSize: 12, lineHeight: 16, color: C.sub },
  eventSupporting: { marginTop: 2, fontSize: 12, lineHeight: 16, color: C.sub },
  dayGap: { height: 12 },
});
