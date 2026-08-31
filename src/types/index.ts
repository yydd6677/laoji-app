import type { NavigatorScreenParams } from '@react-navigation/native';
import type {
  MeetingEntryPoint,
  MeetingFactsResultV3,
  MeetingSummaryActivationFenceV3,
  MeetingSummaryDocument,
} from '../domain/meeting';
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
  /** Stable local MentionGraph/draft revision metadata. */
  eventRevision?: number;
  draftSourceSha256?: string | null;
  producerRevision?: string;
  graphSchemaRevision?: string;
  deletedAtMs?: number | null;
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
  title: string;
  date: string;
  time?: string;
  duration: string;
  tags: { label: string; color: string }[];
  bars?: number[];
  participants?: string[];
  hasTranscript?: boolean;
  hasSummary?: boolean;
  /** Compact summary excerpt projected for the meeting-list cover. */
  summaryCoverText?: string;
  status?: string;
  mode?: 'realtime' | 'offline';
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
  /** Monotonic vNext text state for one stable segment identity. */
  textState?: 'partial' | 'stable' | 'final';
  revisionKind?: 'realtimeDraft' | 'final' | 'reprocessed';
  /** Canonical server script. Missing means a legacy/cache row. */
  script?: 'zh-Hans' | 'unknown';
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
  /** Raw v3 facts retained locally; templates are deterministic projections of this object. */
  facts_document_v3?: MeetingFactsResultV3;
  /** Content-free source-stream identity checked again by the atomic SQLite activation. */
  activation_fence_v3?: MeetingSummaryActivationFenceV3;
}

export interface EventDraftParams {
  title: string;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  isAllDay: boolean;
  repeat?: CalEvent['repeat'];
  recurrenceInterval?: number;
  recurrenceWeekdays?: number[];
  recurrenceUntilDate?: string;
  description?: string;
  rawText?: string;
  location?: string;
  category?: EventCategory;
  detail?: string;
  status?: string;
  reminderMinutes?: number | null;
  eventRevision?: number;
  draftSourceSha256?: string | null;
  producerRevision?: string;
  graphSchemaRevision?: string;
}

export interface MeetingActionFollowupParams {
  /** Legacy/native meeting route identity used when returning to the detail page. */
  meetingId: string;
  canonicalMeetingId: string;
  actionId: string;
  /** Stable across retries so one action cannot create multiple calendar events. */
  clientRequestId: string;
}

export type RootStackParamList = {
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
  SpeakerManager: undefined;
  SpeakerEnrollment: { speakerId?: string } | undefined;
  NotificationSettings: undefined;
  Privacy: undefined;
  HardwareDevices: undefined;
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
