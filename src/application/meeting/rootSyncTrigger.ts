import type { ScopeKey } from '../../domain/meeting';

type MeetingRootSyncListener = (scopeKey: ScopeKey) => void;

const listeners = new Set<MeetingRootSyncListener>();

export function requestMeetingRootSync(scopeKey: ScopeKey): void {
  if (scopeKey === 'guest') return;
  listeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // A committed root mutation must not fail because its scheduler failed.
    }
  });
}

export function subscribeMeetingRootSync(listener: MeetingRootSyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
