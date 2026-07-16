import type { ApiEventEditPatch } from './api';
import type { CalEvent, EventRecurrenceScope, EventRef } from '../types';
import { createClientRequestId } from './clientRequestId';
import { eventRefForEvent } from '../utils/eventIdentity';

export type EventEditPhase = 'pending' | 'submitting' | 'retryable';

export const EVENT_EDIT_JOURNAL_VERSION = 1 as const;

export interface EventEditTransaction {
  id: string;
  scopeKey: string;
  ref: EventRef;
  recurrenceScope: EventRecurrenceScope;
  patch: ApiEventEditPatch;
  expectedRevision?: number;
  phase: EventEditPhase;
  createdAt: number;
  lastAttemptAt?: number;
  lastError?: string;
}

export interface EventEditJournal {
  version: typeof EVENT_EDIT_JOURNAL_VERSION;
  transactions: EventEditTransaction[];
}

export function createEventEditTransaction({
  scopeKey,
  target,
  recurrenceScope,
  patch,
  now = Date.now(),
}: {
  scopeKey: string;
  target: CalEvent;
  recurrenceScope: EventRecurrenceScope;
  patch: ApiEventEditPatch;
  now?: number;
}): EventEditTransaction {
  return {
    id: createClientRequestId('event-edit'),
    scopeKey,
    ref: eventRefForEvent(target),
    recurrenceScope,
    patch,
    expectedRevision: target.revision,
    phase: 'pending',
    createdAt: now,
  };
}

export function isEventEditTransaction(value: unknown): value is EventEditTransaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const transaction = value as Partial<EventEditTransaction>;
  return typeof transaction.id === 'string'
    && typeof transaction.scopeKey === 'string'
    && Boolean(transaction.ref)
    && typeof transaction.ref?.sourceEventId === 'string'
    && typeof transaction.ref?.occurrenceDate === 'string'
    && (transaction.recurrenceScope === 'occurrence'
      || transaction.recurrenceScope === 'following'
      || transaction.recurrenceScope === 'series')
    && Boolean(transaction.patch)
    && typeof transaction.patch === 'object'
    && !Array.isArray(transaction.patch)
    && (transaction.phase === 'pending'
      || transaction.phase === 'submitting'
      || transaction.phase === 'retryable')
    && typeof transaction.createdAt === 'number';
}

export function createEventEditJournal(
  transactions: EventEditTransaction[],
): EventEditJournal {
  return { version: EVENT_EDIT_JOURNAL_VERSION, transactions };
}

export function parseEventEditJournal(value: unknown): EventEditTransaction[] {
  if (Array.isArray(value)) return value.filter(isEventEditTransaction);
  if (!value || typeof value !== 'object') return [];
  const journal = value as Partial<EventEditJournal>;
  if (journal.version !== EVENT_EDIT_JOURNAL_VERSION || !Array.isArray(journal.transactions)) return [];
  return journal.transactions.filter(isEventEditTransaction);
}
