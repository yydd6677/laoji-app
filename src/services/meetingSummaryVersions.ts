import type { SummaryVersionRecord } from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { loadCurrentMeetingSummaryState } from './meetingSummaryState';

export interface MeetingSummaryVersionsState {
  canonicalMeetingId: string;
  currentVersionId: string;
  versions: readonly SummaryVersionRecord[];
}

export async function loadMeetingSummaryVersions(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
): Promise<MeetingSummaryVersionsState | null> {
  const current = await loadCurrentMeetingSummaryState(scopeKey, legacyMeetingId);
  if (!current?.document.remoteVersionId) return null;
  const versions = [...await sqliteMeetingNoteRepository.listReadableSummaryVersions(
    current.canonicalMeetingId,
    scopeKey,
  )];
  if (!versions.some(version => version.id === current.document.remoteVersionId)) {
    const currentVersion = await sqliteMeetingNoteRepository.getCurrentSummaryVersion(
      current.canonicalMeetingId,
      scopeKey,
    );
    if (!currentVersion || (currentVersion.status !== 'ready' && currentVersion.status !== 'stale')) return null;
    versions.push(currentVersion);
  }
  return {
    canonicalMeetingId: current.canonicalMeetingId,
    currentVersionId: current.document.remoteVersionId,
    versions,
  };
}
