import type { ScopeKey } from '../../domain/meeting';

type SpeakerCorrectionSyncListener = (scopeKey: ScopeKey) => void;

const listeners = new Set<SpeakerCorrectionSyncListener>();

export function requestMeetingSpeakerCorrectionSync(scopeKey: ScopeKey): void {
  if (scopeKey === 'guest') return;
  listeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // The committed local correction stays valid if a scheduler listener fails.
    }
  });
}

export function subscribeMeetingSpeakerCorrectionSync(
  listener: SpeakerCorrectionSyncListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
