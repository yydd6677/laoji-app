import type { MeetingOrigin } from '../../../domain/meeting';

export interface MeetingCapabilities {
  schemaVersion: number;
  meetingNotesV2: boolean;
  structuredSummaryV2: boolean;
  summaryCitations: boolean;
  summaryAttachmentsText: boolean;
  summaryAttachmentsImage: boolean;
  meetingQuestionsV1: boolean;
  actionItemsV2: boolean;
  actionItemsPullV2: boolean;
  manualNotesV2: boolean;
  occurrenceLinksV2: boolean;
  speakerCorrections: boolean;
  mediaImport: {
    mimeTypes: readonly string[];
    maxBytes: number;
  } | null;
  syncCursor: boolean;
  softDeleteDays: number | null;
}

export interface CreateMeetingNoteV2Request {
  schema_version: 2;
  client_note_id: string;
  client_request_id: string | null;
  origin: MeetingOrigin;
  entry_point:
    | 'calendar_detail'
    | 'notification'
    | 'widget'
    | 'meeting_tab'
    | 'quick_tile'
    | 'document_picker'
    | 'share_intent'
    | 'legacy_store'
    | 'recorder_recovery'
    | null;
  title: string;
  description: string | null;
  participants: readonly string[];
  location: string | null;
  mode: 'realtime' | 'offline' | 'whisper' | 'qwen';
  recorded_at: string | null;
  occurrence_ref?: {
    source_event_id: string;
    occurrence_date: string;
    calendar_revision?: number | null;
    recurrence_segment_id?: string | null;
    series_key?: string | null;
  };
  schedule_snapshot?: {
    event_title: string;
    planned_start_ms: number | null;
    planned_end_ms: number | null;
    all_day: boolean;
    timezone_id: string | null;
    location: string | null;
    participants: readonly string[];
    description: string | null;
    captured_event_revision: number | null;
    captured_at_ms: number;
  };
}

export interface UpdateMeetingNoteV2Request {
  schema_version: 2;
  title?: string;
  description?: string | null;
  participants?: readonly string[];
  location?: string | null;
  mode?: 'realtime' | 'offline' | 'whisper' | 'qwen';
  status?: string;
  recorded_at?: string | null;
}

export interface MeetingNoteV2Response {
  schema_version: 2;
  id: string;
  client_note_id: string;
  revision: number;
  origin: MeetingOrigin;
  entry_point: CreateMeetingNoteV2Request['entry_point'];
  title: string;
  description: string | null;
  participants: readonly string[];
  location: string | null;
  mode: CreateMeetingNoteV2Request['mode'];
  status: string;
  recorded_at: string | null;
  lifecycle: 'active' | 'deleted';
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  occurrence_ref: (NonNullable<CreateMeetingNoteV2Request['occurrence_ref']> & {
    id: string;
    revision: number;
    link_state: 'active' | 'orphaned';
  }) | null;
  schedule_snapshot: NonNullable<CreateMeetingNoteV2Request['schedule_snapshot']> | null;
  processing_stages: readonly {
    stage: 'capture' | 'upload' | 'transcript' | 'summary' | 'speaker';
    status: string;
    attempt: number;
    progress?: number | null;
    error_code?: string | null;
    retryable?: boolean;
  }[];
}

export interface RemoteMeetingNoteV2 {
  remoteId: string;
  clientNoteId: string;
  revision: number;
  origin: MeetingOrigin;
  entryPoint: CreateMeetingNoteV2Request['entry_point'];
  title: string;
  description: string | null;
  participants: readonly string[];
  location: string | null;
  mode: CreateMeetingNoteV2Request['mode'];
  status: string;
  recordedAtMs: number | null;
  lifecycle: 'active' | 'deleted';
  deletedAtMs: number | null;
  occurrenceRef: MeetingNoteV2Response['occurrence_ref'];
  scheduleSnapshot: MeetingNoteV2Response['schedule_snapshot'];
  processingStages: MeetingNoteV2Response['processing_stages'];
  serverCreatedAtMs: number;
  serverUpdatedAtMs: number;
}

export interface ProcessingJobV2Response {
  job_id: string;
  meeting_id: string;
  stage: 'upload' | 'transcript' | 'summary' | 'speaker';
  status: string;
  attempt: number;
  progress: number | null;
  error_code: string | null;
  retryable: boolean;
  result_revision_id: string | null;
}

