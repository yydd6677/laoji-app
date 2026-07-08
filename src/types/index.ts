import type { NavigatorScreenParams } from '@react-navigation/native';

export interface CalEvent {
  id: string;
  title: string;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  color: string;
  spanning?: boolean;
  category?: string;
  location?: string;
  detail?: string;
  status?: string;
  isAllDay?: boolean;
  repeat?: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  description?: string;
  reminderMinutes?: number | null;
  notificationId?: string | null;
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
}

export type RootStackParamList = {
  Login: undefined;
  MainTabs: NavigatorScreenParams<MainTabsParamList> | undefined;
  EventDetail: { eventId: string };
  Calendar: undefined;
  Recording: { meetingId: string };
  Transcription: { meetingId: string };
  Profile: undefined;
  Account: undefined;
  Privacy: undefined;
  Legal: { kind: 'terms' | 'privacy' | 'help' | 'guide' | 'version' | 'contact' };
  AddEvent: { date?: string; eventId?: string };
};

export type MainTabsParamList = {
  Schedule: undefined;
  Meetings: undefined;
};
