import * as FileSystem from 'expo-file-system/legacy';
import type { CalEvent, Meeting, MeetingSummary, TranscriptLine } from '../types';
import {
  createMeeting,
  importGuestMeetingData,
  saveEvent,
  updateMeeting,
  uploadMeetingAudio,
} from './api';
import { getAppStorageItem, writeAppStorageJson } from './appStorage';
import { calEventToApiEvent, eventSeriesDraft } from './eventMapper';

const GUEST_EVENTS_KEY = '@laoji:guestEvents:v1';
const GUEST_MEETINGS_KEY = '@laoji:meetings:v2:guest';
const GUEST_TRANSCRIPTS_KEY = '@laoji:meetingTranscripts:v1:guest';
const GUEST_SUMMARIES_KEY = '@laoji:meetingSummaries:v1:guest';
const MIGRATION_KEY_PREFIX = '@laoji:guestDataMigration:v1';

type EventMigrationState = {
  imported: boolean;
  updatedAt: string;
  lastError?: string;
};

type MeetingMigrationState = {
  cloudMeetingId?: string;
  created: boolean;
  audioUploaded: boolean;
  contentImported: boolean;
  statusSynced: boolean;
  completed: boolean;
  updatedAt: string;
  lastError?: string;
};

type GuestMigrationJournal = {
  version: 1;
  userId: string;
  events: Record<string, EventMigrationState>;
  meetings: Record<string, MeetingMigrationState>;
  updatedAt: string;
};

export type GuestMigrationPreview = {
  eventCount: number;
  meetingCount: number;
  audioCount: number;
  transcriptCount: number;
  summaryCount: number;
  pendingCount: number;
};

export type GuestMigrationResult = GuestMigrationPreview & {
  migratedEvents: number;
  migratedMeetings: number;
  failedItems: number;
};

type GuestMigrationSource = {
  events: CalEvent[];
  meetings: Meeting[];
  transcripts: Record<string, TranscriptLine[]>;
  summaries: Record<string, MeetingSummary | null>;
};

function emptyJournal(userId: string): GuestMigrationJournal {
  return {
    version: 1,
    userId,
    events: {},
    meetings: {},
    updatedAt: new Date().toISOString(),
  };
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await getAppStorageItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

async function loadSource(): Promise<GuestMigrationSource> {
  const [events, meetings, transcripts, summaries] = await Promise.all([
    readJson<CalEvent[]>(GUEST_EVENTS_KEY, []),
    readJson<Meeting[]>(GUEST_MEETINGS_KEY, []),
    readJson<Record<string, TranscriptLine[]>>(GUEST_TRANSCRIPTS_KEY, {}),
    readJson<Record<string, MeetingSummary | null>>(GUEST_SUMMARIES_KEY, {}),
  ]);
  return {
    events: Array.isArray(events) ? events : [],
    meetings: Array.isArray(meetings) ? meetings : [],
    transcripts: transcripts && typeof transcripts === 'object' ? transcripts : {},
    summaries: summaries && typeof summaries === 'object' ? summaries : {},
  };
}

function migrationKey(userId: string): string {
  return `${MIGRATION_KEY_PREFIX}:user:${userId}`;
}

async function loadJournal(userId: string): Promise<GuestMigrationJournal> {
  const value = await readJson<Partial<GuestMigrationJournal> | null>(migrationKey(userId), null);
  if (!value || value.version !== 1 || value.userId !== userId) return emptyJournal(userId);
  return {
    ...emptyJournal(userId),
    ...value,
    events: value.events ?? {},
    meetings: value.meetings ?? {},
  };
}

async function saveJournal(journal: GuestMigrationJournal): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  await writeAppStorageJson(migrationKey(journal.userId), journal);
}

function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function stableRequestId(kind: 'event' | 'meeting', sourceId: string): string {
  return `guest-migration:${kind}:${stableHash(sourceId)}`;
}

function guestEventKey(event: CalEvent): string {
  return event.sourceEventId || event.id;
}

function sourceEvents(events: CalEvent[]): CalEvent[] {
  const selected = new Map<string, CalEvent>();
  events.forEach(event => {
    if (!event?.id || !event.startDate) return;
    const key = guestEventKey(event);
    const current = selected.get(key);
    if (!current || (current.isExpandedOccurrence && !event.isExpandedOccurrence)) selected.set(key, event);
  });
  return [...selected.values()];
}

function meetingHasAudio(meeting: Meeting): boolean {
  return Boolean(meeting.audioLocalUri?.trim());
}

function meetingHasContent(source: GuestMigrationSource, meetingId: string): boolean {
  return (source.transcripts[meetingId]?.length ?? 0) > 0 || Boolean(source.summaries[meetingId]);
}

function previewFor(
  source: GuestMigrationSource,
  journal: GuestMigrationJournal,
): GuestMigrationPreview {
  const events = sourceEvents(source.events);
  const meetings = source.meetings.filter(meeting => Boolean(meeting?.id));
  const pendingEvents = events.filter(event => !journal.events[guestEventKey(event)]?.imported).length;
  const pendingMeetings = meetings.filter(meeting => !journal.meetings[meeting.id]?.completed).length;
  return {
    eventCount: events.length,
    meetingCount: meetings.length,
    audioCount: meetings.filter(meetingHasAudio).length,
    transcriptCount: meetings.filter(meeting => (source.transcripts[meeting.id]?.length ?? 0) > 0).length,
    summaryCount: meetings.filter(meeting => Boolean(source.summaries[meeting.id])).length,
    pendingCount: pendingEvents + pendingMeetings,
  };
}

