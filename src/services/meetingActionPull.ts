import {
  listMeetingActionsV2,
  loadMeetingCapabilities,
} from '../data/api/v2';
import {
  sqliteMeetingNoteRepository,
  type MergeMeetingActionPullPageResult,
} from '../data/repositories';
import type { ScopeKey } from '../domain/meeting';
import { reconcileMeetingActionNotifications } from './notifications';
import { diagnosticAudit, diagnosticWarn } from './diagnostics';

const PAGE_LIMIT = 100;
const MAX_PAGES_PER_DETAIL_PULL = 20;

export interface PullMeetingActionsForDetailInput {
  scopeKey: ScopeKey;
  canonicalMeetingId: string;
  meetingRemoteId: string;
  accessToken: string;
  signal?: AbortSignal;
}

export interface PullMeetingActionsForDetailResult {
  outcome: 'pulled' | 'disabled' | 'stale' | 'page_limit';
  pages: number;
  inserted: number;
  updated: number;
  attached: number;
  conflicted: number;
  ignoredStale: number;
}

function emptyResult(
  outcome: PullMeetingActionsForDetailResult['outcome'],
): PullMeetingActionsForDetailResult {
  return {
    outcome,
    pages: 0,
    inserted: 0,
    updated: 0,
    attached: 0,
    conflicted: 0,
    ignoredStale: 0,
  };
}

function addPage(
  total: PullMeetingActionsForDetailResult,
  page: MergeMeetingActionPullPageResult,
): void {
  total.pages += 1;
  total.inserted += page.inserted;
  total.updated += page.updated;
  total.attached += page.attached;
  total.conflicted += page.conflicted;
  total.ignoredStale += page.ignoredStale;
}

export async function pullMeetingActionsForDetail(
  input: PullMeetingActionsForDetailInput,
): Promise<PullMeetingActionsForDetailResult> {
  if (
    input.scopeKey === 'guest'
    || !input.accessToken
    || input.signal?.aborted
  ) return emptyResult('stale');
  const capability = await loadMeetingCapabilities({
    accessToken: input.accessToken,
    forceRefresh: true,
    allowStaleOnError: false,
  });
  if (input.signal?.aborted) return emptyResult('stale');
  if (capability.source !== 'remote' || !capability.capabilities.actionItemsPullV2) {
    return emptyResult('disabled');
  }

  const state = await sqliteMeetingNoteRepository.getMeetingActionPullState(
    input.canonicalMeetingId,
    input.scopeKey,
  );
  if (state && state.remoteMeetingId !== input.meetingRemoteId) {
    throw new Error('行动项拉取会议身份已变化');
  }
  let cursor = state?.cursor ?? null;
  const result = emptyResult('pulled');
  let completed = false;

  for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_DETAIL_PULL; pageIndex += 1) {
    if (input.signal?.aborted) return { ...result, outcome: 'stale' };
    const page = await listMeetingActionsV2({
      accessToken: input.accessToken,
      meetingRemoteId: input.meetingRemoteId,
      cursor,
      limit: PAGE_LIMIT,
      signal: input.signal,
    });
    if (input.signal?.aborted) return { ...result, outcome: 'stale' };
    const merged = await sqliteMeetingNoteRepository.mergeMeetingActionPullPage({
      meetingId: input.canonicalMeetingId,
      remoteMeetingId: input.meetingRemoteId,
      scopeKey: input.scopeKey,
      expectedCursor: cursor,
      nextCursor: page.nextCursor,
      items: page.items.map(item => ({
        remoteId: item.remoteId,
        clientActionId: item.clientActionId,
        revision: item.revision,
        clientCreatedAtMs: item.clientCreatedAtMs,
        clientUpdatedAtMs: item.clientUpdatedAtMs,
        userEditedAtMs: item.userEditedAtMs,
        completedAtMs: item.completedAtMs,
        content: item.content,
        status: item.status,
        assigneeText: item.assignee,
        dueAtMs: item.dueAtMs,
        reminderAtMs: item.reminderAtMs,
        followupEventSourceId: item.followupEventSourceId,
        sourceKind: item.sourceKind,
        sourceSummaryVersionId: item.sourceSummaryVersionId,
        sourceSegmentId: item.sourceSegmentId,
        sourceStartMs: item.sourceStartMs,
        generationFingerprint: item.generationFingerprint,
        serverCreatedAtMs: item.serverCreatedAtMs,
        serverUpdatedAtMs: item.serverUpdatedAtMs,
      })),
      pulledAtMs: Date.now(),
    });
    if (!merged.applied) return { ...result, outcome: 'stale' };
    addPage(result, merged);
    cursor = page.nextCursor;
    if (!page.hasMore) {
      completed = true;
      break;
    }
  }

  if (input.signal?.aborted) return { ...result, outcome: 'stale' };
  await reconcileMeetingActionNotifications(input.scopeKey).catch(error => {
    diagnosticWarn('[meeting-action-pull] reminder reconciliation failed', error);
  });
  result.outcome = completed ? 'pulled' : 'page_limit';
  diagnosticAudit('meeting_action_detail_pull', {
    status: result.outcome,
    pages: result.pages,
    inserted: result.inserted,
    updated: result.updated,
    attached: result.attached,
    conflicted: result.conflicted,
    stale: result.ignoredStale,
  });
  return result;
}
