import * as FileSystem from 'expo-file-system/legacy';
import type {
  MeetingNoteAggregate,
  ManualNoteRecord,
} from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { assertScopeKey, calendarMeetingSeriesKey } from '../domain/meeting';
import type { CalEvent, Meeting, MeetingSummary, TranscriptLine } from '../types';
import {
  createMeeting,
  importGuestMeetingData,
  saveEvent,
  updateMeeting,
} from './api';
import { getAppStorageItem, writeAppStorageJson } from './appStorage';
import { calEventToApiEvent, eventSeriesDraft } from './eventMapper';
import { mirrorLegacyMeetingCreated } from './meetingStageMirror';
import type { CalendarMeetingContext } from './occurrenceMeeting';
import { requestMeetingOccurrenceSync } from '../application/meeting/occurrenceSyncTrigger';
import {
  loadMeetingCapabilities,
  uploadRecordingAssetV2,
} from '../data/api/v2';

const GUEST_EVENTS_KEY = '@laoji:guestEvents:v1';
const GUEST_MEETINGS_KEY = '@laoji:meetings:v2:guest';
const GUEST_TRANSCRIPTS_KEY = '@laoji:meetingTranscripts:v1:guest';
const GUEST_SUMMARIES_KEY = '@laoji:meetingSummaries:v1:guest';
const MIGRATION_V1_KEY_PREFIX = '@laoji:guestDataMigration:v1';
const MIGRATION_V2_KEY_PREFIX = '@laoji:guestDataMigration:v2';

type MeetingMigrationPhase =
  | 'create'
  | 'occurrence'
  | 'manualNote'
  | 'transcript'
  | 'summaryVersions'
  | 'actions'
  | 'markers'
  | 'status'
  | 'audio';

type EventMigrationStateV2 = {
  imported: boolean;
  cloudSourceEventId?: string;
  cloudRevision?: number;
  clientRequestId: string;
  updatedAt: string;
  lastError?: string;
};

type MeetingMigrationStateV2 = {
  cloudMeetingId?: string;
  created: boolean;
  /** Account-scoped canonical link whose two IDs both refer to cloud entities. */
  cloudOccurrenceLinked: boolean;
  /** Copied into the account scope and left dirty for the future v2 sync API. */
  manualNoteSynced: boolean;
  transcriptSynced: boolean;
  summaryVersionsSynced: boolean;
  actionsSynced: boolean;
  markersSynced: boolean;
  audioUploaded: boolean;
  statusSynced: boolean;
  completed: boolean;
  updatedAt: string;
  phaseErrors?: Partial<Record<MeetingMigrationPhase, string>>;
};

type GuestMigrationJournalV2 = {
  version: 2;
  userId: string;
  events: Record<string, EventMigrationStateV2>;
  meetings: Record<string, MeetingMigrationStateV2>;
  updatedAt: string;
};

type LegacyEventMigrationState = {
  imported?: boolean;
  updatedAt?: string;
  lastError?: string;
};

type LegacyMeetingMigrationState = {
  cloudMeetingId?: string;
  created?: boolean;
  audioUploaded?: boolean;
  contentImported?: boolean;
  statusSynced?: boolean;
  completed?: boolean;
  updatedAt?: string;
  lastError?: string;
};

type LegacyGuestMigrationJournal = {
  version?: 1;
  userId?: string;
  events?: Record<string, LegacyEventMigrationState>;
  meetings?: Record<string, LegacyMeetingMigrationState>;
  updatedAt?: string;
};

