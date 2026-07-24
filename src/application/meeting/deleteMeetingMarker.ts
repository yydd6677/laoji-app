import type { MarkerRecord, MeetingNoteRepository } from '../../data/repositories';
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey } from '../../domain/meeting';

export interface DeleteMeetingMarkerInput {
  meetingId: string;
  markerId: string;
  scopeKey: ScopeKey;
}

export interface DeleteMeetingMarkerResult {
  marker: MarkerRecord | null;
  applied: boolean;
}

export class DeleteMeetingMarkerUseCase {
  constructor(private readonly repository: MeetingNoteRepository) {}

  async execute(input: DeleteMeetingMarkerInput): Promise<DeleteMeetingMarkerResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    const markerId = input.markerId.trim();
    if (!meetingId || !markerId) throw new Error('meeting marker identity is invalid');
    let result: DeleteMeetingMarkerResult | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting || meeting.lifecycle === 'deleted') {
        throw new Error('meeting does not exist in active scope');
      }
      const marker = await transaction.getMeetingMarker(markerId, meetingId, input.scopeKey);
      if (!marker) {
        result = { marker: null, applied: false };
        return;
      }
      const deleted = await transaction.deleteMeetingMarker(markerId, meetingId, input.scopeKey);
      if (!deleted) throw new Error('meeting marker changed during deletion');
      result = { marker, applied: true };
    });

    if (!result) throw new Error('meeting marker transaction produced no result');
    return result;
  }
}
