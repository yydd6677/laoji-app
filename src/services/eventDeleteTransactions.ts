import type { CalEvent, EventRecurrenceScope, EventRef } from '../types';
import { createClientRequestId } from './clientRequestId';
import { eventRefForEvent, sameEventRef, sourceEventId } from '../utils/eventIdentity';

export const EVENT_DELETE_UNDO_WINDOW_MS = 5_000;

export type EventObservedState = 'present' | 'absent' | 'unknown';
export type EventDeletePhase =
  | 'pending-delete'
  | 'deleting'
  | 'deleted'
  | 'pending-restore'
  | 'restoring'
  | 'restored'
  | 'retryable'
  | 'failed';

export interface EventDeleteTransaction {
  id: string;
  scopeKey: string;
  ref: EventRef;
  recurrenceScope: EventRecurrenceScope;
  snapshot: CalEvent;
  affectedEvents: CalEvent[];
  catalogEvent: CalEvent | null;
  desiredState: 'present' | 'absent';
  observedState: EventObservedState;
  phase: EventDeletePhase;
  deleteRequestId: string;
  restoreRequestId: string;
  deleteExpectedRevision?: number;
  restoreExpectedRevision?: number;
  revision?: number;
  reminderDirty: boolean;
  createdAt: number;
  undoUntil: number;
  lastError?: string;
}

export function eventIsInRecurrenceScope(
  event: CalEvent,
  ref: EventRef,
  scope: EventRecurrenceScope,
): boolean {
  if (sourceEventId(event) !== ref.sourceEventId) return false;
  if (scope === 'series') return true;
  const eventRef = eventRefForEvent(event);
  if (scope === 'occurrence') return sameEventRef(eventRef, ref);
  return eventRef.occurrenceDate >= ref.occurrenceDate;
}

export function createEventDeleteTransaction({
  scopeKey,
  target,
  recurrenceScope,
  relatedEvents,
  catalogEvent,
  now = Date.now(),
}: {
  scopeKey: string;
  target: CalEvent;
  recurrenceScope: EventRecurrenceScope;
  relatedEvents: CalEvent[];
  catalogEvent?: CalEvent | null;
  now?: number;
}): EventDeleteTransaction {
  const ref = eventRefForEvent(target);
  return {
    id: createClientRequestId('event-tx'),
    scopeKey,
    ref,
    recurrenceScope,
    snapshot: target,
    affectedEvents: relatedEvents.filter(event => eventIsInRecurrenceScope(event, ref, recurrenceScope)),
    catalogEvent: catalogEvent ?? null,
    desiredState: 'absent',
    observedState: 'present',
    phase: 'pending-delete',
    deleteRequestId: createClientRequestId('event-delete'),
    restoreRequestId: createClientRequestId('event-restore'),
    deleteExpectedRevision: target.revision,
    revision: target.revision,
    reminderDirty: false,
    createdAt: now,
    undoUntil: now + EVENT_DELETE_UNDO_WINDOW_MS,
  };
}

export function hideTransactionScope(events: CalEvent[], tx: EventDeleteTransaction): CalEvent[] {
  return events.filter(event => !eventIsInRecurrenceScope(event, tx.ref, tx.recurrenceScope));
}

export function restoreTransactionScope(events: CalEvent[], tx: EventDeleteTransaction): CalEvent[] {
  const byId = new Map(events.map(event => [event.id, event]));
  for (const event of tx.affectedEvents) byId.set(event.id, event);
  return [...byId.values()];
}

export function applyGuestTransactionToSeries(
  series: CalEvent,
  tx: EventDeleteTransaction,
  desiredState: 'present' | 'absent',
): CalEvent {
  if (tx.recurrenceScope === 'occurrence') {
    const excluded = new Set(series.excludedOccurrenceDates ?? []);
    if (desiredState === 'absent') excluded.add(tx.ref.occurrenceDate);
    else excluded.delete(tx.ref.occurrenceDate);
    return { ...series, excludedOccurrenceDates: [...excluded].sort() };
  }
  if (tx.recurrenceScope === 'following') {
    return {
      ...series,
      excludedAfterDate: desiredState === 'absent' ? tx.ref.occurrenceDate : undefined,
    };
  }
  return series;
}
