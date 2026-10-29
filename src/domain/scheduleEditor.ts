import type { CalEvent, EventRecurrenceScope, EventRef, MeetingActionFollowupParams } from '../types';
import type { EventCategory } from '../utils/eventColors';
import { isEventCategory, normalizeEventCategory } from '../utils/eventColors';
import type { ParseResult } from '../services/scheduleParsing';
import { isValidEventDate, validateEventDraft } from '../utils/eventDraftValidation';
import { isScheduleTimeValue, unspecifiedScheduleTime, type ScheduleTimeValue } from './scheduleTime';

export type ScheduleEditorPhase = 'editing' | 'recording' | 'parsing' | 'saving' | 'saved';
export type ScheduleFieldOrigin = 'manual' | 'explicit' | 'context' | 'default' | 'legacy';
export type ScheduleInputMode = 'initial' | 'patch' | 'replace';

export interface ScheduleEditorContent {
  startDate: string | null;
  endDate: string | null;
  time: ScheduleTimeValue;
  title: string;
  location: string;
  notes: string;
  category: EventCategory;
  repeat: NonNullable<CalEvent['repeat']>;
  recurrenceInterval: number;
  recurrenceWeekdays: number[];
  recurrenceUntilDate: string | null;
  reminderMinutes: number | null;
  /** Unchanged legacy business data, never exposed as an editor mode. */
  legacyIsAllDay: boolean;
}

export type ScheduleEditorField = Exclude<keyof ScheduleEditorContent, 'legacyIsAllDay'>;
export type ScheduleEditorChanges = Partial<Pick<ScheduleEditorContent, ScheduleEditorField>>;
export interface ScheduleEditorInputOperation {
  id: string;
  baseRevision: number;
  sequence: number;
  mode: ScheduleInputMode;
  referenceDatetime: string;
  timezone: string;
  text: string;
}
export interface ScheduleEditorUndo {
  before: ScheduleEditorChanges;
  after: ScheduleEditorChanges;
  origins: Partial<Record<ScheduleEditorField, ScheduleFieldOrigin>>;
  legacyIsAllDay: boolean;
}
export interface ScheduleEditorDraft extends ScheduleEditorContent {
  schemaVersion: 1;
  id: string;
  revision: number;
  /** Orders persistence of phase/text changes independently of content CAS. */
  stateRevision: number;
  mode: 'create' | 'edit';
  eventRef: EventRef | null;
  eventRevision: number | null;
  recurrenceScope: EventRecurrenceScope | null;
  sourceInputJobId: string | null;
  sourceKind: 'manual' | 'phone_voice' | 'hardware_voice' | 'meeting_action';
  fieldOrigins: Partial<Record<ScheduleEditorField, ScheduleFieldOrigin>>;
  inputSequence: number;
  latestInputText: string;
  pendingInput: ScheduleEditorInputOperation | null;
  lastUndo: ScheduleEditorUndo | null;
  phase: ScheduleEditorPhase;
  saveRequestId: string;
  savedEventRef: EventRef | null;
  /** Source completion shares the saved receipt, never a second event writer. */
  followup?: {
    params: MeetingActionFollowupParams;
    state: 'pending' | 'linked' | 'retired';
    attempts: number;
    retryAtMs: number;
  };
}

export interface ScheduleEditorSaveRequest {
  draftId: string;
  saveRequestId: string;
  stateRevision: number;
}
export interface ScheduleEditorSaveReceipt extends ScheduleEditorSaveRequest {
  eventRef: EventRef;
}

const CONTENT_FIELDS: readonly ScheduleEditorField[] = [
  'startDate', 'endDate', 'time', 'title', 'location', 'notes', 'category', 'repeat',
  'recurrenceInterval', 'recurrenceWeekdays', 'recurrenceUntilDate', 'reminderMinutes',
];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const nullableDate = (value: unknown) => value === null || typeof value === 'string' && isValidEventDate(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 65536;
const origin = (value: unknown) => ['manual', 'explicit', 'context', 'default', 'legacy'].includes(String(value));
function validRef(value: unknown): value is EventRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as EventRef;
  return typeof ref.sourceEventId === 'string' && !!ref.sourceEventId && isValidEventDate(ref.occurrenceDate);
}

