import React, { useMemo, useState } from 'react';
import {
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CalendarSlidePage } from './CalendarSlidePage';
import { dateFromKey, formatMonthTitle } from '../utils/calendarDate';
import { sortEventsForSearch } from '../utils/eventOrdering';
import {
  materializeEventOccurrencesCoveringDate,
  materializeEventsForSearch,
} from '../utils/eventRecurrence';
import { isValidEventDate } from '../utils/eventDraftValidation';
import { eventRefForEvent, eventRefKey } from '../utils/eventIdentity';
import { Colors as C } from '../theme/colors';
import type { CalEvent } from '../types';
import { eventListTitle } from '../utils/eventTitle';

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

  const requestedDates = searchDateKeys(query, today);
  if (requestedDates.length > 0) {
    return buildDateFilteredSearchGroups(events, query, requestedDates, today);
  }
  const matches = events.filter(event => searchableEventValues(event)
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery)));
  const projected = materializeEventsForSearch(matches, today);
  const sorted = sortEventsForSearch(projected, today);
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

function buildDateFilteredSearchGroups(
  events: CalEvent[],
  query: string,
  requestedDates: string[],
  today: Date,
): CalendarSearchGroup[] {
  const textQuery = queryWithoutDateTokens(query).trim().toLocaleLowerCase();
  const seen = new Set<string>();
  const entries = requestedDates.flatMap(groupDate => events.flatMap(event => (
    materializeEventOccurrencesCoveringDate(event, groupDate).flatMap(occurrence => {
      const key = `${groupDate}:${eventRefKey(eventRefForEvent(occurrence))}`;
      if (seen.has(key)) return [];
      if (textQuery && !searchableEventValues(occurrence)
        .some(value => value.toLocaleLowerCase().includes(textQuery))) return [];
      seen.add(key);
      return [{ event: occurrence, groupDate }];
    })
  )));
  const projections: CalEvent[] = entries.map(entry => ({
    ...entry.event,
    startDate: entry.groupDate,
    endDate: undefined,
    spanning: false,
  }));
  const entryForProjection = new Map(projections.map((projection, index) => [projection, entries[index]]));
  const sortedEntries = sortEventsForSearch(projections, today)
    .map(projection => entryForProjection.get(projection))
    .filter((entry): entry is (typeof entries)[number] => Boolean(entry));
  const groups: Omit<CalendarSearchGroup, 'showMonthHeader'>[] = [];
  const groupByDate = new Map<string, Omit<CalendarSearchGroup, 'showMonthHeader'>>();
  for (const entry of sortedEntries) {
    const existing = groupByDate.get(entry.groupDate);
    if (existing) {
      existing.events.push(entry.event);
      continue;
    }
    const date = dateFromKey(entry.groupDate);
    const group = {
      key: entry.groupDate,
      date,
      monthKey: entry.groupDate.slice(0, 7),
      events: [entry.event],
    };
    groups.push(group);
    groupByDate.set(entry.groupDate, group);
  }
  return groups.map((group, index) => ({
    ...group,
    showMonthHeader: index === 0 || groups[index - 1].monthKey !== group.monthKey,
  }));
}

function dateKey(year: number, month: number, day: number): string | null {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidEventDate(value) ? value : null;
}

function searchDateKeys(query: string, today: Date): string[] {
  const keys = new Set<string>();
  const fullDatePattern = /(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/g;
  for (const match of query.matchAll(fullDatePattern)) {
    const key = dateKey(Number(match[1]), Number(match[2]), Number(match[3]));
    if (key) keys.add(key);
  }
  if (keys.size === 0) {
    const monthDayPattern = /(^|\D)(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g;
    for (const match of query.matchAll(monthDayPattern)) {
      const key = dateKey(today.getFullYear(), Number(match[2]), Number(match[3]));
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

function queryWithoutDateTokens(query: string): string {
  return query
    .replace(/\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日?/g, ' ');
}

type HighlightSegment = {
  text: string;
  matchIndex?: number;
};

function splitHighlightSegments(text: string, query: string): HighlightSegment[] {
  const keyword = query.trim();
  if (!keyword) return [{ text }];

  const matcher = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let matchIndex = 0;

  for (const match of text.matchAll(matcher)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    segments.push({ text: match[0], matchIndex });
    cursor = start + match[0].length;
    matchIndex += 1;
  }

  if (cursor === 0) return [{ text }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

function HighlightedText({
  text,
  query,
  style,
  testID,
}: {
  text: string;
  query: string;
  style: StyleProp<TextStyle>;
  testID: string;
}) {
  const segments = splitHighlightSegments(text, query);

  return (
    <Text
      style={style}
      numberOfLines={1}
      accessibilityLabel={text}
      testID={testID}
    >
      {segments.map((segment, index) => (
        segment.matchIndex === undefined
          ? segment.text
          : (
            <Text
              key={`${index}-${segment.matchIndex}`}
              style={s.highlight}
              testID={`${testID}-highlight-${segment.matchIndex}`}
            >
              {segment.text}
            </Text>
          )
      ))}
    </Text>
  );
}

function searchableEventValues(event: CalEvent): string[] {
  const date = dateFromKey(event.startDate);
  const endDate = event.endDate ? dateFromKey(event.endDate) : null;
  return [
    event.title,
    event.startDate,
    event.endDate,
    `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`,
    `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
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
          <Image
            source={require('../../assets/calendar-search-empty.png')}
            style={s.noResultImage}
            resizeMode="contain"
            accessible={false}
            accessibilityIgnoresInvertColors
            testID="calendar-search-empty-asset"
          />
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
              query={queryWithoutDateTokens(query)}
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
  query,
  onPress,
}: {
  event: CalEvent;
  date: Date;
  showDate: boolean;
  query: string;
  onPress: () => void;
}) {
  const [pressed, setPressed] = useState(false);
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
      <Pressable
        style={[s.eventChip, taller && s.eventChipTall]}
        onPress={onPress}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        accessibilityRole="button"
        accessibilityLabel={`${eventListTitle(event.title)}，${event.startDate}，${eventTimeLabel(event)}`}
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
          <HighlightedText
            text={eventListTitle(event.title)}
            query={query}
            style={s.eventTitle}
            testID={`calendar-search-title-${event.id}`}
          />
          <Text style={s.eventMeta} numberOfLines={1}>
            {eventMetaLabel(event)}
          </Text>
          {supportingText ? (
            <HighlightedText
              text={`描述: ${supportingText}`}
              query={query}
              style={s.eventSupporting}
              testID={`calendar-search-description-${event.id}`}
            />
          ) : null}
        </View>
        {pressed ? (
          <View
            pointerEvents="none"
            accessible={false}
            style={s.eventPressedOverlay}
            testID={`calendar-search-pressed-${event.id}`}
          />
        ) : null}
      </Pressable>
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
    width: 160,
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noResultImage: { width: 160, height: 120 },
  noResultText: { marginTop: 12, fontSize: 14, lineHeight: 20, color: C.sub },
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
  eventPressedOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
    backgroundColor: C.pressed,
  },
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
  highlight: { color: C.primary, backgroundColor: C.primaryLight, fontWeight: '700' },
  dayGap: { height: 12 },
});
