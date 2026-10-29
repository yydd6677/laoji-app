import type { SummaryVersionRecord } from "../data/repositories/meetingNoteRepository";
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import type { ScopeKey } from '../domain/meeting';
import { loadMeetingFactsRecordV3ForVersion } from '../data/repositories/meetingSummaryV3Repository';
import { loadCurrentMeetingSummaryState } from './meetingSummaryState';

export interface MeetingSummaryVersionsState {
  canonicalMeetingId: string;
  currentVersionId: string;
  versions: readonly SummaryVersionRecord[];
}

function summaryVersionSortKey(version: SummaryVersionRecord): number {
  return version.completedAtMs ?? version.createdAtMs;
}

function compareSummaryVersions(left: SummaryVersionRecord, right: SummaryVersionRecord): number {
  return summaryVersionSortKey(right) - summaryVersionSortKey(left)
    || right.id.localeCompare(left.id);
}

export async function loadMeetingSummaryVersions(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
): Promise<MeetingSummaryVersionsState | null> {
  const current = await loadCurrentMeetingSummaryState(scopeKey, legacyMeetingId);
  if (!current?.document.remoteVersionId) return null;
  const currentVersion = await sqliteMeetingNoteRepository.getCurrentSummaryVersion(
    current.canonicalMeetingId,
    scopeKey,
  );
  if (!currentVersion || (currentVersion.status !== 'ready' && currentVersion.status !== 'stale')) {
    return null;
  }
  const candidates = await sqliteMeetingNoteRepository.listReadableSummaryVersions(
    current.canonicalMeetingId,
    scopeKey,
  );
  const versions = (await Promise.all(candidates.map(async version => {
    const facts = await loadMeetingFactsRecordV3ForVersion(version.id);
    return facts?.canonicalMeetingId === current.canonicalMeetingId ? version : null;
  }))).filter((version): version is SummaryVersionRecord => version !== null);
  if (!versions.some(version => version.id === currentVersion.id)) return null;
  versions.sort(compareSummaryVersions);
  return {
    canonicalMeetingId: current.canonicalMeetingId,
    currentVersionId: currentVersion.id,
    versions,
  };
}
