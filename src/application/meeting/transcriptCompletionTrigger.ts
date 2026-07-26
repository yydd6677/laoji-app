import type { ScopeKey } from '../../domain/meeting';

export interface MeetingTranscriptCompletionRequestOptions {
  discoverRecordingAssets?: boolean;
}

type TranscriptCompletionListener = (
  scopeKey: ScopeKey,
  options: MeetingTranscriptCompletionRequestOptions,
) => void;

const listeners = new Set<TranscriptCompletionListener>();

export function requestMeetingTranscriptCompletion(
  scopeKey: ScopeKey,
  options: MeetingTranscriptCompletionRequestOptions = {},
): void {
  if (scopeKey === 'guest') return;
  listeners.forEach(listener => {
    try {
      listener(scopeKey, options);
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
