import type { MeetingNoteRepository } from '../../data/repositories';
import { assertScopeKey, type ScopeKey } from '../../domain/meeting';
import { requestMeetingSpeakerCorrectionSync } from './speakerCorrectionSyncTrigger';

export interface RetryMeetingSpeakerCorrectionSyncInput {
  meetingId: string;
  scopeKey: ScopeKey;
}

export class RetryMeetingSpeakerCorrectionSyncUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(input: RetryMeetingSpeakerCorrectionSyncInput): Promise<boolean> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    if (!meetingId) throw new Error('speaker correction meeting ID is invalid');
    if (input.scopeKey === 'guest') return false;
    const requestedAtMs = this.now();
    if (!Number.isSafeInteger(requestedAtMs) || requestedAtMs < 0) {
      throw new Error('speaker correction retry clock is invalid');
    }
    const scheduled = await this.repository.retrySpeakerCorrectionSyncOperations(
      meetingId,
      input.scopeKey,
      requestedAtMs,
    );
    if (scheduled) requestMeetingSpeakerCorrectionSync(input.scopeKey);
    return scheduled;
  }
}
