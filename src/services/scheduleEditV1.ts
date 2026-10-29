import type { ScheduleEditorChanges, ScheduleEditorDraft, ScheduleEditorInputOperation } from '../domain/scheduleEditor';
import { assertScheduleEditorDraft } from '../domain/scheduleEditor';
import { isScheduleTimeValue, unspecifiedScheduleTime } from '../domain/scheduleTime';
import { isValidEventDate } from '../utils/eventDraftValidation';
import { isEventCategory } from '../utils/eventColors';
import { deviceV2Request, loadDeviceV2Capabilities } from './deviceV2Api';

export interface ScheduleEditObservation {
  status: 'patch' | 'no_change' | 'unsupported' | 'ambiguous';
  changes: ScheduleEditorChanges;
  producerRevision: string;
}

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw new Error('没有理解这次修改，请调整后重试'); }
const nullableDate = (value: unknown) => value === null || typeof value === 'string' && isValidEventDate(value);

/** Validate the whole proposal before the draft owner may apply its revision CAS. */
export function decodeScheduleEditObservation(value: unknown, draft: ScheduleEditorDraft,
  operation: ScheduleEditorInputOperation): ScheduleEditObservation {
  if (!record(value) || value.schema_version !== 1 || value.draft_id !== draft.id
    || value.base_revision !== operation.baseRevision || value.input_sequence !== operation.sequence
    || !['patch', 'no_change', 'unsupported', 'ambiguous'].includes(value.status)
    || !Array.isArray(value.changes) || value.changes.length > 16
    || (value.status === 'patch') !== (value.changes.length > 0)
    || !record(value.evidence_spans) || typeof value.producer_revision !== 'string'
    || !value.producer_revision || value.producer_revision.length > 180) invalid();
  const changes: ScheduleEditorChanges = {};
  const fields = new Set<string>();
  for (const change of value.changes) {
    if (!record(change) || !['set', 'clear'].includes(change.op) || fields.has(change.field)
      || (change.op === 'clear') !== (change.value === null) || typeof change.evidence !== 'string'
      || !change.evidence.trim()) invalid();
    fields.add(change.field);
    const span = value.evidence_spans[change.field];
    if (!record(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < 0 || span.end <= span.start || span.end > operation.text.length
      || operation.text.slice(span.start, span.end) !== change.evidence
      || span.text !== change.evidence) invalid();
    const v = change.value;
    switch (change.field) {
      case 'title': case 'location': case 'notes': {
        if (v !== null && (typeof v !== 'string' || v.length > (change.field === 'notes' ? 65536 : 400))) invalid();
        changes[change.field as 'title' | 'location' | 'notes'] = v ?? '';
        break;
      }
      case 'date':
        if (v !== null && (!record(v) || !nullableDate(v.start_date) || !nullableDate(v.end_date))) invalid();
        changes.startDate = v?.start_date ?? null; changes.endDate = v?.end_date ?? null;
        break;
      case 'time': {
        const time = v === null ? unspecifiedScheduleTime() : record(v)
          ? { precision: v.precision, period: v.period, startTime: v.start_time, endTime: v.end_time } : null;
        if (!isScheduleTimeValue(time)) invalid();
        changes.time = time;
        break;
      }
      case 'category':
        if (v !== null && !isEventCategory(v)) invalid();
        changes.category = v ?? '其他';
        break;
      case 'recurrence':
        if (v !== null && (!record(v) || !['once', 'daily', 'weekly', 'monthly', 'yearly'].includes(v.repeat)
          || !Number.isSafeInteger(v.interval) || v.interval < 1 || v.interval > 1000 || !Array.isArray(v.weekdays)
          || v.weekdays.some((day: unknown) => !Number.isInteger(day) || Number(day) < 1 || Number(day) > 7)
          || new Set(v.weekdays).size !== v.weekdays.length || !nullableDate(v.until_date))) invalid();
        Object.assign(changes, { repeat: v?.repeat ?? 'once', recurrenceInterval: v?.interval ?? 1,
          recurrenceWeekdays: v?.weekdays ?? [], recurrenceUntilDate: v?.until_date ?? null });
        break;
      case 'reminder':
        if (v !== null && (!Number.isSafeInteger(v) || v < 0 || v > 525600)) invalid();
        changes.reminderMinutes = v;
        break;
      default: invalid();
    }
  }
  // No partial field write. Cross-field date/time validation follows at the
  // canonical draft owner, where later manual changes can also be detected.
  assertScheduleEditorDraft({ ...draft, ...changes });
  return { status: value.status, changes, producerRevision: value.producer_revision };
}

export async function editScheduleDraftV1(draft: ScheduleEditorDraft,
  operation: ScheduleEditorInputOperation, signal?: AbortSignal): Promise<ScheduleEditObservation> {
  if (operation.mode !== 'patch' || !operation.text.trim()) throw new Error('请先输入这次要修改的内容');
  const capabilities = await loadDeviceV2Capabilities();
  if (!capabilities.scheduleEditV1 || !capabilities.scheduleTimePrecisionV1) {
    throw new Error('暂时无法处理这次修改，可直接编辑日程');
  }
  const value = await deviceV2Request<unknown>('/schedule/graph/edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ schema_version: 1, client_request_id: operation.id, draft_id: draft.id,
      base_revision: operation.baseRevision, input_sequence: operation.sequence,
      reference_datetime: operation.referenceDatetime, timezone: operation.timezone, mode: operation.mode,
      utterance: operation.text, draft: {
        title: draft.title, start_date: draft.startDate, end_date: draft.endDate,
        time: { precision: draft.time.precision, period: draft.time.period,
          start_time: draft.time.startTime, end_time: draft.time.endTime },
        location: draft.location, notes: draft.notes, category: draft.category,
        recurrence: { repeat: draft.repeat, interval: draft.recurrenceInterval,
          weekdays: draft.recurrenceWeekdays, until_date: draft.recurrenceUntilDate },
        reminder_minutes: draft.reminderMinutes,
      },
    }),
  }, '暂时无法处理这次修改，请重试');
  return decodeScheduleEditObservation(value, draft, operation);
}
