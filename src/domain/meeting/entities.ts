/** Stable SQLite wire value for the installation-local data owner. */
export type ScopeKey = 'guest';

export type MeetingOrigin = 'calendar' | 'ad_hoc' | 'file_import' | 'share_intent';

export type MeetingEntryPoint =
  | 'calendar_detail'
  | 'notification'
  | 'widget'
  | 'meeting_tab'
  | 'quick_tile'
  | 'document_picker'
  | 'share_intent'
  | 'recorder_recovery';

export type MeetingLifecycle = 'draft' | 'active' | 'ended' | 'deleted';

export type MeetingCaptureMode = 'realtime' | 'offline';

export interface MeetingNote {
  id: string;
  scopeKey: ScopeKey;
  legacySourceId: string | null;
  origin: MeetingOrigin;
  entryPoint: MeetingEntryPoint | null;
  title: string;
  description: string | null;
  participants: readonly string[];
  location: string | null;
  mode: MeetingCaptureMode | null;
  clientRequestId: string | null;
  recordedAtMs: number | null;
  lifecycle: MeetingLifecycle;
  startedAtMs: number | null;
  endedAtMs: number | null;
  currentSummaryVersionId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs: number | null;
  /** Exact lifecycle captured by the deletion transaction; null for legacy tombstones. */
  deletedFromLifecycle: Exclude<MeetingLifecycle, 'deleted'> | null;
}

export interface OccurrenceReference {
  sourceEventId: string;
  occurrenceDate: string;
}

export interface ScheduleSnapshot {
  eventTitle: string;
  plannedStartMs: number | null;
  plannedEndMs: number | null;
  allDay: boolean;
  timezoneId: string | null;
  location: string | null;
  participants: readonly string[];
  description: string | null;
  capturedEventRevision: number | null;
  capturedAtMs: number;
}

export function isScopeKey(value: string): value is ScopeKey {
  return value === 'guest';
}

export function assertScopeKey(value: string): asserts value is ScopeKey {
  if (!isScopeKey(value)) throw new Error('meeting scope key is invalid');
}

export function calendarMeetingSeriesKey(scopeKey: ScopeKey, sourceEventId: string): string {
  assertScopeKey(scopeKey);
  const normalizedSourceId = sourceEventId.trim();
  if (!normalizedSourceId || normalizedSourceId.length > 512) {
    throw new Error('calendar series source is invalid');
  }
  return `calendar:${scopeKey}:${normalizedSourceId}`;
}
