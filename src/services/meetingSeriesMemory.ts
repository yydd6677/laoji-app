import type { CalEvent } from '../types';
import type {
  MeetingNoteAggregate,
  MeetingNoteRepository,
  SummaryCitationRecord,
  SummarySectionRecord,
} from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import {
  assertScopeKey,
  calendarMeetingSeriesKey,
  type OccurrenceReference,
  type ScopeKey,
} from '../domain/meeting';
import { eventRefForEvent } from '../utils/eventIdentity';

const MAX_DECISIONS = 3;
const MAX_PENDING_ACTIONS = 5;

export interface MeetingSeriesMemoryCitation {
  id: string;
  segmentId: string;
  sourceSegmentId: string | null;
  startMs: number;
  endMs: number;
}

export interface MeetingSeriesMemoryDecision {
  id: string;
  content: string;
  canonicalMeetingId: string;
  legacyMeetingId: string;
  sourceMeetingRemoteId: string | null;
  sourceSectionKey: string;
  sourceOrdinal: number;
  sourceMeetingTitle: string;
  occurrenceDate: string;
  citations: readonly MeetingSeriesMemoryCitation[];
}

export interface MeetingSeriesMemoryAction {
  id: string;
  content: string;
  assigneeText: string | null;
  dueAtMs: number | null;
  canonicalMeetingId: string;
  legacyMeetingId: string;
  sourceMeetingRemoteId: string | null;
  sourceRemoteItemId: string | null;
  sourceMeetingTitle: string;
  occurrenceDate: string;
  sourceSegmentId: string | null;
  sourceSegmentSourceId: string | null;
  sourceStartMs: number | null;
}

export interface MeetingSeriesMemoryProjection {
  seriesKey: string;
  previousMeeting: {
    canonicalMeetingId: string;
    legacyMeetingId: string;
    remoteMeetingId: string | null;
    title: string;
    occurrenceDate: string;
    endedAtMs: number | null;
  };
  decisions: readonly MeetingSeriesMemoryDecision[];
  pendingActions: readonly MeetingSeriesMemoryAction[];
}

function localStartMs(event: CalEvent): number | null {
  const time = event.isAllDay || !event.startTime ? '00:00' : event.startTime;
  const value = new Date(`${event.startDate}T${time}:00`).getTime();
  return Number.isFinite(value) ? value : null;
}

export function isFutureMeetingSeriesOccurrence(event: CalEvent, nowMs = Date.now()): boolean {
  const belongsToSeries = Boolean(
    event.isExpandedOccurrence
    || event.isRecurrenceException
    || (event.repeat && event.repeat !== 'once'),
  );
  const startMs = localStartMs(event);
  return belongsToSeries && startMs !== null && startMs > nowMs;
}

function legacyMeetingId(aggregate: MeetingNoteAggregate): string {
  return aggregate.note.legacySourceId ?? aggregate.note.remoteId ?? aggregate.note.id;
}

function visibleMeetingTitle(aggregate: MeetingNoteAggregate): string {
  return aggregate.note.title.trim()
    || aggregate.scheduleSnapshot?.eventTitle.trim()
    || '(无主题)';
}

function decisionLines(section: SummarySectionRecord): string[] {
  const content = (section.userText ?? section.generatedText).trim();
  if (!content) return [];
  return content
    .split(/\r?\n+/)
    .map(line => line.replace(/^\s*(?:[-*•]+|\d+[.)、])\s*/, '').trim())
    .filter(Boolean);
}

function decisionCitations(
  sectionId: string,
  citations: readonly SummaryCitationRecord[],
): MeetingSeriesMemoryCitation[] {
  return citations
    .filter(citation => citation.sectionId === sectionId && citation.userRemovedAtMs === null)
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .map(citation => ({
      id: citation.id,
      segmentId: citation.segmentId,
      sourceSegmentId: citation.sourceSegmentId,
      startMs: citation.startMs,
      endMs: citation.endMs,
    }));
}

function citationsForDecision(
  decisionCount: number,
  decisionIndex: number,
  citations: readonly MeetingSeriesMemoryCitation[],
): readonly MeetingSeriesMemoryCitation[] {
  if (decisionCount === 1) return citations;
  return citations.length === decisionCount ? [citations[decisionIndex]] : [];
}