export type GuestMigrationPreview = {
  eventCount: number;
  meetingCount: number;
  audioCount: number;
  transcriptCount: number;
  summaryCount: number;
  manualNoteCount: number;
  occurrenceCount: number;
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
  canonicalMeetings: Record<string, MeetingNoteAggregate | null>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function emptyJournal(userId: string): GuestMigrationJournalV2 {
  return {
    version: 2,
    userId,
    events: {},
    meetings: {},
    updatedAt: nowIso(),
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

async function loadCanonicalGuestMeetings(
  meetings: readonly Meeting[],
): Promise<Record<string, MeetingNoteAggregate | null>> {
  const result: Record<string, MeetingNoteAggregate | null> = {};
  for (let offset = 0; offset < meetings.length; offset += 8) {
    await Promise.all(meetings.slice(offset, offset + 8).map(async meeting => {
      if (!meeting?.id) return;
      try {
        result[meeting.id] = await sqliteMeetingNoteRepository.findByNativeSessionId(meeting.id, 'guest');
      } catch {
        // A legacy guest meeting may predate the SQLite shadow import. Its
        // AsyncStorage content remains migratable; only new sidecars are absent.
        result[meeting.id] = null;
      }
    }));
  }
  return result;
}

async function loadSource(): Promise<GuestMigrationSource> {
  const [events, meetings, transcripts, summaries] = await Promise.all([
    readJson<CalEvent[]>(GUEST_EVENTS_KEY, []),
    readJson<Meeting[]>(GUEST_MEETINGS_KEY, []),
    readJson<Record<string, TranscriptLine[]>>(GUEST_TRANSCRIPTS_KEY, {}),
    readJson<Record<string, MeetingSummary | null>>(GUEST_SUMMARIES_KEY, {}),
  ]);
  const normalizedMeetings = Array.isArray(meetings) ? meetings : [];
  return {
    events: Array.isArray(events) ? events : [],
    meetings: normalizedMeetings,
    transcripts: transcripts && typeof transcripts === 'object' ? transcripts : {},
    summaries: summaries && typeof summaries === 'object' ? summaries : {},
    canonicalMeetings: await loadCanonicalGuestMeetings(normalizedMeetings),
  };
}

function migrationV1Key(userId: string): string {
  return `${MIGRATION_V1_KEY_PREFIX}:user:${userId}`;
}

function migrationV2Key(userId: string): string {
  return `${MIGRATION_V2_KEY_PREFIX}:user:${userId}`;
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

function upgradedJournal(
  userId: string,
  legacy: LegacyGuestMigrationJournal | null,
): GuestMigrationJournalV2 {
  const next = emptyJournal(userId);
  if (!legacy || legacy.version !== 1 || legacy.userId !== userId) return next;
  Object.entries(legacy.events ?? {}).forEach(([sourceId, state]) => {
    // V1 did not persist the server event ID. Replaying the stable request is
    // required before an occurrence can be rebuilt safely.
    next.events[sourceId] = {
      imported: false,
      clientRequestId: stableRequestId('event', sourceId),
      updatedAt: state.updatedAt ?? nowIso(),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  });
  Object.entries(legacy.meetings ?? {}).forEach(([meetingId, state]) => {
    const contentImported = state.contentImported === true;
    next.meetings[meetingId] = {
      cloudMeetingId: state.cloudMeetingId,
      created: state.created === true && Boolean(state.cloudMeetingId),
      cloudOccurrenceLinked: false,
      manualNoteSynced: false,
      transcriptSynced: contentImported,
      summaryVersionsSynced: contentImported,
      actionsSynced: contentImported,
      markersSynced: true,
      audioUploaded: state.audioUploaded === true,
      statusSynced: state.statusSynced === true,
      completed: false,
      updatedAt: state.updatedAt ?? nowIso(),
      ...(state.lastError ? { phaseErrors: { create: state.lastError } } : {}),
    };
  });
  return next;
}

async function loadJournal(userId: string): Promise<GuestMigrationJournalV2> {
  const current = await readJson<Partial<GuestMigrationJournalV2> | null>(migrationV2Key(userId), null);
  if (current?.version === 2 && current.userId === userId) {
    return {
      ...emptyJournal(userId),
      ...current,
      version: 2,
      userId,
      events: current.events ?? {},
      meetings: current.meetings ?? {},
    };
  }
  const legacy = await readJson<LegacyGuestMigrationJournal | null>(migrationV1Key(userId), null);
  return upgradedJournal(userId, legacy);
}

async function saveJournal(journal: GuestMigrationJournalV2): Promise<void> {
  journal.updatedAt = nowIso();
  await writeAppStorageJson(migrationV2Key(journal.userId), journal);
}

function meetingHasAudio(meeting: Meeting): boolean {
  return Boolean(meeting.audioLocalUri?.trim());
}

function meetingTranscript(source: GuestMigrationSource, meetingId: string): TranscriptLine[] {
  const value = source.transcripts[meetingId];
  return Array.isArray(value) ? value.filter(line => Boolean(line?.text?.trim())) : [];
}

function meetingSummary(source: GuestMigrationSource, meetingId: string): MeetingSummary | null {
  const value = source.summaries[meetingId];
  return value && typeof value === 'object' ? value : null;
}

function manualNoteFor(source: GuestMigrationSource, meetingId: string): ManualNoteRecord | null {
  return source.canonicalMeetings[meetingId]?.manualNote ?? null;
}

function meetingHasActions(summary: MeetingSummary | null): boolean {
  return Array.isArray(summary?.action_items) && summary.action_items.length > 0;
}

function initialMeetingState(
  source: GuestMigrationSource,
  meeting: Meeting,
  previous?: Partial<MeetingMigrationStateV2>,
): MeetingMigrationStateV2 {
  const hasAudio = meetingHasAudio(meeting);
  const hasTranscript = meetingTranscript(source, meeting.id).length > 0;
  const summary = meetingSummary(source, meeting.id);
  const hasSummary = Boolean(summary);
  const hasManualNote = Boolean(manualNoteFor(source, meeting.id)?.content);
  const hasOccurrence = Boolean(source.canonicalMeetings[meeting.id]?.occurrence);
  const hasActions = meetingHasActions(summary);
  return {
    cloudMeetingId: previous?.cloudMeetingId,
    created: previous?.created === true && Boolean(previous.cloudMeetingId),
    cloudOccurrenceLinked: !hasOccurrence || previous?.cloudOccurrenceLinked === true,
    manualNoteSynced: !hasManualNote || previous?.manualNoteSynced === true,
    transcriptSynced: !hasTranscript || previous?.transcriptSynced === true,
    summaryVersionsSynced: !hasSummary || previous?.summaryVersionsSynced === true,
    actionsSynced: !hasActions || previous?.actionsSynced === true,
    markersSynced: true,
    audioUploaded: !hasAudio || previous?.audioUploaded === true,
    statusSynced: previous?.statusSynced ?? false,
    completed: false,
    updatedAt: previous?.updatedAt ?? nowIso(),
    phaseErrors: previous?.phaseErrors ? { ...previous.phaseErrors } : undefined,
  };
}

function eventComplete(state: EventMigrationStateV2 | undefined): boolean {
  return state?.imported === true && Boolean(state.cloudSourceEventId);
}

function meetingComplete(state: MeetingMigrationStateV2): boolean {
  return state.created
    && state.cloudOccurrenceLinked
    && state.manualNoteSynced
    && state.transcriptSynced
    && state.summaryVersionsSynced
    && state.actionsSynced
    && state.markersSynced
    && state.audioUploaded
    && state.statusSynced;
}

function previewFor(
  source: GuestMigrationSource,
  journal: GuestMigrationJournalV2,
): GuestMigrationPreview {
  const events = sourceEvents(source.events);
  const meetings = source.meetings.filter(meeting => Boolean(meeting?.id));
  const pendingEvents = events.filter(event => !eventComplete(journal.events[guestEventKey(event)])).length;
  const pendingMeetings = meetings.filter(meeting => {
    const state = initialMeetingState(source, meeting, journal.meetings[meeting.id]);
    return !meetingComplete(state);
  }).length;
  return {
    eventCount: events.length,
    meetingCount: meetings.length,
    audioCount: meetings.filter(meetingHasAudio).length,
    transcriptCount: meetings.filter(meeting => meetingTranscript(source, meeting.id).length > 0).length,
    summaryCount: meetings.filter(meeting => Boolean(meetingSummary(source, meeting.id))).length,
    manualNoteCount: meetings.filter(meeting => Boolean(manualNoteFor(source, meeting.id)?.content)).length,
    occurrenceCount: meetings.filter(meeting => Boolean(source.canonicalMeetings[meeting.id]?.occurrence)).length,
    pendingCount: pendingEvents + pendingMeetings,
  };
}

export async function inspectGuestDataMigration(
  userId: string,
): Promise<GuestMigrationPreview> {
  const source = await loadSource();
  const journal = await loadJournal(userId);
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

function setPhaseError(
  state: MeetingMigrationStateV2,
  phase: MeetingMigrationPhase,
  error: unknown,
): void {
  state.phaseErrors = {
    ...(state.phaseErrors ?? {}),
    [phase]: readableFailure(error),
  };
  state.updatedAt = nowIso();
}

function clearPhaseError(state: MeetingMigrationStateV2, phase: MeetingMigrationPhase): void {
  if (!state.phaseErrors?.[phase]) return;
  const next = { ...state.phaseErrors };
  delete next[phase];
  state.phaseErrors = Object.keys(next).length > 0 ? next : undefined;
}

function mappedEventState(
  source: GuestMigrationSource,
  journal: GuestMigrationJournalV2,
  guestSourceEventId: string,
): EventMigrationStateV2 | null {
  const direct = journal.events[guestSourceEventId];
  if (eventComplete(direct)) return direct;
  const matching = source.events.find(event => (
    event.id === guestSourceEventId
    || event.sourceEventId === guestSourceEventId
    || guestEventKey(event) === guestSourceEventId
  ));
  const state = matching ? journal.events[guestEventKey(matching)] : undefined;
  return eventComplete(state) ? state! : null;
}

function migrationCalendarContext(
  source: GuestMigrationSource,
  journal: GuestMigrationJournalV2,
  meetingId: string,
  accountScopeKey: ScopeKey,
): CalendarMeetingContext | null {
  const aggregate = source.canonicalMeetings[meetingId];
  if (!aggregate?.occurrence) return null;
  if (!aggregate.scheduleSnapshot) {
    throw new Error('日程快照缺失，无法恢复会议关联。');
  }
  const eventState = mappedEventState(source, journal, aggregate.occurrence.sourceEventId);
  if (!eventState?.cloudSourceEventId) {
    throw new Error('账号日程编号尚未准备好，稍后可继续迁移。');
  }
  return {
    occurrence: {
      sourceEventId: eventState.cloudSourceEventId,
      occurrenceDate: aggregate.occurrence.occurrenceDate,
    },
    snapshot: {
      ...aggregate.scheduleSnapshot,
      capturedEventRevision: eventState.cloudRevision
        ?? aggregate.scheduleSnapshot.capturedEventRevision,
    },
    recurrenceSegmentId: null,
    seriesKey: calendarMeetingSeriesKey(accountScopeKey, eventState.cloudSourceEventId),
  };
}

function accountMeetingProjection(
  meeting: Meeting,
  cloudMeetingId: string,
  hasContent: boolean,
  hasAudio: boolean,
): Meeting {
  return {
    ...meeting,
    id: cloudMeetingId,
    source: 'cloud',
    status: migratedStatus(meeting, hasContent, hasAudio),
    statusSyncPending: false,
    clientRequestId: stableRequestId('meeting', meeting.id),
  };
}

async function ensureAccountCanonicalMeeting(
  userId: string,
  meeting: Meeting,
  cloudMeetingId: string,
  calendarContext: CalendarMeetingContext | null,
  hasContent: boolean,
  hasAudio: boolean,
): Promise<MeetingNoteAggregate> {
  const scopeKey = `user:${userId}` as ScopeKey;
  assertScopeKey(scopeKey);
  await mirrorLegacyMeetingCreated(
    scopeKey,
    accountMeetingProjection(meeting, cloudMeetingId, hasContent, hasAudio),
    calendarContext ?? undefined,
  );
  const aggregate = await sqliteMeetingNoteRepository.findByNativeSessionId(cloudMeetingId, scopeKey);
  if (!aggregate || aggregate.note.lifecycle === 'deleted') {
    throw new Error('账号会议的本机数据尚未准备好。');
  }
  return aggregate;
}

async function migrateManualNoteToAccount(
  userId: string,
  sourceNote: ManualNoteRecord | null,
  targetMeetingId: string,
): Promise<void> {
  if (!sourceNote?.content) return;
  const scopeKey = `user:${userId}` as ScopeKey;
  assertScopeKey(scopeKey);
  await sqliteMeetingNoteRepository.transaction(async transaction => {
    const current = await transaction.getManualNote(targetMeetingId, scopeKey);
    if (!current) throw new Error('账号会议的笔记容器不存在。');
    if (current.content === sourceNote.content) return;
    if (current.content || current.revision > 0) {
      throw new Error('账号中已有不同笔记，本机未自动覆盖。');
    }
    const nextRevision = Math.max(1, sourceNote.revision);
    if (!Number.isSafeInteger(nextRevision)) throw new Error('访客笔记版本无效。');
    const savedAtMs = Math.max(current.lastSavedAtMs, sourceNote.lastSavedAtMs, Date.now());
    await transaction.saveManualNote({
      ...current,
      content: sourceNote.content,
      revision: nextRevision,
      baseRemoteRevision: null,
      dirty: true,
      lastSavedAtMs: savedAtMs,
      userEditedAtMs: sourceNote.userEditedAtMs ?? savedAtMs,
    }, scopeKey);
    await transaction.markCurrentSummaryStale(targetMeetingId, scopeKey);
  });
}

async function bindAccountOccurrence(
  userId: string,
  targetMeetingId: string,
  context: CalendarMeetingContext | null,
): Promise<void> {
  if (!context) return;
  const scopeKey = `user:${userId}` as ScopeKey;
  assertScopeKey(scopeKey);
  const linkedAtMs = context.snapshot.capturedAtMs;
  await sqliteMeetingNoteRepository.transaction(async transaction => {
    const meeting = await transaction.getMeeting(targetMeetingId, scopeKey);
    if (!meeting || meeting.lifecycle === 'deleted') {
      throw new Error('账号会议的本机数据尚未准备好。');
    }
    if (meeting.origin !== 'calendar' || meeting.entryPoint !== 'calendar_detail') {
      await transaction.updateMeeting(targetMeetingId, scopeKey, {
        origin: 'calendar',
        entryPoint: 'calendar_detail',
        updatedAtMs: Math.max(meeting.updatedAtMs, Date.now()),
      });
    }
    await transaction.bindOccurrence({
      meetingId: targetMeetingId,
      scopeKey,
      ...context.occurrence,
      calendarRevision: context.snapshot.capturedEventRevision,
      recurrenceSegmentId: context.recurrenceSegmentId,
      seriesKey: context.seriesKey,
      linkedAtMs,
    }, context.snapshot);
    await transaction.insertOutbox({
      operationId: `occurrence.migrate:${targetMeetingId}`,
      scopeKey,
      aggregateType: 'meeting_occurrence',
      aggregateId: targetMeetingId,
      operationType: 'occurrence.upsert',
      baseRevision: null,
      payloadJson: JSON.stringify({
        schema_version: 2,
        source_event_id: context.occurrence.sourceEventId,
        occurrence_date: context.occurrence.occurrenceDate,
        calendar_revision: context.snapshot.capturedEventRevision,
        recurrence_segment_id: context.recurrenceSegmentId,
        series_key: context.seriesKey,
        link_state: 'active',
        client_updated_at_ms: linkedAtMs,
        schedule_snapshot: context.snapshot,
      }),
      createdAtMs: linkedAtMs,
    });
  });
  requestMeetingOccurrenceSync(scopeKey);
}

async function persistMeetingPhase(
  journal: GuestMigrationJournalV2,
  state: MeetingMigrationStateV2,
): Promise<void> {
  state.completed = meetingComplete(state);
  state.updatedAt = nowIso();
  await saveJournal(journal);
}

export async function migrateGuestData(
  userId: string,
  accessToken: string,
): Promise<GuestMigrationResult> {
  const accountScopeKey = `user:${userId}` as ScopeKey;
  assertScopeKey(accountScopeKey);
  const source = await loadSource();
  const journal = await loadJournal(userId);
  const initial = previewFor(source, journal);
  let migratedEvents = 0;
  let migratedMeetings = 0;
  let failedItems = 0;
  const recordingAssetCapability = await loadMeetingCapabilities({
    accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  }).catch(() => null);
  const canUploadRecordingAssets = recordingAssetCapability?.source === 'remote'
    && recordingAssetCapability.capabilities.recordingAssetsV2;

  // Events are completed first so every meeting occurrence can be rebuilt with
  // a durable guest-source -> cloud-source mapping.
  for (const event of sourceEvents(source.events)) {
    const sourceId = guestEventKey(event);
    const previous = journal.events[sourceId];
    if (eventComplete(previous)) continue;
    const state: EventMigrationStateV2 = {
      imported: false,
      cloudSourceEventId: previous?.cloudSourceEventId,
      cloudRevision: previous?.cloudRevision,
      clientRequestId: previous?.clientRequestId || stableRequestId('event', sourceId),
      updatedAt: nowIso(),
    };
    journal.events[sourceId] = state;
    try {
      const draft = eventSeriesDraft(event);
      const saved = await saveEvent(calEventToApiEvent({
        ...draft,
        clientRequestId: state.clientRequestId,
      }), accessToken);
      const cloudSourceEventId = saved.source_event_id ?? saved.id;
      if (cloudSourceEventId == null || !String(cloudSourceEventId).trim()) {
        throw new Error('服务器未返回日程编号。');
      }
      state.imported = true;
      state.cloudSourceEventId = String(cloudSourceEventId);
      state.cloudRevision = Number.isSafeInteger(saved.revision) ? saved.revision : undefined;
      delete state.lastError;
      migratedEvents += 1;
    } catch (error) {
      state.imported = false;
      state.lastError = readableFailure(error);
      failedItems += 1;
    }
    state.updatedAt = nowIso();
    await saveJournal(journal);
  }

  for (const meeting of source.meetings) {
    if (!meeting?.id) continue;
    const state = initialMeetingState(source, meeting, journal.meetings[meeting.id]);
    journal.meetings[meeting.id] = state;
    if (meetingComplete(state)) {
      state.completed = true;
      await saveJournal(journal);
      continue;
    }
    const transcript = meetingTranscript(source, meeting.id);
    const summary = meetingSummary(source, meeting.id);
    const hasAudio = meetingHasAudio(meeting);
    const hasContent = transcript.length > 0 || Boolean(summary);
    let itemFailed = false;

    if (!state.created || !state.cloudMeetingId) {
      try {
        const created = await createMeeting({
          title: meeting.title?.trim() ?? '',
          description: meeting.description ?? null,
          participants: meeting.participants ?? [],
          mode: meeting.mode ?? 'realtime',
          clientRequestId: stableRequestId('meeting', meeting.id),
          location: meeting.location ?? null,
          recordedAt: meeting.createdAt ?? null,
        }, accessToken);
        if (!created.id?.trim()) throw new Error('服务器未返回会议编号。');
        state.cloudMeetingId = created.id;
        state.created = true;
        clearPhaseError(state, 'create');
      } catch (error) {
        state.created = false;
        setPhaseError(state, 'create', error);
        itemFailed = true;
      }
      await persistMeetingPhase(journal, state);
    }

    const cloudMeetingId = state.cloudMeetingId;
    if (!state.created || !cloudMeetingId) {
      if (itemFailed) failedItems += 1;
      continue;
    }

    let accountAggregate: MeetingNoteAggregate | null = null;
    let calendarContext: CalendarMeetingContext | null = null;
    if (!state.cloudOccurrenceLinked) {
      try {
        calendarContext = migrationCalendarContext(source, journal, meeting.id, accountScopeKey);
        clearPhaseError(state, 'occurrence');
      } catch (error) {
        setPhaseError(state, 'occurrence', error);
        itemFailed = true;
      }
    }
    try {
      accountAggregate = await ensureAccountCanonicalMeeting(
        userId,
        meeting,
        cloudMeetingId,
        calendarContext,
        hasContent,
        hasAudio,
      );
      clearPhaseError(state, 'create');
    } catch (error) {
      setPhaseError(state, 'create', error);
      itemFailed = true;
    }

    if (!state.manualNoteSynced) {
      try {
        if (!accountAggregate) throw new Error('账号会议尚未准备好，无法迁移笔记。');
        await migrateManualNoteToAccount(
          userId,
          manualNoteFor(source, meeting.id),
          accountAggregate.note.id,
        );
        state.manualNoteSynced = true;
        clearPhaseError(state, 'manualNote');
      } catch (error) {
        setPhaseError(state, 'manualNote', error);
        itemFailed = true;
      }
      await persistMeetingPhase(journal, state);
    }

    if (!state.cloudOccurrenceLinked) {
      try {
        if (!accountAggregate) throw new Error('账号会议尚未准备好，无法恢复日程关联。');
        if (!calendarContext) {
          calendarContext = migrationCalendarContext(source, journal, meeting.id, accountScopeKey);
        }
        await bindAccountOccurrence(userId, accountAggregate.note.id, calendarContext);
        state.cloudOccurrenceLinked = true;
        clearPhaseError(state, 'occurrence');
      } catch (error) {
        setPhaseError(state, 'occurrence', error);
        itemFailed = true;
      }
      await persistMeetingPhase(journal, state);
    }

    if (!state.transcriptSynced || !state.summaryVersionsSynced || !state.actionsSynced) {
      try {
        const imported = await importGuestMeetingData(cloudMeetingId, {
          sourceMeetingId: meeting.id,
          transcripts: transcript,
          summary,
        }, accessToken);
        state.transcriptSynced = transcript.length === 0
          || imported.already_imported
          || imported.transcript_count >= transcript.length;
        state.summaryVersionsSynced = !summary
          || imported.already_imported
          || imported.summary_imported;
        state.actionsSynced = !meetingHasActions(summary) || state.summaryVersionsSynced;
        if (!state.transcriptSynced) throw new Error('服务器未确认完整的文字记录。');
        if (!state.summaryVersionsSynced) throw new Error('服务器未确认完整的整理结果。');
        if (!state.actionsSynced) throw new Error('服务器未确认完整的行动项。');
        clearPhaseError(state, 'transcript');
        clearPhaseError(state, 'summaryVersions');
        clearPhaseError(state, 'actions');
      } catch (error) {
        if (!state.transcriptSynced) setPhaseError(state, 'transcript', error);
        if (!state.summaryVersionsSynced) setPhaseError(state, 'summaryVersions', error);
        if (!state.actionsSynced) setPhaseError(state, 'actions', error);
        itemFailed = true;
      }
      await persistMeetingPhase(journal, state);
    }

    // The stable guest model has no markers yet. Keeping an explicit completed
    // phase prevents a future marker-bearing release from being conflated with
    // the current no-op migration.
    if (!state.markersSynced) {
      state.markersSynced = true;
      clearPhaseError(state, 'markers');
      await persistMeetingPhase(journal, state);
    }

    if (!state.statusSynced) {
      try {
        await updateMeeting(cloudMeetingId, {
          status: migratedStatus(meeting, hasContent, hasAudio),
        }, accessToken);
        state.statusSynced = true;
        clearPhaseError(state, 'status');
      } catch (error) {
        setPhaseError(state, 'status', error);
        itemFailed = true;
      }
      await persistMeetingPhase(journal, state);
    }

    if (!state.audioUploaded && meeting.audioLocalUri) {
      try {
        if (!canUploadRecordingAssets) throw new Error('当前会议服务暂不支持录音迁移。');
        const info = await FileSystem.getInfoAsync(meeting.audioLocalUri);
        if (!info.exists) throw new Error('访客录音文件已不存在，无法迁移该录音。');
        const clientAssetId = `guest-migration:${meeting.id}:primary`;
        await uploadRecordingAssetV2({
          accessToken,
          meetingRemoteId: cloudMeetingId,
          registerIdempotencyKey: `guest-recording-register:${meeting.id}`,
          contentIdempotencyKey: `guest-recording-content:${meeting.id}`,
          registration: {
            schema_version: 2,
            client_asset_id: clientAssetId,
            role: 'primary',
            origin: 'captured',
            mime_type: 'audio/wav',
            file_name: `${meeting.id}.wav`,
            byte_size: typeof info.size === 'number' && Number.isSafeInteger(info.size)
              ? info.size
              : null,
            duration_ms: typeof meeting.audioDurationSec === 'number'
              && Number.isFinite(meeting.audioDurationSec)
              ? Math.max(0, Math.round(meeting.audioDurationSec * 1_000))
              : null,
            checksum_sha256: null,
          },
          audioUri: meeting.audioLocalUri,
        });
        state.audioUploaded = true;
        clearPhaseError(state, 'audio');
      } catch (error) {
        setPhaseError(state, 'audio', error);
        itemFailed = true;
      }
      await persistMeetingPhase(journal, state);
    }

    state.completed = meetingComplete(state);
    await saveJournal(journal);
    if (state.completed) migratedMeetings += 1;
    if (itemFailed) failedItems += 1;
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
