import type { ScopeKey } from '../../domain/meeting';
import { requestMeetingTranscriptCompletion } from './transcriptCompletionTrigger';

/**
 * Imported media has no remote asset ID until upload reconciliation finishes.
 * Keep discovery as an explicit post-import signal, while preserving the
 * guest boundary where account/cloud transcription is intentionally disabled.
 */
export function requestImportedMeetingTranscriptDiscovery(scopeKey: ScopeKey): boolean {
  if (scopeKey === 'guest') return false;
  requestMeetingTranscriptCompletion(scopeKey, { discoverRecordingAssets: true });
  return true;
}
