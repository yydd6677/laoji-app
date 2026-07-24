import type {
  ActionItemRecord,
  MeetingNoteRepository,
} from '../../data/repositories';
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey, secureClientIdFactory, type ClientIdFactory } from '../../domain/meeting';
import { MeetingActionRevisionConflictError } from './updateMeetingAction';
import { requestMeetingActionSync } from './actionSyncTrigger';

export class MeetingActionFollowupConflictError extends Error {
  constructor(public readonly existingEventSourceId: string) {
    super('meeting action already links a different follow-up event');
    this.name = 'MeetingActionFollowupConflictError';
  }
}

export interface LinkMeetingActionFollowupEventInput {
  meetingId: string;
  actionId: string;
  scopeKey: ScopeKey;
  eventSourceId: string;
  operationId?: string;
}

export interface LinkMeetingActionFollowupEventResult {
  action: ActionItemRecord;
  applied: boolean;
}

function normalizedIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export class LinkMeetingActionFollowupEventUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  async execute(
    input: LinkMeetingActionFollowupEventInput,
  ): Promise<LinkMeetingActionFollowupEventResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = normalizedIdentifier(input.meetingId, 'meeting action meeting identity');
    const actionId = normalizedIdentifier(input.actionId, 'meeting action identity');
    const eventSourceId = normalizedIdentifier(input.eventSourceId, 'follow-up event source identity');
    let result: LinkMeetingActionFollowupEventResult | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting || meeting.lifecycle === 'deleted') {
        throw new Error('meeting does not exist in active scope');
      }
      const current = await transaction.getMeetingAction(actionId, meetingId, input.scopeKey);
      if (!current) throw new Error('meeting action does not exist in active scope');
      if (current.followupEventSourceId === eventSourceId) {
        result = { action: current, applied: false };
        return;
      }
      if (current.followupEventSourceId) {
        throw new MeetingActionFollowupConflictError(current.followupEventSourceId);
      }

      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting action clock is invalid');
      const updatedAtMs = Math.max(clockMs, current.updatedAtMs + 1, meeting.updatedAtMs + 1);
      const next: ActionItemRecord = {
        ...current,
        followupEventSourceId: eventSourceId,
        userEditedAtMs: updatedAtMs,
        updatedAtMs,
      };

      if (input.scopeKey !== 'guest') {
        const inserted = await transaction.insertOutbox({
          operationId: input.operationId?.trim() || this.idFactory.create(),
          scopeKey: input.scopeKey,
          aggregateType: 'action_item',
          aggregateId: actionId,
          operationType: 'action_item.upsert',
          baseRevision: current.remoteRevision,
          payloadJson: JSON.stringify({
            schema_version: 2,
            meeting_id: meetingId,
            action_id: actionId,
            remote_id: current.remoteId,
            expected_remote_revision: current.remoteRevision,
            client_created_at_ms: current.createdAtMs,
            client_updated_at_ms: updatedAtMs,
            user_edited_at_ms: updatedAtMs,
            completed_at_ms: current.completedAtMs,
            content: current.content,
            status: current.status,
            assignee: current.assigneeText,
            due_at_ms: current.dueAtMs,
            reminder_at_ms: current.reminderAtMs,
            followup_event_source_id: eventSourceId,
            source_kind: current.sourceKind,
            source_summary_version_id: current.sourceSummaryVersionId,
            source_segment_id: current.sourceSegmentId,
            source_start_ms: current.sourceStartMs,
            generation_fingerprint: current.generationFingerprint,
          }),
          createdAtMs: updatedAtMs,
        });
        if (!inserted) throw new MeetingActionRevisionConflictError();
      }

      const linked = await transaction.linkMeetingActionFollowupEvent(
        actionId,
        meetingId,
        input.scopeKey,
        current.updatedAtMs,
        {
          followupEventSourceId: eventSourceId,
          userEditedAtMs: updatedAtMs,
          updatedAtMs,
        },
      );
      if (!linked) throw new MeetingActionRevisionConflictError();
      await transaction.updateMeeting(meetingId, input.scopeKey, {
        syncState: input.scopeKey === 'guest' ? 'local' : 'pending',
        updatedAtMs,
      });
      result = { action: next, applied: true };
    });

    if (!result) throw new Error('meeting action follow-up transaction produced no result');
    const committedResult = result as LinkMeetingActionFollowupEventResult;
    if (committedResult.applied) requestMeetingActionSync(input.scopeKey);
    return committedResult;
  }
}
