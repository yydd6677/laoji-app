export type ScopeKey = 'guest' | `user:${string}`;

export type MeetingOrigin = 'calendar' | 'ad_hoc' | 'file_import' | 'share_intent';

export type MeetingEntryPoint =
  | 'calendar_detail'
  | 'notification'
  | 'widget'
  | 'meeting_tab'
  | 'quick_tile'
  | 'document_picker'
  | 'share_intent'
  | 'legacy_store'
  | 'recorder_recovery';

export type MeetingLifecycle = 'draft' | 'active' | 'ended' | 'deleted';

export type MeetingCaptureMode = 'realtime' | 'offline' | 'whisper' | 'qwen';

export interface MeetingNote {
  id: string;
  scopeKey: ScopeKey;
  remoteId: string | null;
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
  remoteRevision: number | null;
  syncState: 'local' | 'pending' | 'synced' | 'conflicted' | 'deleted';
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs: number | null;
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
  if (value === 'guest') return true;
  if (!value.startsWith('user:')) return false;
  return value.slice('user:'.length).trim().length > 0;
}

export function assertScopeKey(value: string): asserts value is ScopeKey {
  if (!isScopeKey(value)) throw new Error('meeting scope key is invalid');
}
