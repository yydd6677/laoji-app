import { requireOptionalNativeModule } from 'expo-modules-core';

export const UPCOMING_EVENTS_PROJECTION_SCHEMA_VERSION = 1 as const;

export type UpcomingEventMeetingAction = 'start' | 'continue' | 'view';

export interface UpcomingEventProjectionItem {
  sourceEventId: string;
  occurrenceDate: string;
  title: string;
  startAtMs: number;
  endAtMs: number;
  allDay: boolean;
  meetingAction: UpcomingEventMeetingAction;
}

export interface UpcomingEventsProjection {
  schemaVersion: typeof UPCOMING_EVENTS_PROJECTION_SCHEMA_VERSION;
  scopeKey: 'guest';
  updatedAtMs: number;
  expiresAtMs: number;
  hideTitles: boolean;
  events: UpcomingEventProjectionItem[];
}

export interface NativeSystemEntryProjectionState {
  available: boolean;
  fresh: boolean;
  schemaVersion: number | null;
  eventCount: number;
  updatedAtMs: number | null;
  expiresAtMs: number | null;
}

interface LaojiSystemEntriesNativeModule {
  writeUpcomingEventsProjection(json: string): Promise<NativeSystemEntryProjectionState>;
  clearUpcomingEventsProjection(): Promise<void>;
}

const nativeModule = requireOptionalNativeModule<LaojiSystemEntriesNativeModule>('LaojiSystemEntries');

export async function writeNativeUpcomingEventsProjection(
  projection: UpcomingEventsProjection,
): Promise<NativeSystemEntryProjectionState> {
  if (!nativeModule) {
    return {
      available: false,
      fresh: false,
      schemaVersion: null,
      eventCount: 0,
      updatedAtMs: null,
      expiresAtMs: null,
    };
  }
  return nativeModule.writeUpcomingEventsProjection(JSON.stringify(projection));
}

export async function clearNativeUpcomingEventsProjection(): Promise<void> {
  await nativeModule?.clearUpcomingEventsProjection();
}
