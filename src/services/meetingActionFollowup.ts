import {
  LinkMeetingActionFollowupEventUseCase,
  type LinkMeetingActionFollowupEventResult,
} from '../application/meeting';
import { sqliteMeetingNoteRepository } from '../data/repositories';
import type { MeetingSummaryActionCandidate, ScopeKey } from '../domain/meeting';
import type { EventDraftParams, MeetingActionFollowupParams } from '../types';

const linkUseCase = new LinkMeetingActionFollowupEventUseCase(sqliteMeetingNoteRepository);

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function localTimeKey(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

function requestHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(36)}${right.toString(36)}`;
}

export function meetingActionFollowupClientRequestId(actionId: string): string {
  const normalized = actionId.trim();
  const readable = normalized.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 56) || 'action';
  return `action-followup:${readable}:${requestHash(normalized)}`.slice(0, 96);
}

function futureStart(now: Date): Date {
  const value = new Date(now.getTime() + 60 * 60 * 1000);
  value.setSeconds(0, 0);
  value.setMinutes(value.getMinutes() < 30 ? 30 : 60);
  return value;
}

export function meetingActionFollowupDraft(
  action: Pick<MeetingSummaryActionCandidate, 'content' | 'dueAtMs'>,
  now = new Date(),
): EventDraftParams {
  const due = action.dueAtMs === null ? null : new Date(action.dueAtMs);
  const validDue = due !== null && !Number.isNaN(due.getTime()) ? due : null;
  const dueHasExplicitTime = validDue !== null && (
    validDue.getHours() !== 0 || validDue.getMinutes() !== 0
    || validDue.getSeconds() !== 0 || validDue.getMilliseconds() !== 0
  );
  const start = validDue
    ? new Date(
      validDue.getFullYear(),
      validDue.getMonth(),
      validDue.getDate(),
      dueHasExplicitTime ? validDue.getHours() : 10,
      dueHasExplicitTime ? validDue.getMinutes() : 0,
      0,
      0,
    )
    : futureStart(now);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const startDate = localDateKey(start);
  const endDate = localDateKey(end);
  return {
    title: action.content.trim().slice(0, 100),
    startDate,
    ...(endDate !== startDate ? { endDate } : {}),
    startTime: localTimeKey(start),
    endTime: localTimeKey(end),
    isAllDay: false,
    repeat: 'once',
    reminderMinutes: null,
  };
}

export async function linkMeetingActionFollowup(
  followup: MeetingActionFollowupParams,
  scopeKey: ScopeKey,
  eventSourceId: string,
): Promise<LinkMeetingActionFollowupEventResult> {
  return linkUseCase.execute({
    meetingId: followup.canonicalMeetingId,
    actionId: followup.actionId,
    scopeKey,
    eventSourceId,
  });
}
