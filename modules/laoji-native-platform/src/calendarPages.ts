import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { Platform, View } from 'react-native';
import { requireNativeViewManager } from 'expo-modules-core';

// CAL-SEARCH-001 / CAL-DETAIL-001 / CAL-EDIT-001: route snapshots are structured and repository-free.
export const CALENDAR_PAGE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export type CalendarPageLoadState = 'loading' | 'ready' | 'empty' | 'error';

export interface CalendarPageEventRefSnapshot {
  sourceEventId: string;
  occurrenceDate: string;
}

export interface NativeCalendarSearchResultSnapshot extends CalendarPageEventRefSnapshot {
  title: string;
  dateLabel: string;
  timeLabel: string;
  monthLabel: string;
  dayLabel: string;
  weekdayLabel: string;
  showDate: boolean;
}

export interface NativeCalendarSearchSnapshot {
  schemaVersion: typeof CALENDAR_PAGE_SNAPSHOT_SCHEMA_VERSION;
  query: string;
  state: CalendarPageLoadState;
  message?: string;
  results: readonly NativeCalendarSearchResultSnapshot[];
}

export interface NativeCalendarDetailEventSnapshot extends CalendarPageEventRefSnapshot {
  title: string;
  timeLabel: string;
  repeatLabel?: string;
  location?: string;
  notes?: string;
  reminderLabel?: string;
  recurring: boolean;
  recurrenceException: boolean;
  editable: boolean;
}

export interface NativeCalendarDetailSnapshot {
  schemaVersion: typeof CALENDAR_PAGE_SNAPSHOT_SCHEMA_VERSION;
  state: CalendarPageLoadState;
  message?: string;
  event?: NativeCalendarDetailEventSnapshot;
  deleting?: boolean;
}

export interface NativeCalendarEditDraftSnapshot {
  title: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  isAllDay: boolean;
  repeat: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  reminderMinutes: number | null;
  location: string;
  notes: string;
}

export interface NativeCalendarEditSnapshot {
  schemaVersion: typeof CALENDAR_PAGE_SNAPSHOT_SCHEMA_VERSION;
  state: CalendarPageLoadState;
  message?: string;
  draft: NativeCalendarEditDraftSnapshot;
  editing: boolean;
  recurring: boolean;
  recurrenceException: boolean;
  saving: boolean;
  dirty: boolean;
}

export type NativeCalendarSearchAction =
  | { type: 'close' | 'retry' }
  | { type: 'queryChange'; query: string }
  | ({ type: 'openEvent' } & CalendarPageEventRefSnapshot);

export type NativeCalendarDetailAction =
  | ({ type: 'back' | 'edit' | 'delete' | 'retry' } & Partial<CalendarPageEventRefSnapshot>);

export type NativeCalendarEditAction =
  | { type: 'cancel' | 'delete' | 'retry' }
  | { type: 'save' | 'openRepeat' | 'openReminder'; draft: NativeCalendarEditDraftSnapshot }
  | { type: 'draftChange'; draft: NativeCalendarEditDraftSnapshot }
  | { type: 'feedback'; message: string; durationMs?: number };

type NativeActionHandler<T> = (event: NativeSyntheticEvent<T>) => void;

interface CalendarDetailViewProps extends ViewProps {
  snapshot: NativeCalendarDetailSnapshot;
  onAction?: NativeActionHandler<NativeCalendarDetailAction>;
}

interface CalendarEditViewProps extends ViewProps {
  snapshot: NativeCalendarEditSnapshot;
  onAction?: NativeActionHandler<NativeCalendarEditAction>;
}

function nativeView<T extends ViewProps>(name: string): ComponentType<T> {
  return Platform.OS === 'android'
    ? requireNativeViewManager<T>(name)
    : View as unknown as ComponentType<T>;
}

export const LaojiCalendarDetailView = nativeView<CalendarDetailViewProps>('LaojiCalendarDetail');
export const LaojiCalendarEditView = nativeView<CalendarEditViewProps>('LaojiCalendarEdit');
