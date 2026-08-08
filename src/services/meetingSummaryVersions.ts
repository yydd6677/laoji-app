import type { SummaryVersionRecord } from '../data/repositories';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { summaryProjectionToDocument } from './meetingContentProjection';
import { meetingSummaryDocumentToText } from './meetingSummaryDocument';
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
  const leftTime = summaryVersionSortKey(left);
  const rightTime = summaryVersionSortKey(right);
  // Legacy and structured projections can share the same minute while being
  // created a few milliseconds apart. Keep the structured record first so a
  // freshly generated version is the first item users see.
  const leftMinute = Math.floor(leftTime / 60_000);
  const rightMinute = Math.floor(rightTime / 60_000);
  if (leftMinute !== rightMinute) return rightTime - leftTime;
  if (left.templateId === 'legacy' && right.templateId !== 'legacy') return 1;
  if (left.templateId !== 'legacy' && right.templateId === 'legacy') return -1;
  return rightTime - leftTime || right.id.localeCompare(left.id);
}

function comparableSummaryText(value: string): string {
  return value
    .replace(/^#{1,6}\s+[^\n]*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function hideExactLegacyProjectionDuplicates(
  scopeKey: ScopeKey,
  legacyMeetingId: string,
  currentVersionId: string,
  versions: readonly SummaryVersionRecord[],
): Promise<SummaryVersionRecord[]> {
  const structuredVersions = versions.filter(version => (
    version.templateId !== 'legacy' && !version.userEdited
  ));
  const textByVersionId = new Map<string, Promise<string | null>>();
  const loadText = (version: SummaryVersionRecord): Promise<string | null> => {
    const cached = textByVersionId.get(version.id);
    if (cached) return cached;
    const pending = sqliteMeetingNoteRepository.getSummaryVersionContent(version.id, scopeKey)
      .then(projection => summaryProjectionToDocument(projection, legacyMeetingId))
      .then(document => document
        ? comparableSummaryText(meetingSummaryDocumentToText(document))
        : null);
    textByVersionId.set(version.id, pending);
    return pending;
  };

  const visible: SummaryVersionRecord[] = [];
  for (const version of versions) {
    if (
      version.templateId !== 'legacy'
      || version.id === currentVersionId
      || version.userEdited
    ) {
      visible.push(version);
      continue;
    }
    const completedAt = summaryVersionSortKey(version);
    const structuredCandidates = structuredVersions.filter(candidate => (
      Math.abs(summaryVersionSortKey(candidate) - completedAt) <= 5_000
    ));
    if (structuredCandidates.length === 0) {
      visible.push(version);
      continue;
    }
    const legacyText = await loadText(version);
    if (!legacyText) {
      visible.push(version);
      continue;
    }
    let duplicate = false;
    for (const candidate of structuredCandidates) {
      if (await loadText(candidate) === legacyText) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) visible.push(version);
  }
  return visible;
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
  const versions = [...await sqliteMeetingNoteRepository.listReadableSummaryVersions(
    current.canonicalMeetingId,
    scopeKey,
  )];
  if (!versions.some(version => version.id === currentVersion.id)) {
    versions.push(currentVersion);
  }
  const visibleVersions = await hideExactLegacyProjectionDuplicates(
    scopeKey,
    legacyMeetingId,
    currentVersion.id,
    versions,
  );
  visibleVersions.sort(compareSummaryVersions);
  return {
    canonicalMeetingId: current.canonicalMeetingId,
    currentVersionId: currentVersion.id,
    versions: visibleVersions,
  };
}
