import type { NavigatorScreenParams } from '@react-navigation/native';
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
  status?: string;
  statusSyncPending?: boolean;
  mode?: 'realtime' | 'offline' | 'whisper' | 'qwen';
  description?: string | null;
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
  speaker_id?: string;
  speaker_label?: string;
  text: string;
  start_time?: number;
  end_time?: number;
  confidence?: number;
  created_at?: string | null;
}

export interface MeetingSummary {
  id?: string;
  meeting_id?: string;
  overview?: string;
  full_text?: string;
  markdown?: string | null;
  key_decisions?: string[];
  action_items?: { id?: string; content: string; assignee?: string | null; due_date?: string | null; status?: string }[];
  generated_at?: string | null;
}

export interface EventDraftParams {
  title: string;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  isAllDay: boolean;
  repeat?: CalEvent['repeat'];
  description?: string;
  rawText?: string;
  location?: string;
  category?: EventCategory;
  detail?: string;
  status?: string;
  reminderMinutes?: number | null;
}

export type EditableProfileField = 'nickname' | 'email' | 'phone';

export type RootStackParamList = {
  Login: undefined;
  MainTabs: NavigatorScreenParams<MainTabsParamList> | undefined;
  EventDetail: { eventRef: EventRef };
  MeetingLive: { meetingId?: string } | undefined;
  Transcription: { meetingId: string; focus?: 'transcript' | 'summary' | 'title' };
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
    draft?: EventDraftParams;
  };
};

export type MainTabsParamList = {
  Schedule: undefined;
  Meetings: undefined;
};
