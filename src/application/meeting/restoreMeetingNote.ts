import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';
import type { MeetingNoteAggregate, MeetingNoteRepository } from "../../data/repositories/meetingNoteRepository";
import type { MeetingRootSyncOperation } from './updateMeetingNote';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RestoreMeetingNoteInput {
  meetingId: string;
  scopeKey: ScopeKey;
  retentionDays: number;
  syncOperation: MeetingRootSyncOperation;
  canonicalWrite?: boolean;
}

export interface RestoreMeetingNoteResult {
  aggregate: MeetingNoteAggregate;
  restored: boolean;
  canonicalRevision: number | null;
}

export interface RestoreMeetingNoteDependencies {
  repository: MeetingNoteRepository;
  now?: () => number;
}

function normalizeRetentionDays(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_650) {
    throw new Error('meeting recycle retention is invalid');
  }
  return value;
}

export class RestoreMeetingNoteUseCase {
  private readonly repository: MeetingNoteRepository;
  private readonly now: () => number;

  constructor(dependencies: RestoreMeetingNoteDependencies) {
    this.repository = dependencies.repository;
    this.now = dependencies.now ?? Date.now;
  }

  async execute(input: RestoreMeetingNoteInput): Promise<RestoreMeetingNoteResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    if (!meetingId) throw new Error('meeting ID is invalid');
    const retentionDays = normalizeRetentionDays(input.retentionDays);
    let restored = false;
    let canonicalRevision: number | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting) throw new Error('meeting does not exist in active scope');
      if (meeting.lifecycle !== 'deleted') throw new Error('meeting is not in the recycle bin');
      if (!meeting.deletedFromLifecycle || meeting.deletedAtMs === null) {
        throw new Error('meeting deletion history cannot be restored safely');
      }
      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting clock is invalid');
      const expiresAtMs = meeting.deletedAtMs + retentionDays * DAY_MS;
      if (!Number.isSafeInteger(expiresAtMs) || clockMs >= expiresAtMs) {
        throw new Error('meeting recycle retention has expired');
      }
      const restoredAtMs = Math.max(clockMs, meeting.updatedAtMs + 1);
      if (!Number.isSafeInteger(restoredAtMs)) throw new Error('meeting clock is invalid');
      if (input.canonicalWrite) {
        canonicalRevision = await transaction.advanceCanonicalWrite(input.scopeKey, restoredAtMs);
      }
      await transaction.updateMeeting(meetingId, input.scopeKey, {
        lifecycle: meeting.deletedFromLifecycle,
        deletedFromLifecycle: null,
        deletedAtMs: null,
        updatedAtMs: restoredAtMs,
      });
      restored = true;
    });

    const aggregate = await this.repository.get(meetingId, input.scopeKey);
    if (!aggregate) throw new Error('meeting restoration transaction lost aggregate');
    return { aggregate, restored, canonicalRevision };
  }
}
