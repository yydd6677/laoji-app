import type { Meeting } from '../../types';
import type { MeetingLifecycle, ProcessingStageName, ScopeKey } from '../../domain/meeting';
import { PROCESSING_STAGE_NAMES, assertScopeKey } from '../../domain/meeting';
import type {
  MeetingListProjectionItem,
  MeetingNoteRepository,
} from './meetingNoteRepository';

export interface MeetingDualReadReport {
  status: 'consistent' | 'mismatch';
  legacyMeetings: number;
  repositoryMeetings: number;
  missingFromRepository: number;
  extraInRepository: number;
  duplicateRepositoryIdentities: number;
  titleMismatches: number;
  lifecycleMismatches: number;
  invalidStageSets: number;
  transcriptCountMismatches: number;
  summaryAvailabilityMismatches: number;
}

export interface LegacyMeetingContentProjection {
  transcriptLineCounts: Readonly<Record<string, number>>;
  summaryReady: Readonly<Record<string, boolean>>;
}

function lifecycleForLegacy(meeting: Meeting): MeetingLifecycle {
  const status = meeting.status?.toLowerCase();
  if (status === 'deleted') return 'deleted';
  if (status === 'recording' || status === 'paused' || status === 'processing') return 'active';
  if (['completed', 'ended', 'done', 'processed', 'failed'].includes(status ?? '')) return 'ended';
  return 'draft';
}

function legacyIdentityForRepositoryItem(item: MeetingListProjectionItem, scopeKey: ScopeKey): string {
  if (item.remoteId) return item.remoteId;
  const prefix = `legacy:${encodeURIComponent(scopeKey)}:`;
  if (item.id.startsWith(prefix)) {
    try {
      return decodeURIComponent(item.id.slice(prefix.length));
    } catch {
      return item.id;
    }
  }
  return item.id;
}

function hasCompleteStageSet(item: MeetingListProjectionItem): boolean {
  if (item.stages.length !== PROCESSING_STAGE_NAMES.length) return false;
  const names = new Set<ProcessingStageName>(item.stages.map(stage => stage.stage));
  return PROCESSING_STAGE_NAMES.every(name => names.has(name));
}

export class MeetingRepositoryFacade {
  constructor(private readonly repository: MeetingNoteRepository) {}

  async compareLegacySnapshot(
    scopeKey: ScopeKey,
    legacyMeetings: readonly Meeting[],
    content?: LegacyMeetingContentProjection,
  ): Promise<MeetingDualReadReport> {
    assertScopeKey(scopeKey);
    const repositoryItems: MeetingListProjectionItem[] = [];
    let before: { updatedAtMs: number; id: string } | null = null;
    for (let page = 0; page < 100; page += 1) {
      const projection = await this.repository.listProjection(scopeKey, {
        limit: 200,
        before,
        includeDeleted: true,
      });
      repositoryItems.push(...projection.items);
      if (!projection.hasMore || projection.items.length === 0) break;
      const last = projection.items.at(-1)!;
      before = { updatedAtMs: last.updatedAtMs, id: last.id };
      if (page === 99) throw new Error('meeting repository projection exceeds audit limit');
    }

    const legacyById = new Map<string, Meeting>();
    legacyMeetings.forEach(meeting => {
      const id = meeting.id?.trim();
      if (id) legacyById.set(id, meeting);
    });
    const repositoryByIdentity = new Map<string, MeetingListProjectionItem>();
    let duplicateRepositoryIdentities = 0;
    repositoryItems.forEach(item => {
      const identity = legacyIdentityForRepositoryItem(item, scopeKey);
      if (repositoryByIdentity.has(identity)) duplicateRepositoryIdentities += 1;
      else repositoryByIdentity.set(identity, item);
    });

    let missingFromRepository = 0;
    let titleMismatches = 0;
    let lifecycleMismatches = 0;
    let transcriptCountMismatches = 0;
    let summaryAvailabilityMismatches = 0;
    legacyById.forEach((legacy, id) => {
      const repositoryItem = repositoryByIdentity.get(id);
      if (!repositoryItem) {
        missingFromRepository += 1;
        return;
      }
      if (repositoryItem.title !== (legacy.title ?? '')) titleMismatches += 1;
      if (repositoryItem.lifecycle !== lifecycleForLegacy(legacy)) lifecycleMismatches += 1;
      if (content) {
        const legacyTranscriptCount = Math.max(0, Math.trunc(content.transcriptLineCounts[id] ?? 0));
        if (repositoryItem.activeTranscriptSegmentCount !== legacyTranscriptCount) {
          transcriptCountMismatches += 1;
        }
        if (repositoryItem.currentSummaryReady !== Boolean(content.summaryReady[id])) {
          summaryAvailabilityMismatches += 1;
        }
      }
    });
    let extraInRepository = 0;
    repositoryByIdentity.forEach((_, identity) => {
      if (!legacyById.has(identity)) extraInRepository += 1;
    });
    const invalidStageSets = repositoryItems.filter(item => !hasCompleteStageSet(item)).length;
    const mismatchCount = missingFromRepository + extraInRepository + duplicateRepositoryIdentities
      + titleMismatches + lifecycleMismatches + invalidStageSets
      + transcriptCountMismatches + summaryAvailabilityMismatches;
    return {
      status: mismatchCount === 0 ? 'consistent' : 'mismatch',
      legacyMeetings: legacyById.size,
      repositoryMeetings: repositoryItems.length,
      missingFromRepository,
      extraInRepository,
      duplicateRepositoryIdentities,
      titleMismatches,
      lifecycleMismatches,
      invalidStageSets,
      transcriptCountMismatches,
      summaryAvailabilityMismatches,
    };
  }
}
