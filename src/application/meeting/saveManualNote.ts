import type {
  ManualNoteRecord,
  MeetingNoteRepository,
  MeetingTransaction,
} from '../../data/repositories';
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey, secureClientIdFactory, type ClientIdFactory } from '../../domain/meeting';
import { requestMeetingManualNoteSync } from './manualNoteSyncTrigger';

const MAX_MANUAL_NOTE_LENGTH = 200_000;

export class ManualNoteRevisionConflictError extends Error {
  constructor() {
    super('manual note revision changed');
    this.name = 'ManualNoteRevisionConflictError';
  }
}

export interface SaveManualNoteInput {
  meetingId: string;
  scopeKey: ScopeKey;
  content: string;
  expectedRevision?: number | null;
  operationId?: string;
}

export interface SaveManualNoteResult {
  note: ManualNoteRecord;
  applied: boolean;
}

export class SaveManualNoteUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  async execute(input: SaveManualNoteInput): Promise<SaveManualNoteResult> {
    let result: SaveManualNoteResult | null = null;
    await this.repository.transaction(async transaction => {
      result = await this.executeInTransaction(transaction, input);
    });
    if (!result) throw new Error('manual note transaction produced no result');
    const committed = result as SaveManualNoteResult;
    if (committed.applied) requestMeetingManualNoteSync(input.scopeKey);
    return committed;
  }

  async executeInTransaction(
    transaction: MeetingTransaction,
    input: SaveManualNoteInput,
  ): Promise<SaveManualNoteResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    if (!meetingId) throw new Error('meeting ID is invalid');
    const content = input.content.replace(/\r\n?/g, '\n');
    if (content.length > MAX_MANUAL_NOTE_LENGTH) throw new Error('manual note is too long');
    const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
    if (!meeting || meeting.lifecycle === 'deleted') {
      throw new Error('meeting does not exist in active scope');
    }
    const current = await transaction.getManualNote(meetingId, input.scopeKey);
    if (!current) throw new Error('meeting manual note is missing');
    if (current.content === content) return { note: current, applied: false };
    // A retry may arrive after SQLite committed but before the caller received
    // the result. Equal content is therefore an idempotent success even when
    // the caller still carries the previous revision.
    if (input.expectedRevision != null && input.expectedRevision !== current.revision) {
      throw new ManualNoteRevisionConflictError();
    }
    const clockMs = this.now();
    if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting clock is invalid');
    const revision = current.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('manual note revision overflow');
    const savedAtMs = Math.max(clockMs, current.lastSavedAtMs + 1, meeting.updatedAtMs + 1);
    const next: ManualNoteRecord = {
      ...current,
      content,
      revision,
      dirty: true,
      lastSavedAtMs: savedAtMs,
      userEditedAtMs: savedAtMs,
    };
    if (input.scopeKey !== 'guest') {
      const operationId = input.operationId?.trim() || this.idFactory.create();
      const inserted = await transaction.insertOutbox({
        operationId,
        scopeKey: input.scopeKey,
        aggregateType: 'manual_note',
        aggregateId: meetingId,
        operationType: 'manual_note.upsert',
        baseRevision: current.baseRemoteRevision,
        payloadJson: JSON.stringify({
          schema_version: 2,
          meeting_id: meetingId,
          expected_remote_revision: current.baseRemoteRevision,
          client_note_revision: revision,
          client_updated_at_ms: savedAtMs,
          user_edited_at_ms: savedAtMs,
          content,
        }),
        createdAtMs: savedAtMs,
      });
      if (!inserted) throw new Error('manual note sync identity already exists');
    }
    await transaction.saveManualNote(next, input.scopeKey);
    await transaction.markCurrentSummaryStale(meetingId, input.scopeKey);
    if (input.scopeKey !== 'guest') {
      await transaction.updateMeeting(meetingId, input.scopeKey, {
        syncState: 'pending',
        updatedAtMs: savedAtMs,
      });
    }
    return { note: next, applied: true };
  }
}
