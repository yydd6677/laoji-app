import type { ScopeKey } from '../../domain/meeting';

type ActionSyncListener = (scopeKey: ScopeKey) => void;

const listeners = new Set<ActionSyncListener>();

export function requestMeetingActionSync(scopeKey: ScopeKey): void {
  if (scopeKey === 'guest') return;
  listeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // A committed local mutation must not fail because a scheduler listener failed.
    }
  });
}

export function subscribeMeetingActionSync(listener: ActionSyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
