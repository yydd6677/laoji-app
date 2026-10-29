import {
  LinkMeetingActionFollowupEventUseCase,
  type LinkMeetingActionFollowupEventResult,
} from '../application/meeting';
import { sqliteMeetingNoteRepository } from "../data/repositories/sqliteMeetingNoteRepository";
import type { MeetingSummaryActionCandidate, ScopeKey } from '../domain/meeting';
import type { EventDraftParams, MeetingActionFollowupParams } from '../types';
import { MeetingActionFollowupConflictError, MeetingActionFollowupUnavailableError } from '../application/meeting/linkMeetingActionFollowupEvent';
import { hasScheduleEditorSavedEvent, listSavedScheduleFollowups, settleScheduleEditorFollowup } from '../data/repositories/scheduleEditorRepository';
import { isLocalDataErasing, localDataEraseRevision } from './localDataEraseState';
import { diagnosticAudit } from './diagnostics';

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
  const start = validDue ?? now;
  const startDate = localDateKey(start);
  return {
    title: action.content.trim().slice(0, 100),
    startDate,
    timePrecision: dueHasExplicitTime ? 'exact' : 'unspecified',
    timePeriod: null,
    ...(dueHasExplicitTime ? { startTime: localTimeKey(start) } : {}),
    isAllDay: false,
    repeat: 'once',
    reminderMinutes: null,
  };
}

async function linkMeetingActionFollowup(
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

let reconciling: Promise<{ retryInMs: number | null }> | null = null;

/** Cross-database completion replays the saved source receipt, not calendar creation. */
export function reconcileSavedScheduleFollowups(): Promise<{ retryInMs: number | null }> {
  if (reconciling) return reconciling;
  const epoch = localDataEraseRevision();
  const valid = () => !isLocalDataErasing() && epoch === localDataEraseRevision();
  const run = (async () => {
    if (!valid()) return { retryInMs: null };
    for (const draft of await listSavedScheduleFollowups()) {
      if (!valid()) return { retryInMs: null };
      const followup = draft.followup!;
      if (followup.retryAtMs > Date.now()) continue;
      try {
        const exists = await hasScheduleEditorSavedEvent(draft);
        if (!valid()) return { retryInMs: null };
        if (exists) await linkMeetingActionFollowup(followup.params, 'guest', draft.savedEventRef!.sourceEventId);
        if (!valid()) return { retryInMs: null };
        await settleScheduleEditorFollowup(draft, exists ? 'linked' : 'retired');
      } catch (reason) {
        if (!valid()) return { retryInMs: null };
        const terminal = reason instanceof MeetingActionFollowupConflictError || reason instanceof MeetingActionFollowupUnavailableError;
        await settleScheduleEditorFollowup(draft, terminal ? 'retired' : 'pending', terminal ? 0
          : Date.now() + Math.min(300_000, 1_000 * 2 ** Math.min(followup.attempts, 9)));
        diagnosticAudit('schedule_followup_completion', { outcome: terminal ? 'retired' : 'retry' });
      }
    }
    if (!valid()) return { retryInMs: null };
    const remaining = await listSavedScheduleFollowups();
    return { retryInMs: remaining.length ? Math.max(0, Math.min(...remaining.map(value => value.followup!.retryAtMs)) - Date.now()) : null };
  })();
  reconciling = run;
  void run.finally(() => { if (reconciling === run) reconciling = null; }).catch(() => {});
  return run;
}
