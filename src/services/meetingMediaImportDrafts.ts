import type { ScopeKey } from '../domain/meeting';
import { assertScopeKey } from '../domain/meeting';
import { getAppStorageItem, writeAppStorageJson } from './appStorage';
import type { CalendarMeetingContext } from './occurrenceMeeting';

const IMPORT_DRAFTS_KEY = '@laoji:meetingMediaImportDrafts:v1';

export interface MeetingMediaImportDraft {
  scopeKey: ScopeKey;
  title: string;
  recordedAtMs: number;
  calendarContext: CalendarMeetingContext | null;
}

type StoredDrafts = Record<string, MeetingMediaImportDraft>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseCalendarContext(value: unknown): CalendarMeetingContext | null {
  if (value === null) return null;
  if (!isRecord(value) || !isRecord(value.occurrence) || !isRecord(value.snapshot)) return null;
  const sourceEventId = optionalString(value.occurrence.sourceEventId);
  const occurrenceDate = optionalString(value.occurrence.occurrenceDate);
  const snapshot = value.snapshot;
  const capturedAtMs = optionalTimestamp(snapshot.capturedAtMs);
  if (!sourceEventId || !occurrenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate) || capturedAtMs === null) {
    return null;
  }
  const plannedStartMs = snapshot.plannedStartMs === null ? null : optionalTimestamp(snapshot.plannedStartMs);
  const plannedEndMs = snapshot.plannedEndMs === null ? null : optionalTimestamp(snapshot.plannedEndMs);
  if (
    (snapshot.plannedStartMs !== null && plannedStartMs === null)
    || (snapshot.plannedEndMs !== null && plannedEndMs === null)
    || !Array.isArray(snapshot.participants)
    || snapshot.participants.some(item => typeof item !== 'string')
  ) return null;
  return {
    occurrence: { sourceEventId, occurrenceDate },
    snapshot: {
      eventTitle: typeof snapshot.eventTitle === 'string' ? snapshot.eventTitle : '',
      plannedStartMs,
      plannedEndMs,
      allDay: snapshot.allDay === true,
      timezoneId: optionalString(snapshot.timezoneId),
      location: optionalString(snapshot.location),
      participants: snapshot.participants as string[],
      description: optionalString(snapshot.description),
      capturedEventRevision: snapshot.capturedEventRevision === null
        ? null
        : optionalTimestamp(snapshot.capturedEventRevision),
      capturedAtMs,
    },
    recurrenceSegmentId: optionalString(value.recurrenceSegmentId),
    seriesKey: optionalString(value.seriesKey),
  };
}

function parseDraft(value: unknown): MeetingMediaImportDraft | null {
  if (!isRecord(value)) return null;
  const scopeKey = optionalString(value.scopeKey);
  const title = typeof value.title === 'string' ? value.title.slice(0, 500) : null;
  const recordedAtMs = optionalTimestamp(value.recordedAtMs);
  if (!scopeKey || title === null || recordedAtMs === null) return null;
  try {
    assertScopeKey(scopeKey);
  } catch {
    return null;
  }
  return {
    scopeKey,
    title,
    recordedAtMs,
    calendarContext: parseCalendarContext(value.calendarContext),
  };
}

async function readDrafts(): Promise<StoredDrafts> {
  const raw = await getAppStorageItem(IMPORT_DRAFTS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const drafts: StoredDrafts = {};
    Object.entries(parsed).forEach(([meetingId, value]) => {
      const draft = parseDraft(value);
      if (meetingId.trim() && draft) drafts[meetingId] = draft;
    });
    return drafts;
  } catch {
    return {};
  }
}

export async function saveMeetingMediaImportDraft(
  meetingId: string,
  draft: MeetingMediaImportDraft,
): Promise<void> {
  const normalizedMeetingId = meetingId.trim();
  if (!normalizedMeetingId) throw new Error('meeting media import draft ID is invalid');
  assertScopeKey(draft.scopeKey);
  if (!Number.isSafeInteger(draft.recordedAtMs) || draft.recordedAtMs < 0) {
    throw new Error('meeting media import recorded time is invalid');
  }
  const drafts = await readDrafts();
  drafts[normalizedMeetingId] = {
    ...draft,
    title: draft.title.slice(0, 500),
  };
  await writeAppStorageJson(IMPORT_DRAFTS_KEY, drafts);
}

export async function loadMeetingMediaImportDraft(
  meetingId: string,
): Promise<MeetingMediaImportDraft | null> {
  const drafts = await readDrafts();
  return drafts[meetingId.trim()] ?? null;
}

export async function deleteMeetingMediaImportDraft(meetingId: string): Promise<void> {
  const drafts = await readDrafts();
  delete drafts[meetingId.trim()];
  await writeAppStorageJson(IMPORT_DRAFTS_KEY, drafts, { removeIfEmpty: true });
}
