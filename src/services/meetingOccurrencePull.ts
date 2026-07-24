import {
  getOccurrenceLinkByReferenceV2,
  loadMeetingCapabilities,
} from '../data/api/v2';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { OccurrenceReference, ScopeKey } from '../domain/meeting';
import { diagnosticAudit } from './diagnostics';

export interface PullOccurrenceMeetingInput {
  scopeKey: ScopeKey;
  occurrence: OccurrenceReference;
  accessToken: string;
  refreshRemoteMeetings?: () => Promise<void>;
  signal?: AbortSignal;
}

export interface PullOccurrenceMeetingResult {
  outcome: 'attached' | 'updated' | 'unchanged' | 'conflicted' | 'meeting_unavailable' | 'ignored_stale' | 'missing' | 'disabled' | 'stale';
  meetingId: string | null;
}

export async function pullOccurrenceMeeting(
  input: PullOccurrenceMeetingInput,
): Promise<PullOccurrenceMeetingResult> {
  if (input.scopeKey === 'guest' || !input.accessToken || input.signal?.aborted) {
    return { outcome: 'stale', meetingId: null };
  }
  const capability = await loadMeetingCapabilities({
    accessToken: input.accessToken,
    forceRefresh: false,
    allowStaleOnError: true,
  });
  if (input.signal?.aborted) return { outcome: 'stale', meetingId: null };
  if (!capability.capabilities.occurrenceLinksV2) {
    return { outcome: 'disabled', meetingId: null };
  }
  const remote = await getOccurrenceLinkByReferenceV2({
    accessToken: input.accessToken,
    sourceEventId: input.occurrence.sourceEventId,
    occurrenceDate: input.occurrence.occurrenceDate,
    signal: input.signal,
  });
  if (input.signal?.aborted) return { outcome: 'stale', meetingId: null };
  if (!remote.exists) return { outcome: 'missing', meetingId: null };
  if (
    remote.remoteId === null
    || remote.meetingRemoteId === null
    || remote.sourceEventId === null
    || remote.occurrenceDate === null
    || remote.linkState === null
    || remote.scheduleSnapshot === null
    || remote.serverCreatedAtMs === null
    || remote.serverUpdatedAtMs === null
  ) throw new Error('日程关联云端状态不完整');

  const merge = () => sqliteMeetingNoteRepository.mergeOccurrenceRemote({
    scopeKey: input.scopeKey,
    pulledAtMs: Date.now(),
    remote: {
      remoteId: remote.remoteId!,
      meetingRemoteId: remote.meetingRemoteId!,
      revision: remote.revision,
      sourceEventId: remote.sourceEventId!,
      occurrenceDate: remote.occurrenceDate!,
      calendarRevision: remote.calendarRevision,
      recurrenceSegmentId: remote.recurrenceSegmentId,
      seriesKey: remote.seriesKey,
      linkState: remote.linkState!,
      clientUpdatedAtMs: remote.clientUpdatedAtMs,
      scheduleSnapshot: remote.scheduleSnapshot!,
      serverCreatedAtMs: remote.serverCreatedAtMs!,
      serverUpdatedAtMs: remote.serverUpdatedAtMs!,
    },
  });
  let merged = await merge();
  if (
    merged.outcome === 'meeting_unavailable'
    && input.refreshRemoteMeetings
    && !input.signal?.aborted
  ) {
    await input.refreshRemoteMeetings();
    if (input.signal?.aborted) return { outcome: 'stale', meetingId: null };
    merged = await merge();
  }
  diagnosticAudit('occurrence_detail_pull', {
    status: merged.outcome,
    meeting_available: merged.meetingId !== null,
  });
  return merged;
}
