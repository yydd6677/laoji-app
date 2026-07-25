import type {
  MeetingNoteAggregate,
  MeetingNoteRepository,
  MeetingRootRemoteConflictFields,
  SyncOperationRecord,
} from '../../data/repositories';
import type { ClientIdFactory, MeetingLifecycle, ScopeKey } from '../../domain/meeting';
import { assertScopeKey, secureClientIdFactory } from '../../domain/meeting';
import {
  meetingRootSyncConflictView,
  restorableLifecycleFromRemote,
  type MeetingRootSyncConflictView,
} from '../../services/meetingRootConflicts';
import { requestMeetingRootSync } from './rootSyncTrigger';

export class MeetingRootSyncConflictChangedError extends Error {
  constructor() {
    super('meeting root sync conflict changed');
    this.name = 'MeetingRootSyncConflictChangedError';
  }
}

export interface ResolveMeetingRootSyncConflictUseCaseInput {
  conflictId: string;
  meetingId: string;
  scopeKey: ScopeKey;
  expectedLocalUpdatedAtMs: number;
  resolution: 'keep_local' | 'use_remote';
}

export interface ResolveMeetingRootSyncConflictUseCaseResult {
  aggregate: MeetingNoteAggregate;
  resolution: ResolveMeetingRootSyncConflictUseCaseInput['resolution'];
}

function localStatus(
  aggregate: MeetingNoteAggregate,
): string {
  if (aggregate.note.lifecycle === 'ended') return 'ended';
  if (aggregate.note.lifecycle === 'draft') return 'draft';
  const capture = aggregate.processingStages.find(stage => stage.stage === 'capture')?.status;
  if (capture === 'paused') return 'paused';
  if (capture === 'recording') return 'recording';
  return 'processing';
}

function updatePayload(
  aggregate: MeetingNoteAggregate,
  remote: NonNullable<MeetingRootSyncConflictView['remote']>,
): string {
  return JSON.stringify({
    schema_version: 1,
    meeting_id: aggregate.note.id,
    base_revision: remote.revision,
    changes: {
      title: aggregate.note.title,
      description: aggregate.note.description,
      participants: aggregate.note.participants,
      location: aggregate.note.location,
      mode: aggregate.note.mode ?? remote.mode,
      recordedAtMs: aggregate.note.recordedAtMs,
      status: localStatus(aggregate),
    },
  });
}

function operation(
  input: {
    operationId: string;
    scopeKey: ScopeKey;
    meetingId: string;
    type: 'meeting.restore' | 'meeting.update' | 'meeting.delete';
    baseRevision: number;
    payloadJson: string;
    createdAtMs: number;
  },
): SyncOperationRecord {
  return {
    operationId: input.operationId,
    scopeKey: input.scopeKey,
    aggregateType: 'meeting_note',
    aggregateId: input.meetingId,
    operationType: input.type,
    baseRevision: input.baseRevision,
    payloadJson: input.payloadJson,
    createdAtMs: input.createdAtMs,
  };
}

function identityPayload(meetingId: string, baseRevision: number): string {
  return JSON.stringify({ schema_version: 1, meeting_id: meetingId, base_revision: baseRevision });
}

function nextOperations(
  aggregate: MeetingNoteAggregate,
  view: MeetingRootSyncConflictView,
  scopeKey: ScopeKey,
  resolvedAtMs: number,
  idFactory: ClientIdFactory,
): readonly SyncOperationRecord[] {
  const remote = view.remote!;
  const localDeleted = aggregate.note.lifecycle === 'deleted';
  const remoteDeleted = remote.lifecycle === 'deleted';
  if (localDeleted && remoteDeleted) return [];
  if (localDeleted) {
    return [operation({
      operationId: idFactory.create(),
      scopeKey,
      meetingId: aggregate.note.id,
      type: 'meeting.delete',
      baseRevision: remote.revision,
      payloadJson: JSON.stringify({
        schema_version: 1,
        meeting_id: aggregate.note.id,
        base_revision: remote.revision,
        deleted_at_ms: aggregate.note.deletedAtMs ?? aggregate.note.updatedAtMs,
      }),
      createdAtMs: resolvedAtMs,
    })];
  }
  const update = operation({
    operationId: idFactory.create(),
    scopeKey,
    meetingId: aggregate.note.id,
    type: 'meeting.update',
    baseRevision: remote.revision,
    payloadJson: updatePayload(aggregate, remote),
    createdAtMs: resolvedAtMs,
  });
  if (!remoteDeleted) return [update];
  return [
    operation({
      operationId: idFactory.create(),
      scopeKey,
      meetingId: aggregate.note.id,
      type: 'meeting.restore',
      baseRevision: remote.revision,
      payloadJson: identityPayload(aggregate.note.id, remote.revision),
      createdAtMs: resolvedAtMs,
    }),
    update,
  ];
}

