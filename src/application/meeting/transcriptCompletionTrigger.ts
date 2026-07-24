import type { ScopeKey } from '../../domain/meeting';

type TranscriptCompletionListener = (scopeKey: ScopeKey) => void;

const listeners = new Set<TranscriptCompletionListener>();

export function requestMeetingTranscriptCompletion(scopeKey: ScopeKey): void {
  if (scopeKey === 'guest') return;
  listeners.forEach(listener => {
    try {
      listener(scopeKey);
    } catch {
      // A committed local capture must not fail because a scheduler listener failed.
    }
  });
}

export function subscribeMeetingTranscriptCompletion(
  listener: TranscriptCompletionListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
