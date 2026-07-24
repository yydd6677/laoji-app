import type {
  MeetingNoteRepository,
  SummaryVersionRecord,
} from '../../data/repositories';
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';

export class MeetingSummaryVersionConflictError extends Error {
  constructor() {
    super('meeting summary current version changed');
    this.name = 'MeetingSummaryVersionConflictError';
  }
}

export class MeetingSummaryVersionUnavailableError extends Error {
  constructor() {
    super('meeting summary version is unavailable');
    this.name = 'MeetingSummaryVersionUnavailableError';
  }
}

export interface SelectMeetingSummaryVersionInput {
  meetingId: string;
  versionId: string;
  expectedCurrentVersionId: string | null;
  scopeKey: ScopeKey;
}

export interface SelectMeetingSummaryVersionResult {
  version: SummaryVersionRecord;
  applied: boolean;
}

export class SelectMeetingSummaryVersionUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(input: SelectMeetingSummaryVersionInput): Promise<SelectMeetingSummaryVersionResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    const versionId = input.versionId.trim();
    if (!meetingId || !versionId) throw new MeetingSummaryVersionUnavailableError();
    let result: SelectMeetingSummaryVersionResult | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      const version = await transaction.getSummaryVersion(versionId, input.scopeKey);
      if (
        !meeting
        || meeting.lifecycle === 'deleted'
        || !version
        || version.meetingId !== meetingId
        || (version.status !== 'ready' && version.status !== 'stale')
      ) {
        throw new MeetingSummaryVersionUnavailableError();
      }
      if (meeting.currentSummaryVersionId === versionId) {
        result = { version, applied: false };
        return;
      }
      if (meeting.currentSummaryVersionId !== input.expectedCurrentVersionId) {
        throw new MeetingSummaryVersionConflictError();
      }
      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0 || meeting.updatedAtMs >= Number.MAX_SAFE_INTEGER) {
        throw new Error('meeting summary selection clock is invalid');
      }
      await transaction.updateMeeting(meetingId, input.scopeKey, {
        currentSummaryVersionId: versionId,
        updatedAtMs: Math.max(clockMs, meeting.updatedAtMs + 1),
      });
      result = { version, applied: true };
    });

    if (!result) throw new Error('meeting summary selection produced no result');
    return result;
  }
}
