export const NATIVE_PLATFORM_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const NATIVE_CALENDAR_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface NativePlatformCapabilities {
  calendarSurface: boolean;
  minutesSurface: boolean;
  nativeAudioRuntime: boolean;
  mediaPlayer: boolean;
}

export type NativeAudioPurpose = 'schedule' | 'meeting';

export type NativeAudioSessionState =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'localSaved'
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed';

export interface NativeCalendarEventSnapshot {
  sourceEventId: string;
  occurrenceDate: string;
  title: string;
  startEpochDay: number;
  endEpochDay: number;
  /** Half-open end used by all-day layout; timed events leave it null. */
  endEpochDayExclusive?: number | null;
  startMinutes: number | null;
  endMinutes: number | null;
  timeZoneId: string;
  allDay: boolean;
  editable: boolean;
  revision: number;
  /** Optional Feishu-compatible timed-event rectangle in percentages. */
  instanceLayout?: NativeCalendarInstanceLayout | null;
}

// CAL-DAY-COMPOSE-001: source-shaped percentage rectangle for the native timed-event layer.
export interface NativeCalendarInstanceLayout {
  xOffsetPercent: number;
  yOffsetPercent: number;
  widthPercent: number;
  heightPercent: number;
  zIndex?: number;
  fullDisplayWidthPercent?: number | null;
}

export interface NativeCalendarSettings {
  defaultEventDurationMinutes: number;
  firstDayOfWeek: 0;
}

export interface NativeCalendarRangeSnapshot {
  schemaVersion: typeof NATIVE_CALENDAR_SNAPSHOT_SCHEMA_VERSION;
  generation: number;
  rangeStartEpochDay: number;
  rangeEndEpochDayExclusive: number;
  selectedEpochDay: number;
  todayEpochDay: number;
  settings: NativeCalendarSettings;
  events: NativeCalendarEventSnapshot[];
}

export type NativeCalendarMutationKind = 'move' | 'resize-start' | 'resize-end';

export interface NativeCalendarMutationRequest {
  operationId: string;
  kind: NativeCalendarMutationKind;
  sourceEventId: string;
  occurrenceDate: string;
  startEpochDay: number;
  endEpochDay: number;
  startMinutes: number | null;
  endMinutes: number | null;
  baseRevision: number;
}

export interface NativeCalendarMutationResolution {
  operationId: string;
  accepted: boolean;
  replacement?: NativeCalendarEventSnapshot;
  message?: string;
}
