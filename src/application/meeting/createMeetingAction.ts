import type {
  ActionItemRecord,
  MeetingNoteRepository,
} from '../../data/repositories';
import type { ScopeKey } from '../../domain/meeting';
import { assertScopeKey, secureClientIdFactory, type ClientIdFactory } from '../../domain/meeting';
import { requestMeetingActionSync } from './actionSyncTrigger';

const MAX_ACTION_CONTENT_LENGTH = 20_000;
const MAX_ASSIGNEE_LENGTH = 200;

export class MeetingActionIdentityConflictError extends Error {
  constructor() {
    super('meeting action identity already exists');
    this.name = 'MeetingActionIdentityConflictError';
  }
}

export interface CreateMeetingActionInput {
  meetingId: string;
  scopeKey: ScopeKey;
  content: string;
  assigneeText?: string | null;
  dueAtMs?: number | null;
  reminderAtMs?: number | null;
  reminderNotificationId?: string | null;
  sourceMarkerId?: string | null;
  actionId?: string;
  operationId?: string;
}

export interface CreateMeetingActionResult {
  action: ActionItemRecord;
  applied: boolean;
}

function normalizedContent(value: string): string {
  const result = value.replace(/\r\n?/g, '\n').trim();
  if (!result) throw new Error('meeting action content is empty');
  if (result.length > MAX_ACTION_CONTENT_LENGTH) throw new Error('meeting action content is too long');
  return result;
}

function normalizedAssignee(value: string | null | undefined): string | null {
  if (value == null) return null;
  const result = value.trim();
  if (result.length > MAX_ASSIGNEE_LENGTH) throw new Error('meeting action assignee is too long');
  return result || null;
}

function normalizedTimestamp(value: number | null | undefined, label: string): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function normalizedNotificationId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const result = value.trim();
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error('meeting action notification identity is invalid');
  }
  return result;
}

function normalizedSourceMarkerId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const result = value.trim();
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error('meeting action marker source is invalid');
  }
  return result;
}

function sameCreatedAction(
  current: ActionItemRecord,
  content: string,
  assigneeText: string | null,
  dueAtMs: number | null,
  reminderAtMs: number | null,
  reminderNotificationId: string | null,
  sourceMarkerId: string | null,
  sourceSegmentId: string | null,
  sourceStartMs: number | null,
): boolean {
  return current.sourceKind === (sourceMarkerId === null ? 'manual' : 'marker')
    && current.status === 'pending'
    && current.content === content
    && current.assigneeText === assigneeText
    && current.dueAtMs === dueAtMs
    && current.reminderAtMs === reminderAtMs
    && current.reminderNotificationId === reminderNotificationId
    && current.sourceMarkerId === sourceMarkerId
    && current.sourceSegmentId === sourceSegmentId
    && current.sourceStartMs === sourceStartMs;
}

export class CreateMeetingActionUseCase {
  constructor(
    private readonly repository: MeetingNoteRepository,
    private readonly now: () => number = Date.now,
    private readonly idFactory: ClientIdFactory = secureClientIdFactory,
  ) {}

