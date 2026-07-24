import type {
  ActionItemRecord,
  MeetingNoteRepository,
} from '../../data/repositories';
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey, secureClientIdFactory, type ClientIdFactory } from '../../domain/meeting';
import { requestMeetingActionSync } from './actionSyncTrigger';

const MAX_ACTION_CONTENT_LENGTH = 20_000;
const MAX_ASSIGNEE_LENGTH = 200;

export class MeetingActionRevisionConflictError extends Error {
  constructor() {
    super('meeting action revision changed');
    this.name = 'MeetingActionRevisionConflictError';
  }
}

export interface UpdateMeetingActionInput {
  meetingId: string;
  actionId: string;
  scopeKey: ScopeKey;
  expectedUpdatedAtMs: number;
  content?: string;
  status?: ActionItemRecord['status'];
  assigneeText?: string | null;
  dueAtMs?: number | null;
  reminderAtMs?: number | null;
  reminderNotificationId?: string | null;
  operationId?: string;
}

export interface UpdateMeetingActionResult {
  action: ActionItemRecord;
  applied: boolean;
}

function normalizedContent(value: string): string {
  const result = value.replace(/\r\n?/g, '\n').trim();
  if (!result) throw new Error('meeting action content is empty');
  if (result.length > MAX_ACTION_CONTENT_LENGTH) throw new Error('meeting action content is too long');
  return result;
}

function normalizedAssignee(value: string | null): string | null {
  if (value === null) return null;
  const result = value.trim();
  if (result.length > MAX_ASSIGNEE_LENGTH) throw new Error('meeting action assignee is too long');
  return result || null;
}

function normalizedDueAtMs(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('meeting action due time is invalid');
  return value;
}

function normalizedReminderNotificationId(value: string | null): string | null {
  if (value === null) return null;
  const result = value.trim();
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error('meeting action notification identity is invalid');
  }
  return result;
}

export class UpdateMeetingActionUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  async execute(input: UpdateMeetingActionInput): Promise<UpdateMeetingActionResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    const actionId = input.actionId.trim();
    if (!meetingId || !actionId) throw new Error('meeting action identity is invalid');
    if (!Number.isSafeInteger(input.expectedUpdatedAtMs) || input.expectedUpdatedAtMs < 0) {
      throw new Error('meeting action expected revision is invalid');
    }
    let result: UpdateMeetingActionResult | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting || meeting.lifecycle === 'deleted') {
        throw new Error('meeting does not exist in active scope');
      }
      const current = await transaction.getMeetingAction(actionId, meetingId, input.scopeKey);
      if (!current) throw new Error('meeting action does not exist in active scope');
      const content = input.content === undefined ? current.content : normalizedContent(input.content);
      const status = input.status ?? current.status;
      const assigneeText = input.assigneeText === undefined
        ? current.assigneeText
        : normalizedAssignee(input.assigneeText);
      const dueAtMs = input.dueAtMs === undefined ? current.dueAtMs : normalizedDueAtMs(input.dueAtMs);
      if (!['pending', 'completed', 'dismissed'].includes(status)) {
        throw new Error('meeting action status is invalid');
      }
      let reminderAtMs = input.reminderAtMs === undefined
        ? current.reminderAtMs
        : normalizedDueAtMs(input.reminderAtMs);
      let reminderNotificationId = input.reminderNotificationId === undefined
        ? current.reminderNotificationId
        : normalizedReminderNotificationId(input.reminderNotificationId);
      if (status !== 'pending') {
        reminderAtMs = null;
        reminderNotificationId = null;
      }
      if (reminderAtMs !== null && dueAtMs === null) {
        throw new Error('meeting action reminder requires a due time');
      }
      if (reminderAtMs === null) reminderNotificationId = null;
      const unchanged = content === current.content
        && status === current.status
        && assigneeText === current.assigneeText
        && dueAtMs === current.dueAtMs
        && reminderAtMs === current.reminderAtMs
        && reminderNotificationId === current.reminderNotificationId;
      if (unchanged) {
        result = { action: current, applied: false };
        return;
      }
      if (current.updatedAtMs !== input.expectedUpdatedAtMs) {
        throw new MeetingActionRevisionConflictError();
      }
      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting action clock is invalid');
      const updatedAtMs = Math.max(clockMs, current.updatedAtMs + 1, meeting.updatedAtMs + 1);
      const next: ActionItemRecord = {
        ...current,
        content,
        status,
        assigneeText,
        dueAtMs,
        reminderAtMs,
        reminderNotificationId,
        userEditedAtMs: updatedAtMs,
        completedAtMs: status === 'completed'
          ? current.status === 'completed' && current.completedAtMs !== null
            ? current.completedAtMs
            : updatedAtMs
          : null,
        updatedAtMs,
      };
      if (input.scopeKey !== 'guest') {
        const operationId = input.operationId?.trim() || this.idFactory.create();
        const inserted = await transaction.insertOutbox({
          operationId,
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
            completed_at_ms: next.completedAtMs,
            content,
            status,
            assignee: assigneeText,
            due_at_ms: dueAtMs,
            reminder_at_ms: reminderAtMs,
            followup_event_source_id: current.followupEventSourceId,
            source_kind: current.sourceKind,
            source_summary_version_id: current.sourceSummaryVersionId,
            source_segment_id: current.sourceSegmentId,
            source_start_ms: current.sourceStartMs,
            generation_fingerprint: current.generationFingerprint,
          }),
          createdAtMs: updatedAtMs,
        });
        if (!inserted) {
          result = { action: current, applied: false };
          return;
        }
      }
      const updated = await transaction.updateMeetingAction(
        actionId,
        meetingId,
        input.scopeKey,
        current.updatedAtMs,
        {
          content: next.content,
          status: next.status,
          assigneeText: next.assigneeText,
          dueAtMs: next.dueAtMs,
          reminderAtMs: next.reminderAtMs,
          reminderNotificationId: next.reminderNotificationId,
          userEditedAtMs: updatedAtMs,
          completedAtMs: next.completedAtMs,
          updatedAtMs,
        },
      );
      if (!updated) throw new MeetingActionRevisionConflictError();
      await transaction.updateMeeting(meetingId, input.scopeKey, {
        syncState: input.scopeKey === 'guest' ? 'local' : 'pending',
        updatedAtMs,
      });
      result = { action: next, applied: true };
    });

    if (!result) throw new Error('meeting action transaction produced no result');
    const committedResult = result as UpdateMeetingActionResult;
    if (committedResult.applied) requestMeetingActionSync(input.scopeKey);
    return committedResult;
  }
}