async function resolveMeetingSeriesMemoryForReference(
  scopeKey: ScopeKey,
  reference: OccurrenceReference,
  options: {
    repository?: MeetingNoteRepository;
  } = {},
): Promise<MeetingSeriesMemoryProjection | null> {
  assertScopeKey(scopeKey);
  const repository = options.repository ?? sqliteMeetingNoteRepository;
  const [previous, pendingActionRecords] = await Promise.all([
    repository.findPreviousEndedSeriesMeeting(reference, scopeKey),
    repository.listPendingSeriesActions(reference, scopeKey, MAX_PENDING_ACTIONS),
  ]);
  if (!previous) return null;

  const previousLegacyId = legacyMeetingId(previous);
  const previousTitle = visibleMeetingTitle(previous);
  const previousOccurrenceDate = previous.occurrence?.occurrenceDate ?? '';
  const summary = previous.note.currentSummaryVersionId
    ? await repository.getCurrentSummaryContent(previous.note.id, scopeKey)
    : null;
  const decisions: MeetingSeriesMemoryDecision[] = [];
  for (const section of summary?.sections ?? []) {
    if (section.kind !== 'decisions' && section.stableKey !== 'decisions' && section.stableKey !== 'commitments') {
      continue;
    }
    const lines = decisionLines(section);
    const citations = decisionCitations(section.id, summary?.citations ?? []);
    for (const [index, content] of lines.entries()) {
      decisions.push({
        id: `${section.id}:${index}`,
        content,
        canonicalMeetingId: previous.note.id,
        legacyMeetingId: previousLegacyId,
        sourceMeetingRemoteId: previous.note.remoteId,
        sourceSectionKey: section.stableKey,
        sourceOrdinal: index,
        sourceMeetingTitle: previousTitle,
        occurrenceDate: previousOccurrenceDate,
        citations: citationsForDecision(lines.length, index, citations),
      });
      if (decisions.length >= MAX_DECISIONS) break;
    }
    if (decisions.length >= MAX_DECISIONS) break;
  }

  return {
    seriesKey: calendarMeetingSeriesKey(scopeKey, reference.sourceEventId),
    previousMeeting: {
      canonicalMeetingId: previous.note.id,
      legacyMeetingId: previousLegacyId,
      remoteMeetingId: previous.note.remoteId,
      title: previousTitle,
      occurrenceDate: previousOccurrenceDate,
      endedAtMs: previous.note.endedAtMs,
    },
    decisions,
    pendingActions: pendingActionRecords.map(record => ({
      id: record.action.id,
      content: record.action.content,
      assigneeText: record.action.assigneeText,
      dueAtMs: record.action.dueAtMs,
      canonicalMeetingId: record.canonicalMeetingId,
      legacyMeetingId: record.legacyMeetingId,
      sourceMeetingRemoteId: record.remoteMeetingId,
      sourceRemoteItemId: record.action.remoteId,
      sourceMeetingTitle: record.meetingTitle.trim() || '(无主题)',
      occurrenceDate: record.occurrenceDate,
      sourceSegmentId: record.action.sourceSegmentId,
      sourceSegmentSourceId: record.action.sourceSegmentSourceId ?? null,
      sourceStartMs: record.action.sourceStartMs,
    })),
  };
}

export async function resolveMeetingSeriesMemory(
  scopeKey: ScopeKey,
  event: CalEvent,
  options: {
    nowMs?: number;
    repository?: MeetingNoteRepository;
  } = {},
): Promise<MeetingSeriesMemoryProjection | null> {
  assertScopeKey(scopeKey);
  if (!isFutureMeetingSeriesOccurrence(event, options.nowMs)) return null;
  return resolveMeetingSeriesMemoryForReference(scopeKey, eventRefForEvent(event), options);
}

export async function resolveMeetingSeriesMemoryForMeeting(
  scopeKey: ScopeKey,
  meetingId: string,
  options: { repository?: MeetingNoteRepository } = {},
): Promise<MeetingSeriesMemoryProjection | null> {
  assertScopeKey(scopeKey);
  const normalizedMeetingId = meetingId.trim();
  if (!normalizedMeetingId) return null;
  const repository = options.repository ?? sqliteMeetingNoteRepository;
  const aggregate = await repository.findByNativeSessionId(normalizedMeetingId, scopeKey);
  const occurrence = aggregate?.occurrence;
  if (!aggregate || aggregate.note.lifecycle === 'deleted' || !occurrence) return null;
  return resolveMeetingSeriesMemoryForReference(scopeKey, {
    sourceEventId: occurrence.sourceEventId,
    occurrenceDate: occurrence.occurrenceDate,
  }, { repository });
}