  async execute(input: CreateMeetingActionInput): Promise<CreateMeetingActionResult> {
    assertScopeKey(input.scopeKey);
    const meetingId = input.meetingId.trim();
    const actionId = input.actionId?.trim() || this.idFactory.create();
    if (!meetingId || !actionId) throw new Error('meeting action identity is invalid');
    const content = normalizedContent(input.content);
    const assigneeText = normalizedAssignee(input.assigneeText);
    const dueAtMs = normalizedTimestamp(input.dueAtMs, 'meeting action due time');
    const reminderAtMs = normalizedTimestamp(input.reminderAtMs, 'meeting action reminder time');
    const reminderNotificationId = normalizedNotificationId(input.reminderNotificationId);
    const sourceMarkerId = normalizedSourceMarkerId(input.sourceMarkerId);
    if (reminderAtMs !== null && dueAtMs === null) {
      throw new Error('meeting action reminder requires a due time');
    }
    if (reminderAtMs === null && reminderNotificationId !== null) {
      throw new Error('meeting action notification requires a reminder time');
    }
    let result: CreateMeetingActionResult | null = null;

    await this.repository.transaction(async transaction => {
      const meeting = await transaction.getMeeting(meetingId, input.scopeKey);
      if (!meeting || meeting.lifecycle === 'deleted') {
        throw new Error('meeting does not exist in active scope');
      }
      const sourceMarker = sourceMarkerId === null
        ? null
        : await transaction.getMeetingMarker(sourceMarkerId, meetingId, input.scopeKey);
      if (sourceMarkerId !== null && !sourceMarker) {
        throw new Error('meeting action marker source is unavailable');
      }
      const sourceSegmentId = sourceMarker?.nearestSegmentId ?? null;
      const sourceStartMs = sourceMarker?.positionMs ?? null;
      const existing = await transaction.getMeetingAction(actionId, meetingId, input.scopeKey);
      if (existing) {
        if (!sameCreatedAction(
          existing,
          content,
          assigneeText,
          dueAtMs,
          reminderAtMs,
          reminderNotificationId,
          sourceMarkerId,
          sourceSegmentId,
          sourceStartMs,
        )) throw new MeetingActionIdentityConflictError();
        result = { action: existing, applied: false };
        return;
      }
      const clockMs = this.now();
      if (!Number.isSafeInteger(clockMs) || clockMs < 0) throw new Error('meeting action clock is invalid');
      const updatedAtMs = Math.max(clockMs, meeting.updatedAtMs + 1);
      const action: ActionItemRecord = {
        id: actionId,
        meetingId,
        remoteId: null,
        remoteRevision: null,
        content,
        status: 'pending',
        assigneeText,
        dueAtMs,
        reminderAtMs,
        reminderNotificationId,
        followupEventSourceId: null,
        sourceKind: sourceMarker === null ? 'manual' : 'marker',
        sourceMarkerId,
        sourceSummaryVersionId: null,
        sourceSegmentId,
        sourceStartMs,
        generationFingerprint: null,
        userEditedAtMs: updatedAtMs,
        completedAtMs: null,
        createdAtMs: updatedAtMs,
        updatedAtMs,
      };
      if (input.scopeKey !== 'guest') {
        const operationId = input.operationId?.trim() || this.idFactory.create();
        const insertedOperation = await transaction.insertOutbox({
          operationId,
          scopeKey: input.scopeKey,
          aggregateType: 'action_item',
          aggregateId: actionId,
          operationType: 'action_item.upsert',
          baseRevision: null,
          payloadJson: JSON.stringify({
            schema_version: 2,
            meeting_id: meetingId,
            action_id: actionId,
            remote_id: null,
            expected_remote_revision: null,
            client_created_at_ms: updatedAtMs,
            client_updated_at_ms: updatedAtMs,
            user_edited_at_ms: updatedAtMs,
            completed_at_ms: null,
            content,
            status: 'pending',
            assignee: assigneeText,
            due_at_ms: dueAtMs,
            reminder_at_ms: reminderAtMs,
            followup_event_source_id: null,
            source_kind: sourceMarker === null ? 'manual' : 'marker',
            source_summary_version_id: null,
            source_segment_id: sourceSegmentId,
            source_start_ms: sourceStartMs,
            generation_fingerprint: null,
          }),
          createdAtMs: updatedAtMs,
        });
        if (!insertedOperation) throw new MeetingActionIdentityConflictError();
      }
      const inserted = await transaction.insertMeetingAction(action, input.scopeKey);
      if (!inserted) throw new MeetingActionIdentityConflictError();
      await transaction.updateMeeting(meetingId, input.scopeKey, {
        syncState: input.scopeKey === 'guest' ? 'local' : 'pending',
        updatedAtMs,
      });
      result = { action, applied: true };
    });

    if (!result) throw new Error('meeting action transaction produced no result');
    const committedResult = result as CreateMeetingActionResult;
    if (committedResult.applied) requestMeetingActionSync(input.scopeKey);
    return committedResult;
  }
}