export interface ActionItemV2Mutation {
  schema_version: 2;
  meeting_remote_id: string;
  action_id: string;
  remote_id: string | null;
  expected_remote_revision: number | null;
  client_created_at_ms: number;
  client_updated_at_ms: number;
  user_edited_at_ms: number | null;
  completed_at_ms: number | null;
  content: string;
  status: 'pending' | 'completed' | 'dismissed';
  assignee: string | null;
  due_at_ms: number | null;
  reminder_at_ms: number | null;
  followup_event_source_id: string | null;
  source_kind: 'generated' | 'manual' | 'marker';
  source_summary_version_id: string | null;
  source_segment_id: string | null;
  source_start_ms: number | null;
  generation_fingerprint: string | null;
}

export interface ActionItemV2Response {
  id: string;
  clientActionId: string;
  revision: number;
}

export interface RemoteActionItemV2 {
  remoteId: string;
  meetingRemoteId: string;
  clientActionId: string;
  revision: number;
  clientCreatedAtMs: number;
  clientUpdatedAtMs: number;
  userEditedAtMs: number | null;
  completedAtMs: number | null;
  content: string;
  status: 'pending' | 'completed' | 'dismissed';
  assignee: string | null;
  dueAtMs: number | null;
  reminderAtMs: number | null;
  followupEventSourceId: string | null;
  sourceKind: 'generated' | 'manual' | 'marker';
  sourceSummaryVersionId: string | null;
  sourceSegmentId: string | null;
  sourceStartMs: number | null;
  generationFingerprint: string | null;
  serverCreatedAtMs: number;
  serverUpdatedAtMs: number;
}

export interface ActionItemV2Page {
  meetingRemoteId: string;
  items: readonly RemoteActionItemV2[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ManualNoteV2Mutation {
  schema_version: 2;
  meeting_remote_id: string;
  expected_remote_revision: number | null;
  client_note_revision: number;
  client_updated_at_ms: number;
  user_edited_at_ms: number | null;
  content: string;
}

export interface RemoteManualNoteV2 {
  exists: boolean;
  remoteId: string | null;
  meetingRemoteId: string;
  revision: number;
  clientNoteRevision: number;
  clientUpdatedAtMs: number;
  userEditedAtMs: number | null;
  content: string;
  serverCreatedAtMs: number | null;
  serverUpdatedAtMs: number | null;
}

export interface OccurrenceScheduleSnapshotV2 {
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

export interface OccurrenceLinkV2Mutation {
  schema_version: 2;
  meeting_remote_id: string;
  expected_remote_revision: number | null;
  source_event_id: string;
  occurrence_date: string;
  calendar_revision: number | null;
  recurrence_segment_id: string | null;
  series_key: string | null;
  link_state: 'active' | 'orphaned';
  client_updated_at_ms: number;
  schedule_snapshot: OccurrenceScheduleSnapshotV2;
}

export interface RemoteOccurrenceLinkV2 {
  exists: boolean;
  remoteId: string | null;
  meetingRemoteId: string | null;
  revision: number;
  sourceEventId: string | null;
  occurrenceDate: string | null;
  calendarRevision: number | null;
  recurrenceSegmentId: string | null;
  seriesKey: string | null;
  linkState: 'active' | 'orphaned' | null;
  clientUpdatedAtMs: number;
  scheduleSnapshot: OccurrenceScheduleSnapshotV2 | null;
  serverCreatedAtMs: number | null;
  serverUpdatedAtMs: number | null;
}

export interface SpeakerCorrectionV2Mutation {
  schema_version: 2;
  client_request_id: string;
  transcript_revision_id: string;
  scope: 'segment' | 'cluster' | 'future_profile';
  segment_ids: readonly string[];
  cluster_id: string | null;
  speaker_profile_id: string | null;
  display_name: string;
  consent_to_profile_update: boolean;
  base_revision: number;
}

export interface SpeakerCorrectionV2Response {
  clientRequestId: string;
  assignmentRevision: number;
}

export const LEGACY_MEETING_CAPABILITIES: MeetingCapabilities = {
  schemaVersion: 0,
  meetingNotesV2: false,
  structuredSummaryV2: false,
  summaryCitations: false,
  summaryAttachmentsText: false,
  summaryAttachmentsImage: false,
  meetingQuestionsV1: false,
  actionItemsV2: false,
  actionItemsPullV2: false,
  manualNotesV2: false,
  occurrenceLinksV2: false,
  speakerCorrections: false,
  mediaImport: null,
  syncCursor: false,
  softDeleteDays: null,
};
