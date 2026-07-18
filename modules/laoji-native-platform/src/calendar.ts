import { requireNativeViewManager } from 'expo-modules-core';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

// CAL-ROOT-001: TypeScript observes low-frequency calendar semantics, never native drag frames.

import type {
  NativeCalendarEventSnapshot,
  NativeCalendarMutationRequest,
  NativeCalendarMutationResolution,
  NativeCalendarRangeSnapshot,
} from './contracts';
import type { NativeTabPressEvent } from './ui';

export type NativeCalendarMode = 'month' | 'day';

export interface NativeCalendarModeChangeEvent {
  mode: NativeCalendarMode;
}

export interface NativeCalendarVisibleRangeEvent {
  mode: NativeCalendarMode;
  rangeStartEpochDay: number;
  rangeEndEpochDayExclusive: number;
  selectedEpochDay: number;
  source: 'swipe' | 'picker' | 'mode-change' | 'month' | 'day-strip' | string;
}

export interface NativeCalendarDateSelectEvent {
  epochDay: number;
  source: 'month' | 'day-strip' | 'picker' | string;
}

export interface NativeCalendarEventOpenEvent
  extends Omit<NativeCalendarEventSnapshot, 'startMinutes' | 'endMinutes'> {
  startMinutes?: number;
  endMinutes?: number;
}

export interface NativeCalendarDraftEvent {
  active?: boolean;
  reason?: 'created' | 'adjusted' | 'cancelled' | 'disposed' | string;
  startEpochDay?: number;
  endEpochDay?: number;
  startMinutes?: number;
  endMinutes?: number;
  allDay?: false;
}

export interface NativeCalendarCreateEvent {
  startEpochDay: number;
  endEpochDay: number;
  startMinutes: number;
  endMinutes: number;
  allDay: false;
}

export interface NativeCalendarMutationResolvedEvent {
  operationId: string;
  status: 'ack' | 'rollback' | 'ignored';
  message?: string;
}

export interface NativeCalendarPickerStateEvent {
  open: boolean;
  year: number;
  month: number;
  preservedDayOfMonth: number;
  reason: string;
}

export interface NativeCalendarSemanticEvent {
  type:
    | 'mode-change'
    | 'month-change'
    | 'date-select'
    | 'event-open'
    | 'profile-open'
    | 'search-open'
    | 'create-menu'
    | 'create-voice'
    | 'create-manual'
    | 'create-request'
    | 'picker-open'
    | 'picker-close'
    | 'mutation-commit'
    | 'mutation-ack'
    | 'mutation-rollback'
    | 'mutation-ignored'
    | 'mutation-blocked'
    | 'snapshot-rejected'
    | 'back-today'
    | `draft-${string}`;
  [key: string]: string | number | boolean | undefined;
}

type NativeEventHandler<T> = (event: NativeSyntheticEvent<T>) => void;

export interface LaojiCalendarViewProps extends ViewProps {
  mode?: NativeCalendarMode;
  snapshot?: NativeCalendarRangeSnapshot | null;
  selectedEpochDay?: number | null;
  visibleMonthEpochDay?: number | null;
  // UI-SHELL-BOTTOM-MAIN-001: selection motion resumes in the newly active native root.
  bottomBarSelectionCommand?: number | null;
  mutationResolution?: NativeCalendarMutationResolution | null;
  onModeChange?: NativeEventHandler<NativeCalendarModeChangeEvent>;
  onVisibleRangeChange?: NativeEventHandler<NativeCalendarVisibleRangeEvent>;
  onDateSelect?: NativeEventHandler<NativeCalendarDateSelectEvent>;
  onEventOpen?: NativeEventHandler<NativeCalendarEventOpenEvent>;
  onCreateEvent?: NativeEventHandler<NativeCalendarCreateEvent>;
  onDraftChange?: NativeEventHandler<NativeCalendarDraftEvent>;
  onMutationCommit?: NativeEventHandler<NativeCalendarMutationRequest>;
  onMutationResolved?: NativeEventHandler<NativeCalendarMutationResolvedEvent>;
  onPickerStateChange?: NativeEventHandler<NativeCalendarPickerStateEvent>;
  onSemanticEvent?: NativeEventHandler<NativeCalendarSemanticEvent>;
  onTabPress?: NativeEventHandler<NativeTabPressEvent>;
}

export const LaojiCalendarView = requireNativeViewManager<LaojiCalendarViewProps>(
  'LaojiCalendar',
);
