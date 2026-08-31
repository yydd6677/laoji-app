export const NATIVE_CALENDAR_SNAPSHOT_SCHEMA_VERSION = 1 as const;

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
  /** Legacy LaoJi event bucket; native rendering derives its stable hue from this value. */
  category?: string | null;
  startEpochDay: number;
  endEpochDay: number;
  /** Half-open end used by all-day layout; timed events leave it null. */
  endEpochDayExclusive?: number | null;
  startMinutes: number | null;
  endMinutes: number | null;
  /** Spoken period such as 下午 when an exact clock was not provided. */
  timePeriodLabel?: string | null;
  timeZoneId: string;
  allDay: boolean;
  editable: boolean;
  revision: number;
  /** Optional timed-event rectangle in percentages. */
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
  projection?: NativeProjectionEnvelope | null;
}

export interface NativeProjectionEnvelope {
  deviceEpoch: string;
  entityId: string;
  entityRevision: number;
  viewRevision: number;
  surfaceInstanceId: string;
  payloadSha256: string;
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
  projection?: NativeProjectionEnvelope | null;
}

export interface NativeCalendarMutationResolution {
  operationId: string;
  accepted: boolean;
  replacement?: NativeCalendarEventSnapshot;
  message?: string;
}