function assertContent(draft: ScheduleEditorContent): void {
  if (!nullableDate(draft.startDate) || !nullableDate(draft.endDate)
    || !isScheduleTimeValue(draft.time) || !text(draft.title) || !text(draft.location) || !text(draft.notes)
    || !isEventCategory(draft.category) || !['once', 'daily', 'weekly', 'monthly', 'yearly'].includes(draft.repeat)
    || !positive(draft.recurrenceInterval) || !Array.isArray(draft.recurrenceWeekdays)
    || draft.recurrenceWeekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)
    || !nullableDate(draft.recurrenceUntilDate) || typeof draft.legacyIsAllDay !== 'boolean'
    || !(draft.reminderMinutes === null || Number.isSafeInteger(draft.reminderMinutes) && draft.reminderMinutes >= 0)) {
    throw new Error('日程草稿格式不正确');
  }
}

export function assertScheduleEditorDraft(value: unknown): asserts value is ScheduleEditorDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('日程草稿格式不正确');
  const draft = value as ScheduleEditorDraft;
  assertContent(draft);
  if (draft.schemaVersion !== 1 || !text(draft.id) || !draft.id || !text(draft.saveRequestId) || !draft.saveRequestId
    || !positive(draft.revision) || !positive(draft.stateRevision)
    || !['create', 'edit'].includes(draft.mode) || !(draft.eventRef === null || validRef(draft.eventRef))
    || draft.mode === 'edit' && !validRef(draft.eventRef)
    || !(draft.eventRevision === null || positive(draft.eventRevision))
    || !(draft.recurrenceScope === null || ['occurrence', 'following', 'series'].includes(draft.recurrenceScope))
    || !(draft.sourceInputJobId === null || text(draft.sourceInputJobId) && !!draft.sourceInputJobId)
    || !['manual', 'phone_voice', 'hardware_voice', 'meeting_action'].includes(draft.sourceKind)
    || !draft.fieldOrigins || Object.entries(draft.fieldOrigins).some(([key, value]) =>
      !CONTENT_FIELDS.includes(key as ScheduleEditorField) || !origin(value))
    || !Number.isSafeInteger(draft.inputSequence) || draft.inputSequence < 0 || !text(draft.latestInputText)
    || !['editing', 'recording', 'parsing', 'saving', 'saved'].includes(draft.phase)
    || !(draft.savedEventRef === null || validRef(draft.savedEventRef))) {
    throw new Error('日程草稿状态不正确');
  }
  if (draft.pendingInput !== null) {
    const op = draft.pendingInput;
    if (!op || !text(op.id) || !op.id || !positive(op.baseRevision) || !positive(op.sequence)
      || op.sequence !== draft.inputSequence || op.baseRevision > draft.revision
      || !['initial', 'patch', 'replace'].includes(op.mode) || !text(op.text)
      || !text(op.referenceDatetime) || !/(?:[Zz]|[+-]\d{2}:\d{2})$/.test(op.referenceDatetime)
      || !Number.isFinite(Date.parse(op.referenceDatetime)) || !text(op.timezone) || !op.timezone) {
      throw new Error('日程输入状态不正确');
    }
  }
  if (draft.phase === 'saved' && (!draft.savedEventRef || draft.pendingInput)
    || ['recording', 'parsing'].includes(draft.phase) && !draft.pendingInput
    || ['editing', 'saving', 'saved'].includes(draft.phase) && draft.pendingInput) {
    throw new Error('日程草稿阶段不正确');
  }
  if (draft.lastUndo !== null) {
    const undo = draft.lastUndo;
    if (!undo || !undo.before || !undo.after || !undo.origins || typeof undo.legacyIsAllDay !== 'boolean'
      || Object.keys(undo.before).some(key => !CONTENT_FIELDS.includes(key as ScheduleEditorField))
      || !same(Object.keys(undo.before).sort(), Object.keys(undo.after).sort())
      || Object.entries(undo.origins).some(([key, value]) =>
        !CONTENT_FIELDS.includes(key as ScheduleEditorField) || !origin(value))) {
      throw new Error('日程撤销记录不正确');
    }
    assertContent({ ...draft, ...undo.before });
    assertContent({ ...draft, ...undo.after });
  }
  if (draft.followup !== undefined) {
    const f = draft.followup;
    if (!f || !f.params || draft.mode !== 'create' || draft.sourceKind !== 'meeting_action'
      || f.params.clientRequestId !== draft.saveRequestId
      || ['meetingId', 'canonicalMeetingId', 'actionId', 'clientRequestId'].some(key => {
        const id = f.params[key as keyof MeetingActionFollowupParams];
        return typeof id !== 'string' || !id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id);
      }) || !['pending', 'linked', 'retired'].includes(f.state)
      || !Number.isSafeInteger(f.attempts) || f.attempts < 0
      || !Number.isSafeInteger(f.retryAtMs) || f.retryAtMs < 0
      || f.state !== 'pending' && draft.phase !== 'saved') throw new Error('日程来源回执不正确');
  }
}

