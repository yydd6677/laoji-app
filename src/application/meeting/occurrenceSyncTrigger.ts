import type { ScopeKey } from '../../domain/meeting';

type OccurrenceSyncListener = (scopeKey: ScopeKey) => void;

const listeners = new Set<OccurrenceSyncListener>();

export function requestMeetingOccurrenceSync(scopeKey: ScopeKey): void {
  if (scopeKey === 'guest') return;
  listeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // A committed occurrence binding must not fail because scheduling failed.
    }
  });
}

export function subscribeMeetingOccurrenceSync(listener: OccurrenceSyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
