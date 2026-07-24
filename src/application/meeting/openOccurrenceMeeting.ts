import * as Crypto from 'expo-crypto';
import type { CalEvent, Meeting } from '../../types';
import type { MeetingEntryPoint, ScopeKey } from '../../domain/meeting';
import {
  bindLegacyMeetingToOccurrence,
  calendarMeetingContext,
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

async function stableClientRequestId(context: CalendarMeetingContext): Promise<string> {
  const readable = `calendar:${context.occurrence.sourceEventId}:${context.occurrence.occurrenceDate}`;
  if (readable.length <= 512) return readable;
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify(context.occurrence),
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
    if (existing.syncConflict) throw new Error('日程关联正在处理，请稍后重试');
    return occurrenceMeetingOpenTarget(existing);
  }

  const created = await input.createMeeting(input.event.title ?? '', {
    description: input.event.description ?? input.event.detail ?? null,
    location: input.event.location ?? null,
    mode: 'realtime',
    clientRequestId: await stableClientRequestId(context),
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