export function createScheduleEditorDraft(input: {
  id: string; saveRequestId: string; startDate: string | null;
  dateOrigin?: ScheduleFieldOrigin;
  eventRef?: EventRef; eventRevision?: number; recurrenceScope?: EventRecurrenceScope;
  sourceInputJobId?: string; sourceKind?: ScheduleEditorDraft['sourceKind'];
  followup?: MeetingActionFollowupParams;
  content?: Partial<ScheduleEditorContent>;
}): ScheduleEditorDraft {
  const draft: ScheduleEditorDraft = {
    schemaVersion: 1, id: input.id, saveRequestId: input.saveRequestId,
    revision: 1, stateRevision: 1, mode: input.eventRef ? 'edit' : 'create',
    eventRef: input.eventRef ?? null, eventRevision: input.eventRevision ?? null,
    recurrenceScope: input.recurrenceScope ?? null, sourceInputJobId: input.sourceInputJobId ?? null,
    sourceKind: input.sourceKind ?? 'manual', startDate: input.startDate, endDate: null,
    time: unspecifiedScheduleTime(), title: '', location: '', notes: '', category: '其他',
    repeat: 'once', recurrenceInterval: 1, recurrenceWeekdays: [], recurrenceUntilDate: null,
    reminderMinutes: null, legacyIsAllDay: false,
    fieldOrigins: input.dateOrigin ? { startDate: input.dateOrigin } : {}, inputSequence: 0,
    latestInputText: '', pendingInput: null, lastUndo: null, phase: 'editing', savedEventRef: null,
    ...input.content,
    ...(input.followup ? { followup: { params: { ...input.followup }, state: 'pending' as const, attempts: 0, retryAtMs: 0 } } : {}),
  };
  assertScheduleEditorDraft(draft);
  return draft;
}

export function initialScheduleEditorDate(parsed: ParseResult, context: {
  entryDate?: string | null; referenceDatetime?: string; timezone?: string;
} = {}): { date: string | null; origin: ScheduleFieldOrigin } {
  // An older producer's absent metadata is not proof that the user omitted
  // dates. Unknown/explicitly unresolved observations never default to today.
  if (parsed.date_resolution === 'unresolved') return { date: null, origin: 'explicit' };
  if (parsed.date_resolution !== 'omitted') return { date: parsed.start_date || null, origin: 'explicit' };
  if (context.entryDate && isValidEventDate(context.entryDate)) return { date: context.entryDate, origin: 'context' };
  const reference = context.referenceDatetime ?? parsed.reference_datetime;
  const timezone = context.timezone ?? parsed.timezone;
  if (!reference || !/(?:[Zz]|[+-]\d{2}:\d{2})$/.test(reference)
    || !Number.isFinite(Date.parse(reference)) || !timezone) return { date: null, origin: 'default' };
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(reference));
    const part = (type: string) => parts.find(value => value.type === type)?.value;
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    return { date: isValidEventDate(date) ? date : null, origin: 'default' };
  } catch { return { date: null, origin: 'default' }; }
}