function remoteFields(
  view: MeetingRootSyncConflictView,
): MeetingRootRemoteConflictFields {
  const remote = view.remote!;
  return {
    remoteId: remote.remoteId,
    clientNoteId: remote.clientNoteId,
    remoteRevision: remote.revision,
    origin: remote.origin,
    entryPoint: remote.entryPoint,
    title: remote.title,
    description: remote.description,
    participants: remote.participants,
    location: remote.location,
    mode: remote.mode,
    recordedAtMs: remote.recordedAtMs,
    lifecycle: view.remoteLifecycle as MeetingLifecycle,
    deletedFromLifecycle: remote.lifecycle === 'deleted'
      ? restorableLifecycleFromRemote(remote)
      : null,
    deletedAtMs: remote.deletedAtMs,
    serverCreatedAtMs: remote.serverCreatedAtMs,
    serverUpdatedAtMs: remote.serverUpdatedAtMs,
  };
}

export class ResolveMeetingRootSyncConflictUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  private async currentConflict(
    input: ResolveMeetingRootSyncConflictUseCaseInput,
  ): Promise<{ aggregate: MeetingNoteAggregate; view: MeetingRootSyncConflictView }> {
    const aggregate = await this.repository.get(input.meetingId, input.scopeKey);
    if (!aggregate || aggregate.note.updatedAtMs !== input.expectedLocalUpdatedAtMs) {
      throw new MeetingRootSyncConflictChangedError();
    }
    const conflict = await this.repository.getMeetingRootSyncConflict(
      input.meetingId,
      input.scopeKey,
    );
    if (!conflict || conflict.id !== input.conflictId) {
      throw new MeetingRootSyncConflictChangedError();
    }
    return { aggregate, view: meetingRootSyncConflictView(aggregate, conflict) };
  }

  async execute(
    input: ResolveMeetingRootSyncConflictUseCaseInput,
  ): Promise<ResolveMeetingRootSyncConflictUseCaseResult> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('guest meeting cannot resolve a sync conflict');
    const conflictId = input.conflictId.trim();
    const meetingId = input.meetingId.trim();
    if (!conflictId || !meetingId) throw new Error('meeting root conflict identity is invalid');
    if (!Number.isSafeInteger(input.expectedLocalUpdatedAtMs) || input.expectedLocalUpdatedAtMs < 0) {
      throw new Error('meeting root conflict revision is invalid');
    }
    const current = await this.currentConflict({ ...input, conflictId, meetingId });
    const { aggregate, view } = current;
    if (!view.remote || !view.remoteLifecycle) {
      throw new Error('meeting root remote version is unavailable');
    }
    if (input.resolution === 'keep_local' ? !view.canKeepLocal : !view.canUseRemote) {
      throw new Error('meeting root remote identity is incompatible');
    }
    const clockMs = this.now();
    if (!Number.isSafeInteger(clockMs) || clockMs < 0) {
      throw new Error('meeting root conflict resolution clock is invalid');
    }
    const resolvedAtMs = Math.max(
      clockMs,
      aggregate.note.updatedAtMs + 1,
      view.remote.serverUpdatedAtMs + 1,
    );
    const operations = input.resolution === 'keep_local'
      ? nextOperations(aggregate, view, input.scopeKey, resolvedAtMs, this.idFactory)
      : [];
    const applied = await this.repository.resolveMeetingRootSyncConflict({
      conflictId,
      meetingId,
      scopeKey: input.scopeKey,
      expectedLocalUpdatedAtMs: input.expectedLocalUpdatedAtMs,
      resolution: input.resolution,
      remoteId: view.remote.remoteId,
      remoteClientNoteId: view.remote.clientNoteId,
      remoteRevision: view.remote.revision,
      remoteFields: input.resolution === 'use_remote' ? remoteFields(view) : null,
      nextOperations: operations,
      resolvedAtMs,
    });
    if (!applied) throw new MeetingRootSyncConflictChangedError();
    const next = await this.repository.get(meetingId, input.scopeKey);
    if (!next) throw new MeetingRootSyncConflictChangedError();
    requestMeetingRootSync(input.scopeKey);
    return { aggregate: next, resolution: input.resolution };
  }
}
