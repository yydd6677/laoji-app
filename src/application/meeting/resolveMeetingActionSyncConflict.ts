import type {
  ActionItemRecord,
  MeetingActionRemoteConflictFields,
  MeetingNoteRepository,
  SyncOperationRecord,
} from '../../data/repositories';
import type { ClientIdFactory, ScopeKey } from '../../domain/meeting';
import { assertScopeKey, secureClientIdFactory } from '../../domain/meeting';
import {
  meetingActionSyncConflictView,
  type MeetingActionSyncConflictView,
} from '../../services/meetingActionConflicts';
import { requestMeetingActionSync } from './actionSyncTrigger';

export class MeetingActionSyncConflictChangedError extends Error {
  constructor() {
    super('meeting action sync conflict changed');
    this.name = 'MeetingActionSyncConflictChangedError';
  }
}

export interface ResolveMeetingActionSyncConflictUseCaseInput {
  conflictId: string;
  meetingId: string;
  actionId: string;
  scopeKey: ScopeKey;
  expectedUpdatedAtMs: number;
  resolution: 'keep_local' | 'use_remote';
}

export interface ResolveMeetingActionSyncConflictUseCaseResult {
  action: ActionItemRecord;
  previousNotificationId: string | null;
  resolution: ResolveMeetingActionSyncConflictUseCaseInput['resolution'];
}

function localOperationPayload(
  action: ActionItemRecord,
  remoteId: string | null,
  remoteRevision: number | null,
  resolvedAtMs: number,
): string {
  return JSON.stringify({
    schema_version: 2,
    meeting_id: action.meetingId,
    action_id: action.id,
    remote_id: remoteId,
    expected_remote_revision: remoteRevision,
    client_created_at_ms: action.createdAtMs,
    client_updated_at_ms: resolvedAtMs,
    user_edited_at_ms: resolvedAtMs,
    completed_at_ms: action.completedAtMs,
    content: action.content,
    status: action.status,
    assignee: action.assigneeText,
    due_at_ms: action.dueAtMs,
    reminder_at_ms: action.reminderAtMs,
    followup_event_source_id: action.followupEventSourceId,
    source_kind: action.sourceKind,
    source_summary_version_id: action.sourceSummaryVersionId,
    source_segment_id: action.sourceSegmentSourceId ?? action.sourceSegmentId,
    source_start_ms: action.sourceStartMs,
    generation_fingerprint: action.generationFingerprint,
  });
}

export class ResolveMeetingActionSyncConflictUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  private async currentConflict(
    input: ResolveMeetingActionSyncConflictUseCaseInput,
  ): Promise<{ view: MeetingActionSyncConflictView; meetingUpdatedAtMs: number }> {
    const [aggregate, actions, conflicts] = await Promise.all([
      this.repository.get(input.meetingId, input.scopeKey),
      this.repository.listMeetingActions(input.meetingId, input.scopeKey),
      this.repository.listMeetingActionSyncConflicts(input.meetingId, input.scopeKey),
    ]);
    if (!aggregate || aggregate.note.lifecycle === 'deleted') {
      throw new MeetingActionSyncConflictChangedError();
    }
    const action = actions.find(candidate => candidate.id === input.actionId);
    const conflict = conflicts.find(candidate => candidate.id === input.conflictId);
    if (!action || !conflict || conflict.actionId !== action.id) {
      throw new MeetingActionSyncConflictChangedError();
    }
    if (action.updatedAtMs !== input.expectedUpdatedAtMs) {
      throw new MeetingActionSyncConflictChangedError();
    }
    return {
      view: meetingActionSyncConflictView(action, conflict),
      meetingUpdatedAtMs: aggregate.note.updatedAtMs,
    };
  }

  async execute(
    input: ResolveMeetingActionSyncConflictUseCaseInput,
  ): Promise<ResolveMeetingActionSyncConflictUseCaseResult> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('guest action cannot resolve a sync conflict');
    const conflictId = input.conflictId.trim();
    const meetingId = input.meetingId.trim();
    const actionId = input.actionId.trim();
    if (!conflictId || !meetingId || !actionId) {
      throw new Error('meeting action conflict identity is invalid');
    }
    if (!Number.isSafeInteger(input.expectedUpdatedAtMs) || input.expectedUpdatedAtMs < 0) {
      throw new Error('meeting action conflict revision is invalid');
    }
    const current = await this.currentConflict({ ...input, conflictId, meetingId, actionId });
    const { view } = current;
    const clockMs = this.now();
    if (!Number.isSafeInteger(clockMs) || clockMs < 0) {
      throw new Error('meeting action conflict resolution clock is invalid');
    }
    const resolvedAtMs = Math.max(
      clockMs,
      view.local.updatedAtMs + 1,
      current.meetingUpdatedAtMs + 1,
      view.remote ? view.remote.clientUpdatedAtMs + 1 : 0,
    );
    if (!Number.isSafeInteger(resolvedAtMs)) {
      throw new Error('meeting action conflict resolution clock is invalid');
    }
    let remoteId: string | null;
    let remoteRevision: number | null;
    let remoteFields: MeetingActionRemoteConflictFields | null = null;
    let nextOperation: SyncOperationRecord | null = null;

    if (input.resolution === 'keep_local') {
      if (!view.canKeepLocal) throw new Error('meeting action remote identity is unavailable');
      remoteId = view.remoteIdentity?.remoteId ?? null;
      remoteRevision = view.remoteIdentity?.revision ?? null;
      const operationId = this.idFactory.create();
      nextOperation = {
        operationId,
        scopeKey: input.scopeKey,
        aggregateType: 'action_item',
        aggregateId: actionId,
        operationType: 'action_item.upsert',
        baseRevision: remoteRevision,
        payloadJson: localOperationPayload(view.local, remoteId, remoteRevision, resolvedAtMs),
        createdAtMs: resolvedAtMs,
      };
    } else {
      if (!view.remote) throw new Error('meeting action remote version is unavailable');
      remoteId = view.remote.remoteId;
      remoteRevision = view.remote.revision;
      remoteFields = {
        content: view.remote.content,
        status: view.remote.status,
        assigneeText: view.remote.assigneeText,
        dueAtMs: view.remote.dueAtMs,
        reminderAtMs: view.remote.reminderAtMs,
        reminderNotificationId: null,
        followupEventSourceId: view.remote.followupEventSourceId,
        userEditedAtMs: view.remote.userEditedAtMs,
        completedAtMs: view.remote.completedAtMs,
        updatedAtMs: view.remote.clientUpdatedAtMs,
      };
    }

    const applied = await this.repository.resolveMeetingActionSyncConflict({
      conflictId,
      meetingId,
      actionId,
      scopeKey: input.scopeKey,
      expectedUpdatedAtMs: input.expectedUpdatedAtMs,
      resolution: input.resolution,
      remoteId,
      remoteRevision,
      remoteFields,
      nextOperation,
      resolvedAtMs,
    });
    if (!applied) throw new MeetingActionSyncConflictChangedError();
    const action = (await this.repository.listMeetingActions(meetingId, input.scopeKey))
      .find(candidate => candidate.id === actionId);
    if (!action) throw new MeetingActionSyncConflictChangedError();
    if (input.resolution === 'keep_local') requestMeetingActionSync(input.scopeKey);
    return {
      action,
      previousNotificationId: view.local.reminderNotificationId,
      resolution: input.resolution,
    };
  }
}