/** Phone and hardware observations enter the same editable content contract. */
export function initialScheduleEditorChanges(parsed: ParseResult,
  context: Parameters<typeof initialScheduleEditorDate>[1] = {}): ScheduleEditorChanges {
  const time = parsed.start_time
    ? { precision: 'exact' as const, period: null, startTime: parsed.start_time, endTime: parsed.end_time ?? null }
    : parsed.time_period
      ? { precision: 'period' as const, period: parsed.time_period, startTime: null, endTime: null }
      : { precision: 'unspecified' as const, period: null, startTime: null, endTime: null };
  const date = initialScheduleEditorDate(parsed, context).date;
  return { title: parsed.title, startDate: date,
    endDate: date && parsed.date_resolution !== 'omitted' && parsed.end_date && parsed.end_date !== date ? parsed.end_date : null,
    time, location: parsed.location ?? '', notes: parsed.description ?? parsed.detail ?? '',
    category: normalizeEventCategory(parsed.category), repeat: parsed.event_type,
    recurrenceInterval: parsed.recurrence_interval ?? 1, recurrenceWeekdays: parsed.recurrence_weekdays ?? [],
    recurrenceUntilDate: parsed.recurrence_until_date ?? null,
    reminderMinutes: time.precision === 'exact' ? parsed.reminder_minutes ?? null : null };
}

/** Entry identity, not an approximate title/date match, decides which durable
 * draft can be offered. Explicit calendar context is never silently replaced. */
export function isScheduleEditorResumeCandidate(draft: ScheduleEditorDraft,
  entry: import('../types').RootStackParamList['AddEvent']): boolean {
  if (draft.phase === 'saved') return false;
  const hasContent = !!(draft.latestInputText.trim() || draft.title.trim() || draft.location.trim() || draft.notes.trim())
    || Object.values(draft.fieldOrigins).some(value => value === 'manual' || value === 'explicit');
  if (!hasContent) return false;
  if (entry.eventRef) return draft.mode === 'edit' && same(draft.eventRef, entry.eventRef)
    && draft.recurrenceScope === (entry.recurrenceScope ?? 'series');
  if (draft.mode !== 'create') return false;
  if (entry.draft?.inputJobId) return draft.sourceInputJobId === entry.draft.inputJobId;
  const request = entry.followup?.clientRequestId ?? entry.draft?.clientRequestId;
  if (request) return draft.saveRequestId === request;
  if (entry.draft || entry.followup || draft.sourceInputJobId
    || !['manual', 'phone_voice'].includes(draft.sourceKind)) return false;
  return (!entry.date || draft.startDate === entry.date)
    && (!entry.startTime || draft.time.startTime === entry.startTime)
    && (!entry.endDate || (draft.endDate ?? draft.startDate) === entry.endDate)
    && (!entry.endTime || draft.time.endTime === entry.endTime);
}

function changedContent(draft: ScheduleEditorDraft, changes: ScheduleEditorChanges,
  by: ScheduleFieldOrigin, legacyIsAllDay?: boolean): ScheduleEditorDraft {
  if (Object.keys(changes).some(key => !CONTENT_FIELDS.includes(key as ScheduleEditorField))) {
    throw new Error('日程修改字段不受支持');
  }
  const next = { ...draft, ...changes, fieldOrigins: { ...draft.fieldOrigins } };
  if (changes.time && !same(changes.time, draft.time)) {
    if (changes.time.precision !== 'unspecified') next.legacyIsAllDay = false;
    if (changes.time.precision !== 'exact') next.reminderMinutes = null;
  }
  if (legacyIsAllDay !== undefined) next.legacyIsAllDay = legacyIsAllDay;
  assertContent(next);
  const changed = CONTENT_FIELDS.filter(key => !same(draft[key], next[key]));
  if (changed.length === 0 && next.legacyIsAllDay === draft.legacyIsAllDay) return draft;
  for (const key of changed) next.fieldOrigins[key] = by;
  return { ...next, revision: draft.revision + 1, stateRevision: draft.stateRevision + 1 };
}

