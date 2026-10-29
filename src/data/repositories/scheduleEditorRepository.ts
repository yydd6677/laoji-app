import type { SQLiteDatabase } from 'expo-sqlite';
import { openScheduleDatabase, withScheduleDatabaseTransaction } from '../db/openScheduleDatabase';
import {
  assertScheduleEditorDraft, createScheduleEditorDraft, initialScheduleEditorChanges,
  recoverScheduleEditorDraft, scheduleEditorEventValue, type ScheduleEditorDraft,
  type ScheduleEditorSaveReceipt, type ScheduleEditorSaveRequest,
} from '../../domain/scheduleEditor';
import type { CalEvent, EventRef, MeetingActionFollowupParams } from '../../types';
import { validateEventDraft } from '../../utils/eventDraftValidation';
import type { ScheduleInputJob } from '../../services/scheduleInput';
import { resolveEventReference } from '../../utils/eventRecurrence';

interface Row {
  id: string;
  state: ScheduleEditorDraft['phase'];
  revision: number;
  state_revision: number;
  draft_json: string;
  input_job_id: string | null;
  save_request_id: string;
}

function decode(row: Row): ScheduleEditorDraft {
  const draft: unknown = JSON.parse(row.draft_json);
  assertScheduleEditorDraft(draft);
  if (draft.id !== row.id || draft.phase !== row.state || draft.revision !== row.revision
    || draft.stateRevision !== row.state_revision || draft.sourceInputJobId !== row.input_job_id
    || draft.saveRequestId !== row.save_request_id) throw new Error('日程草稿存储状态不一致');
  return draft;
}

function values(draft: ScheduleEditorDraft) {
  return [draft.phase, draft.revision, draft.stateRevision, JSON.stringify(draft), draft.sourceInputJobId,
    draft.eventRef ? JSON.stringify(draft.eventRef) : null,
    draft.pendingInput ? JSON.stringify(draft.pendingInput) : null,
    draft.lastUndo ? JSON.stringify(draft.lastUndo) : null, draft.saveRequestId,
    draft.savedEventRef ? JSON.stringify(draft.savedEventRef) : null, Date.now()] as const;
}

function assertSavePayload(draft: ScheduleEditorDraft, event: Partial<CalEvent>): void {
  if (typeof event.title !== 'string' || typeof event.startDate !== 'string') {
    throw new Error('日程保存内容与草稿不一致');
  }
  const expected = validateEventDraft(scheduleEditorEventValue(draft));
  const actual = validateEventDraft({ ...event, title: event.title, startDate: event.startDate });
  if (!expected.valid || !expected.value || !actual.valid || !actual.value
    || Object.entries(expected.value).some(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify((actual.value as Record<string, unknown>)[key]))) {
    throw new Error('日程保存内容与草稿不一致');
  }
}

export async function findCommittedScheduleEditorSave(request: ScheduleEditorSaveRequest,
  event: Partial<CalEvent>): Promise<ScheduleEditorSaveReceipt | null> {
  const row = await (await openScheduleDatabase()).getFirstAsync<Row>(
    'SELECT * FROM schedule_editor_drafts WHERE id=?', request.draftId);
  if (!row) throw new Error('日程草稿不存在');
  const draft = decode(row);
  if (draft.saveRequestId !== request.saveRequestId) throw new Error('日程保存请求不一致');
  if (draft.phase !== 'saved' || !draft.savedEventRef) return null;
  assertSavePayload(draft, event);
  return { ...request, stateRevision: draft.stateRevision, eventRef: draft.savedEventRef };
}

