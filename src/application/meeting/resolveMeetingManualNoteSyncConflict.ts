import type {
  ManualNoteRecord,
  MeetingNoteRepository,
  SyncOperationRecord,
} from '../../data/repositories';
import type { ClientIdFactory, ScopeKey } from '../../domain/meeting';
import { assertScopeKey, secureClientIdFactory } from '../../domain/meeting';
import {
  meetingManualNoteSyncConflictView,
  type MeetingManualNoteSyncConflictView,
} from '../../services/meetingManualNoteConflicts';
import { requestMeetingManualNoteSync } from './manualNoteSyncTrigger';

export class MeetingManualNoteSyncConflictChangedError extends Error {
  constructor() {
    super('meeting manual note sync conflict changed');
    this.name = 'MeetingManualNoteSyncConflictChangedError';
  }
}

export interface ResolveMeetingManualNoteSyncConflictUseCaseInput {
  conflictId: string;
  meetingId: string;
  scopeKey: ScopeKey;
  expectedLocalRevision: number;
  resolution: 'keep_local' | 'use_remote';
}

export interface ResolveMeetingManualNoteSyncConflictUseCaseResult {
  note: ManualNoteRecord;
  resolution: ResolveMeetingManualNoteSyncConflictUseCaseInput['resolution'];
}

export class ResolveMeetingManualNoteSyncConflictUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  private async currentConflict(
    input: ResolveMeetingManualNoteSyncConflictUseCaseInput,
  ): Promise<{ view: MeetingManualNoteSyncConflictView; meetingUpdatedAtMs: number }> {
    const aggregate = await this.repository.get(input.meetingId, input.scopeKey);
    if (!aggregate || aggregate.note.lifecycle === 'deleted' || !aggregate.note.remoteId) {
      throw new MeetingManualNoteSyncConflictChangedError();
    }
    const conflict = await this.repository.getMeetingManualNoteSyncConflict(
      input.meetingId,
      input.scopeKey,
    );
    if (!conflict || conflict.id !== input.conflictId) {
      throw new MeetingManualNoteSyncConflictChangedError();
    }
    const view = meetingManualNoteSyncConflictView(
      aggregate.manualNote,
      conflict,
      aggregate.note.remoteId,
    );
    if (view.local.revision !== input.expectedLocalRevision) {
      throw new MeetingManualNoteSyncConflictChangedError();
    }
    return { view, meetingUpdatedAtMs: aggregate.note.updatedAtMs };
  }

  async execute(
    input: ResolveMeetingManualNoteSyncConflictUseCaseInput,
  ): Promise<ResolveMeetingManualNoteSyncConflictUseCaseResult> {
    assertScopeKey(input.scopeKey);
    if (input.scopeKey === 'guest') throw new Error('guest note cannot resolve a sync conflict');
    const conflictId = input.conflictId.trim();
    const meetingId = input.meetingId.trim();
    if (!conflictId || !meetingId) throw new Error('manual note conflict identity is invalid');
    if (!Number.isSafeInteger(input.expectedLocalRevision) || input.expectedLocalRevision < 0) {
      throw new Error('manual note conflict revision is invalid');
    }
    const current = await this.currentConflict({ ...input, conflictId, meetingId });
    const { view } = current;
    if (!view.remote) throw new Error('manual note remote version is unavailable');
    if (input.resolution === 'keep_local' && !view.canKeepLocal) {
      throw new Error('manual note remote version is unavailable');
    }
    if (input.resolution === 'use_remote' && !view.canUseRemote) {
      throw new Error('manual note remote version is unavailable');
    }
    const clockMs = this.now();
    if (!Number.isSafeInteger(clockMs) || clockMs < 0) {
      throw new Error('manual note conflict resolution clock is invalid');
    }
    const resolvedAtMs = Math.max(
      clockMs,
      view.local.lastSavedAtMs + 1,
      current.meetingUpdatedAtMs + 1,
      view.remote.clientUpdatedAtMs + 1,
    );
    let nextOperation: SyncOperationRecord | null = null;
    if (input.resolution === 'keep_local') {
      const operationId = this.idFactory.create();
      const nextRevision = view.local.revision + 1;
      if (!Number.isSafeInteger(nextRevision)) throw new Error('manual note revision overflow');
      const baseRevision = view.remote.exists ? view.remote.revision : null;
      nextOperation = {
        operationId,
        scopeKey: input.scopeKey,
        aggregateType: 'manual_note',
        aggregateId: meetingId,
        operationType: 'manual_note.upsert',
        baseRevision,
        payloadJson: JSON.stringify({
          schema_version: 2,
          meeting_id: meetingId,
          expected_remote_revision: baseRevision,
          client_note_revision: nextRevision,
          client_updated_at_ms: resolvedAtMs,
          user_edited_at_ms: resolvedAtMs,
          content: view.local.content,
        }),
        createdAtMs: resolvedAtMs,
      };
    }
    const applied = await this.repository.resolveMeetingManualNoteSyncConflict({
      conflictId,
      meetingId,
      scopeKey: input.scopeKey,
      expectedLocalRevision: input.expectedLocalRevision,
      resolution: input.resolution,
      remote: view.remote,
      nextOperation,
      resolvedAtMs,
    });
    if (!applied) throw new MeetingManualNoteSyncConflictChangedError();
    const aggregate = await this.repository.get(meetingId, input.scopeKey);
    if (!aggregate || aggregate.note.lifecycle === 'deleted') {
      throw new MeetingManualNoteSyncConflictChangedError();
    }
    if (input.resolution === 'keep_local') requestMeetingManualNoteSync(input.scopeKey);
    return { note: aggregate.manualNote, resolution: input.resolution };
  }
}