export function editScheduleFields(draft: ScheduleEditorDraft, changes: ScheduleEditorChanges): ScheduleEditorDraft {
  if (draft.phase === 'saving' || draft.phase === 'saved') return draft;
  return changedContent(draft, changes, 'manual');
}

export function beginScheduleEditorInput(draft: ScheduleEditorDraft, input: {
  id: string; mode: ScheduleInputMode; referenceDatetime: string; timezone: string; text?: string; recording?: boolean;
}): ScheduleEditorDraft {
  if (draft.phase === 'saving' || draft.phase === 'saved') return draft;
  const sequence = draft.inputSequence + 1;
  const next: ScheduleEditorDraft = { ...draft, stateRevision: draft.stateRevision + 1,
    inputSequence: sequence, latestInputText: input.text ?? '', phase: input.recording ? 'recording' : 'parsing',
    pendingInput: { id: input.id, baseRevision: draft.revision, sequence, mode: input.mode,
      referenceDatetime: input.referenceDatetime, timezone: input.timezone, text: input.text ?? '' } };
  assertScheduleEditorDraft(next);
  return next;
}

export function finishScheduleEditorTranscript(draft: ScheduleEditorDraft, operationId: string, value: string): ScheduleEditorDraft {
  if (draft.pendingInput?.id !== operationId || !['recording', 'parsing'].includes(draft.phase)) return draft;
  const next = { ...draft, stateRevision: draft.stateRevision + 1, latestInputText: value,
    phase: 'parsing' as const, pendingInput: { ...draft.pendingInput, text: value } };
  assertScheduleEditorDraft(next);
  return next;
}

/** Input text is durable, but not a structural field revision or another phase owner. */
export function writeScheduleEditorInputText(draft: ScheduleEditorDraft, value: string, operationId?: string): ScheduleEditorDraft {
  if (draft.phase === 'saving' || draft.phase === 'saved'
    || operationId !== undefined && draft.pendingInput?.id !== operationId
    || operationId === undefined && draft.phase !== 'editing' || draft.latestInputText === value) return draft;
  const next = { ...draft, stateRevision: draft.stateRevision + 1, latestInputText: value,
    pendingInput: draft.pendingInput ? { ...draft.pendingInput, text: value } : null };
  assertScheduleEditorDraft(next);
  return next;
}

export function cancelScheduleEditorInput(draft: ScheduleEditorDraft): ScheduleEditorDraft {
  if (!draft.pendingInput) return draft;
  return { ...draft, stateRevision: draft.stateRevision + 1, phase: 'editing', pendingInput: null };
}

export function scheduleEditorEventValue(draft: ScheduleEditorDraft) {
  return { title: draft.title, startDate: draft.startDate ?? '', endDate: draft.endDate ?? undefined,
    startTime: draft.time.startTime ?? undefined, endTime: draft.time.endTime ?? undefined,
    timePrecision: draft.time.precision, timePeriod: draft.time.period,
    isAllDay: draft.legacyIsAllDay, repeat: draft.repeat, recurrenceInterval: draft.recurrenceInterval,
    recurrenceWeekdays: draft.recurrenceWeekdays.length ? [...draft.recurrenceWeekdays] : undefined,
    recurrenceUntilDate: draft.recurrenceUntilDate ?? undefined,
    reminderMinutes: draft.reminderMinutes, location: draft.location, description: draft.notes, category: draft.category };
}

