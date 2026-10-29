import * as Crypto from 'expo-crypto';
import type { CalEvent, Meeting } from '../../types';
import type { MeetingEntryPoint, ScopeKey } from '../../domain/meeting';
import {
  bindLegacyMeetingToOccurrence,
  calendarMeetingContext,
  resolveDeletedOccurrenceMeetingIdentity,
  resolveOccurrenceMeeting,
  type CalendarMeetingContext,
  type OccurrenceMeetingProjection,
} from '../../services/occurrenceMeeting';

export type OccurrenceMeetingEntryPoint = Extract<
  MeetingEntryPoint,
  'calendar_detail' | 'notification' | 'widget'
>;

export interface OccurrenceMeetingCreateOptions {
  description: string | null;
  location: string | null;
  mode: 'realtime';
  clientRequestId: string;
  calendarContext: CalendarMeetingContext;
  entryPoint: OccurrenceMeetingEntryPoint;
}

export type CreateOccurrenceMeeting = (
  title: string,
  options: OccurrenceMeetingCreateOptions,
) => Promise<Meeting>;

export type OccurrenceMeetingOpenTarget =
  | {
      route: 'MeetingLive';
      params: { meetingId: string; startRequested: boolean };
      projection: OccurrenceMeetingProjection;
    }
  | {
      route: 'Transcription';
      params: { meetingId: string };
      projection: OccurrenceMeetingProjection;
    };

export interface OpenOccurrenceMeetingInput {
  scopeKey: ScopeKey;
  event: CalEvent;
  entryPoint: OccurrenceMeetingEntryPoint;
  createMeeting: CreateOccurrenceMeeting;
}

const openOperations = new Map<string, Promise<OccurrenceMeetingOpenTarget>>();

function operationKey(scopeKey: ScopeKey, context: CalendarMeetingContext): string {
  return JSON.stringify([
    scopeKey,
    context.occurrence.sourceEventId,
    context.occurrence.occurrenceDate,
  ]);
}

async function stableClientRequestId(
  context: CalendarMeetingContext,
  supersededDeletedMeetingId: string | null,
): Promise<string> {
  const base = `calendar:${context.occurrence.sourceEventId}:${context.occurrence.occurrenceDate}`;
  const readable = supersededDeletedMeetingId
    ? `${base}:after:${supersededDeletedMeetingId}`
    : base;
  // The deployed meeting root contract accepts at most 96 characters.
  if (readable.length <= 96) return readable;
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify({
      occurrence: context.occurrence,
      supersededDeletedMeetingId,
    }),
  );
  return `calendar:sha256:${digest}`;
}

export function occurrenceMeetingOpenTarget(
  projection: OccurrenceMeetingProjection,
): OccurrenceMeetingOpenTarget {
  if (projection.action === 'view') {
    return {
      route: 'Transcription',
      params: { meetingId: projection.meetingId },
      projection,
    };
  }
  return {
    route: 'MeetingLive',
    params: {
      meetingId: projection.meetingId,
      startRequested: projection.action === 'start',
    },
    projection,
  };
}

async function executeOpenOccurrenceMeeting(
  input: OpenOccurrenceMeetingInput,
  context: CalendarMeetingContext,
): Promise<OccurrenceMeetingOpenTarget> {
  const existing = await resolveOccurrenceMeeting(input.scopeKey, context.occurrence);
  if (existing) {
    // [PRODUCT] Occurrence synchronization is metadata recovery, not a
    // recording gate. Keep opening the local meeting while its association is
    // reconciled; an ended meeting exposes the dedicated resolution entry.
    return occurrenceMeetingOpenTarget(existing);
  }

  // A deleted meeting intentionally stays as a tombstone, but it must not
  // reserve this occurrence forever. Its local ID makes the replacement's
  // retry identity stable and distinct.
  const supersededDeletedMeeting = await resolveDeletedOccurrenceMeetingIdentity(
    input.scopeKey,
    context.occurrence,
  );

  const created = await input.createMeeting(input.event.title ?? '', {
    description: input.event.description ?? input.event.detail ?? null,
    location: input.event.location ?? null,
    mode: 'realtime',
    clientRequestId: await stableClientRequestId(
      context,
      supersededDeletedMeeting?.localMeetingId ?? null,
    ),
    calendarContext: context,
    entryPoint: input.entryPoint,
  });
  const projection = await bindLegacyMeetingToOccurrence(input.scopeKey, created, context);
  return occurrenceMeetingOpenTarget(projection);
}

export function openOccurrenceMeeting(
  input: OpenOccurrenceMeetingInput,
): Promise<OccurrenceMeetingOpenTarget> {
  const context = calendarMeetingContext(input.event, input.scopeKey);
  const key = operationKey(input.scopeKey, context);
  const existing = openOperations.get(key);
  if (existing) return existing;

  const operation = executeOpenOccurrenceMeeting(input, context).finally(() => {
    if (openOperations.get(key) === operation) openOperations.delete(key);
  });
  openOperations.set(key, operation);
  return operation;
}