export async function createStoredScheduleEditorDraft(draft: ScheduleEditorDraft): Promise<ScheduleEditorDraft> {
  assertScheduleEditorDraft(draft);
  return withScheduleDatabaseTransaction(async db => {
    const existing = await db.getFirstAsync<Row>(
      'SELECT * FROM schedule_editor_drafts WHERE id = ? OR save_request_id = ? OR (input_job_id IS NOT NULL AND input_job_id = ?)',
      draft.id, draft.saveRequestId, draft.sourceInputJobId,
    );
    if (existing) return bindFollowupInTransaction(db, decode(existing), draft.followup?.params);
    await db.runAsync(`INSERT INTO schedule_editor_drafts (id, state, revision, state_revision, draft_json,
      input_job_id, event_ref_json, pending_input_json, last_undo_json, save_request_id,
      saved_event_ref_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, draft.id, ...values(draft));
    return draft;
  });
}

/** Reopening a received capture must restore its draft, never seed another
 * confirmation copy or overwrite edits with the original ASR observation. */
export async function openScheduleInputEditorDraft(job: ScheduleInputJob): Promise<ScheduleEditorDraft> {
  return withScheduleDatabaseTransaction(async db => {
    // The page snapshot can outlive dismissal/save. Reconcile under the same
    // writer barrier before creating a draft or consuming the original text.
    const existing = await db.getFirstAsync<Row>('SELECT * FROM schedule_editor_drafts WHERE input_job_id=?', job.id);
    if (existing && existing.state === 'saved') return decode(existing);
    const input = await db.getFirstAsync<{ state: string; draft_json: string | null }>(
      'SELECT state,draft_json FROM schedule_input_jobs WHERE id=?', job.id);
    if (input?.state !== 'ready' || !input.draft_json) throw new Error('日程语音尚未准备完成');
    if (existing) return restoreDraftInTransaction(db, existing);
    const parsed: ScheduleInputJob['draft'] = JSON.parse(input.draft_json);
    if (!parsed) throw new Error('日程语音尚未准备完成');
    const seed = createScheduleEditorDraft({ id: `schedule-editor:${job.id}`,
      saveRequestId: `schedule-input:${job.id}`, startDate: null,
      sourceInputJobId: job.id, sourceKind: 'hardware_voice',
      content: initialScheduleEditorChanges(parsed) });
    seed.latestInputText = parsed.raw_text ?? '';
    await db.runAsync(`INSERT INTO schedule_editor_drafts (id, state, revision, state_revision, draft_json,
      input_job_id, event_ref_json, pending_input_json, last_undo_json, save_request_id,
      saved_event_ref_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, seed.id, ...values(seed));
    return seed;
  });
}

/** Reused by the event commit owner for an atomic save/activation receipt. */
export async function writeScheduleEditorDraftInTransaction(
  db: SQLiteDatabase, draft: ScheduleEditorDraft, expectedStateRevision: number,
): Promise<boolean> {
  assertScheduleEditorDraft(draft);
  if (draft.stateRevision <= expectedStateRevision) throw new Error('日程草稿状态版本未推进');
  const previous = await db.getFirstAsync<Row>('SELECT * FROM schedule_editor_drafts WHERE id = ?', draft.id);
  if (!previous || previous.state_revision !== expectedStateRevision) return false;
  const old = decode(previous);
  if (old.sourceInputJobId !== draft.sourceInputJobId || old.saveRequestId !== draft.saveRequestId
    || old.mode !== draft.mode || JSON.stringify(old.eventRef) !== JSON.stringify(draft.eventRef)
    || old.revision > draft.revision || old.inputSequence > draft.inputSequence
    || JSON.stringify(old.followup) !== JSON.stringify(draft.followup)
    || old.phase === 'saved') throw new Error('日程草稿身份或提交回执不能改变');
  const result = await db.runAsync(`UPDATE schedule_editor_drafts SET state=?, revision=?, state_revision=?,
    draft_json=?, input_job_id=?, event_ref_json=?, pending_input_json=?, last_undo_json=?,
    save_request_id=?, saved_event_ref_json=?, updated_at_ms=? WHERE id=? AND state_revision=?`,
    ...values(draft), draft.id, expectedStateRevision);
  return result.changes === 1;
}

export function persistScheduleEditorDraft(draft: ScheduleEditorDraft, expectedStateRevision: number): Promise<boolean> {
  return withScheduleDatabaseTransaction(db => writeScheduleEditorDraftInTransaction(db, draft, expectedStateRevision));
}

export async function loadStoredScheduleEditorDraft(id: string, followup?: MeetingActionFollowupParams): Promise<ScheduleEditorDraft | null> {
  return withScheduleDatabaseTransaction(async db => {
    const row = await db.getFirstAsync<Row>('SELECT * FROM schedule_editor_drafts WHERE id = ?', id);
    if (!row) return null;
    return bindFollowupInTransaction(db, await restoreDraftInTransaction(db, row), followup);
  });
}

async function bindFollowupInTransaction(db: SQLiteDatabase, draft: ScheduleEditorDraft,
  params?: MeetingActionFollowupParams): Promise<ScheduleEditorDraft> {
  if (!params) return draft;
  if (draft.followup) {
    if (Object.keys(draft.followup.params).some(key =>
      draft.followup!.params[key as keyof MeetingActionFollowupParams] !== params[key as keyof MeetingActionFollowupParams])) {
      throw new Error('日程来源已发生变化');
    }
    return draft;
  }
  const next = { ...draft, stateRevision: draft.stateRevision + (draft.phase === 'saved' ? 0 : 1),
    followup: { params: { ...params }, state: 'pending' as const, attempts: 0, retryAtMs: 0 } };
  assertScheduleEditorDraft(next);
  await db.runAsync('UPDATE schedule_editor_drafts SET draft_json=?, state_revision=?, updated_at_ms=? WHERE id=? AND state_revision=?',
    JSON.stringify(next), next.stateRevision, Date.now(), draft.id, draft.stateRevision);
  return next;
}

/** The unique save request, not an ephemeral route, owns meeting adoption. */
export async function findScheduleEditorFollowup(params: MeetingActionFollowupParams): Promise<ScheduleEditorDraft | null> {
  return withScheduleDatabaseTransaction(async db => {
    const row = await db.getFirstAsync<Row>('SELECT * FROM schedule_editor_drafts WHERE save_request_id=?', params.clientRequestId);
    return row ? bindFollowupInTransaction(db, await restoreDraftInTransaction(db, row), params) : null;
  });
}

export async function listSavedScheduleFollowups(): Promise<ScheduleEditorDraft[]> {
  const db = await openScheduleDatabase();
  const rows = await db.getAllAsync<Row>(`SELECT * FROM schedule_editor_drafts WHERE state='saved'
    AND json_valid(draft_json) AND json_extract(draft_json, '$.followup.state')='pending'
    ORDER BY json_extract(draft_json, '$.followup.retryAtMs') ASC, updated_at_ms ASC LIMIT 64`);
  return rows.map(decode);
}

/** Only source completion metadata can advance after the immutable event receipt. */
export async function settleScheduleEditorFollowup(draft: ScheduleEditorDraft,
  state: 'pending' | 'linked' | 'retired', retryAtMs = 0): Promise<boolean> {
  return withScheduleDatabaseTransaction(async db => {
    const row = await db.getFirstAsync<Row>('SELECT * FROM schedule_editor_drafts WHERE id=?', draft.id);
    if (!row) return false;
    const current = decode(row);
    if (current.phase !== 'saved' || current.followup?.state !== 'pending'
      || current.stateRevision !== draft.stateRevision || current.followup.attempts !== draft.followup?.attempts) return false;
    // Completion has its own attempts fence. It cannot invalidate the already
    // issued editor receipt while the original UI is still accepting it.
    const next = { ...current, followup: { ...current.followup,
      state, attempts: current.followup.attempts + 1, retryAtMs } };
    assertScheduleEditorDraft(next);
    const result = await db.runAsync('UPDATE schedule_editor_drafts SET draft_json=?, state_revision=?, updated_at_ms=? WHERE id=? AND state_revision=?',
      JSON.stringify(next), next.stateRevision, Date.now(), current.id, current.stateRevision);
    return result.changes === 1;
  });
}

export async function hasScheduleEditorSavedEvent(draft: ScheduleEditorDraft): Promise<boolean> {
  if (draft.phase !== 'saved' || !draft.savedEventRef) return false;
  const rows = await (await openScheduleDatabase()).getAllAsync<{ event_json: string }>(
    'SELECT event_json FROM local_schedule_events WHERE (id=? OR source_event_id=?) AND deleted_at_ms IS NULL',
    draft.savedEventRef.sourceEventId, draft.savedEventRef.sourceEventId);
  // Later edits may move the occurrence; linking must never restore old content.
  return rows.some(row => {
    const event = JSON.parse(row.event_json) as CalEvent;
    return (event.sourceEventId ?? event.id) === draft.savedEventRef!.sourceEventId;
  });
}

async function restoreDraftInTransaction(db: SQLiteDatabase, row: Row): Promise<ScheduleEditorDraft> {
  const id = row.id;
  const draft = decode(row);
  if (draft.phase === 'saving') {
    // Reconcile the stable request under the same writer barrier. No network
    // worker can commit later: events and the saved receipt use this database.
    if (draft.mode === 'create') {
      const committed = await db.getFirstAsync<{ event_json: string }>(
        "SELECT event_json FROM local_schedule_events WHERE json_valid(event_json) AND json_extract(event_json, '$.clientRequestId')=?",
        draft.saveRequestId);
      if (committed) {
        const event = JSON.parse(committed.event_json) as CalEvent;
        const eventRef = { sourceEventId: event.sourceEventId ?? event.id, occurrenceDate: event.occurrenceDate ?? event.startDate };
        await completeScheduleEditorSaveInTransaction(db, { draftId: draft.id,
          saveRequestId: draft.saveRequestId, stateRevision: draft.stateRevision }, eventRef, event);
        return decode((await db.getFirstAsync<Row>('SELECT * FROM schedule_editor_drafts WHERE id=?', id))!);
      }
    }
    // A rolled-back/interrupted atomic commit has no completion receipt.
    const retryable = { ...draft, phase: 'editing' as const, stateRevision: draft.stateRevision + 1 };
    await writeScheduleEditorDraftInTransaction(db, retryable, draft.stateRevision);
    return retryable;
  }
  const recovered = recoverScheduleEditorDraft(draft);
  if (recovered !== draft) await writeScheduleEditorDraftInTransaction(db, recovered, draft.stateRevision);
  return recovered;
}

export async function listUnfinishedScheduleEditorDrafts(): Promise<ScheduleEditorDraft[]> {
  const db = await openScheduleDatabase();
  const rows = await db.getAllAsync<Row>(
    "SELECT * FROM schedule_editor_drafts WHERE state != 'saved' ORDER BY updated_at_ms DESC, id",
  );
  return rows.map(decode);
}

/** Explicit abandonment only; a pending/uncertain commit must be reconciled. */
export async function discardStoredScheduleEditorDraft(id: string, expectedStateRevision: number): Promise<boolean> {
  return withScheduleDatabaseTransaction(async db => {
    const result = await db.runAsync(
      "DELETE FROM schedule_editor_drafts WHERE id=? AND state_revision=? AND state NOT IN ('saving','saved')",
      id, expectedStateRevision,
    );
    return result.changes === 1;
  });
}

/** Must run inside the event writer's existing transaction, after its event rows. */
export async function completeScheduleEditorSaveInTransaction(db: SQLiteDatabase,
  request: ScheduleEditorSaveRequest, eventRef: EventRef, event: Omit<CalEvent, 'id'>,
  previousEventRevision: number | null = null, committedEventRef: EventRef = eventRef): Promise<ScheduleEditorSaveReceipt> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM schedule_editor_drafts WHERE id=?', request.draftId);
  if (!row) throw new Error('日程草稿不存在');
  const draft = decode(row);
  if (draft.saveRequestId !== request.saveRequestId) throw new Error('日程保存请求不一致');
  assertSavePayload(draft, event);
  if (draft.phase === 'saved') {
    if (JSON.stringify(draft.savedEventRef) !== JSON.stringify(committedEventRef)) throw new Error('日程保存回执不一致');
    return { ...request, stateRevision: draft.stateRevision, eventRef: committedEventRef };
  }
  if (draft.phase !== 'saving' || draft.stateRevision !== request.stateRevision) throw new Error('日程草稿已发生变化');
  if (draft.mode === 'create' ? event.clientRequestId !== draft.saveRequestId
    : draft.eventRef?.sourceEventId !== eventRef.sourceEventId || draft.eventRef?.occurrenceDate !== eventRef.occurrenceDate
      || draft.eventRevision !== null && draft.eventRevision !== previousEventRevision) {
    throw new Error('日程保存目标已发生变化');
  }
  if (committedEventRef.sourceEventId !== eventRef.sourceEventId) throw new Error('日程保存目标已发生变化');
  const rows = await db.getAllAsync<{ event_json: string }>(
    'SELECT event_json FROM local_schedule_events WHERE (id=? OR source_event_id=?) AND deleted_at_ms IS NULL',
    committedEventRef.sourceEventId, committedEventRef.sourceEventId);
  const committed = resolveEventReference(rows.map(row => JSON.parse(row.event_json) as CalEvent), committedEventRef);
  if (!committed) throw new Error('日程提交回执没有对应记录');
  assertSavePayload(draft, committed);
  const saved = { ...draft, phase: 'saved' as const, stateRevision: draft.stateRevision + 1, savedEventRef: committedEventRef };
  if (!await writeScheduleEditorDraftInTransaction(db, saved, request.stateRevision)) throw new Error('日程草稿已发生变化');
  if (draft.sourceInputJobId) {
    const completed = await db.runAsync(`UPDATE schedule_input_jobs SET state='saved', draft_json=NULL,
      source_json='{}', updated_at_ms=? WHERE id=? AND state='ready'`, Date.now(), draft.sourceInputJobId);
    if (completed.changes !== 1) throw new Error('日程输入尚未准备完成');
  }
  return { ...request, stateRevision: saved.stateRevision, eventRef: committedEventRef };
}

export function completeStoredScheduleEditorSave(request: ScheduleEditorSaveRequest, eventRef: EventRef,
  event: Omit<CalEvent, 'id'>, previousEventRevision: number | null = null,
  committedEventRef: EventRef = eventRef): Promise<ScheduleEditorSaveReceipt> {
  return withScheduleDatabaseTransaction(db => completeScheduleEditorSaveInTransaction(db, request, eventRef, event, previousEventRevision, committedEventRef));
}