export function applyScheduleEditorInput(draft: ScheduleEditorDraft, fence: {
  id: string; baseRevision: number; sequence: number;
}, changes: ScheduleEditorChanges, origins: Partial<Record<ScheduleEditorField, ScheduleFieldOrigin>> = {}): { draft: ScheduleEditorDraft; accepted: boolean } {
  const op = draft.pendingInput;
  if (!op || op.id !== fence.id || op.sequence !== fence.sequence || op.baseRevision !== fence.baseRevision
    || draft.phase !== 'parsing') return { draft, accepted: false };
  if (draft.revision !== fence.baseRevision) return { draft: cancelScheduleEditorInput(draft), accepted: false };
  const replacing = op.mode === 'replace';
  if (replacing && !CONTENT_FIELDS.every(key => Object.prototype.hasOwnProperty.call(changes, key))) {
    throw new Error('重新输入的内容不完整，请重试');
  }
  const changed = changedContent(draft, changes, 'explicit', replacing ? false : undefined);
  const proposed = { ...changed, fieldOrigins: { ...changed.fieldOrigins } };
  for (const key of CONTENT_FIELDS) {
    if (replacing) proposed.fieldOrigins[key] = origins[key] ?? 'explicit';
    else if (origins[key] && key in changes && !same(draft[key], changed[key])) proposed.fieldOrigins[key] = origins[key];
  }
  const issues = validateEventDraft(scheduleEditorEventValue(proposed)).issues
    .filter(issue => !(proposed.startDate === null && issue.code === 'invalid-start-date'));
  if (issues.length) throw new Error(issues[0].message);
  // Replacement owns the complete new content, including equal values. Its
  // one undo must restore those prior origins as well, without touching identity.
  const keys = CONTENT_FIELDS.filter(key => replacing || !same(draft[key], proposed[key]));
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
  for (const key of keys) { before[key] = draft[key]; after[key] = proposed[key]; }
  const next = { ...proposed, stateRevision: draft.stateRevision + 1, phase: 'editing' as const,
    pendingInput: null, lastUndo: keys.length
      ? { before, after, origins: { ...draft.fieldOrigins }, legacyIsAllDay: draft.legacyIsAllDay } : draft.lastUndo };
  assertScheduleEditorDraft(next);
  return { draft: next, accepted: true };
}

export function undoScheduleEditorInput(draft: ScheduleEditorDraft): ScheduleEditorDraft {
  if (!draft.lastUndo || draft.phase !== 'editing') return draft;
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(draft.lastUndo.after) as ScheduleEditorField[]) {
    // Equality is not ownership: the user may have edited away and back to
    // this value. Only an untouched semantic write is still ours to undo.
    if (['explicit', 'context', 'default'].includes(draft.fieldOrigins[key] ?? '') && same(draft[key], draft.lastUndo.after[key])) {
      changes[key] = draft.lastUndo.before[key];
    }
  }
  const next = changedContent(draft, changes, 'explicit', 'time' in changes ? draft.lastUndo.legacyIsAllDay : undefined);
  // The inverse may carry coupled effects, such as clearing a reminder when
  // restoring a period. It must not bypass the same manual ownership fence.
  if (CONTENT_FIELDS.some(key => draft.fieldOrigins[key] === 'manual' && !same(next[key], draft[key]))) {
    return { ...draft, lastUndo: null, stateRevision: draft.stateRevision + 1 };
  }
  const issues = validateEventDraft(scheduleEditorEventValue(next)).issues
    .filter(issue => !(next.startDate === null && issue.code === 'invalid-start-date'));
  if (issues.length) return { ...draft, lastUndo: null, stateRevision: draft.stateRevision + 1 };
  const origins = { ...next.fieldOrigins };
  for (const key of Object.keys(changes) as ScheduleEditorField[]) {
    if (draft.lastUndo.origins[key]) origins[key] = draft.lastUndo.origins[key]; else delete origins[key];
  }
  return { ...next, fieldOrigins: origins, lastUndo: null, stateRevision: draft.stateRevision + 1 };
}

export function recoverScheduleEditorDraft(draft: ScheduleEditorDraft): ScheduleEditorDraft {
  assertScheduleEditorDraft(draft);
  // Saving is reconciled by its stable request receipt, never silently reset.
  return ['recording', 'parsing'].includes(draft.phase) ? cancelScheduleEditorInput(draft) : draft;
}
