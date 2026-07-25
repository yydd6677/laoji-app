import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';
import type { MeetingNoteAggregate, MeetingNoteRepository } from '../../data/repositories';
import type { MeetingRootSyncOperation } from './updateMeetingNote';

export interface DeleteMeetingNoteInput {
  meetingId: string;
  scopeKey: ScopeKey;
  syncOperation?: MeetingRootSyncOperation | null;
  canonicalWrite?: boolean;
  preserveForRestore?: boolean;
}

export interface DeleteMeetingNoteResult {
  aggregate: MeetingNoteAggregate;
  deleted: boolean;
  canonicalRevision: number | null;
}

export interface DeleteMeetingNoteDependencies {
  repository: MeetingNoteRepository;
  now?: () => number;
}

const ACTIVE_CAPTURE_STATUSES = new Set(['preparing', 'recording', 'paused', 'finalizing']);

function normalizeSyncOperation(
  scopeKey: ScopeKey,
  operation: MeetingRootSyncOperation | null | undefined,
): MeetingRootSyncOperation | null {
  if (scopeKey === 'guest') return null;
  const operationId = operation?.operationId.trim() ?? '';
  const operationType = operation?.operationType.trim() ?? '';
  if (!operationId || operationType !== 'meeting.delete') {
    throw new Error('account meeting deletion requires an atomic sync operation');
  }
  return { operationId, operationType };
}

export class DeleteMeetingNoteUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly now: () => number;

  constructor(dependencies: DeleteMeetingNoteDependencies) {
    this.repository = dependencies.repository;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(input: DeleteMeetingNoteInput): Promise<DeleteMeetingNoteResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    if (!meetingId) throw new Error('meeting ID is invalid');
    const syncOperation = normalizeSyncOperation(input.scopeKey, input.syncOperation);
    let deleted = false;
    let canonicalRevision: number | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting) throw new Error('meeting does not exist in active scope');
      if (meeting.lifecycle === 'deleted') {
        if (syncOperation && meeting.syncState === 'pending') {
          const deletedAtMs = meeting.deletedAtMs ?? meeting.updatedAtMs;
          await transaction.insertOutbox({
            operationId: syncOperation.operationId,
            scopeKey: input.scopeKey,
            aggregateType: 'meeting_note',
            aggregateId: meetingId,
            operationType: syncOperation.operationType,
            baseRevision: meeting.remoteRevision,
            payloadJson: JSON.stringify({
              schema_version: 1,
              meeting_id: meetingId,
              base_revision: meeting.remoteRevision,
              deleted_at_ms: deletedAtMs,
            }),
            createdAtMs: deletedAtMs,
          });
        }
        return;
      }
      const capture = await transaction.getStage(meetingId, input.scopeKey, 'capture');
      if (!capture) throw new Error('meeting capture processing stage is missing');
      if (ACTIVE_CAPTURE_STATUSES.has(capture.status)) {
        throw new Error('active recording must finish before meeting deletion');
      }
      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting clock is invalid');
      const deletedAtMs = Math.max(clockMs, meeting.updatedAtMs, capture.updatedAtMs);
      if (syncOperation) {
        const inserted = await transaction.insertOutbox({
          operationId: syncOperation.operationId,
          scopeKey: input.scopeKey,
          aggregateType: 'meeting_note',
          aggregateId: meetingId,
          operationType: syncOperation.operationType,
          baseRevision: meeting.remoteRevision,
          payloadJson: JSON.stringify({
            schema_version: 1,
            meeting_id: meetingId,
            base_revision: meeting.remoteRevision,
            deleted_at_ms: deletedAtMs,
          }),
          createdAtMs: deletedAtMs,
        });
        if (!inserted) return;
      }
      if (input.canonicalWrite) {
        canonicalRevision = await transaction.advanceCanonicalWrite(input.scopeKey, deletedAtMs);
      }
      await transaction.updateMeeting(meetingId, input.scopeKey, {
        lifecycle: 'deleted',
        deletedFromLifecycle: input.preserveForRestore ? meeting.lifecycle : null,
        syncState: input.scopeKey === 'guest' ? 'deleted' : 'pending',
        deletedAtMs,
        updatedAtMs: deletedAtMs,
      });
      deleted = true;
    });

    const aggregate = await this.repository.get(meetingId, input.scopeKey);
    if (!aggregate) throw new Error('meeting deletion transaction lost tombstone');
    return { aggregate, deleted, canonicalRevision };
  }
}