export async function inspectGuestDataMigration(
  userId: string,
): Promise<GuestMigrationPreview> {
  const [source, journal] = await Promise.all([loadSource(), loadJournal(userId)]);
  return previewFor(source, journal);
}

function readableFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message || '迁移暂时未完成，请稍后重试。';
}

function migratedStatus(meeting: Meeting, hasContent: boolean, hasAudio: boolean): string {
  if (['completed', 'ended', 'done', 'processed'].includes(meeting.status ?? '')) return 'ended';
  if (meeting.status === 'recording') return hasContent || hasAudio ? 'ended' : 'failed';
  if (meeting.status === 'failed') return 'failed';
  return meeting.status || (hasContent || hasAudio ? 'ended' : 'created');
}

export async function migrateGuestData(
  userId: string,
  accessToken: string,
): Promise<GuestMigrationResult> {
  const source = await loadSource();
  const journal = await loadJournal(userId);
  const initial = previewFor(source, journal);
  let migratedEvents = 0;
  let migratedMeetings = 0;
  let failedItems = 0;

  for (const event of sourceEvents(source.events)) {
    const sourceId = guestEventKey(event);
    if (journal.events[sourceId]?.imported) continue;
    try {
      const draft = eventSeriesDraft(event);
      await saveEvent(calEventToApiEvent({
        ...draft,
        clientRequestId: stableRequestId('event', sourceId),
      }), accessToken);
      journal.events[sourceId] = {
        imported: true,
        updatedAt: new Date().toISOString(),
      };
      migratedEvents += 1;
    } catch (error) {
      journal.events[sourceId] = {
        imported: false,
        updatedAt: new Date().toISOString(),
        lastError: readableFailure(error),
      };
      failedItems += 1;
    }
    await saveJournal(journal);
  }

  for (const meeting of source.meetings) {
    if (!meeting?.id || journal.meetings[meeting.id]?.completed) continue;
    const previous = journal.meetings[meeting.id];
    const hasAudio = meetingHasAudio(meeting);
    const hasContent = meetingHasContent(source, meeting.id);
    const state: MeetingMigrationState = {
      cloudMeetingId: previous?.cloudMeetingId,
      created: previous?.created ?? false,
      audioUploaded: previous?.audioUploaded ?? !hasAudio,
      contentImported: previous?.contentImported ?? !hasContent,
      statusSynced: previous?.statusSynced ?? false,
      completed: false,
      updatedAt: new Date().toISOString(),
    };
    journal.meetings[meeting.id] = state;

    try {
      if (!state.created || !state.cloudMeetingId) {
        const created = await createMeeting({
          title: meeting.title?.trim() || '未命名会议',
          description: meeting.description ?? null,
          participants: meeting.participants ?? [],
          mode: meeting.mode ?? 'realtime',
          clientRequestId: stableRequestId('meeting', meeting.id),
          location: meeting.location ?? null,
          recordedAt: meeting.createdAt ?? null,
        }, accessToken);
        state.cloudMeetingId = created.id;
        state.created = true;
        state.updatedAt = new Date().toISOString();
        delete state.lastError;
        await saveJournal(journal);
      }

      const cloudMeetingId = state.cloudMeetingId;
      if (!cloudMeetingId) throw new Error('服务器未返回会议编号');
      let phaseFailure: unknown = null;
      if (!state.contentImported) {
        try {
          await importGuestMeetingData(cloudMeetingId, {
            sourceMeetingId: meeting.id,
            transcripts: source.transcripts[meeting.id] ?? [],
            summary: source.summaries[meeting.id] ?? null,
          }, accessToken);
          state.contentImported = true;
          state.updatedAt = new Date().toISOString();
          await saveJournal(journal);
        } catch (error) {
          phaseFailure ??= error;
        }
      }

      if (!state.statusSynced) {
        try {
          await updateMeeting(cloudMeetingId, {
            status: migratedStatus(meeting, hasContent, hasAudio),
          }, accessToken);
          state.statusSynced = true;
          state.updatedAt = new Date().toISOString();
          await saveJournal(journal);
        } catch (error) {
          phaseFailure ??= error;
        }
      }

      if (!state.audioUploaded && meeting.audioLocalUri) {
        try {
          const info = await FileSystem.getInfoAsync(meeting.audioLocalUri);
          if (!info.exists) throw new Error('访客录音文件已不存在，无法迁移该录音。');
          await uploadMeetingAudio(cloudMeetingId, meeting.audioLocalUri, accessToken, {
            fileName: `${cloudMeetingId}.wav`,
            mimeType: 'audio/wav',
          });
          state.audioUploaded = true;
          state.updatedAt = new Date().toISOString();
          await saveJournal(journal);
        } catch (error) {
          phaseFailure ??= error;
        }
      }
      state.completed = state.created
        && state.audioUploaded
        && state.contentImported
        && state.statusSynced;
      state.updatedAt = new Date().toISOString();
      delete state.lastError;
      if (phaseFailure) throw phaseFailure;
      if (state.completed) migratedMeetings += 1;
    } catch (error) {
      state.completed = false;
      state.lastError = readableFailure(error);
      state.updatedAt = new Date().toISOString();
      failedItems += 1;
    }
    await saveJournal(journal);
  }

  const remaining = previewFor(source, journal).pendingCount;
  return {
    ...initial,
    pendingCount: remaining,
    migratedEvents,
    migratedMeetings,
    failedItems,
  };
}
