import type { MeetingOrigin } from '../../../domain/meeting';

export interface MeetingCapabilities {
  schemaVersion: number;
  meetingNotesV2: boolean;
  structuredSummaryV2: boolean;
  summaryCitations: boolean;
  speakerCorrections: boolean;
  mediaImport: {
    mimeTypes: readonly string[];
    maxBytes: number;
  } | null;
  syncCursor: boolean;
  softDeleteDays: number | null;
}

export interface CreateMeetingNoteV2Request {
  client_note_id: string;
  origin: MeetingOrigin;
  title: string;
  recorded_at: string | null;
  occurrence_ref?: {
    calendar_source_event_id: string;
    occurrence_date: string;
    calendar_revision?: number | null;
    recurrence_segment_id?: string | null;
  };
  schedule_snapshot?: {
    title: string;
    planned_start: string | null;
    planned_end: string | null;
    timezone: string | null;
    location: string | null;
    participants: readonly string[];
  };
}

export interface MeetingNoteV2Response {
  id: string;
  client_note_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  occurrence_ref?: CreateMeetingNoteV2Request['occurrence_ref'];
  processing_stages: readonly {
    stage: 'capture' | 'upload' | 'transcript' | 'summary' | 'speaker';
    status: string;
    attempt: number;
    progress?: number | null;
    error_code?: string | null;
    retryable?: boolean;
  }[];
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

export const LEGACY_MEETING_CAPABILITIES: MeetingCapabilities = {
  schemaVersion: 0,
  meetingNotesV2: false,
  structuredSummaryV2: false,
  summaryCitations: false,
  speakerCorrections: false,
  mediaImport: null,
  syncCursor: false,
  softDeleteDays: null,
};
