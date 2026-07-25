import {
  listMeetingNotesV2,
  loadMeetingCapabilities,
  type RemoteMeetingNoteV2,
} from '../data/api/v2';
import { MergeAccountMeetingRemoteSnapshotUseCase } from '../application/meeting';
import {
  sqliteMeetingNoteRepository,
  type RemoteOccurrenceLinkRecord,
} from '../data/repositories';
import type { MeetingProcessingStatuses, ScopeKey } from '../domain/meeting';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';

const PAGE_SIZE = 100;
const MAX_PAGES_PER_PULL = 20;

const mergeRemoteRoots = new MergeAccountMeetingRemoteSnapshotUseCase({
  repository: sqliteMeetingNoteRepository,
});

export interface PullMeetingRootsV2Input {
  scopeKey: ScopeKey;
  accessToken: string;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface PullMeetingRootsV2Result {
  outcome: 'pulled' | 'disabled' | 'unavailable' | 'stale' | 'page_limit';
  hadState: boolean;
  pages: number;
  items: number;
  created: number;
  updated: number;
  protectedLocal: number;
  attachedRemoteIdentities: number;
  remoteTombstonesApplied: number;
  remoteRestoresApplied: number;
  ignoredStale: number;
  occurrenceConflicts: number;
  occurrenceDeferred: number;
}

function emptyResult(
  outcome: PullMeetingRootsV2Result['outcome'],
  hadState: boolean,
): PullMeetingRootsV2Result {
  return {
    outcome,
    hadState,
    pages: 0,
    items: 0,
    created: 0,
    updated: 0,
    protectedLocal: 0,
    attachedRemoteIdentities: 0,
    remoteTombstonesApplied: 0,
    remoteRestoresApplied: 0,
    ignoredStale: 0,
    occurrenceConflicts: 0,
    occurrenceDeferred: 0,
  };
}

function stageStatus(
  meeting: RemoteMeetingNoteV2,
  stage: RemoteMeetingNoteV2['processingStages'][number]['stage'],
): string {
  const match = meeting.processingStages.find(item => item.stage === stage);
  if (!match) throw new Error('会议处理状态不完整');
  return match.status;
}

function localStatuses(meeting: RemoteMeetingNoteV2): MeetingProcessingStatuses {
  const capture = stageStatus(meeting, 'capture');
  const upload = stageStatus(meeting, 'upload');
  const transcript = stageStatus(meeting, 'transcript');
  const summary = stageStatus(meeting, 'summary');
  const speaker = stageStatus(meeting, 'speaker');
  return {
    capture: capture === 'ready'
      ? 'local_ready'
      : capture === 'processing' ? 'finalizing'
        : capture === 'failed_retryable' ? 'failed_recoverable'
          : 'not_started',
    upload: upload === 'ready'
      ? 'uploaded'
      : upload === 'processing' ? 'uploading'
        : upload === 'failed_retryable' ? 'failed_retryable'
          : 'not_required',
    transcript: transcript === 'ready'
      ? 'ready'
      : transcript === 'processing' || transcript === 'partial' ? 'finalizing'
        : transcript === 'failed_retryable' ? 'failed_retryable'
          : 'none',
    summary: summary === 'ready'
      ? 'ready'
      : summary === 'generating' || summary === 'processing' ? 'generating'
        : summary === 'queued' ? 'queued'
          : summary === 'stale' ? 'stale'
            : summary === 'failed_retryable' ? 'failed_retryable'
              : 'none',
    speaker: speaker === 'ready'
      ? 'ready'
      : speaker === 'processing' ? 'processing'
        : speaker === 'partial' ? 'partial'
          : speaker === 'failed_retryable' ? 'failed_retryable'
            : 'none',
  };
}

function rootSnapshot(meeting: RemoteMeetingNoteV2) {
  const statuses = localStatuses(meeting);
  return {
    remoteId: meeting.remoteId,
    clientNoteId: meeting.clientNoteId,
    clientRequestId: null,
    remoteRevision: meeting.revision,
    origin: meeting.origin,
    entryPoint: meeting.entryPoint,
    remoteLifecycle: meeting.lifecycle,
    deletedAtMs: meeting.deletedAtMs,
    title: meeting.title,
    description: meeting.description,
    participants: meeting.participants,
    location: meeting.location,
    mode: meeting.mode,
    status: meeting.status,
    recordedAtMs: meeting.recordedAtMs,
    createdAtMs: meeting.serverCreatedAtMs,
    updatedAtMs: meeting.serverUpdatedAtMs,
    audioAvailable: statuses.upload === 'uploaded',
    transcriptAvailable: statuses.transcript === 'ready',
    summaryAvailable: statuses.summary === 'ready',
  } as const;
}

function occurrenceSnapshot(meeting: RemoteMeetingNoteV2): RemoteOccurrenceLinkRecord | null {
  const occurrence = meeting.occurrenceRef;
  const schedule = meeting.scheduleSnapshot;
  if (!occurrence || !schedule || meeting.lifecycle === 'deleted') return null;
  return {
    remoteId: occurrence.id,
    meetingRemoteId: meeting.remoteId,
    revision: occurrence.revision,
    sourceEventId: occurrence.source_event_id,
    occurrenceDate: occurrence.occurrence_date,
    calendarRevision: occurrence.calendar_revision ?? null,
    recurrenceSegmentId: occurrence.recurrence_segment_id ?? null,
    seriesKey: occurrence.series_key ?? null,
    linkState: occurrence.link_state,
    clientUpdatedAtMs: schedule.captured_at_ms,
    scheduleSnapshot: {
      eventTitle: schedule.event_title,
      plannedStartMs: schedule.planned_start_ms,
      plannedEndMs: schedule.planned_end_ms,
      allDay: schedule.all_day,
      timezoneId: schedule.timezone_id,
      location: schedule.location,
      participants: schedule.participants,
      description: schedule.description,
      capturedEventRevision: schedule.captured_event_revision,
      capturedAtMs: schedule.captured_at_ms,
    },
    serverCreatedAtMs: meeting.serverCreatedAtMs,
    serverUpdatedAtMs: meeting.serverUpdatedAtMs,
  };
}

function addMerge(
  total: PullMeetingRootsV2Result,
  merged: Awaited<ReturnType<MergeAccountMeetingRemoteSnapshotUseCase['execute']>>,
): void {
  total.created += merged.created;
  total.updated += merged.updated;
  total.protectedLocal += merged.protectedLocal;
  total.attachedRemoteIdentities += merged.attachedRemoteIdentities;
  total.remoteTombstonesApplied += merged.remoteTombstonesApplied;
  total.remoteRestoresApplied += merged.remoteRestoresApplied;
  total.ignoredStale += merged.ignoredStale;
}

export async function pullMeetingRootsV2(
  input: PullMeetingRootsV2Input,
): Promise<PullMeetingRootsV2Result> {
  const isCurrent = input.isCurrent ?? (() => true);
  if (input.scopeKey === 'guest' || !input.accessToken || input.signal?.aborted || !isCurrent()) {
    return emptyResult('stale', false);
  }
  const state = await sqliteMeetingNoteRepository.getMeetingRootPullState(input.scopeKey);
  const hadState = state !== null;
  let capability;
  try {
    capability = await loadMeetingCapabilities({
      accessToken: input.accessToken,
      forceRefresh: true,
      allowStaleOnError: false,
    });
  } catch (error) {
    diagnosticWarn('[meeting-root-pull] fresh capability unavailable', error);
    return emptyResult('unavailable', hadState);
  }
  if (input.signal?.aborted || !isCurrent()) return emptyResult('stale', hadState);
  if (capability.source !== 'remote' || !capability.capabilities.meetingNotesV2) {
    return emptyResult('disabled', hadState);
  }

  let cursor = state?.cursor ?? null;
  const result = emptyResult('pulled', hadState);
  let completed = false;
  for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_PULL; pageIndex += 1) {
    if (input.signal?.aborted || !isCurrent()) return { ...result, outcome: 'stale' };
    const page = await listMeetingNotesV2({
      accessToken: input.accessToken,
      cursor,
      limit: PAGE_SIZE,
      signal: input.signal,
    });
    if (input.signal?.aborted || !isCurrent()) return { ...result, outcome: 'stale' };
    const merged = await mergeRemoteRoots.execute({
      scopeKey: input.scopeKey,
      snapshots: page.items.map(rootSnapshot),
      canonicalWrite: true,
    });
    if (
      (merged.created > 0 || merged.updated > 0 || merged.attachedRemoteIdentities > 0)
      && merged.canonicalRevision === null
    ) throw new Error('会议下行同步未推进本机数据版本');
    addMerge(result, merged);
    for (const meeting of page.items) {
      const occurrence = occurrenceSnapshot(meeting);
      if (!occurrence) continue;
      const occurrenceResult = await sqliteMeetingNoteRepository.mergeOccurrenceRemote({
        scopeKey: input.scopeKey,
        remote: occurrence,
        pulledAtMs: Date.now(),
      });
      if (occurrenceResult.outcome === 'conflicted') result.occurrenceConflicts += 1;
      if (occurrenceResult.outcome === 'meeting_unavailable') result.occurrenceDeferred += 1;
    }
    if (input.signal?.aborted || !isCurrent()) return { ...result, outcome: 'stale' };
    const advanced = await sqliteMeetingNoteRepository.advanceMeetingRootPullCursor({
      scopeKey: input.scopeKey,
      expectedCursor: cursor,
      nextCursor: page.nextCursor,
      pulledAtMs: Date.now(),
    });
    if (!advanced) return { ...result, outcome: 'stale' };
    result.pages += 1;
    result.items += page.items.length;
    cursor = page.nextCursor;
    if (!page.hasMore) {
      completed = true;
      break;
    }
  }
  result.outcome = completed ? 'pulled' : 'page_limit';
  diagnosticAudit('meeting_root_pull', {
    status: result.outcome,
    pages: result.pages,
    items: result.items,
    created: result.created,
    updated: result.updated,
    protected_local: result.protectedLocal,
    identities_attached: result.attachedRemoteIdentities,
    tombstones: result.remoteTombstonesApplied,
    restores: result.remoteRestoresApplied,
    ignored_stale: result.ignoredStale,
    occurrence_conflicts: result.occurrenceConflicts,
    occurrence_deferred: result.occurrenceDeferred,
  });
  return result;
}
