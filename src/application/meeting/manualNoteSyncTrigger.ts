import type { ScopeKey } from '../../domain/meeting';

type ManualNoteSyncListener = (scopeKey: ScopeKey) => void;

const listeners = new Set<ManualNoteSyncListener>();

export function requestMeetingManualNoteSync(scopeKey: ScopeKey): void {
  if (scopeKey === 'guest') return;
  listeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // A committed local note must not fail because a scheduler listener failed.
    }
  });
}

export function subscribeMeetingManualNoteSync(listener: ManualNoteSyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
