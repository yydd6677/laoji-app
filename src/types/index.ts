import type { NavigatorScreenParams } from '@react-navigation/native';
import type { MeetingEntryPoint, MeetingSummaryDocument } from '../domain/meeting';
import type { EventCategory } from '../utils/eventColors';

export interface CalEvent {
  id: string;
  sourceEventId?: string;
  /** Original recurrence anchor. It remains stable if this occurrence is moved. */
  occurrenceDate?: string;
  occurrenceId?: string;
  isExpandedOccurrence?: boolean;
  isRecurrenceException?: boolean;
  seriesStartDate?: string;
  seriesEndDate?: string;
  revision?: number;
  recurrenceSegmentId?: number | string;
  recurrenceInterval?: number;
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  recurrenceWeekdays?: number[];
  recurrenceUntilDate?: string;
  /** Stable recurrence anchor from which a segment becomes effective. */
  recurrenceEffectiveFromDate?: string;
  excludedOccurrenceDates?: string[];
  excludedAfterDate?: string;
  title: string;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  color: string;
  spanning?: boolean;
  category?: EventCategory;
  location?: string;
  detail?: string;
  status?: string;
  isAllDay?: boolean;
  repeat?: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  description?: string;
  rawText?: string;
  clientRequestId?: string;
  reminderMinutes?: number | null;
  notificationId?: string | null;
  /** Optional native event-layer rectangle; absent events use the native fallback. */
  instanceLayout?: {
    xOffsetPercent: number;
    yOffsetPercent: number;
    widthPercent: number;
    heightPercent: number;
    zIndex?: number;
    fullDisplayWidthPercent?: number | null;
  } | null;
}

export type EventRecurrenceScope = 'occurrence' | 'following' | 'series';

/** Stable domain identity for one calendar occurrence. */
export interface EventRef {
  sourceEventId: string;
  occurrenceDate: string;
}

export interface Meeting {
  id: string;
  /** Stable server identity. Explicit null means this local meeting is not created remotely yet. */
  remoteId?: string | null;
  title: string;
  date: string;
  time?: string;
  duration: string;
  tags: { label: string; color: string }[];
  bars?: number[];
  participants?: string[];
  hasTranscript?: boolean;
  hasSummary?: boolean;
  status?: string;
  statusSyncPending?: boolean;
  mode?: 'realtime' | 'offline' | 'whisper' | 'qwen';
  description?: string | null;
  location?: string | null;
  createdAt?: string;
  updatedAt?: string;
  audioAvailable?: boolean;
  audioSyncPending?: boolean;
  audioSyncBlocked?: boolean;
  audioLocalUri?: string | null;
  audioDurationSec?: number;
  audioBars?: number[];
  clientRequestId?: string;
  source?: 'cloud' | 'guest';
}

export interface TranscriptLine {
  id: string;
  meeting_id?: string;
  /** Server RecordingAsset v2 identity returned by the transcript endpoint. */
  recording_asset_id?: string | null;
  /** Server transcription job that produced this line. */
  transcription_job_id?: string | null;
  /** Local canonical RecordingAsset identity used by playback and clip creation. */
  recordingAssetId?: string;
  /** Explicit remote identity retained when the source asset is not local. */
  recordingAssetRemoteId?: string;
  transcriptionJobId?: string;
  speaker_id?: string;
  speaker_label?: string;
  /** Compatibility metadata for meeting-local diarization grouping. */
  speakerClusterId?: string;
  text: string;
  start_time?: number;
  end_time?: number;
  confidence?: number;
  created_at?: string | null;
  /** Compatibility metadata projected from the local transcript revision model. */
  isFinal?: boolean;
  revisionKind?: 'realtimeDraft' | 'final' | 'reprocessed';
}

export interface MeetingSummary {
  id?: string;
  meeting_id?: string;
  overview?: string;
  full_text?: string;
  markdown?: string | null;
  raw_json?: unknown;
  key_decisions?: string[];
  action_items?: { id?: string; content: string; assignee?: string | null; due_date?: string | null; status?: string }[];
  generated_at?: string | null;
  /** Schema-v2 document retained while legacy consumers are incrementally removed. */
  structured_document?: MeetingSummaryDocument;
}

export interface EventDraftParams {
  title: string;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  isAllDay: boolean;
  repeat?: CalEvent['repeat'];
  recurrenceUntilDate?: string;
  description?: string;
  rawText?: string;
  location?: string;
  category?: EventCategory;
  detail?: string;
  status?: string;
  reminderMinutes?: number | null;
}

export interface MeetingActionFollowupParams {
  /** Legacy/native meeting route identity used when returning to the detail page. */
  meetingId: string;
  canonicalMeetingId: string;
  actionId: string;
  /** Stable across retries so one action cannot create multiple calendar events. */
  clientRequestId: string;
}

export type EditableProfileField = 'nickname' | 'email' | 'phone';

export type RootStackParamList = {
  Login: undefined;
  MainTabs: NavigatorScreenParams<MainTabsParamList> | undefined;
  EventDetail: { eventRef: EventRef };
  MeetingLive: {
    meetingId?: string;
    startRequested?: boolean;
    entryPoint?: Extract<MeetingEntryPoint, 'meeting_tab' | 'quick_tile'>;
  } | undefined;
  Transcription: {
    meetingId: string;
    focus?: 'notes' | 'transcript' | 'summary' | 'title';
    actionId?: string;
    actionFocusRequestId?: number;
    segmentId?: string;
    positionMs?: number;
    transcriptFocusRequestId?: number;
  };
  MeetingAttachments: {
    meetingId: string;
    meetingTitle?: string;
    markerId?: string;
    positionMs?: number;
  };
  MeetingOrganization: undefined;
  SharedAction: { token: string };
  SpeakerManager: undefined;
  SpeakerEnrollment: { speakerId?: string } | undefined;
  Profile: undefined;
  ProfileField: { field: EditableProfileField };
  Account: { section?: 'deletion' } | undefined;
  ChangePassword: undefined;
  NotificationSettings: undefined;
  AccountDeletion: undefined;
  Privacy: undefined;
  Legal: { kind: 'terms' | 'privacy' | 'help' | 'guide' | 'version' | 'contact' };
  AddEvent: {
    date?: string;
    endDate?: string;
    startTime?: string;
    endTime?: string;
    eventRef?: EventRef;
    recurrenceScope?: EventRecurrenceScope;
    draft?: EventDraftParams;
    followup?: MeetingActionFollowupParams;
  };
};

export type MainTabsParamList = {
  Schedule: undefined;
  Meetings: undefined;
};
